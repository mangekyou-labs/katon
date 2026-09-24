import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AccountLayout, MintLayout, TOKEN_PROGRAM_ID, createMint, getAccount, mintTo, createAccount,
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, getMint,
  getTransferFeeConfig,
  createInitializeTransferFeeConfigInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
} from '@solana/spl-token';
import { Surfnet } from '@solana/surfpool';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contractDir = join(root, 'contracts/solana-rfq');
const programId = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const nativeUsdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const nativeUsdt = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const vault = Keypair.generate();
const guardian = Keypair.generate();
const seller = Keypair.generate();
const maker = Keypair.generate();
const feeRecipient = Keypair.generate();
const mintAuthority = Keypair.generate();
const ZERO = Buffer.alloc(32);
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const i64 = value => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; };
const optionKey = key => key ? Buffer.concat([Buffer.from([1]), key.toBuffer()]) : Buffer.from([0]);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const build = spawnSync('anchor', ['build', '--skip-lint'], {
  cwd: contractDir, encoding: 'utf8',
  env: { ...process.env, NO_DNA: '1', SOLANA_SQUADS_VAULT_AUTHORITY: vault.publicKey.toBase58(), KATON_DEPLOYMENT_BUILD: '0' },
});
assert.equal(build.status, 0, build.stderr || build.stdout);
const { default: idl } = await import('../contracts/solana-rfq/target/idl/solana_rfq.json', { with: { type: 'json' } });
const surfnet = Surfnet.startWithConfig({ offline: true });
try {
  surfnet.deploy({ programId: programId.toBase58(), soPath: join(contractDir, 'target/deploy/solana_rfq.so') });
  const connection = new Connection(surfnet.rpcUrl, 'confirmed');
  for (const signer of [vault, guardian, seller, maker, feeRecipient, mintAuthority]) {
    surfnet.fundSol(signer.publicKey.toBase58(), 5_000_000_000);
  }
  const instruction = (name, accounts, args = Buffer.alloc(0)) => {
    const definition = idl.instructions.find(ix => ix.name === name);
    assert.ok(definition, `IDL missing ${name}`);
    return new TransactionInstruction({
      programId,
      keys: definition.accounts.map(a => ({
        pubkey: accounts[a.name], isSigner: a.signer === true, isWritable: a.writable === true,
      })),
      data: Buffer.concat([Buffer.from(definition.discriminator), args]),
    });
  };
  const send = async (ix, payer, signers = []) => {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(ix);
    return sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' });
  };
  const governance = pda(Buffer.from('governance'));
  const makerRegistry = pda(Buffer.from('makers'));
  await send(instruction('initialize_governance', {
    governance, squads_vault: vault.publicKey, system_program: SystemProgram.programId,
  }, guardian.publicKey.toBuffer()), vault);
  await send(instruction('initialize_maker_registry', {
    governance, squads_vault: vault.publicKey, maker_registry: makerRegistry, system_program: SystemProgram.programId,
  }, Buffer.concat([u32(1), maker.publicKey.toBuffer()])), vault);

  const stockMint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
  const stockFingerprint = createHash('sha256').update(Buffer.alloc(0)).digest();
  const authorityFingerprint = createHash('sha256').update(mintAuthority.publicKey.toBuffer()).digest();
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: mintAuthority.publicKey, supply: 0n, decimals: 6,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  surfnet.setAccount(nativeUsdc.toBase58(), 1_000_000_000, mintData, TOKEN_PROGRAM_ID.toBase58());
  surfnet.setAccount(nativeUsdt.toBase58(), 1_000_000_000, mintData, TOKEN_PROGRAM_ID.toBase58());
  const assetRegistry = pda(Buffer.from('asset'), stockMint.toBuffer());
  const registryArgs = Buffer.concat([
    Buffer.from([0]), nativeUsdc.toBuffer(), nativeUsdt.toBuffer(), stockFingerprint,
    optionKey(null), u32(0), mintAuthority.publicKey.toBuffer(), mintAuthority.publicKey.toBuffer(),
    authorityFingerprint, optionKey(null), ZERO,
  ]);
  await send(instruction('initialize_asset_registry', {
    governance, squads_vault: vault.publicKey, stock_mint: stockMint,
    stock_token_program: TOKEN_PROGRAM_ID, stable_token_program: TOKEN_PROGRAM_ID,
    asset_registry: assetRegistry, system_program: SystemProgram.programId,
  }, registryArgs), vault);

  const sellerStock = await createAccount(connection, seller, stockMint, seller.publicKey);
  const makerStock = await createAccount(connection, maker, stockMint, maker.publicKey);
  const makerStable = await createAccount(connection, maker, nativeUsdc, maker.publicKey);
  const sellerStable = await createAccount(connection, seller, nativeUsdc, seller.publicKey);
  const feeStable = await createAccount(connection, feeRecipient, nativeUsdc, feeRecipient.publicKey);
  await mintTo(connection, mintAuthority, stockMint, sellerStock, mintAuthority, 1_000_000);
  // The fixed native mint is seeded as a local fixture; seed its maker balance directly.
  const stableData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: nativeUsdc, owner: maker.publicKey, amount: 1_000_000n,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
    isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0,
    closeAuthority: PublicKey.default }, stableData);
  surfnet.setAccount(makerStable.toBase58(), 1_000_000_000, stableData, TOKEN_PROGRAM_ID.toBase58());

  const quoteId = randomBytes(32);
  const fillReceipt = pda(Buffer.from('fill'), maker.publicKey.toBuffer(), quoteId);
  const settleAccounts = {
    seller: seller.publicKey, maker: maker.publicKey,
    seller_stock_account: sellerStock, maker_stock_account: makerStock,
    maker_stable_account: makerStable, seller_stable_account: sellerStable,
    fee_recipient_stable_account: feeStable, fee_recipient: feeRecipient.publicKey,
    stock_mint: stockMint, stable_mint: nativeUsdc,
    stock_token_program: TOKEN_PROGRAM_ID, stable_token_program: TOKEN_PROGRAM_ID,
    asset_registry: assetRegistry, maker_registry: makerRegistry, governance,
    fill_receipt: fillReceipt, system_program: SystemProgram.programId,
  };
  const clockAccount = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  assert.ok(clockAccount, 'Surfnet clock must be observable');
  const now = Number(clockAccount.data.readBigInt64LE(32));
  const settle = (id = quoteId, expiresAt = now + 20, feeBps = 10, accountOverrides = {}, fingerprint = stockFingerprint) => instruction('settle_private_quote', {
    ...settleAccounts,
    fill_receipt: pda(Buffer.from('fill'), maker.publicKey.toBuffer(), id),
    ...accountOverrides,
  }, Buffer.concat([
    id, i64(now - 1), i64(expiresAt), u64(100_000), u64(100_000),
    u64(500_000), u64(499_500), u16(feeBps), fingerprint,
  ]));
  await assert.rejects(send(settle(randomBytes(32), now - 1), seller, [maker]), /ClockOutsideQuoteWindow/);
  await assert.rejects(send(settle(randomBytes(32), now + 31), seller, [maker]), /InvalidQuoteWindow/);
  console.log('AC-029: expired and overlong signed windows are rejected');
  await assert.rejects(send(settle(randomBytes(32), now + 20, 26), seller, [maker]), /FeeCapExceeded/);
  console.log('AC-027: fee above the protocol cap is rejected');
  await assert.rejects(send(settle(randomBytes(32), now + 20, 10, {
    fee_recipient: seller.publicKey,
    fee_recipient_stable_account: sellerStable,
  }), seller, [maker]), /DuplicateMutableAccount/);
  console.log('AC-031/034: duplicate economic token accounts are rejected');
  const sellerStableInfo = await connection.getAccountInfo(sellerStable);
  assert.ok(sellerStableInfo);
  const frozenSellerStable = Buffer.from(sellerStableInfo.data);
  frozenSellerStable[108] = 2; // SPL Token account state: Frozen.
  surfnet.setAccount(sellerStable.toBase58(), sellerStableInfo.lamports, frozenSellerStable, TOKEN_PROGRAM_ID.toBase58());
  const rollbackId = randomBytes(32);
  await assert.rejects(send(settle(rollbackId), seller, [maker]),
    'stable transfer failure after the stock CPI must roll back the whole transaction');
  assert.equal((await getAccount(connection, sellerStock)).amount, 1_000_000n);
  assert.equal((await getAccount(connection, makerStock)).amount, 0n);
  assert.equal(await connection.getAccountInfo(pda(Buffer.from('fill'), maker.publicKey.toBuffer(), rollbackId)), null);
  surfnet.setAccount(sellerStable.toBase58(), sellerStableInfo.lamports, sellerStableInfo.data, TOKEN_PROGRAM_ID.toBase58());
  console.log('AC-030: failed stable CPI rolls back stock transfer and receipt');
  const zeroQuoteId = Buffer.alloc(32);
  await assert.rejects(send(settle(zeroQuoteId), seller, [maker]), /InvalidQuoteId/,
    'all-zero quote ID must not create a fill receipt');
  assert.equal(await connection.getAccountInfo(pda(Buffer.from('fill'), maker.publicKey.toBuffer(), zeroQuoteId)), null);
  assert.equal((await getAccount(connection, sellerStock)).amount, 1_000_000n);
  console.log('AC-028: malformed quote ID is rejected before settlement');
  await send(settle(), seller, [maker]);
  assert.equal((await getAccount(connection, sellerStock)).amount, 900_000n);
  assert.equal((await getAccount(connection, makerStock)).amount, 100_000n);
  assert.equal((await getAccount(connection, makerStable)).amount, 500_000n);
  assert.equal((await getAccount(connection, sellerStable)).amount, 499_500n);
  assert.equal((await getAccount(connection, feeStable)).amount, 500n);
  assert.ok(await connection.getAccountInfo(fillReceipt), 'successful settlement creates a replay receipt');
  console.log('AC-026: exact stock and stable deltas plus fee receipt passed');
  await assert.rejects(send(settle(quoteId, now + 21), seller, [maker]),
    'reusing the live maker/quote receipt must fail');
  assert.equal((await getAccount(connection, sellerStock)).amount, 900_000n);
  assert.equal((await getAccount(connection, makerStable)).amount, 500_000n);
  console.log('AC-028: live receipt rejects replay without token movement');

  const createFeeStock = async (initialFeeBps, scheduledFeeBps = null) => {
    const mint = Keypair.generate();
    const mintSpace = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
    const mintRent = await connection.getMinimumBalanceForRentExemption(mintSpace);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: mintAuthority.publicKey, newAccountPubkey: mint.publicKey,
        space: mintSpace, lamports: mintRent, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeTransferFeeConfigInstruction(mint.publicKey, mintAuthority.publicKey,
        mintAuthority.publicKey, initialFeeBps, initialFeeBps === 0 ? 0n : 1_000n),
      createInitializeMetadataPointerInstruction(mint.publicKey, mintAuthority.publicKey,
        mintAuthority.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, 6, mintAuthority.publicKey, null,
        TOKEN_2022_PROGRAM_ID),
    ), [mintAuthority, mint], { commitment: 'confirmed' });
    if (scheduledFeeBps !== null) {
      await sendAndConfirmTransaction(connection, new Transaction().add(new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([26, 5]), u16(scheduledFeeBps), u64(1_000)]),
      })), [mintAuthority], { commitment: 'confirmed' });
    }
    const fingerprint = createHash('sha256').update(
      (await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID)).tlvData,
    ).digest();
    const registry = pda(Buffer.from('asset'), mint.publicKey.toBuffer());
    await send(instruction('initialize_asset_registry', {
      governance, squads_vault: vault.publicKey, stock_mint: mint.publicKey,
      stock_token_program: TOKEN_2022_PROGRAM_ID, stable_token_program: TOKEN_PROGRAM_ID,
      asset_registry: registry, system_program: SystemProgram.programId,
    }, Buffer.concat([
      Buffer.from([0]), nativeUsdc.toBuffer(), nativeUsdt.toBuffer(), fingerprint,
      optionKey(null), u32(0), mintAuthority.publicKey.toBuffer(), mintAuthority.publicKey.toBuffer(),
      authorityFingerprint, optionKey(null), ZERO,
    ])), vault);
    const sellerStock = await createAccount(connection, seller, mint.publicKey,
      seller.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    const makerStock = await createAccount(connection, maker, mint.publicKey,
      maker.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(connection, mintAuthority, mint.publicKey, sellerStock, mintAuthority,
      1_000_000, [], undefined, TOKEN_2022_PROGRAM_ID);
    return { mint: mint.publicKey, registry, sellerStock, makerStock, fingerprint };
  };

  const zeroFeeStock = await createFeeStock(0);
  const feeQuoteId = randomBytes(32);
  await send(settle(feeQuoteId, now + 20, 10, {
    seller_stock_account: zeroFeeStock.sellerStock, maker_stock_account: zeroFeeStock.makerStock,
    stock_mint: zeroFeeStock.mint, stock_token_program: TOKEN_2022_PROGRAM_ID,
    asset_registry: zeroFeeStock.registry,
  }, zeroFeeStock.fingerprint), seller, [maker]);
  assert.equal((await getAccount(connection, zeroFeeStock.sellerStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 900_000n);
  assert.equal((await getAccount(connection, zeroFeeStock.makerStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 100_000n);
  assert.equal((await getAccount(connection, makerStable)).amount, 0n);
  assert.equal((await getAccount(connection, sellerStable)).amount, 999_000n);
  assert.equal((await getAccount(connection, feeStable)).amount, 1_000n);
  console.log('AC-011/026: zero-fee Token-2022 transfer settles with exact stock deltas');

  const nonzeroFeeStock = await createFeeStock(1);
  const nonzeroFeeQuoteId = randomBytes(32);
  await assert.rejects(send(settle(nonzeroFeeQuoteId, now + 20, 10, {
    seller_stock_account: nonzeroFeeStock.sellerStock, maker_stock_account: nonzeroFeeStock.makerStock,
    stock_mint: nonzeroFeeStock.mint, stock_token_program: TOKEN_2022_PROGRAM_ID,
    asset_registry: nonzeroFeeStock.registry,
  }, nonzeroFeeStock.fingerprint), seller, [maker]), /NonzeroTransferFee/);
  assert.equal((await getAccount(connection, nonzeroFeeStock.sellerStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 1_000_000n);
  assert.equal((await getAccount(connection, nonzeroFeeStock.makerStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 0n);
  assert.equal((await getAccount(connection, makerStable)).amount, 0n);
  assert.equal(await connection.getAccountInfo(pda(Buffer.from('fill'), maker.publicKey.toBuffer(), nonzeroFeeQuoteId)), null);
  console.log('AC-011: nonzero Token-2022 transfer fee is rejected before settlement');

  const scheduledFeeStock = await createFeeStock(0, 1);
  const scheduledMint = await getMint(connection, scheduledFeeStock.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const scheduledFeeConfig = getTransferFeeConfig(scheduledMint);
  const currentEpoch = BigInt((await connection.getEpochInfo('confirmed')).epoch);
  assert.ok(scheduledFeeConfig, 'scheduled Token-2022 mint exposes its fee configuration');
  assert.equal(scheduledFeeConfig.olderTransferFee.transferFeeBasisPoints, 0);
  assert.equal(scheduledFeeConfig.newerTransferFee.transferFeeBasisPoints, 1);
  assert.ok(scheduledFeeConfig.newerTransferFee.epoch > currentEpoch,
    'nonzero fee is scheduled for a future epoch');
  const scheduledFeeQuoteId = randomBytes(32);
  await assert.rejects(send(settle(scheduledFeeQuoteId, now + 20, 10, {
    seller_stock_account: scheduledFeeStock.sellerStock, maker_stock_account: scheduledFeeStock.makerStock,
    stock_mint: scheduledFeeStock.mint, stock_token_program: TOKEN_2022_PROGRAM_ID,
    asset_registry: scheduledFeeStock.registry,
  }, scheduledFeeStock.fingerprint), seller, [maker]), /NonzeroTransferFee/);
  assert.equal((await getAccount(connection, scheduledFeeStock.sellerStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 1_000_000n);
  assert.equal((await getAccount(connection, scheduledFeeStock.makerStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 0n);
  assert.equal((await getAccount(connection, makerStable)).amount, 0n);
  assert.equal(await connection.getAccountInfo(pda(Buffer.from('fill'), maker.publicKey.toBuffer(), scheduledFeeQuoteId)), null);
  console.log('AC-011: scheduled Token-2022 transfer fee is rejected before settlement');

  await send(instruction('guardian_pause_program', {
    governance, guardian: guardian.publicKey,
  }), guardian);
  const pausedQuote = randomBytes(32);
  await assert.rejects(send(settle(pausedQuote), seller, [maker]), /ProgramPaused/,
    'guardian pause must block an already-issued settlement');
  assert.equal(await connection.getAccountInfo(pda(Buffer.from('fill'), maker.publicKey.toBuffer(), pausedQuote)), null);
  assert.equal((await getAccount(connection, sellerStock)).amount, 900_000n);
  assert.equal((await getAccount(connection, makerStable)).amount, 0n);
  console.log('AC-033: paused settlement rolls back receipt and token movement');

  const close = instruction('close_fill_receipt', { fill_receipt: fillReceipt, payer: seller.publicKey });
  await assert.rejects(send(close, guardian), /CloseTooEarly/);
  const receiptRent = (await connection.getAccountInfo(fillReceipt)).lamports;
  surfnet.timeTravelToTimestamp((now + 20 + 3_601) * 1_000);
  const sellerLamportsBeforeClose = await connection.getBalance(seller.publicKey);
  await send(close, guardian);
  assert.equal(await connection.getAccountInfo(fillReceipt), null);
  assert.equal(await connection.getBalance(seller.publicKey), sellerLamportsBeforeClose + receiptRent);
  console.log('AC-032: third-party cleanup after grace returns receipt rent to the seller');
} finally {
  surfnet.stop();
}
// web3.js leaves a reconnecting WebSocket after Surfnet stops.
process.exit(0);

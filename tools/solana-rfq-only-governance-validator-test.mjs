import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Surfnet } from '@solana/surfpool';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const contractDir = join(repo, 'contracts/solana-rfq');
const programId = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const vault = Keypair.generate();
const guardian = Keypair.generate();
const member = Keypair.generate();

function run(command, args, env = process.env, cwd = repo) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'inherit' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}

const env = {
  ...process.env,
  NO_DNA: '1',
  SOLANA_SQUADS_VAULT_AUTHORITY: vault.publicKey.toBase58(),
  KATON_DEPLOYMENT_BUILD: '0',
};

let surfnet;
try {
  run('anchor', ['build', '--skip-lint'], env, contractDir);
  const { default: idl } = await import('../contracts/solana-rfq/target/idl/solana_rfq.json', {
    with: { type: 'json' },
  });
  surfnet = Surfnet.startWithConfig({ offline: true });
  surfnet.deploy({
    programId: programId.toBase58(),
    soPath: join(contractDir, 'target/deploy/solana_rfq.so'),
  });
  const rpcUrl = surfnet.rpcUrl;
  const connection = new Connection(rpcUrl, 'confirmed');

  surfnet.fundSol(vault.publicKey.toBase58(), 5_000_000_000);
  surfnet.fundSol(member.publicKey.toBase58(), 5_000_000_000);

  const governance = PublicKey.findProgramAddressSync([Buffer.from('governance')], programId)[0];
  const makerRegistry = PublicKey.findProgramAddressSync([Buffer.from('makers')], programId)[0];
  const queuedAddress = proposalId => PublicKey.findProgramAddressSync(
    [Buffer.from('governance-action'), proposalId], programId,
  )[0];
  const instruction = (name, accounts, args = Buffer.alloc(0)) => {
    const definition = idl.instructions.find(item => item.name === name);
    assert.ok(definition, `IDL missing ${name}`);
    return new TransactionInstruction({
      programId,
      keys: definition.accounts.map(account => ({
        pubkey: accounts[account.name],
        isSigner: account.signer === true,
        isWritable: account.writable === true,
      })),
      data: Buffer.concat([Buffer.from(definition.discriminator), args]),
    });
  };
  const send = async (ix, extraSigners = [], feePayer = vault) => {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: feePayer.publicKey, ...latest }).add(ix);
    return sendAndConfirmTransaction(connection, tx, [feePayer, ...extraSigners.filter(item => item !== feePayer)], {
      commitment: 'confirmed',
    });
  };
  const bootstrap = (signer, guardianKey) => instruction('initialize_governance', {
    governance,
    squads_vault: signer.publicKey,
    system_program: SystemProgram.programId,
  }, Buffer.from(guardianKey.toBytes()));

  await assert.rejects(send(bootstrap(member, guardian.publicKey), [], member),
    'individual member signer must not bootstrap governance');
  assert.equal(await connection.getAccountInfo(governance), null, 'failed bootstrap must leave no account');
  await send(bootstrap(vault, guardian.publicKey));
  let governanceAccount = await connection.getAccountInfo(governance, 'confirmed');
  assert.ok(governanceAccount, 'vault bootstrap should create governance state');
  assert.equal(governanceAccount.data.readUInt8(72), 0, 'program begins unpaused');
  assert.equal(governanceAccount.data.readBigInt64LE(73), 86_400n, 'governance delay is 24 hours');

  const economicsAction = (feeBps = 12) => Buffer.concat([
    Buffer.from([2]),
    u16(feeBps), u16(25), i64(29), u64(1_000_000),
  ]);
  const u16 = value => { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; };
  const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
  const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
  const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
  let proposalCounter = 1;
  const newProposal = () => Buffer.alloc(32, proposalCounter++);
  const queue = (proposalId, target, action, expectedVersion, signer = vault) => instruction('queue_governance_action', {
      governance,
      squads_vault: signer.publicKey,
      target,
      queued_change: queuedAddress(proposalId),
      system_program: SystemProgram.programId,
    }, Buffer.concat([proposalId, action, u64(expectedVersion)]));
  const queuedInstruction = (name, proposalId, target = governance, signer = vault) => instruction(name, {
    governance,
    squads_vault: signer.publicKey,
    target,
    queued_change: queuedAddress(proposalId),
  });

  await send(instruction('initialize_maker_registry', {
    governance,
    squads_vault: vault.publicKey,
    maker_registry: makerRegistry,
    system_program: SystemProgram.programId,
  }, u32(0)));

  const appliedProposal = newProposal();
  const staleProposal = newProposal();
  await assert.rejects(send(queue(newProposal(), governance, economicsAction(12), 1, member), [], member),
    'member signer must not queue a governance change');
  await assert.rejects(send(queue(newProposal(), governance, economicsAction(12), 2)),
    'stale expected version must be rejected at queue time');
  await send(queue(appliedProposal, governance, economicsAction(12), 1));
  await send(queue(staleProposal, governance, economicsAction(13), 1));
  const makersProposal = newProposal();
  const makersAction = Buffer.concat([Buffer.from([1]), u32(1), member.publicKey.toBuffer(), Buffer.from([0])]);
  await send(queue(makersProposal, makerRegistry, makersAction, 1));
  await assert.rejects(send(queuedInstruction('apply_governance_action', appliedProposal)),
    'queued changes must not apply before the delay');

  const queuedAccount = await connection.getAccountInfo(queuedAddress(appliedProposal), 'confirmed');
  assert.ok(queuedAccount, 'queue action should persist its immutable payload');
  const applyAfter = queuedAccount.data.readBigInt64LE(8 + 32 + 32 + 32 + 8 + 32 + 8);
  surfnet.timeTravelToTimestamp((Number(applyAfter) + 1) * 1_000);
  const clockAccount = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  assert.ok(clockAccount, 'validator clock sysvar must be available');
  const chainTime = Number(clockAccount.data.readBigInt64LE(32));
  assert.ok(chainTime >= Number(applyAfter),
    `validator clock ${chainTime} must reach apply_after ${applyAfter} at slot ${await connection.getSlot('confirmed')}`);

  await send(queuedInstruction('apply_governance_action', appliedProposal, governance));
  governanceAccount = await connection.getAccountInfo(governance, 'confirmed');
  assert.equal(governanceAccount.data.readUInt16LE(8 + 32 + 32 + 1 + 8 + 8), 12,
    'delayed apply updates economics');
  assert.equal(governanceAccount.data.readBigUInt64LE(8 + 32 + 32 + 1 + 8), 2n,
    'delayed apply advances governance version');
  await send(queuedInstruction('apply_governance_action', makersProposal, makerRegistry));
  const makerRegistryAccount = await connection.getAccountInfo(makerRegistry, 'confirmed');
  assert.ok(makerRegistryAccount, 'delayed maker policy apply must retain its registry');
  assert.equal(makerRegistryAccount.data.readUInt32LE(8), 1, 'maker policy allowlist is replaced');
  assert.equal(makerRegistryAccount.data.subarray(12, 44).equals(member.publicKey.toBuffer()), true,
    'maker policy applies the queued allowlisted identity');
  assert.equal(makerRegistryAccount.data.readUInt8(44), 0, 'maker policy pause state is applied');
  assert.equal(makerRegistryAccount.data.readBigUInt64LE(45), 2n,
    'delayed maker policy apply advances its registry version');
  await assert.rejects(send(queuedInstruction('apply_governance_action', staleProposal, governance)),
    'a queued action with a stale version must not apply');
  await send(queuedInstruction('cancel_governance_action', staleProposal, governance));
  assert.equal(await connection.getAccountInfo(queuedAddress(staleProposal)), null,
    'vault cancellation closes the queued action');

  const cancelledProposal = newProposal();
  await send(queue(cancelledProposal, governance, economicsAction(14), 2));
  await send(queuedInstruction('cancel_governance_action', cancelledProposal, governance));
  assert.equal(await connection.getAccountInfo(queuedAddress(cancelledProposal)), null,
    'queue and cancel remain separate explicit actions');

  const guardianPause = instruction('guardian_pause_program', {
    governance,
    guardian: member.publicKey,
  });
  await assert.rejects(send(guardianPause, [member]), 'an unrelated signer must not use guardian pause');
  const validGuardianPause = instruction('guardian_pause_program', {
    governance,
    guardian: guardian.publicKey,
  });
  await send(validGuardianPause, [guardian]);
  governanceAccount = await connection.getAccountInfo(governance, 'confirmed');
  assert.equal(governanceAccount.data.readUInt8(72), 1, 'guardian may pause the program');
  assert.equal(idl.instructions.some(item => item.name.includes('unpause') && item.name.includes('guardian')),
    false, 'guardian has no unpause instruction');

  const guardianCannotCancel = newProposal();
  await send(queue(guardianCannotCancel, governance, economicsAction(14), 2));
  await assert.rejects(send(queuedInstruction('cancel_governance_action', guardianCannotCancel, governance, guardian), [guardian]),
    'guardian must not cancel governed changes');
  await send(queuedInstruction('cancel_governance_action', guardianCannotCancel, governance));
  console.log('validator RFQ-only generated-vault-signer coverage passed: bootstrap, delayed economics and maker-policy apply, cancel, stale versions, signer isolation, guardian pause; no Squads threshold/PDA signing claim');
} finally {
  // web3.js closes idle websocket subscriptions asynchronously.
  await delay(750);
  surfnet?.stop();
}

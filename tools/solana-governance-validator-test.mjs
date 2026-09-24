import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Surfnet } from '@solana/surfpool';
import * as squads from '@sqds/multisig';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const contractDir = join(repo, 'contracts/solana-rfq');
const rfqProgramId = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const squadsProgramId = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const pinnedSourceRevision = '64af7330413d5c85cbbccfd8c27a05d45b6e666f';
const expectedLocalExecutableHash = 'd48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac';
const expectedRawExecutableSha256 = 'ae9587376b1d5febf83f558b87ed876cdd4bdcc9ad877f257992287fb09d0b11';
const pinnedVerifierVersion = 'solana-verify 0.5.2';
const pinnedBuildImage = 'solanafoundation/solana-verifiable-build:1.18.16';
const pinnedBuildImageDigest = 'sha256:1388b6e423013b0a4a1b67b3481b1c35f5a13034af97d9059439d923c19f1c87';
const pinnedSdkIntegrity = 'sha512-5w+NmwHOzl96nI50R/fjSD6uFydRLNUquhoEmmWbGepS4D9DnQyF2TKcUBfTyxV3sgJt00ypBt7SXB3y8WOzUQ==';
// 2.1.2 is the source checkout's package version, but its published tarball
// omits the ESM entrypoint declared by package.json. Pin the compatible 2.1.4
// release, whose published Node ESM bundle is present.
const pinnedSdkVersion = '2.1.4';
const devnetRpc = process.env.SQUADS_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const verifyBin = process.env.SOLANA_VERIFY_BIN ?? 'solana-verify';
const sourceDir = process.env.SQUADS_V4_SOURCE_DIR
  ? resolve(process.env.SQUADS_V4_SOURCE_DIR)
  : null;
const require = createRequire(import.meta.url);
let connection;
let submittedSignatures = [];

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function outputHash(output, description) {
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const hash = normalized.split(/\s+/).at(-1)?.replace(/[.,]$/, '');
  assert.ok(hash && /^[A-Fa-f0-9]{64}$/.test(hash),
    `${description} did not return a recognizable program hash: ${normalized}`);
  return hash;
}

function verifySquadsArtifact() {
  assert.ok(sourceDir,
    'Set SQUADS_V4_SOURCE_DIR to the official Squads v4 checkout built with its documented solana-verify command.');
  const actualRevision = capture('git', ['rev-parse', 'HEAD'], { cwd: sourceDir });
  assert.equal(actualRevision, pinnedSourceRevision,
    `Squads source must be pinned at ${pinnedSourceRevision}`);
  const origin = capture('git', ['remote', 'get-url', 'origin'], { cwd: sourceDir });
  assert.equal(origin, 'https://github.com/Squads-Protocol/v4.git',
    'Squads source must come from the official GitHub repository');
  const dirtyFiles = capture('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: sourceDir });
  assert.equal(dirtyFiles, '', 'Squads source checkout must be clean before using its build artifact');

  const sourceReadme = readFileSync(join(sourceDir, 'README.md'), 'utf8');
  assert.match(sourceReadme, /anchor build[\s\S]*solana-verify get-executable-hash target\/deploy\/multisig\.so[\s\S]*solana-verify get-program-hash/,
    'Squads checkout must document Anchor compilation and local/on-chain executable hash verification');
  const anchorToml = readFileSync(join(sourceDir, 'Anchor.toml'), 'utf8');
  const anchorProgramId = anchorToml.match(/^\s*multisig\s*=\s*"([^"]+)"/m)?.[1];
  const sourceProgramId = readFileSync(join(sourceDir, 'programs/squads_multisig_program/src/lib.rs'), 'utf8')
    .match(/declare_id!\("([^"]+)"\)/)?.[1];
  assert.equal(anchorProgramId, squadsProgramId.toBase58(), 'Squads Anchor config must target the canonical program ID');
  assert.equal(sourceProgramId, squadsProgramId.toBase58(), 'Squads source must declare the canonical program ID');
  assert.equal(squads.PROGRAM_ADDRESS, squadsProgramId.toBase58(), 'Pinned Squads SDK must target the canonical program ID');

  const sdkPackage = JSON.parse(readFileSync(require.resolve('@sqds/multisig/package.json'), 'utf8'));
  assert.equal(sdkPackage.version, pinnedSdkVersion,
    `@sqds/multisig must be pinned at ${pinnedSdkVersion}`);
  const lockfile = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  const sdkLock = lockfile.packages?.['node_modules/@sqds/multisig'];
  assert.equal(sdkLock?.version, pinnedSdkVersion, 'package-lock.json must pin the Squads SDK version');
  assert.equal(sdkLock?.integrity, pinnedSdkIntegrity, 'package-lock.json must pin the Squads SDK tarball integrity');

  const executable = join(sourceDir, 'target/deploy/squads_multisig_program.so');
  assert.ok(existsSync(executable),
    `Build the pinned Squads source with the official solana-verify procedure first: ${executable}`);
  const verifierVersion = capture(verifyBin, ['--version']);
  assert.equal(verifierVersion, pinnedVerifierVersion, `Squads artifact verifier must be ${pinnedVerifierVersion}`);
  const localHash = outputHash(capture(verifyBin, ['get-executable-hash', executable]), 'Local executable');
  assert.equal(localHash, expectedLocalExecutableHash,
    `Squads local artifact must match the recorded official build hash ${expectedLocalExecutableHash}`);
  const rawSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  assert.equal(rawSha256, expectedRawExecutableSha256,
    `Squads local artifact bytes must match the recorded raw SHA-256 ${expectedRawExecutableSha256}`);

  // Devnet identity is reported independently. A mismatch or unavailable RPC
  // cannot invalidate a local behavior run, but it does leave Devnet identity
  // unverified. Local source/build/hash/SDK/program identity checks above fail closed.
  let devnetIdentity;
  try {
    devnetIdentity = {
      status: 'observed',
      rpc: devnetRpc,
      executableHash: outputHash(capture(verifyBin, [
        'get-program-hash', '-u', devnetRpc, squadsProgramId.toBase58(),
      ]), 'Devnet executable'),
    };
  } catch (error) {
    devnetIdentity = {
      status: 'unavailable',
      rpc: devnetRpc,
      error: String(error?.message ?? error).slice(0, 500),
    };
  }

  return {
    sourceOrigin: origin,
    sourceRevision: actualRevision,
    sdkVersion: sdkPackage.version,
    sdkIntegrity: sdkLock.integrity,
    executable,
    executableHash: localHash,
    rawSha256,
    programIdentity: squadsProgramId.toBase58(),
    build: {
      procedure: 'anchor build; solana-verify build -b solanafoundation/solana-verifiable-build:1.18.16',
      image: pinnedBuildImage,
      imageDigest: pinnedBuildImageDigest,
      verifierVersion,
    },
    devnetIdentity: {
      ...devnetIdentity,
      matchesLocal: devnetIdentity.status === 'observed'
        ? devnetIdentity.executableHash === localHash
        : null,
      deploymentIdentityOnly: true,
    },
  };
}

function runBuild(command, args, env, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'inherit' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}

function u16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
}

function u32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function u64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(BigInt(value));
  return output;
}

function i64(value) {
  const output = Buffer.alloc(8);
  output.writeBigInt64LE(BigInt(value));
  return output;
}

function governanceDigest(action, proposalId, target, expectedVersion, vault, createdAt, applyAfter) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from('Katon governance action v1'),
    action,
    proposalId,
    new PublicKey(target).toBuffer(),
    u64(expectedVersion),
    new PublicKey(vault).toBuffer(),
    i64(createdAt),
    i64(applyAfter),
  ])).digest('hex');
}

function errorDetail(error) {
  return [error?.message, ...(error?.logs ?? []), error?.toString?.()]
    .filter(Boolean)
    .join('\n');
}

function firstTransactionSignature(rawTransaction) {
  const bytes = Buffer.from(rawTransaction);
  let signatureCount = 0;
  let cursor = 0;
  let shift = 0;
  while (true) {
    const byte = bytes[cursor++];
    assert.notEqual(byte, undefined, 'serialized transaction must include a signature count');
    signatureCount |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (signatureCount === 0) return null;
  assert.ok(bytes.length >= cursor + 64, 'serialized transaction must include its first signature');
  return bs58.encode(bytes.subarray(cursor, cursor + 64));
}

async function expectRejected(work, label, expectedError, evidence = {}) {
  const signatureStart = submittedSignatures.length;
  let caught;
  try {
    await work();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `${label} must reject`);
  const detail = errorDetail(caught);
  assert.match(detail, expectedError, `${label} rejected for an unexpected reason:\n${detail}`);
  const signatures = submittedSignatures.slice(signatureStart);
  const rejectedSignature = (caught.signature && caught.signature.length > 0 ? caught.signature : null)
    ?? signatures.at(-1)
    ?? null;
  assert.ok(rejectedSignature, `${label} must expose the rejected local transaction signature`);
  const expectedRejection = {
    label,
    signature: rejectedSignature,
    error: detail.split('\n').find(line => expectedError.test(line)) ?? detail.split('\n')[0],
    evidence,
  };
  if (connection) {
    const signatureStatus = await connection.getSignatureStatuses([rejectedSignature], { searchTransactionHistory: true });
    expectedRejection.signatureStatus = signatureStatus.value[0]?.err ?? 'not-landed-or-pruned';
  }
  failedChecks.push(expectedRejection);
  return expectedRejection;
}

const verifiedArtifact = verifySquadsArtifact();
const guardian = Keypair.generate();
const members = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const nonmember = Keypair.generate();
const createKey = Keypair.generate();
const multisigPda = squads.getMultisigPda({
  createKey: createKey.publicKey,
  programId: squadsProgramId,
})[0];
const vaultPda = squads.getVaultPda({ multisigPda, index: 0, programId: squadsProgramId })[0];
const configAuthority = Keypair.generate();
const treasury = Keypair.generate();
const successfulTransactions = [];
const failedChecks = [];
const accountObservations = [];
const assertionEvidence = [];
let surfnet;

const buildEnv = {
  ...process.env,
  NO_DNA: '1',
  SOLANA_SQUADS_VAULT_AUTHORITY: vaultPda.toBase58(),
  KATON_DEPLOYMENT_BUILD: '0',
};

try {
  // Only the source/build/SDK/program identity checks gate loading the local
  // Squads executable. Devnet executable identity is reported independently.
  runBuild('anchor', ['build', '--skip-lint'], buildEnv, contractDir);
  const { default: idl } = await import('../contracts/solana-rfq/target/idl/solana_rfq.json', {
    with: { type: 'json' },
  });

  surfnet = Surfnet.startWithConfig({ offline: true });
  surfnet.deploy({ programId: squadsProgramId.toBase58(), soPath: verifiedArtifact.executable });
  surfnet.deploy({
    programId: rfqProgramId.toBase58(),
    soPath: join(contractDir, 'target/deploy/solana_rfq.so'),
  });
  connection = new Connection(surfnet.rpcUrl, 'confirmed');
  const sendRawTransaction = connection.sendRawTransaction.bind(connection);
  connection.sendRawTransaction = async (rawTransaction, ...args) => {
    const signature = firstTransactionSignature(rawTransaction);
    if (signature) submittedSignatures.push(signature);
    return sendRawTransaction(rawTransaction, ...args);
  };

  for (const key of [guardian, ...members, nonmember, treasury]) {
    surfnet.fundSol(key.publicKey.toBase58(), 5_000_000_000);
  }
  surfnet.fundSol(vaultPda.toBase58(), 5_000_000_000);

  const programConfig = squads.getProgramConfigPda({ programId: squadsProgramId })[0];
  // The official executable's one-time ProgramConfigInit instruction is
  // restricted to Squads' hard-coded team initializer. Seed the already
  // initialized singleton as Surfnet genesis state; every multisig proposal
  // and RFQ governance action below still executes through the official .so.
  const programConfigBytes = Buffer.alloc(8 + 32 + 8 + 32 + 64);
  createHash('sha256').update('account:ProgramConfig').digest().subarray(0, 8).copy(programConfigBytes, 0);
  configAuthority.publicKey.toBuffer().copy(programConfigBytes, 8);
  programConfigBytes.writeBigUInt64LE(0n, 40);
  treasury.publicKey.toBuffer().copy(programConfigBytes, 48);
  surfnet.setAccount(
    programConfig.toBase58(),
    1_000_000_000,
    [...programConfigBytes],
    squadsProgramId.toBase58(),
  );

  const programConfigData = await squads.accounts.ProgramConfig.fromAccountAddress(connection, programConfig);
  assert.equal(programConfigData.authority.toBase58(), configAuthority.publicKey.toBase58());
  assert.equal(programConfigData.treasury.toBase58(), treasury.publicKey.toBase58());
  accountObservations.push({
    account: 'SquadsProgramConfig',
    label: 'surfnet-genesis-fixture-for-existing-global-config',
    address: programConfig.toBase58(),
    owner: squadsProgramId.toBase58(),
    accountDataLength: programConfigBytes.length,
    authority: programConfigData.authority.toBase58(),
    multisigCreationFee: Number(programConfigData.multisigCreationFee),
    treasury: programConfigData.treasury.toBase58(),
    fixtureReason: 'Squads source restricts ProgramConfigInit to its hard-coded one-time team key; governance proposals still execute through the official local program binary.',
  });
  const createMultisigSignature = await squads.rpc.multisigCreateV2({
    connection,
    treasury: programConfigData.treasury,
    creator: members[0],
    multisigPda,
    configAuthority: null,
    timeLock: 0,
    threshold: 2,
    members: members.map(key => ({ key: key.publicKey, permissions: squads.types.Permissions.all() })),
    createKey,
    rentCollector: null,
    programId: squadsProgramId,
  });
  await connection.confirmTransaction(createMultisigSignature, 'confirmed');
  successfulTransactions.push({ label: 'squads-create-2-of-3', signature: createMultisigSignature });

  const governance = PublicKey.findProgramAddressSync([Buffer.from('governance')], rfqProgramId)[0];
  const makerRegistry = PublicKey.findProgramAddressSync([Buffer.from('makers')], rfqProgramId)[0];
  const queuedAddress = proposalId => PublicKey.findProgramAddressSync(
    [Buffer.from('governance-action'), proposalId], rfqProgramId,
  )[0];
  const proposalAddress = (transactionIndex, multisig = multisigPda) => squads.getProposalPda({
    multisigPda: multisig,
    transactionIndex,
    programId: squadsProgramId,
  })[0];
  const instruction = (name, accounts, args = Buffer.alloc(0)) => {
    const definition = idl.instructions.find(item => item.name === name);
    assert.ok(definition, `IDL missing ${name}`);
    return new TransactionInstruction({
      programId: rfqProgramId,
      keys: definition.accounts.map(account => ({
        pubkey: accounts[account.name],
        isSigner: account.signer === true,
        isWritable: account.writable === true,
      })),
      data: Buffer.concat([Buffer.from(definition.discriminator), args]),
    });
  };
  const bootstrapInstruction = instruction('initialize_governance', {
    governance,
    squads_vault: vaultPda,
    system_program: SystemProgram.programId,
  }, Buffer.from(guardian.publicKey.toBytes()));

  const confirm = async (signature, label) => {
    const result = await connection.confirmTransaction(signature, 'confirmed');
    assert.equal(result.value.err, null, `${label} transaction ${signature} failed`);
    successfulTransactions.push({ label, signature });
  };

  async function observeGovernance(label) {
    const account = await connection.getAccountInfo(governance, 'confirmed');
    assert.ok(account, `${label}: governance account must exist`);
    const data = account.data;
    const state = {
      label,
      address: governance.toBase58(),
      owner: account.owner.toBase58(),
      squadsVault: new PublicKey(data.subarray(8, 40)).toBase58(),
      guardian: new PublicKey(data.subarray(40, 72)).toBase58(),
      programPaused: data.readUInt8(72) === 1,
      changeDelaySeconds: Number(data.readBigInt64LE(73)),
      governanceVersion: Number(data.readBigUInt64LE(81)),
      feeBps: data.readUInt16LE(89),
      maxFeeBps: data.readUInt16LE(91),
    };
    accountObservations.push({ account: 'GovernanceConfig', ...state });
    return state;
  }

  async function observeMakerRegistry(label) {
    const account = await connection.getAccountInfo(makerRegistry, 'confirmed');
    assert.ok(account, `${label}: maker registry account must exist`);
    const data = account.data;
    const count = data.readUInt32LE(8);
    const state = {
      label,
      address: makerRegistry.toBase58(),
      owner: account.owner.toBase58(),
      allowlisted: Array.from({ length: count }, (_, index) =>
        new PublicKey(data.subarray(12 + index * 32, 44 + index * 32)).toBase58()),
      paused: data.readUInt8(12 + count * 32) === 1,
      registryVersion: Number(data.readBigUInt64LE(13 + count * 32)),
    };
    accountObservations.push({ account: 'MakerRegistry', ...state });
    return state;
  }

  async function observeQueuedAction(label, proposalId) {
    const address = queuedAddress(proposalId);
    const account = await connection.getAccountInfo(address, 'confirmed');
    if (!account) {
      const state = { label, address: address.toBase58(), exists: false };
      accountObservations.push({ account: 'QueuedGovernanceAction', ...state });
      return state;
    }
    const data = account.data;
    const state = {
      label,
      address: address.toBase58(),
      exists: true,
      owner: account.owner.toBase58(),
      proposalId: data.subarray(8, 40).toString('hex'),
      payloadHash: data.subarray(40, 72).toString('hex'),
      target: new PublicKey(data.subarray(72, 104)).toBase58(),
      expectedVersion: Number(data.readBigUInt64LE(104)),
      proposingVault: new PublicKey(data.subarray(112, 144)).toBase58(),
      createdAt: Number(data.readBigInt64LE(144)),
      applyAfter: Number(data.readBigInt64LE(152)),
    };
    accountObservations.push({ account: 'QueuedGovernanceAction', ...state });
    return state;
  }

  async function observeProposal(label, transactionIndex, multisig = multisigPda) {
    const address = proposalAddress(transactionIndex, multisig);
    const proposal = await squads.accounts.Proposal.fromAccountAddress(connection, address);
    const state = {
      label,
      address: address.toBase58(),
      transactionIndex: transactionIndex.toString(),
      status: proposal.status.__kind,
      approvedMembers: proposal.approved.map(key => key.toBase58()),
    };
    accountObservations.push({ account: 'SquadsProposal', ...state });
    return state;
  }

  function recordAssertion(label, evidence) {
    assertionEvidence.push({ label, ...evidence });
  }

  async function createVaultProposal(label, innerInstruction, multisig = multisigPda, vault = vaultPda) {
    const multisigAccount = await squads.accounts.Multisig.fromAccountAddress(connection, multisig);
    const transactionIndex = squads.utils.toBigInt(multisigAccount.transactionIndex) + 1n;
    const message = new TransactionMessage({
      payerKey: vault,
      recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
      instructions: [innerInstruction],
    });
    const transactionSignature = await squads.rpc.vaultTransactionCreate({
      connection,
      feePayer: members[0],
      multisigPda: multisig,
      transactionIndex,
      creator: members[0].publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      programId: squadsProgramId,
    });
    await confirm(transactionSignature, `${label}-vault-transaction-create`);
    const proposalSignature = await squads.rpc.proposalCreate({
      connection,
      feePayer: members[0],
      creator: members[0],
      multisigPda: multisig,
      transactionIndex,
      programId: squadsProgramId,
    });
    await confirm(proposalSignature, `${label}-proposal-create`);
    return transactionIndex;
  }

  async function approveProposal(label, transactionIndex, member, multisig = multisigPda) {
    const signature = await squads.rpc.proposalApprove({
      connection,
      feePayer: member,
      member,
      multisigPda: multisig,
      transactionIndex,
      programId: squadsProgramId,
    });
    await confirm(signature, `${label}-approve-${member.publicKey.toBase58()}`);
  }

  async function executeProposal(label, transactionIndex, feePayer, member = feePayer, multisig = multisigPda) {
    const signature = await squads.rpc.vaultTransactionExecute({
      connection,
      feePayer,
      multisigPda: multisig,
      transactionIndex,
      member: member.publicKey,
      signers: [member],
      programId: squadsProgramId,
    });
    await confirm(signature, `${label}-execute`);
  }

  async function invokeDirect(label, innerInstruction, signer) {
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(innerInstruction),
      [signer],
      { commitment: 'confirmed' },
    );
    successfulTransactions.push({ label, signature });
    return signature;
  }

  const bootstrapIndex = await createVaultProposal('bootstrap', bootstrapInstruction);
  const initialMultisig = await squads.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  assert.equal(initialMultisig.threshold, 2, 'the real Squads multisig threshold must be two');
  assert.equal(initialMultisig.members.length, 3, 'the real Squads multisig must have three members');
  recordAssertion('real-squads-multisig-is-2-of-3', {
    passed: true,
    multisig: multisigPda.toBase58(),
    threshold: initialMultisig.threshold,
    members: initialMultisig.members.map(member => member.key.toBase58()),
    vault: vaultPda.toBase58(),
    bootstrapTransactionIndex: bootstrapIndex.toString(),
  });
  await approveProposal('bootstrap', bootstrapIndex, members[0]);
  const bootstrapAfterOneApproval = await observeProposal('bootstrap-after-one-approval', bootstrapIndex);
  assert.equal(bootstrapAfterOneApproval.status, 'Active');
  assert.equal(bootstrapAfterOneApproval.approvedMembers.length, 1);
  await expectRejected(
    () => executeProposal('bootstrap-one-approval', bootstrapIndex, members[0]),
    'one member approval cannot execute the bootstrap proposal',
    /InvalidProposalStatus/,
    { proposal: bootstrapAfterOneApproval },
  );
  const bootstrapStillActive = await observeProposal('bootstrap-after-one-approval-rejection', bootstrapIndex);
  assert.equal(bootstrapStillActive.status, 'Active', 'one-approval rejection leaves proposal active');
  await approveProposal('bootstrap', bootstrapIndex, members[1]);
  const bootstrapAfterTwoApprovals = await observeProposal('bootstrap-after-two-approvals', bootstrapIndex);
  assert.equal(bootstrapAfterTwoApprovals.status, 'Approved');
  assert.equal(bootstrapAfterTwoApprovals.approvedMembers.length, 2);
  await expectRejected(
    () => executeProposal('bootstrap-nonmember', bootstrapIndex, nonmember),
    'a nonmember cannot execute an approved bootstrap proposal',
    /NotAMember/,
    { proposal: bootstrapAfterTwoApprovals, attemptedMember: nonmember.publicKey.toBase58() },
  );
  const bootstrapStillApproved = await observeProposal('bootstrap-after-nonmember-rejection', bootstrapIndex);
  assert.equal(bootstrapStillApproved.status, 'Approved', 'nonmember rejection leaves proposal approved');
  await executeProposal('bootstrap-two-approvals', bootstrapIndex, members[2]);
  const bootstrapExecuted = await observeProposal('bootstrap-after-vault-execution', bootstrapIndex);
  assert.equal(bootstrapExecuted.status, 'Executed', 'two-of-three Squads approvals execute bootstrap');

  const initialGovernance = await observeGovernance('governance-after-squads-vault-bootstrap');
  assert.equal(initialGovernance.squadsVault, vaultPda.toBase58(), 'bootstrap records the Squads vault PDA');
  assert.equal(initialGovernance.guardian, guardian.publicKey.toBase58());
  assert.equal(initialGovernance.programPaused, false, 'program begins unpaused');
  assert.equal(initialGovernance.changeDelaySeconds, 86_400, 'RFQ delay is 24 hours');
  recordAssertion('squads-vault-pda-signed-bootstrap-without-delay', {
    passed: true,
    proposal: bootstrapExecuted,
    governance: initialGovernance,
    localSignature: successfulTransactions.find(item => item.label === 'bootstrap-execute')?.signature,
  });

  let governanceAccount = await connection.getAccountInfo(governance, 'confirmed');

  async function executeBySquads(label, innerInstruction, multisig = multisigPda, vault = vaultPda) {
    const index = await createVaultProposal(label, innerInstruction, multisig, vault);
    await approveProposal(label, index, members[0], multisig);
    await approveProposal(label, index, members[1], multisig);
    await executeProposal(label, index, members[2], members[2], multisig);
    return index;
  }

  const makerRegistryInit = instruction('initialize_maker_registry', {
    governance,
    squads_vault: vaultPda,
    maker_registry: makerRegistry,
    system_program: SystemProgram.programId,
  }, u32(0));
  await executeBySquads('initialize-maker-registry', makerRegistryInit);

  let proposalCounter = 1;
  const nextProposalId = () => Buffer.alloc(32, proposalCounter++);
  const economicsAction = (feeBps = 12) => Buffer.concat([
    Buffer.from([2]),
    u16(feeBps), u16(25), i64(29), u64(1_000_000),
  ]);
  const queue = (proposalId, target, action, expectedVersion, signerVault = vaultPda) => instruction('queue_governance_action', {
    governance,
    squads_vault: signerVault,
    target,
    queued_change: queuedAddress(proposalId),
    system_program: SystemProgram.programId,
  }, Buffer.concat([proposalId, action, u64(expectedVersion)]));
  const queuedInstruction = (name, proposalId, target = governance, signerVault = vaultPda) => instruction(name, {
    governance,
    squads_vault: signerVault,
    target,
    queued_change: queuedAddress(proposalId),
  });

  const appliedProposal = nextProposalId();
  const staleProposal = nextProposalId();
  const makersProposal = nextProposalId();
  await executeBySquads('queue-economics', queue(appliedProposal, governance, economicsAction(12), 1));
  await executeBySquads('queue-stale-economics', queue(staleProposal, governance, economicsAction(13), 1));
  const makersAction = Buffer.concat([
    Buffer.from([1]), u32(1), members[0].publicKey.toBuffer(), Buffer.from([0]),
  ]);
  await executeBySquads('queue-maker-policy', queue(makersProposal, makerRegistry, makersAction, 1));

  const governanceBeforeStaleQueue = await observeGovernance('governance-before-stale-queue-rejection');
  const staleQueueProposalId = nextProposalId();
  const staleQueueIndex = await createVaultProposal(
    'queue-stale-version',
    queue(staleQueueProposalId, governance, economicsAction(14), 2),
  );
  await approveProposal('queue-stale-version', staleQueueIndex, members[0]);
  await approveProposal('queue-stale-version', staleQueueIndex, members[1]);
  await expectRejected(
    () => executeProposal('queue-stale-version', staleQueueIndex, members[2]),
    'a queue instruction with a stale expected version is rejected',
    /RegistryVersionNotIncreasing/,
    { governance: governanceBeforeStaleQueue, proposalId: staleQueueProposalId.toString('hex') },
  );
  const staleQueueSquadsProposal = await observeProposal('stale-queue-after-rejection', staleQueueIndex);
  const staleQueueAccount = await observeQueuedAction('stale-queue-account-after-rejection', staleQueueProposalId);
  assert.equal(staleQueueSquadsProposal.status, 'Approved');
  assert.equal(staleQueueAccount.exists, false, 'a stale queue rejection must not create an action account');
  recordAssertion('stale-expected-version-cannot-be-queued', {
    passed: true,
    expectedError: failedChecks.at(-1).error,
    rejectionSignature: failedChecks.at(-1).signature,
    proposal: staleQueueSquadsProposal,
    queuedAction: staleQueueAccount,
    governance: governanceBeforeStaleQueue,
  });

  const appliedQueuedAction = await observeQueuedAction('economics-action-before-delay', appliedProposal);
  assert.equal(appliedQueuedAction.exists, true, 'Squads queue execution persists the RFQ action');
  assert.equal(appliedQueuedAction.target, governance.toBase58());
  assert.equal(appliedQueuedAction.expectedVersion, 1);
  assert.equal(appliedQueuedAction.proposingVault, vaultPda.toBase58());
  assert.equal(appliedQueuedAction.applyAfter - appliedQueuedAction.createdAt, 86_400);
  assert.equal(appliedQueuedAction.payloadHash, governanceDigest(
    economicsAction(12), appliedProposal, governance, 1, vaultPda,
    appliedQueuedAction.createdAt, appliedQueuedAction.applyAfter,
  ), 'queued action hash commits to its payload, target, version, vault, and delay timestamps');
  const applyAfter = appliedQueuedAction.applyAfter;
  recordAssertion('queued-change-hash-target-version-and-delay', {
    passed: true,
    queuedAction: appliedQueuedAction,
    payloadHashVerified: true,
  });

  const earlyApplyIndex = await createVaultProposal(
    'apply-economics-before-delay',
    queuedInstruction('apply_governance_action', appliedProposal),
  );
  await approveProposal('apply-economics-before-delay', earlyApplyIndex, members[0]);
  await approveProposal('apply-economics-before-delay', earlyApplyIndex, members[1]);
  const governanceBeforeEarlyApply = await observeGovernance('governance-before-early-apply-rejection');
  await expectRejected(
    () => executeProposal('apply-economics-before-delay', earlyApplyIndex, members[2]),
    'RFQ rejects a Squads-approved apply before the 24-hour delay',
    /GovernanceDelayActive/,
    { queuedAction: appliedQueuedAction, governance: governanceBeforeEarlyApply },
  );
  const earlyApplyProposal = await observeProposal('early-apply-after-delay-rejection', earlyApplyIndex);
  const queueAfterEarlyApply = await observeQueuedAction('queued-action-after-early-apply-rejection', appliedProposal);
  assert.equal(earlyApplyProposal.status, 'Approved', 'early apply rejection leaves the Squads proposal approved');
  assert.equal(queueAfterEarlyApply.payloadHash, appliedQueuedAction.payloadHash);
  assert.equal(queueAfterEarlyApply.applyAfter, appliedQueuedAction.applyAfter);

  surfnet.timeTravelToTimestamp((Number(applyAfter) + 1) * 1_000);
  const clockAccount = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  assert.ok(clockAccount, 'validator clock sysvar must be available');
  const chainTime = Number(clockAccount.data.readBigInt64LE(32));
  const applySlot = await connection.getSlot('confirmed');
  assert.ok(chainTime >= Number(applyAfter),
    `validator clock ${chainTime} must reach apply_after ${applyAfter} at slot ${applySlot}`);

  await executeProposal('apply-economics-after-delay', earlyApplyIndex, members[2]);
  const economicsAppliedGovernance = await observeGovernance('governance-after-delayed-economics-apply');
  assert.equal(economicsAppliedGovernance.feeBps, 12,
    'delayed Squads apply updates RFQ economics');
  assert.equal(economicsAppliedGovernance.governanceVersion, 2,
    'delayed Squads apply advances RFQ governance version');
  recordAssertion('early-apply-rejected-and-delayed-apply-succeeded', {
    passed: true,
    queuedAction: appliedQueuedAction,
    earlyApplyRejection: failedChecks.find(item => item.label === 'RFQ rejects a Squads-approved apply before the 24-hour delay'),
    earlyApplyProposal,
    clockAtSuccessfulApply: { unixTimestamp: chainTime, slot: applySlot },
    applyAfter,
    successSignature: successfulTransactions.find(item => item.label === 'apply-economics-after-delay-execute')?.signature,
    governanceAfterApply: economicsAppliedGovernance,
  });

  await executeBySquads(
    'apply-maker-policy-after-delay',
    queuedInstruction('apply_governance_action', makersProposal, makerRegistry),
  );
  const makerRegistryAfterApply = await observeMakerRegistry('maker-registry-after-delayed-apply');
  assert.deepEqual(makerRegistryAfterApply.allowlisted, [members[0].publicKey.toBase58()],
    'maker policy applies the queued allowlisted identity');
  assert.equal(makerRegistryAfterApply.paused, false, 'maker policy pause state is applied');
  assert.equal(makerRegistryAfterApply.registryVersion, 2,
    'delayed maker policy apply advances its registry version');
  recordAssertion('delayed-maker-policy-apply-succeeded', {
    passed: true,
    makerRegistry: makerRegistryAfterApply,
    successSignature: successfulTransactions.find(item => item.label === 'apply-maker-policy-after-delay-execute')?.signature,
  });

  const staleApplyIndex = await createVaultProposal(
    'apply-stale-version',
    queuedInstruction('apply_governance_action', staleProposal),
  );
  await approveProposal('apply-stale-version', staleApplyIndex, members[0]);
  await approveProposal('apply-stale-version', staleApplyIndex, members[1]);
  const staleQueuedBeforeApply = await observeQueuedAction('stale-action-before-stale-apply', staleProposal);
  const governanceBeforeStaleApply = await observeGovernance('governance-before-stale-apply-rejection');
  await expectRejected(
    () => executeProposal('apply-stale-version', staleApplyIndex, members[2]),
    'a queued action becomes stale after the previous governance apply',
    /RegistryVersionNotIncreasing/,
    { queuedAction: staleQueuedBeforeApply, governance: governanceBeforeStaleApply },
  );
  const staleApplyProposal = await observeProposal('stale-apply-after-rejection', staleApplyIndex);
  assert.equal(staleApplyProposal.status, 'Approved');
  recordAssertion('stale-queued-action-cannot-apply', {
    passed: true,
    expectedError: failedChecks.at(-1).error,
    rejectionSignature: failedChecks.at(-1).signature,
    queuedAction: staleQueuedBeforeApply,
    governance: governanceBeforeStaleApply,
    proposal: staleApplyProposal,
  });

  const memberAttemptId = nextProposalId();
  const governanceBeforeMemberAttempt = await observeGovernance('governance-before-direct-member-attempt');
  const memberDirectFailure = await expectRejected(
    () => invokeDirect(
      'member-direct-queue-attempt',
      queue(memberAttemptId, governance, economicsAction(14), 2, members[0].publicKey),
      members[0],
    ),
    'a Squads member key cannot directly act as the RFQ governance signer',
    /ConstraintAddress/,
    { caller: members[0].publicKey.toBase58(), governance: governanceBeforeMemberAttempt },
  );
  const memberAttemptAccount = await observeQueuedAction('member-direct-queue-account-after-rejection', memberAttemptId);
  assert.equal(memberAttemptAccount.exists, false);
  recordAssertion('individual-squads-member-key-rejected-as-governance-signer', {
    passed: true,
    expectedError: memberDirectFailure.error,
    rejectionSignature: memberDirectFailure.signature,
    queuedAction: memberAttemptAccount,
    governance: governanceBeforeMemberAttempt,
  });

  const otherCreateKey = Keypair.generate();
  const otherMultisig = squads.getMultisigPda({ createKey: otherCreateKey.publicKey, programId: squadsProgramId })[0];
  const otherVault = squads.getVaultPda({ multisigPda: otherMultisig, index: 0, programId: squadsProgramId })[0];
  surfnet.fundSol(otherVault.toBase58(), 5_000_000_000);
  const otherMultisigSignature = await squads.rpc.multisigCreateV2({
    connection,
    treasury: programConfigData.treasury,
    creator: members[0],
    multisigPda: otherMultisig,
    configAuthority: null,
    timeLock: 0,
    threshold: 2,
    members: members.map(key => ({ key: key.publicKey, permissions: squads.types.Permissions.all() })),
    createKey: otherCreateKey,
    rentCollector: null,
    programId: squadsProgramId,
  });
  await confirm(otherMultisigSignature, 'create-unrelated-squads-multisig');
  const otherVaultAttemptId = nextProposalId();
  const otherVaultAttemptIndex = await createVaultProposal(
    'unrelated-vault-direct-governance-attempt',
    queue(otherVaultAttemptId, governance, economicsAction(14), 2, otherVault),
    otherMultisig,
    otherVault,
  );
  await approveProposal('unrelated-vault-direct-governance-attempt', otherVaultAttemptIndex, members[0], otherMultisig);
  await approveProposal('unrelated-vault-direct-governance-attempt', otherVaultAttemptIndex, members[1], otherMultisig);
  const otherVaultRejection = await expectRejected(
    () => executeProposal(
      'unrelated-vault-direct-governance-attempt', otherVaultAttemptIndex, members[2], members[2], otherMultisig,
    ),
    'an unrelated Squads vault PDA cannot act as the configured RFQ governance signer',
    /ConstraintAddress/,
    { attemptedVault: otherVault.toBase58(), configuredVault: vaultPda.toBase58() },
  );
  const otherVaultProposalAfter = await observeProposal(
    'unrelated-vault-proposal-after-rfq-rejection', otherVaultAttemptIndex, otherMultisig,
  );
  const otherVaultQueuedAccount = await observeQueuedAction('unrelated-vault-queue-after-rejection', otherVaultAttemptId);
  assert.equal(otherVaultProposalAfter.status, 'Approved');
  assert.equal(otherVaultQueuedAccount.exists, false);
  recordAssertion('unrelated-pda-cannot-act-as-governance-signer', {
    passed: true,
    expectedError: otherVaultRejection.error,
    rejectionSignature: otherVaultRejection.signature,
    unrelatedVault: otherVault.toBase58(),
    configuredVault: vaultPda.toBase58(),
    proposal: otherVaultProposalAfter,
    queuedAction: otherVaultQueuedAccount,
  });

  await executeBySquads('cancel-stale-version', queuedInstruction('cancel_governance_action', staleProposal));
  const staleCancelledAction = await observeQueuedAction('stale-action-after-squads-cancel', staleProposal);
  assert.equal(staleCancelledAction.exists, false,
    'Squads vault cancellation closes the stale queued action');
  recordAssertion('stale-queued-action-cancelled-by-squads', {
    passed: true,
    cancellationSignature: successfulTransactions.find(item => item.label === 'cancel-stale-version-execute')?.signature,
    queuedAction: staleCancelledAction,
  });

  const cancelledProposal = nextProposalId();
  await executeBySquads('queue-to-cancel', queue(cancelledProposal, governance, economicsAction(14), 2));
  const queuedForCancellation = await observeQueuedAction('action-before-immediate-squads-cancel', cancelledProposal);
  const cancelClockAccount = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  const cancelClock = Number(cancelClockAccount.data.readBigInt64LE(32));
  assert.ok(cancelClock < queuedForCancellation.applyAfter,
    'cancellation succeeds while the action is still inside its delay window');

  const guardianQueueId = nextProposalId();
  const governanceBeforeGuardianAttempts = await observeGovernance('governance-before-guardian-admin-attempts');
  const guardianQueueFailure = await expectRejected(
    () => invokeDirect(
      'guardian-direct-queue-attempt',
      queue(guardianQueueId, governance, economicsAction(14), 2, guardian.publicKey),
      guardian,
    ),
    'the Guardian cannot queue a non-pause governance action',
    /ConstraintAddress/,
    { guardian: guardian.publicKey.toBase58(), governance: governanceBeforeGuardianAttempts },
  );
  const guardianQueueAccount = await observeQueuedAction('guardian-queue-after-rejection', guardianQueueId);
  assert.equal(guardianQueueAccount.exists, false);

  const guardianApplyFailure = await expectRejected(
    () => invokeDirect(
      'guardian-direct-apply-attempt',
      queuedInstruction('apply_governance_action', cancelledProposal, governance, guardian.publicKey),
      guardian,
    ),
    'the Guardian cannot apply a queued non-pause governance action',
    /ConstraintAddress/,
    { guardian: guardian.publicKey.toBase58(), queuedAction: queuedForCancellation },
  );
  const guardianCancelFailure = await expectRejected(
    () => invokeDirect(
      'guardian-direct-cancel-attempt',
      queuedInstruction('cancel_governance_action', cancelledProposal, governance, guardian.publicKey),
      guardian,
    ),
    'the Guardian cannot cancel a queued governance action',
    /ConstraintAddress/,
    { guardian: guardian.publicKey.toBase58(), queuedAction: queuedForCancellation },
  );
  const queuedAfterGuardianAttempts = await observeQueuedAction('queued-action-after-guardian-attempts', cancelledProposal);
  assert.equal(queuedAfterGuardianAttempts.exists, true);
  assert.equal(queuedAfterGuardianAttempts.payloadHash, queuedForCancellation.payloadHash);
  recordAssertion('guardian-cannot-queue-apply-or-cancel-governance', {
    passed: true,
    rejectionSignatures: [guardianQueueFailure.signature, guardianApplyFailure.signature, guardianCancelFailure.signature],
    expectedErrors: [guardianQueueFailure.error, guardianApplyFailure.error, guardianCancelFailure.error],
    queuedActionBefore: queuedForCancellation,
    queuedActionAfter: queuedAfterGuardianAttempts,
    governance: governanceBeforeGuardianAttempts,
  });

  await executeBySquads('cancel-queued-action', queuedInstruction('cancel_governance_action', cancelledProposal));
  const cancelledAction = await observeQueuedAction('queued-action-after-squads-cancel', cancelledProposal);
  assert.equal(cancelledAction.exists, false,
    'Squads queue and cancel remain separate explicit actions');
  recordAssertion('squads-can-cancel-before-24-hour-apply-time', {
    passed: true,
    queuedAction: queuedForCancellation,
    clockBeforeCancellation: cancelClock,
    cancellationSignature: successfulTransactions.find(item => item.label === 'cancel-queued-action-execute')?.signature,
    resultingAccount: cancelledAction,
  });

  const governanceBeforeGuardianPause = await observeGovernance('governance-before-guardian-pause');
  const guardianPauseSignature = await invokeDirect(
    'guardian-pause-program',
    instruction('guardian_pause_program', { governance, guardian: guardian.publicKey }),
    guardian,
  );
  const governanceAfterGuardianPause = await observeGovernance('governance-after-guardian-pause');
  assert.equal(governanceBeforeGuardianPause.programPaused, false);
  assert.equal(governanceAfterGuardianPause.programPaused, true,
    'configured Guardian can pause the program');
  assert.equal(governanceAfterGuardianPause.squadsVault, vaultPda.toBase58(),
    'Guardian pause leaves the configured Squads vault unchanged');
  recordAssertion('guardian-has-pause-only-authority', {
    passed: true,
    pauseSignature: guardianPauseSignature,
    governanceBefore: governanceBeforeGuardianPause,
    governanceAfter: governanceAfterGuardianPause,
    prohibitedActions: [guardianQueueFailure, guardianApplyFailure, guardianCancelFailure],
  });

  console.log(JSON.stringify({
    scenario: 'verified Squads v4 2-of-3 local Surfnet governance',
    provenance: verifiedArtifact,
    squadsProgramId: squadsProgramId.toBase58(),
    rfqProgramId: rfqProgramId.toBase58(),
    multisig: multisigPda.toBase58(),
    vault: vaultPda.toBase58(),
    accountObservations,
    assertions: assertionEvidence,
    localTransactions: successfulTransactions,
    expectedRejections: failedChecks,
  }, null, 2));

  const evidencePath = resolve(process.env.SQUADS_GOVERNANCE_EVIDENCE_PATH
    ?? join(repo, 'docs/ai/testing/evidence/2026-09-23-ticket14-squads-local.json'));
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify({
    scenario: 'verified Squads v4 2-of-3 local Surfnet governance',
    recordedAt: new Date().toISOString(),
    provenance: verifiedArtifact,
    squadsProgramId: squadsProgramId.toBase58(),
    rfqProgramId: rfqProgramId.toBase58(),
    multisig: multisigPda.toBase58(),
    vault: vaultPda.toBase58(),
    accountObservations,
    assertions: assertionEvidence,
    localTransactions: successfulTransactions,
    expectedRejections: failedChecks,
  }, null, 2)}\n`);
  console.log(`governance evidence: ${evidencePath}`);
  console.log('validator Squads v4 2-of-3 local behavior: vault-PDA bootstrap, threshold and membership rejection, delayed apply, early-apply rejection, cancellation, stale-version rejection, and Guardian pause-only authority passed; Devnet executable identity is recorded separately');
} finally {
  await delay(750);
  surfnet?.stop();
}

import process from 'node:process';

import { InMemoryBaseRepository, InMemoryNotificationPort, InMemorySignatureVerificationPort } from '../apps/base-api/src/memory.ts';
import { startBaseApi } from '../apps/base-api/src/server.ts';

let app;

function send(message) {
  if (typeof process.send === 'function') process.send(message);
}

async function closeAndExit(code) {
  try { await app?.close(); } finally { process.exit(code); }
}

try {
  const deterministic = process.env.KATON_BASE_SOAK_FIXTURE === 'true';
  const overrides = deterministic
    ? {
      repository: new InMemoryBaseRepository(),
      signatures: new InMemorySignatureVerificationPort(),
      notifications: new InMemoryNotificationPort(),
      swapPreflight: deterministicPreflight(),
    }
    : {};
  app = await startBaseApi(overrides);
  send({ type: 'ready' });
} catch (error) {
  send({ type: 'error', reason: error instanceof Error ? error.message : String(error) });
  console.error(`base-api-soak-child=FAIL reason=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

process.on('message', async (message) => {
  if (message?.type === 'heap' && app) {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    send({
      type: 'heap',
      id: message.id,
      heapUsedBytes: process.memoryUsage().heapUsed,
    });
  }
  if (message?.type === 'shutdown') await closeAndExit(0);
});

process.once('SIGTERM', () => { void closeAndExit(0); });
process.once('SIGINT', () => { void closeAndExit(0); });

function deterministicPreflight() {
  const snapshot = {
    decisionBlock: 100n,
    decisionBlockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    simulationBlock: 101n,
    simulationBlockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  return {
    async captureSnapshot() {
      return snapshot;
    },
    async simulateInternalRoute(input) {
      if (input.route.kind !== 'INTERNAL' || input.transaction.to.toLowerCase() !== process.env.KATON_BASE_ROUTER_ADDRESS?.toLowerCase()) {
        throw new Error('PREFLIGHT_SIMULATION_FAILED');
      }
      return { ...snapshot, allowanceTarget: input.allowanceTarget };
    },
  };
}

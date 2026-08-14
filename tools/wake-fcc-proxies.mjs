#!/usr/bin/env node

import { resolve } from 'node:path';
import { requireStableInfoUrls } from './validate-fcc-render.mjs';

export async function wakeFccProxies(urls, {
  timeoutMs = 90_000,
  intervalMs = 2_000,
  fetchImpl = fetch,
} = {}) {
  const targets = requireStableInfoUrls(urls);
  const started = Date.now();
  const proxies = targets.map((url) => ({ url, status: 0, attempts: 0, ok: false }));

  while (Date.now() - started <= timeoutMs) {
    await Promise.all(proxies.map(async (proxy) => {
      if (proxy.ok) return;
      proxy.attempts += 1;
      try {
        const response = await fetchImpl(proxy.url, { headers: { accept: 'application/json' } });
        proxy.status = response.status;
        proxy.ok = Boolean(response.ok);
        if (typeof response.text === 'function') await response.text();
      } catch {
        proxy.status = 0;
        proxy.ok = false;
      }
    }));
    if (proxies.every((proxy) => proxy.ok)) {
      return { ok: true, proxies };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('FCC_WAKE_TIMEOUT');
}

export function formatWakeResult(result) {
  const rows = result.proxies.map((proxy) => `${new URL(proxy.url).host}:http=${proxy.status}`).join(' ');
  return `fcc-wake=${result.ok ? 'PASS' : 'BLOCKED'} count=${result.proxies.length} ${rows}`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const urls = (process.env.FCC_PROXY_INFO_URLS ?? process.argv.slice(2).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    const result = await wakeFccProxies(urls);
    console.log(formatWakeResult(result));
  } catch (error) {
    console.error(`fcc-wake=BLOCKED reason=${error instanceof Error ? error.message : 'FCC_WAKE_FAILED'}`);
    process.exitCode = 1;
  }
}

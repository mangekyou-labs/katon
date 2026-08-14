#!/usr/bin/env node

import { resolve } from 'node:path';

const EPHEMERAL_HOST = /(trycloudflare\.com|localhost|127\.0\.0\.1)$/iu;
const PRIVATE_KEY_RE = /(?:PRIVATE_KEY|PROXY_PRIVATE_KEY)\s*[:=]\s*['"]?0x?[0-9a-fA-F]{64}/u;

export function requireStableInfoUrls(urls) {
  const cleaned = (urls ?? []).map((value) => String(value ?? '').trim()).filter(Boolean);
  if (cleaned.length !== 3) throw new Error('FCC_INFO_URL_COUNT');
  if (new Set(cleaned).size !== 3) throw new Error('FCC_INFO_URL_DUPLICATE');
  for (const url of cleaned) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('FCC_INFO_URL_INVALID');
    }
    if (parsed.protocol !== 'https:') throw new Error('FCC_PROXY_HTTPS_REQUIRED');
    if (!parsed.pathname.endsWith('/info')) throw new Error('FCC_INFO_PATH_REQUIRED');
    if (EPHEMERAL_HOST.test(parsed.hostname)) throw new Error('FCC_INFO_URL_EPHEMERAL');
  }
  return cleaned;
}

export function parseRenderBlueprint(yaml) {
  const text = String(yaml ?? '');
  const blocks = text.split(/\n(?= {2}- )/u).filter((block) => /^\s*-\s+type:/u.test(block) || /type:\s+\w+/u.test(block));
  const services = [];
  for (const block of blocks) {
    const type = block.match(/^\s*-?\s*type:\s*(\S+)/mu)?.[1];
    const name = block.match(/^\s*name:\s*(\S+)/mu)?.[1];
    const plan = block.match(/^\s*plan:\s*(\S+)/mu)?.[1];
    if (!type || !name) continue;
    services.push({ type, name, plan: plan ?? 'free' });
  }
  return {
    services,
    containsPrivateKey: PRIVATE_KEY_RE.test(text),
    simulatedTee: /SIMULATED_TEE[\s\S]{0,80}value:\s*["']?true["']?/u.test(text),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { readFileSync } = await import('node:fs');
  const { findWorktreeRoot } = await import('./load-worktree-env.mjs');
  const root = findWorktreeRoot();
  const yaml = readFileSync(resolve(root, 'render.yaml'), 'utf8');
  const blueprint = parseRenderBlueprint(yaml);
  if (blueprint.services.length !== 3) throw new Error('FCC_RENDER_SERVICE_COUNT');
  if (blueprint.containsPrivateKey) throw new Error('FCC_RENDER_SECRET_IN_GIT');
  if (!blueprint.simulatedTee) throw new Error('FCC_RENDER_SIMULATED_REQUIRED');
  const names = blueprint.services.map((service) => service.name);
  if (new Set(names).size !== 3) throw new Error('FCC_RENDER_DUPLICATE');
  console.log(JSON.stringify({ ok: true, services: blueprint.services, simulatedTee: true }, null, 2));
}

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseRenderBlueprint, requireStableInfoUrls } from '../tools/validate-fcc-render.mjs';
import { formatWakeResult, wakeFccProxies } from '../tools/wake-fcc-proxies.mjs';

const threeUrls = [
  'https://trustrfq-tee-a.onrender.com/info',
  'https://trustrfq-tee-b.onrender.com/info',
  'https://trustrfq-tee-c.onrender.com/info',
];

describe('FCC Render wake-first preflight', () => {
  it('requires exactly three distinct HTTPS /info URLs and rejects tunnels', () => {
    expect(() => requireStableInfoUrls(['https://a.onrender.com/info'])).toThrow('FCC_INFO_URL_COUNT');
    expect(() => requireStableInfoUrls([
      'https://a.onrender.com/info',
      'https://b.onrender.com/info',
      'http://c.onrender.com/info',
    ])).toThrow('FCC_PROXY_HTTPS_REQUIRED');
    expect(() => requireStableInfoUrls([
      'https://a.onrender.com/info',
      'https://b.onrender.com/info',
      'https://owned-painting-food-personality.trycloudflare.com/info',
    ])).toThrow('FCC_INFO_URL_EPHEMERAL');
    expect(requireStableInfoUrls(threeUrls)).toEqual(threeUrls);
  });

  it('wakes all three proxies before reporting ready and never prints bodies', async () => {
    const hits = new Map<string, number>();
    const result = await wakeFccProxies(threeUrls, {
      timeoutMs: 1_000,
      intervalMs: 1,
      fetchImpl: async (url) => {
        const key = String(url);
        hits.set(key, (hits.get(key) ?? 0) + 1);
        if ((hits.get(key) ?? 0) < 2) return { ok: false, status: 503, text: async () => 'SECRET_BODY' };
        return { ok: true, status: 200, text: async () => '{"teeInfo":{"publicKey":"SECRET_KEY"}}' };
      },
    });
    const output = formatWakeResult(result);
    expect(result.ok).toBe(true);
    expect(result.proxies).toHaveLength(3);
    expect(output).toContain('fcc-wake=PASS');
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('publicKey');
  });

  it('fails closed when a free-tier service stays cold', async () => {
    await expect(wakeFccProxies(threeUrls, {
      timeoutMs: 20,
      intervalMs: 5,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'cold' }),
    })).rejects.toThrow('FCC_WAKE_TIMEOUT');
  });

  it('keeps the Render blueprint at three isolated free web services without secrets', () => {
    const yaml = readFileSync(resolve(import.meta.dirname, '../render.yaml'), 'utf8');
    const blueprint = parseRenderBlueprint(yaml);
    expect(blueprint.services.map((service) => service.name)).toEqual([
      'trustrfq-tee-a',
      'trustrfq-tee-b',
      'trustrfq-tee-c',
    ]);
    expect(blueprint.services.every((service) => service.type === 'web' && service.plan === 'free')).toBe(true);
    expect(blueprint.containsPrivateKey).toBe(false);
    expect(blueprint.simulatedTee).toBe(true);
  });
});

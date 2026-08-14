import { resolve } from 'node:path';

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function summarizeProxyInfo(body) {
  const info = body?.teeInfo ?? body?.machineData ?? body ?? {};
  const policy = info.lastSigningPolicyId ?? body?.lastSigningPolicyId;
  return {
    teeId: asText(info.teeId ?? info.teeID),
    extensionId: asText(info.extensionId),
    lastSigningPolicyId: Number.isInteger(policy) || /^\d+$/u.test(String(policy)) ? Number(policy) : null,
  };
}

export async function fetchProxyInfo(url, { fetchImpl = fetch } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('FCC_PROXY_HTTPS_REQUIRED');
  let response;
  try {
    response = await fetchImpl(parsed, { headers: { accept: 'application/json' } });
  } catch {
    throw new Error('FCC_PROXY_UNREACHABLE');
  }
  if (!response.ok) throw new Error(`FCC_PROXY_HTTP_${response.status}`);
  return summarizeProxyInfo(await response.json());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const urls = (process.env.FCC_PROXY_INFO_URLS ?? process.argv.slice(2).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    console.error('fcc-proxy=BLOCKED reason=FCC_PROXY_INFO_URL_REQUIRED');
    process.exitCode = 1;
  } else {
    const expectedPolicy = process.env.FCC_EXPECTED_SIGNING_POLICY_ID
      ? Number(process.env.FCC_EXPECTED_SIGNING_POLICY_ID)
      : null;
    const results = [];
    for (const url of urls) {
      try {
        const info = await fetchProxyInfo(url);
        const current = expectedPolicy === null || info.lastSigningPolicyId === expectedPolicy;
        results.push({ url, ...info, policyCurrent: current });
        if (!current) process.exitCode = 1;
      } catch (error) {
        results.push({ url, error: error instanceof Error ? error.message : 'FCC_PROXY_PREFLIGHT_FAILED' });
        process.exitCode = 1;
      }
    }
    console.log(JSON.stringify({ ok: process.exitCode !== 1, expectedPolicy, proxies: results }, null, 2));
  }
}

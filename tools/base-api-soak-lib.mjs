import process from 'node:process';

const MIB = 1024 * 1024;

export const SOAK_LIMITS = Object.freeze({
  requiredDurationSeconds: 600,
  requiredConcurrency: 4,
  maxQuoteP95Ms: 1_500,
  maxRetainedGrowthBytes: 32 * MIB,
  maxHeapSlopeBytesPerMinute: 1 * MIB,
});

export const SOAK_DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:4010',
  path: '/v1/swaps/quote',
  durationSeconds: SOAK_LIMITS.requiredDurationSeconds,
  concurrency: SOAK_LIMITS.requiredConcurrency,
  requestTimeoutMs: 5_000,
  requestIntervalMs: 10,
});

function parsePositiveInteger(value, name) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`BASE_API_SOAK_CONFIG:${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`BASE_API_SOAK_CONFIG:${name}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`BASE_API_SOAK_CONFIG:${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`BASE_API_SOAK_CONFIG:${name}`);
  }
  return parsed;
}

function envValue(env, primary, legacy, fallback) {
  return env[primary] ?? (legacy ? env[legacy] : undefined) ?? fallback;
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    const hasUsername = Boolean(url.username);
    const hasPassword = Boolean(url.password);
    url.username = '';
    url.password = '';
    const serialized = url.toString();
    if (!hasUsername && !hasPassword) return serialized;
    const authority = `${hasUsername ? '[REDACTED]' : ''}${hasPassword ? ':[REDACTED]' : ''}@`;
    return serialized.replace(`${url.protocol}//`, `${url.protocol}//${authority}`);
  } catch {
    return '[REDACTED_URL]';
  }
}

export function parseSoakConfig(env = process.env) {
  const baseUrl = String(envValue(env, 'BASE_API_URL', 'BASE_QA_API_URL', SOAK_DEFAULTS.baseUrl));
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error('BASE_API_SOAK_CONFIG:BASE_API_URL');
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('BASE_API_SOAK_CONFIG:BASE_API_URL');
  }

  const path = String(envValue(env, 'BASE_API_PATH', 'BASE_SOAK_PATH', SOAK_DEFAULTS.path));
  if (!path.startsWith('/')) throw new Error('BASE_API_SOAK_CONFIG:BASE_API_PATH');

  const durationSeconds = parsePositiveInteger(
    envValue(env, 'BASE_API_SOAK_DURATION_SECONDS', 'BASE_SOAK_DURATION_SECONDS', SOAK_DEFAULTS.durationSeconds),
    'BASE_API_SOAK_DURATION_SECONDS',
  );
  const concurrency = parsePositiveInteger(
    envValue(env, 'BASE_API_SOAK_CONCURRENCY', 'BASE_SOAK_CONCURRENCY', SOAK_DEFAULTS.concurrency),
    'BASE_API_SOAK_CONCURRENCY',
  );
  const requestTimeoutMs = parsePositiveInteger(
    envValue(env, 'BASE_API_SOAK_REQUEST_TIMEOUT_MS', 'BASE_SOAK_REQUEST_TIMEOUT_MS', SOAK_DEFAULTS.requestTimeoutMs),
    'BASE_API_SOAK_REQUEST_TIMEOUT_MS',
  );
  const requestIntervalMs = parseNonNegativeInteger(
    envValue(env, 'BASE_API_SOAK_INTERVAL_MS', 'BASE_SOAK_INTERVAL_MS', SOAK_DEFAULTS.requestIntervalMs),
    'BASE_API_SOAK_INTERVAL_MS',
  );
  const externalValue = String(envValue(env, 'BASE_API_SOAK_EXTERNAL', undefined, 'false')).toLowerCase();
  if (!['true', 'false'].includes(externalValue)) throw new Error('BASE_API_SOAK_CONFIG:BASE_API_SOAK_EXTERNAL');
  let quoteBody;
  const quoteBodyValue = envValue(env, 'BASE_API_SOAK_QUOTE_BODY', undefined, undefined);
  if (quoteBodyValue !== undefined) {
    try {
      quoteBody = JSON.parse(String(quoteBodyValue));
    } catch {
      throw new Error('BASE_API_SOAK_CONFIG:BASE_API_SOAK_QUOTE_BODY');
    }
    if (!quoteBody || typeof quoteBody !== 'object' || Array.isArray(quoteBody)) throw new Error('BASE_API_SOAK_CONFIG:BASE_API_SOAK_QUOTE_BODY');
  }

  return {
    baseUrl,
    url: redactUrl(baseUrl),
    requestUrl: redactUrl(new URL(path, parsedBaseUrl).toString()),
    fetchUrl: new URL(path, parsedBaseUrl).toString(),
    path,
    durationSeconds,
    concurrency,
    requestTimeoutMs,
    requestIntervalMs,
    external: externalValue === 'true',
    sessionToken: envValue(env, 'BASE_API_SOAK_SESSION_TOKEN', undefined, undefined),
    privateKey: envValue(env, 'BASE_API_SOAK_PRIVATE_KEY', undefined, undefined),
    makerPrivateKey: envValue(env, 'BASE_API_SOAK_MAKER_PRIVATE_KEY', undefined, undefined),
    quoteBody,
  };
}

export function createSoakMetrics() {
  return {
    requests: 0,
    requestFailures: 0,
    schemaFailures: 0,
    failures: 0,
    firstFailure: '',
    heapSamples: [],
    quoteLatenciesMs: [],
  };
}

export function recordProbe(metrics, result) {
  metrics.requests += 1;
  if (!result.ok) metrics.requestFailures += 1;
  if (result.ok && !result.schemaValid) metrics.schemaFailures += 1;
  if (result.ok && Number.isFinite(result.latencyMs)) metrics.quoteLatenciesMs.push(result.latencyMs);
  metrics.failures = metrics.requestFailures + metrics.schemaFailures;
  if (!result.ok || !result.schemaValid) {
    const reason = result.error ? String(result.error) : (!result.ok ? 'REQUEST_FAILED' : 'SCHEMA_FAILED');
    if (!metrics.firstFailure) metrics.firstFailure = reason;
  }
  return metrics;
}

export function percentile(values, percentileValue) {
  const ordered = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (ordered.length === 0) return undefined;
  const rank = Math.min(ordered.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1));
  return ordered[rank];
}

export function calculateHeapMetrics(samples) {
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.elapsedMs) && Number.isFinite(sample.heapUsedBytes))
    .sort((left, right) => left.elapsedMs - right.elapsedMs);
  if (ordered.length === 0) {
    return { retainedGrowthBytes: 0, heapSlopeBytesPerMinute: 0 };
  }

  const first = ordered[0].heapUsedBytes;
  const last = ordered[ordered.length - 1].heapUsedBytes;
  const meanX = ordered.reduce((sum, sample) => sum + sample.elapsedMs, 0) / ordered.length;
  const meanY = ordered.reduce((sum, sample) => sum + sample.heapUsedBytes, 0) / ordered.length;
  const numerator = ordered.reduce(
    (sum, sample) => sum + (sample.elapsedMs - meanX) * (sample.heapUsedBytes - meanY),
    0,
  );
  const denominator = ordered.reduce(
    (sum, sample) => sum + (sample.elapsedMs - meanX) ** 2,
    0,
  );
  const heapSlopeBytesPerMinute = denominator === 0 ? 0 : (numerator / denominator) * 60_000;
  return {
    retainedGrowthBytes: last - first,
    heapSlopeBytesPerMinute,
  };
}

export function qualifySoak(input) {
  const reasons = [];
  if (input.durationSeconds !== SOAK_LIMITS.requiredDurationSeconds) reasons.push('DURATION_NOT_600_SECONDS');
  if (input.concurrency !== SOAK_LIMITS.requiredConcurrency) reasons.push('CONCURRENCY_NOT_4');
  if (input.elapsedSeconds < input.durationSeconds) reasons.push('ELAPSED_SHORT');
  if (input.requests <= 0) reasons.push('NO_REQUESTS');
  if (input.managedChild !== true) reasons.push('MANAGED_CHILD_REQUIRED');
  if ((input.heapSamples ?? 0) < 2) reasons.push('POST_GC_HEAP_SAMPLES_REQUIRED');
  if (input.requestFailures !== 0) reasons.push('REQUEST_FAILURES');
  if (input.schemaFailures !== 0) reasons.push('SCHEMA_FAILURES');
  if (input.quoteMode === true && input.quoteP95Ms === undefined) reasons.push('NO_QUOTE_LATENCY');
  if (input.quoteP95Ms !== undefined && input.quoteP95Ms > SOAK_LIMITS.maxQuoteP95Ms) reasons.push('QUOTE_P95_OVER_1500_MS');
  if (input.retainedGrowthBytes > SOAK_LIMITS.maxRetainedGrowthBytes) reasons.push('RETAINED_GROWTH_OVER_32_MIB');
  if (input.heapSlopeBytesPerMinute > SOAK_LIMITS.maxHeapSlopeBytesPerMinute) reasons.push('HEAP_SLOPE_OVER_1_MIB_PER_MINUTE');
  return { qualified: reasons.length === 0, reasons };
}

export function formatSoakReport(input) {
  const failures = input.failures ?? (input.requestFailures + input.schemaFailures);
  const status = failures === 0 && input.requests > 0 ? 'PASS' : 'FAIL';
  return [
    `base-api-soak=${status}`,
    `durationSeconds=${input.durationSeconds}`,
    `concurrency=${input.concurrency}`,
    `requestIntervalMs=${input.requestIntervalMs ?? SOAK_DEFAULTS.requestIntervalMs}`,
    `requests=${input.requests}`,
    `requestFailures=${input.requestFailures}`,
    `schemaFailures=${input.schemaFailures}`,
    `quoteP95Ms=${input.quoteP95Ms === undefined ? 'n/a' : Number(input.quoteP95Ms).toFixed(2)}`,
    `failures=${failures}`,
    `elapsedSeconds=${Number(input.elapsedSeconds).toFixed(1)}`,
    `retainedGrowthBytes=${Math.round(input.retainedGrowthBytes)}`,
    `heapSlopeBytesPerMinute=${Number(input.heapSlopeBytesPerMinute).toFixed(2)}`,
    `managedChild=${input.managedChild === true}`,
    `heapSamples=${input.heapSamples ?? 0}`,
    ...(input.firstFailure ? [`firstFailure=${input.firstFailure}`] : []),
    `qualified=${input.qualified}`,
    `url=${input.url}`,
    ...(input.reasons?.length ? [`qualificationReasons=${input.reasons.join(',')}`] : []),
  ].join(' ');
}

export function stopManagedChild(child, { graceMs = 5_000 } = {}) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener?.('exit', finish);
      child.removeListener?.('close', finish);
      resolve();
    };
    child.once?.('exit', finish);
    child.once?.('close', finish);
    try {
      const sent = child.kill?.('SIGTERM');
      if (sent === false && child.exitCode !== null && child.exitCode !== undefined) finish();
    } catch {
      finish();
      return;
    }
    timer = setTimeout(() => {
      try { child.kill?.('SIGKILL'); } catch { /* the process already exited */ }
      finish();
    }, graceMs);
  });
}

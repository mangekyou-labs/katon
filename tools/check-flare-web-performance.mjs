import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const assets = resolve(root, 'dist/flare-web/assets');
if (!existsSync(assets)) throw new Error('FLARE_WEB_BUILD_REQUIRED');
const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(resolve(assets, name)).size }));
const jsBytes = files.filter((file) => file.name.endsWith('.js')).reduce((total, file) => total + file.bytes, 0);
const cssBytes = files.filter((file) => file.name.endsWith('.css')).reduce((total, file) => total + file.bytes, 0);
// JS budget re-baselined 2026-08-14: 300k -> 320k. The browser-side
// `encryptFccEnvelope` ECIES path (noble secp256k1 + AES-GCM) required by the
// confidential-auction business flow added ~50k minified. This stays a
// regression tripwire: further growth needs a new documented justification.
const jsBudget = Number(process.env.FLARE_WEB_JS_BUDGET_BYTES ?? 320_000);
const cssBudget = Number(process.env.FLARE_WEB_CSS_BUDGET_BYTES ?? 25_000);
if (!Number.isSafeInteger(jsBudget) || !Number.isSafeInteger(cssBudget) || jsBudget <= 0 || cssBudget <= 0) throw new Error('FLARE_WEB_BUDGET_INVALID');
if (jsBytes > jsBudget) throw new Error(`FLARE_WEB_JS_BUDGET:${jsBytes}>${jsBudget}`);
if (cssBytes > cssBudget) throw new Error(`FLARE_WEB_CSS_BUDGET:${cssBytes}>${cssBudget}`);
console.log(`flare-web-performance=PASS jsBytes=${jsBytes} cssBytes=${cssBytes} jsBudget=${jsBudget} cssBudget=${cssBudget}`);

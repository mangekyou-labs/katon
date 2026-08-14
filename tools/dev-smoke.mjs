// Headless smoke of the DEV server (StrictMode active → double-mounted effects,
// double realtime subscribe). Complements the dist smoke, which exercises the
// production build where StrictMode is inert.
//   node tools/dev-smoke.mjs [seedAddress]
import { createServer as createViteServer } from 'vite';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const SEED = process.argv[2] ?? '';

const vite = await createViteServer({ server: { port: 0, host: '127.0.0.1' } });
await vite.listen();
const target = `http://127.0.0.1:${vite.httpServer.address().port}`;

const HEAD_SHIM = `<script>
  ${SEED ? `try { localStorage.setItem('otc_address', ${JSON.stringify(SEED)}); } catch {}` : ''}
  window.__errs = [];
  addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.error)));
  addEventListener('unhandledrejection', (e) => window.__errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
  const _ce = console.error.bind(console);
  console.error = (...a) => { window.__errs.push('console.error: ' + a.map(String).join(' ').slice(0, 300)); _ce(...a); };
</script>`;

const NEEDLE = SEED ? '#makerToken option' : '#connectBtn';
const POLLER = `<script>
  (function () {
    let n = 0;
    const hit = () => document.querySelector(${JSON.stringify(NEEDLE)});
    const t = setInterval(() => {
      // wait longer after first hit so realtime subscribe errors have time to surface
      if ((hit() && n > 20) || ++n > 120) {
        clearInterval(t);
        fetch('/__dev-smoke', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ booted: !!hit(), waitedMs: n * 250, errors: window.__errs }) });
      }
    }, 250);
  })();
</script>`;

let chrome;
const shutdown = async (c) => { try { chrome?.kill(); } catch {} await vite.close().catch(() => {}); process.exit(c); };
const body = (req) => new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b).toString())); });

const proxy = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__dev-smoke') {
    const v = JSON.parse(await body(req));
    res.writeHead(204).end();
    // Vite's HMR websocket cannot tunnel through this plain-HTTP proxy; those
    // errors are harness artifacts, impossible under real `npm run dev`.
    const errors = v.errors.filter((e) => !/\[vite\]|Failed to send error to Vite server/.test(e));
    console.log(`booted    : ${v.booted ? `YES (waited ${v.waitedMs}ms)` : 'NO'}`);
    console.log(`js errors : ${errors.length ? '\n  ' + errors.join('\n  ') : 'none (harness HMR noise filtered)'}`);
    return shutdown(v.booted && !errors.length ? 0 : 1);
  }
  const upstream = await fetch(target + req.url, { headers: { accept: req.headers.accept ?? '*/*' } });
  const ct = upstream.headers.get('content-type') ?? 'text/plain';
  let buf = Buffer.from(await upstream.arrayBuffer());
  if (ct.includes('text/html')) {
    buf = Buffer.from(buf.toString()
      .replace('<head>', `<head>\n${HEAD_SHIM}`)
      .replace('</body>', `${POLLER}\n</body>`));
  }
  res.writeHead(upstream.status, { 'content-type': ct });
  res.end(buf);
});

setTimeout(() => { console.error('TIMEOUT'); shutdown(1); }, 120_000).unref();

// Override with CHROME_PATH when Chrome isn't installed — e.g. a Playwright
// cache: ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/…/Google Chrome for Testing
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

proxy.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${proxy.address().port}/otc.html`;
  console.log(`dev-smoke: ${url} (seed=${SEED ? 'yes' : 'no'})`);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=/tmp/trustrfq-dev-smoke-${process.pid}`, url,
  ], { stdio: 'ignore' });
  // A failed spawn used to exit(1) silently, which reads exactly like a failed
  // smoke run. Say which binary was missing.
  chrome.on('error', (err) => {
    console.error(`could not launch a browser at ${CHROME} — set CHROME_PATH. (${err.message})`);
    shutdown(1);
  });
});

// ---------------------------------------------------------------------------
// One-shot golden-vector capture.
// ---------------------------------------------------------------------------
// Serves the repo, drives tools/capture.html in headless Chrome, receives the
// computed vectors back over POST /capture, writes fixtures/canonical-args.json,
// and exits. A real browser is used on purpose: the fixture must record what the
// live desk actually produces, including esm.sh's buffer@6 rather than Node's
// built-in Buffer. That is precisely the substitution the fixture exists to catch.
//
//   node tools/capture-server.mjs              # headless, writes the fixture
//   node tools/capture-server.mjs --no-launch  # serve only; open the URL yourself
//
// Override the browser with CHROME=/path/to/chrome.
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(ROOT, 'fixtures', 'canonical-args.json');
const LAUNCH = !process.argv.includes('--no-launch');
const TIMEOUT_MS = 120_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].filter(Boolean);

let chrome, profileDir;
async function shutdown(code) {
  try { chrome?.kill(); } catch {}
  if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}

const readBody = (req) => new Promise((res, rej) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
  req.on('error', rej);
});

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/capture') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      console.error('captured payload was not valid JSON:', err.message);
      res.writeHead(400).end();
      return shutdown(1);
    }
    await mkdir(join(ROOT, 'fixtures'), { recursive: true });
    await writeFile(FIXTURE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    res.writeHead(204).end();
    console.log(`wrote ${FIXTURE}`);
    console.log(`  passphrase : ${parsed.networkPassphrase}`);
    for (const [tok, id] of Object.entries(parsed.sacIds ?? {})) console.log(`  SAC ${tok.split(':')[0].padEnd(4)}: ${id}`);
    for (const v of parsed.vectors ?? []) console.log(`  vector     : ${v.name} (${v.fillArgsXdr.length} args)`);
    return shutdown(0);
  }

  if (req.method === 'POST' && req.url === '/capture-failed') {
    console.error('capture.html threw:\n' + (await readBody(req)));
    res.writeHead(204).end();
    return shutdown(1);
  }

  // static, confined to the repo root
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = resolve(join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

setTimeout(() => {
  console.error(`timed out after ${TIMEOUT_MS / 1000}s waiting for the page to report back`);
  shutdown(1);
}, TIMEOUT_MS).unref();

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/tools/capture.html`;
  if (!LAUNCH) return console.log(`serving — open ${url}`);

  const bin = CHROME_CANDIDATES.find((p) => p);
  if (!bin) {
    console.error('no Chrome found; set CHROME=/path/to/chrome or use --no-launch');
    return shutdown(1);
  }
  profileDir = await mkdtemp(join(tmpdir(), 'trustrfq-capture-'));
  console.log(`driving ${url}`);
  chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profileDir}`, url,
  ], { stdio: 'ignore' });
  chrome.on('error', (err) => { console.error(`could not launch ${bin}: ${err.message}`); shutdown(1); });
});

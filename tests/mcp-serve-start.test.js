/**
 * Serve start-up when MCP instances share a .magector from separate PID namespaces (an MCP gateway
 * starting one container per session), and magento_search answering inside the MCP client's 60s
 * while serve is not ready.
 *
 * Runs the real MCP server against a fake magector-core (a bash script): `serve` records that it
 * started and reports ready only when FAKE_SERVE_READY=1, `search` answers FAKE_SEARCH at once.
 *
 * Usage: node tests/mcp-serve-start.test.js   (needs bash; skipped on Windows)
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, utimesSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

if (process.platform === 'win32') {
  console.log('  ○ mcp serve start — skipped (needs bash)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(here, '..', 'src', 'mcp-server.js');
const VERSION = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf-8')).version;
const OTHER_NAMESPACE = 'pid:[1]';                // no process of this test runs there
const tmp = mkdtempSync(path.join(os.tmpdir(), 'magector-serve-start-'));
const fakeCore = path.join(tmp, 'fake-core.sh');
writeFileSync(fakeCore, `#!/bin/bash
cmd="$1"; shift
case "$cmd" in
  stats) echo "Total vectors: 10" ;;
  search) echo "$FAKE_SEARCH" ;;
  serve)
    echo "serve-start" >> "$FAKE_TIMELINE"
    [ "$FAKE_SERVE_READY" = 1 ] && echo '{"ok":true,"ready":true}'
    while read -r line; do [ "$FAKE_SERVE_READY" = 1 ] && echo '{"ok":true,"data":[]}'; done ;;
esac
`);
chmodSync(fakeCore, 0o755);

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A Magento root with an index; `files` written into its .magector first. */
function makeRoot(name, files = {}) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.magector'), { recursive: true });
  writeFileSync(path.join(root, '.magector', 'index.db'), Buffer.alloc(4096, 1));
  for (const [f, content] of Object.entries(files)) writeFileSync(path.join(root, '.magector', f), content);
  return root;
}

/** The MCP server on `root`: { started() — whether serve was spawned, call(tool, args), stop() }. */
function startServer(root, env = {}) {
  const timeline = path.join(root, 'timeline.log');
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env, MAGENTO_ROOT: root, MAGECTOR_BIN: fakeCore, MAGECTOR_NO_UPDATE: '1', MAGECTOR_AUTO_INDEX: '0',
      FAKE_TIMELINE: timeline, FAKE_SERVE_READY: '1', FAKE_SEARCH: '[]', ...env,
    },
  });
  const pending = new Map(); let id = 0;
  createInterface({ input: child.stdout }).on('line', l => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch { /* not JSON-RPC */ } });
  const req = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const ready = req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'serve-start-test', version: '1' } });
  return {
    started: () => existsSync(timeline) && readFileSync(timeline, 'utf-8').includes('serve-start'),
    log: () => { try { return readFileSync(path.join(root, '.magector', 'magector.log'), 'utf-8'); } catch { return ''; } },
    call: async (name, args) => { await ready; const t0 = Date.now(); const r = await req('tools/call', { name, arguments: args }); return { text: (r.result?.content || []).map(c => c.text).join(''), ms: Date.now() - t0 }; },
    stop: () => new Promise(res => { child.once('exit', res); child.kill(); }),
  };
}
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(200); return cond(); };

async function main() {
  console.log('\nmcp serve start\n');
  try {
    // serve.pid of another namespace, naming a PID that is alive here (this test's)
    let root = makeRoot('foreign-serve-pid', { 'serve.pid': `${process.pid}\n${VERSION}\n${OTHER_NAMESPACE}` });
    let s = startServer(root);
    ok("another namespace's serve.pid: the primary starts its own serve, not taking that PID for one",
      await waitFor(s.started, 10000), s.log().split('\n').filter(l => /serve/i.test(l)).slice(-3).join(' | '));
    await s.stop();

    // a primary lock of another namespace, refreshed by its holder: this instance stays secondary
    root = makeRoot('foreign-lock', { 'primary.lock': `4194000\n${OTHER_NAMESPACE}` });
    s = startServer(root);
    await sleep(6000);
    ok("another namespace's live primary lock: no second serve", !s.started(), s.log().split('\n').filter(l => /primary|lock/i.test(l)).slice(-3).join(' | '));
    await s.stop();

    // a live primary of another namespace, of another Magector version: its socket stays
    root = makeRoot('foreign-version', { 'primary.lock': `4194000\n${OTHER_NAMESPACE}`, 'serve.pid': `4194000\n0.0.1\n${OTHER_NAMESPACE}`, 'serve.sock': '' });
    s = startServer(root);
    await sleep(4000);
    ok("another namespace's serve of another version: its socket is left alone", existsSync(path.join(root, '.magector', 'serve.sock')));
    await s.stop();

    // the same lock, untouched for longer than LOCK_STALE_MS: abandoned, taken over
    root = makeRoot('foreign-stale-lock', { 'primary.lock': `4194000\n${OTHER_NAMESPACE}` });
    const old = new Date(Date.now() - 120000);
    utimesSync(path.join(root, '.magector', 'primary.lock'), old, old);
    s = startServer(root);
    ok("another namespace's abandoned primary lock: taken over, serve started", await waitFor(s.started, 10000));
    await s.stop();

    // serve never ready: magento_search waits MAGECTOR_SERVE_WAIT_MS, then answers from a cold search
    const hit = JSON.stringify([{ id: 1, score: 0.9, metadata: { path: 'app/code/Acme/Price/Model/Calculator.php', file_type: 'php', class_name: 'Calculator', search_text: 'price calculator' } }]);
    root = makeRoot('serve-not-ready');
    s = startServer(root, { FAKE_SERVE_READY: '0', FAKE_SEARCH: hit, MAGECTOR_SERVE_WAIT_MS: '1000' });
    let r = await s.call('magento_search', { query: 'price calculator' });
    ok('serve not ready: magento_search answers from the cold search, inside the wait bound', r.text.includes('Calculator.php') && r.ms < 15000, `${r.ms} ms: ${r.text.slice(0, 200)}`);
    await s.stop();

    // a README is indexed in sections: its hits collapse into the best one, other files keep their slots
    const readme = (score, section) => ({ id: score, score, metadata: { path: 'app/code/Acme/Price/README.md', file_type: 'markdown', magento_type: 'readme', module: 'Acme_Price', search_text: `Acme_Price README ${section}: prices` } });
    const sections = JSON.stringify([readme(0.95, 'How it works'), readme(0.94, 'Data'), readme(0.93, 'Purpose'), JSON.parse(hit)[0]]);
    root = makeRoot('readme-sections');
    s = startServer(root, { FAKE_SERVE_READY: '0', FAKE_SEARCH: sections, MAGECTOR_SERVE_WAIT_MS: '1000' });
    r = await s.call('magento_search', { query: 'price calculation' });
    ok('README sections: one hit per file, the best section first, the PHP file still listed',
      (r.text.match(/README\.md/g) || []).length === 1 && r.text.includes('How it works') && r.text.includes('Calculator.php'), r.text.slice(0, 400));
    await s.stop();

    root = makeRoot('serve-not-ready-empty');
    s = startServer(root, { FAKE_SERVE_READY: '0', MAGECTOR_SERVE_WAIT_MS: '1000' });
    r = await s.call('magento_search', { query: 'price calculator' });
    ok('serve not ready, no answer: magento_search says it is still starting, to retry', /still starting/.test(r.text) && r.ms < 15000, `${r.ms} ms: ${r.text.slice(0, 200)}`);
    await s.stop();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

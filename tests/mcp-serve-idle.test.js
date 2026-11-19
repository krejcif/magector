/**
 * Idle sleep of the serve process (MAGECTOR_SERVE_IDLE_SEC).
 *
 * The primary stops serve after the idle time and keeps its socket proxy. A query that needs the
 * index wakes serve again (also from a secondary instance over the socket); grep and other light
 * commands are answered by a one-shot `magector-core request` and do not wake it.
 *
 * Runs the real MCP server against a fake magector-core (a Node script) that records every
 * serve start/exit and every one-shot request in events.log.
 *
 * Usage: node tests/mcp-serve-idle.test.js   (skipped on Windows: the fake core is a shebang script)
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

if (process.platform === 'win32') {
  console.log('  ○ mcp serve idle — skipped (needs a shebang fake core)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(here, '..', 'src', 'mcp-server.js');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'magector-serve-idle-'));
const events = path.join(tmp, 'events.log');
const fakeCore = path.join(tmp, 'fake-core.mjs');
writeFileSync(fakeCore, `#!/usr/bin/env node
import { createInterface } from 'readline';
import { appendFileSync } from 'fs';
const ev = (s) => appendFileSync(${JSON.stringify(events)}, s + '\\n');
const hit = (q) => ({ id: 1, score: 1, metadata: { path: q + '.php', file_type: 'php', class_name: q, search_text: q } });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const [cmd] = process.argv.slice(2);
if (cmd === 'stats') { console.log('Total vectors: 10'); process.exit(0); }
if (cmd === 'search') { console.log('[]'); process.exit(0); }
const reply = (req) => {
  const id = req.id === undefined ? {} : { id: req.id };
  if (req.command === 'grep') return { ok: true, data: { matches: [{ file: 'fake.php', line: 1, text: req.pattern }], total: 1 }, ...id };
  if (req.command === 'search') return { ok: true, data: [hit(req.query)], ...id };
  if (req.command === 'stats') return { ok: true, data: { vectors: 10 }, ...id };
  return { ok: true, data: null, ...id };
};
if (cmd === 'request') {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    ev('request ' + req.command);
    out(reply(req));
  });
} else if (cmd === 'serve') {
  ev('serve-start ' + process.pid);
  process.on('SIGTERM', () => { ev('serve-exit ' + process.pid); process.exit(0); });
  out({ ok: true, ready: true });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    ev('serve ' + req.command);
    out(reply(req));
  });
} else process.exit(0);
`);
chmodSync(fakeCore, 0o755);

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const ev = () => { try { return readFileSync(events, 'utf-8').split('\n').filter(Boolean); } catch { return []; } };
const count = (prefix) => ev().filter(l => l.startsWith(prefix)).length;

/** A Magento root with an index. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.magector'), { recursive: true });
  writeFileSync(path.join(root, '.magector', 'index.db'), Buffer.alloc(4096, 1));
  return root;
}

/** The MCP server on `root`: { call(tool, args), log(), stop() }. */
function startServer(root, env = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, MAGENTO_ROOT: root, MAGECTOR_BIN: fakeCore, MAGECTOR_NO_UPDATE: '1', MAGECTOR_AUTO_INDEX: '0', ...env },
  });
  const pending = new Map(); let id = 0;
  createInterface({ input: child.stdout }).on('line', l => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch { /* not JSON-RPC */ } });
  const req = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const ready = req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'serve-idle-test', version: '1' } });
  return {
    initialize: () => ready,
    log: () => { try { return readFileSync(path.join(root, '.magector', 'magector.log'), 'utf-8'); } catch { return ''; } },
    call: async (name, args) => { await ready; const r = await req('tools/call', { name, arguments: args }); return (r.result?.content || []).map(c => c.text).join(''); },
    stop: () => new Promise(res => { child.once('exit', res); child.kill(); }),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(100); return cond(); };

async function main() {
  console.log('\nmcp serve idle\n');
  try {
    const root = makeRoot('idle');
    const env = { MAGECTOR_SERVE_IDLE_SEC: '1', MAGECTOR_SERVE_KEEP_IF_DAILY: '0' };
    const primary = startServer(root, env);
    const init = await primary.initialize();
    ok('the server sends usage instructions', /magento_grep/.test(init.result?.instructions || ''),
      JSON.stringify(init.result || {}).slice(0, 200));
    ok('serve starts', await waitFor(() => count('serve-start') === 1, 10000), ev().join(' | '));
    ok('serve sleeps after the idle time', await waitFor(() => count('serve-exit') === 1, 10000), ev().join(' | '));
    ok('a sleeping serve is not respawned as a crash', !/exited unexpectedly/.test(primary.log()));

    const grep = await primary.call('magento_grep', { pattern: 'needle' });
    ok('grep is answered while serve sleeps', grep.includes('fake.php:1:needle'), grep.slice(0, 200));
    ok('grep runs as a one-shot request', count('request grep') === 1, ev().join(' | '));
    ok('grep does not wake serve', count('serve-start') === 1, ev().join(' | '));

    const search = await primary.call('magento_search', { query: 'wakeprobe' });
    ok('search wakes serve', count('serve-start') === 2, ev().join(' | '));
    ok('search is answered by the woken serve', search.includes('wakeprobe.php'), search.slice(0, 200));
    ok('serve sleeps again', await waitFor(() => count('serve-exit') === 2, 10000), ev().join(' | '));

    const secondary = startServer(root, env);
    await secondary.call('magento_stats', {}).catch(() => {});
    ok('a second instance joins the socket of the sleeping primary',
      await waitFor(() => /Connected to existing serve process via socket proxy/.test(primary.log()), 10000));
    await waitFor(() => count('serve-exit') === count('serve-start'), 10000); // stats may have woken it
    const before = count('serve-start');
    const viaSocket = await secondary.call('magento_search', { query: 'socketprobe' });
    ok('a search from the second instance wakes serve', count('serve-start') === before + 1, ev().join(' | '));
    ok('and gets the answer', viaSocket.includes('socketprobe.php'), viaSocket.slice(0, 200));

    await secondary.stop();
    await primary.stop();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

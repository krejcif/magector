/**
 * Serve replies are routed to the request they answer, by the request id.
 *
 * A serve query that times out in the MCP server is dropped from the pending queue, but the core
 * still answers it later. Matched in FIFO order, that late reply resolved the NEXT pending query,
 * and every later reply was off by one. Every request now carries an id, the core echoes it, and
 * the server routes by it (FIFO only for a core that echoes none).
 *
 * Runs the real MCP server against a fake magector-core (a Node script): `serve` answers every
 * request with its id at once, except search 'slow', whose reply is held until the next search
 * arrives (or 6 s pass) and then written just before that search's own reply — a late reply landing
 * while the next query is pending.
 *
 * Usage: node tests/mcp-serve-ids.test.js   (skipped on Windows: the fake core is a shebang script)
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

if (process.platform === 'win32') {
  console.log('  ○ mcp serve ids — skipped (needs a shebang fake core)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(here, '..', 'src', 'mcp-server.js');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'magector-serve-ids-'));
const fakeCore = path.join(tmp, 'fake-core.mjs');
writeFileSync(fakeCore, `#!/usr/bin/env node
import { createInterface } from 'readline';
const hit = (q) => ({ id: 1, score: 1, metadata: { path: q + '.php', file_type: 'php', class_name: q, search_text: q } });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const [cmd] = process.argv.slice(2);
if (cmd === 'stats') { console.log('Total vectors: 10'); process.exit(0); }
if (cmd === 'search') { console.log('[]'); process.exit(0); }
if (cmd !== 'serve') process.exit(0);
out({ ok: true, ready: true });
let held = null; // the late reply of search 'slow'
const flush = () => { if (held) { clearTimeout(held.timer); out(held.reply); held = null; } };
createInterface({ input: process.stdin }).on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { out({ ok: false, error: 'Invalid JSON' }); return; }
  const id = req.id === undefined ? {} : { id: req.id };
  if (req.command !== 'search') { out({ ok: true, data: null, ...id }); return; }
  if (req.query === 'slow') {
    held = { reply: { ok: true, data: [hit('slow')], ...id }, timer: setTimeout(flush, 6000) };
    return;
  }
  flush(); // the slow reply lands while this search is pending
  setTimeout(() => out({ ok: true, data: [hit(req.query)], ...id }), 10);
});
`);
chmodSync(fakeCore, 0o755);

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

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
  const ready = req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'serve-ids-test', version: '1' } });
  return {
    log: () => { try { return readFileSync(path.join(root, '.magector', 'magector.log'), 'utf-8'); } catch { return ''; } },
    call: async (name, args) => { await ready; const r = await req('tools/call', { name, arguments: args }); return (r.result?.content || []).map(c => c.text).join(''); },
    stop: () => new Promise(res => { child.once('exit', res); child.kill(); }),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(100); return cond(); };

async function main() {
  console.log('\nmcp serve ids\n');
  try {
    const root = makeRoot('late-reply');
    const s = startServer(root, { MAGECTOR_SERVE_QUERY_TIMEOUT_MS: '500', MAGECTOR_SERVE_WAIT_MS: '3000' });
    await s.call('magento_stats', {}).catch(() => {}); // the server is up
    ok('serve becomes ready', await waitFor(() => /Serve process ready/.test(s.log()), 10000));
    await s.call('magento_search', { query: 'slow' });   // times out, answered cold (no results)
    const second = await s.call('magento_search', { query: 'fast' });
    ok("a timed-out query's late reply is not handed to the next query",
      second.includes('fast.php') && !second.includes('slow.php'), `second answer: ${second.slice(0, 300)}`);
    ok('the late reply is dropped and logged', /late reply dropped/.test(s.log()),
      s.log().split('\n').filter(l => /QUERY|ERR/.test(l)).slice(-6).join(' | '));
    await s.stop();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

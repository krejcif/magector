#!/usr/bin/env node
/**
 * `magector snapshot save / load / info`: the index and the PHP scan built once (an image build),
 * restored where they are used. A restore replaces the live files only when the whole archive is
 * there and every entry matches its checksum; a snapshot of another version is refused.
 */
import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, truncateSync, utimesSync, readdirSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveSnapshot } from '../src/index-snapshot.js';
import { loadSnapshot as loadPhpScan } from '../src/php-scan-snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const SERVER = path.join(__dirname, '..', 'src', 'mcp-server.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'dispatch-resolution');
const VERSION = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version;

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env: { ...process.env, MAGECTOR_DB: '' } });
const LIVE = ['index.db', 'index.manifest', 'index.sona', 'sqlite.db'];
/** The fixture's PHP code (not a .magector other tests left in it), mtimes kept unless `keepTimes` is false. */
const copyFixture = (dir, keepTimes = true) => cpSync(FIXTURE, dir, { recursive: true, preserveTimestamps: keepTimes, filter: src => path.basename(src) !== '.magector' });

/** A Magento root: the fixture's PHP code and a .magector with an index (random bytes stand in for vectors). */
function makeRoot(dir) {
  copyFixture(dir);
  const m = path.join(dir, '.magector');
  mkdirSync(m, { recursive: true });
  writeFileSync(path.join(m, 'index.db'), randomBytes(3 * 1024 * 1024 + 123));
  writeFileSync(path.join(m, 'index.manifest'), JSON.stringify({ files: { 'app/code/Acme/Disp/Model/Product.php': {} } }));
  writeFileSync(path.join(m, 'index.sona'), randomBytes(4096));
  writeFileSync(path.join(m, 'sqlite.db'), randomBytes(10000));
  return dir;
}
const hashes = root => Object.fromEntries(LIVE.map(n => [n, existsSync(path.join(root, '.magector', n)) ? sha(path.join(root, '.magector', n)) : null]));

async function serverLog(root) {
  // the MCP server on a restored root: it takes the PHP scan from the snapshot instead of reading the tree
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MAGENTO_ROOT: root, MAGECTOR_AUTO_INDEX: '0', MAGECTOR_BIN: '/bin/true', MAGECTOR_PREWARM_PHP: '0' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map(); let id = 0;
  createInterface({ input: child.stdout }).on('line', l => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch { /* log */ } });
  const req = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'snapshot-test', version: '1' } });
  const r = await req('tools/call', { name: 'magento_find_event_dispatchers', arguments: { eventName: 'acme_product_save_after' } });
  await new Promise(res => { child.once('exit', res); child.kill(); });
  return { answer: (r.result?.content || []).map(c => c.text).join(''), log: readFileSync(path.join(root, '.magector', 'magector.log'), 'utf-8') };
}

async function main() {
  console.log('\nmagector snapshot save / load / info\n');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'magector-snap-'));
  try {
    const A = makeRoot(path.join(tmp, 'build', 'app'));
    const built = hashes(A);
    const archive = path.join(tmp, 'magector.tar.gz');

    // ── save ──────────────────────────────────────────────────────
    let r = cli('snapshot', 'save', archive, A, '--no-index');
    ok('save: writes one archive (index, manifest, SONA, descriptions DB, PHP scan)', r.status === 0 && existsSync(archive), (r.stderr || r.stdout).trim().split('\n').pop());
    ok('save: builds the PHP scan the MCP server uses (.magector/php-scan.json)', existsSync(path.join(A, '.magector', 'php-scan.json')));
    r = cli('snapshot', 'info', archive);
    ok('info: version, root and every entry with its size', r.status === 0 && r.stdout.includes(`Magector ${VERSION} snapshot of ${A}`) &&
      ['index.db', 'index.manifest', 'index.sona', 'sqlite.db', 'php-scan.json'].every(n => r.stdout.includes(n)), r.stdout + r.stderr);
    const tarList = spawnSync('tar', ['tzf', archive], { encoding: 'utf-8' });
    if (tarList.status === 0) ok('the archive is a standard tar.gz (tar tzf lists it)', tarList.stdout.split('\n').filter(Boolean).join(',') === 'snapshot.json,index.db,index.manifest,index.sona,sqlite.db,php-scan.json,checksums.json', tarList.stdout);

    // ── load into the root it was built for (the image's runtime) ──
    for (const n of [...LIVE, 'php-scan.json']) rmSync(path.join(A, '.magector', n), { force: true });
    r = cli('snapshot', 'load', archive, A);
    ok('load: every file back, byte for byte', r.status === 0 && JSON.stringify(hashes(A)) === JSON.stringify(built), r.stderr);
    let php = loadPhpScan(A, VERSION);
    ok('load: the PHP scan is usable as is — no file to read again (same files, same mtimes)', r.stdout.includes('every file as in the snapshot') && php.scan && php.changed.length === 0 && php.deleted.length === 0, php.reason);

    // ── load into another root with the same files (a copy keeping mtimes) ──
    const B = path.join(tmp, 'runtime', 'var', 'www');
    copyFixture(B);
    r = cli('snapshot', 'load', archive, B);
    ok('load elsewhere: restored, and the answer says the root changed', r.status === 0 && r.stdout.includes(`The snapshot was built for ${A}; the PHP scan now refers to ${B}.`), r.stdout + r.stderr);
    php = loadPhpScan(B, VERSION);
    ok('load elsewhere: the PHP scan is rewritten for the new root and needs nothing read again', php.scan && php.changed.length === 0, php.reason);
    const s = await serverLog(B);
    ok('the MCP server takes the restored PHP scan instead of reading the tree', /PHP scan loaded from snapshot: .*0 changed/.test(s.log) && !/\] PHP scan: \d+ files/.test(s.log), s.log.split('\n').filter(l => /PHP scan/.test(l)).join(' | '));
    ok('… and answers from it', s.answer.includes('for `Acme\\Disp\\Model\\Product`'), s.answer.slice(0, 300));

    // ── other mtimes (a checkout, not the same files): reported, read again on first use ──
    const C = path.join(tmp, 'checkout');
    copyFixture(C, false);
    const later = new Date(Date.now() + 3600_000);
    for (const f of readdirSync(path.join(C, 'app/code/Acme/Disp/Model'))) if (f.endsWith('.php')) utimesSync(path.join(C, 'app/code/Acme/Disp/Model', f), later, later);
    r = cli('snapshot', 'load', archive, C);
    ok('load with other mtimes: restored; the PHP scan is reported as read again on first use', r.status === 0 && /PHP scan: .*read again on first use/.test(r.stdout), r.stdout + r.stderr);

    // ── refusals leave the live index alone ──
    const live = hashes(A);
    const noLeftovers = () => !readdirSync(path.join(A, '.magector')).some(f => f.endsWith('.restore') || f.endsWith('.new') || f.endsWith('.db.manifest'));
    const other = path.join(tmp, 'other-version.tar');
    await saveSnapshot({ root: A, dbPath: path.join(A, '.magector', 'index.db'), outFile: other, version: '0.0.1' });
    r = cli('snapshot', 'load', other, A);
    ok('another Magector version: refused, rebuild it with this version', r.status !== 0 && /snapshot of Magector 0\.0\.1, this is/.test(r.stderr), r.stderr);
    ok('… the live index is untouched', JSON.stringify(hashes(A)) === JSON.stringify(live) && noLeftovers());

    const plain = path.join(tmp, 'plain.tar');
    ok('save without gzip (.tar)', cli('snapshot', 'save', plain, A, '--no-index').status === 0 && readFileSync(plain).subarray(257, 262).toString() === 'ustar');
    const truncated = path.join(tmp, 'truncated.tar');
    cpSync(plain, truncated);
    truncateSync(truncated, statSync(truncated).size - 3 * 1024 * 1024);
    r = cli('snapshot', 'load', truncated, A);
    ok('a truncated archive: refused', r.status !== 0 && /truncated/.test(r.stderr), r.stderr);
    ok('… the live index is untouched, no staged file left', JSON.stringify(hashes(A)) === JSON.stringify(live) && noLeftovers());

    const damaged = path.join(tmp, 'damaged.tar');
    const bytes = readFileSync(plain);
    const at = bytes.indexOf(Buffer.from('index.db')) + 512 + 4096;   // inside the index.db entry
    bytes[at] ^= 0xff;
    writeFileSync(damaged, bytes);
    r = cli('snapshot', 'load', damaged, A);
    ok('a damaged entry: refused on its checksum', r.status !== 0 && /index\.db: checksum mismatch/.test(r.stderr), r.stderr);
    ok('… the live index is untouched, no staged file left', JSON.stringify(hashes(A)) === JSON.stringify(live) && noLeftovers());

    writeFileSync(path.join(tmp, 'not-a-snapshot.tar'), randomBytes(4096));
    r = cli('snapshot', 'load', path.join(tmp, 'not-a-snapshot.tar'), A);
    ok('not a snapshot: refused', r.status !== 0 && /not a Magector snapshot/.test(r.stderr), r.stderr);

    writeFileSync(path.join(A, '.magector', 'reindex.pid'), String(process.pid));
    r = cli('snapshot', 'load', archive, A);
    ok('an indexer writing the index (reindex.pid of a live process): refused', r.status !== 0 && /an indexer \(PID \d+\) is writing the index/.test(r.stderr), r.stderr);
    rmSync(path.join(A, '.magector', 'reindex.pid'), { force: true });

    r = cli('snapshot', 'load', archive, A);
    ok('the replaced index is kept as index.db.bak', r.status === 0 && existsSync(path.join(A, '.magector', 'index.db.bak')));

    // ── a failure while the files go live: every live file put back ──
    const D = makeRoot(path.join(tmp, 'failing'));
    const before = hashes(D);
    mkdirSync(path.join(D, '.magector', 'index.db.bak', 'x'), { recursive: true });   // the old index cannot be moved aside
    r = cli('snapshot', 'load', archive, D);
    const leftovers = readdirSync(path.join(D, '.magector')).filter(f => /\.(restore|prev|new)$|\.db\.manifest$/.test(f));
    ok('a failure while the files go live: refused, every live file as before', r.status !== 0 && JSON.stringify(hashes(D)) === JSON.stringify(before) && !existsSync(path.join(D, '.magector', 'php-scan.json')), r.stderr);
    ok('… no staged or kept-aside file left', leftovers.length === 0, leftovers.join(', '));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

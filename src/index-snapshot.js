/**
 * A Magector snapshot: everything a Magento root's .magector holds that takes long to build — the
 * vector index with its manifest, SONA state and descriptions DB, and the PHP scan — in one archive,
 * to build once (an image build, a fast machine) and restore where the index is used.
 *
 * The archive is a tar (gzip when the name ends in .gz / .tgz). Its first entry, snapshot.json, names
 * the Magector version, the root it was built for and every entry with its size; the last one,
 * checksums.json, the sha256 of each entry, computed while it was written (no file is read twice).
 * Restoring checks all of it before anything replaces the live index. Paths in the vector index and its
 * manifest are relative to the root; the PHP scan records the root and is rewritten for the root it is
 * restored into (its per-file stamps — mtime and size — still decide what is read again).
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, renameSync, statSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import { createHash } from 'crypto';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import { manifestPath, tempDbPathFor, swapInIndex } from './paths.js';
import { snapshotPathFor as phpScanPathFor } from './php-scan-snapshot.js';

export const SNAPSHOT_FORMAT = 1;
const BLOCK = 512;
const CHECKSUMS = 'checksums.json';

/** The files of a root's .magector a snapshot carries: entry name → path (null: not there). */
export function snapshotSources(root, dbPath) {
  const sona = path.join(path.dirname(dbPath), path.parse(dbPath).name + '.sona');   // Rust's db_path.with_extension("sona")
  return {
    'index.db': dbPath,
    'index.manifest': manifestPath(dbPath),
    'index.sona': sona,
    'sqlite.db': path.join(root, '.magector', 'sqlite.db'),
    'php-scan.json': phpScanPathFor(root),
  };
}

// ─── tar (ustar) ────────────────────────────────────────────────

function tarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
  if (Buffer.byteLength(name) > 100) throw new Error(`entry name too long: ${name}`);
  if (size >= 8 ** 11) throw new Error(`entry too large for the archive: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const field = (str, off, len) => h.write(str, off, len, 'utf8');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  field(name, 0, 100);
  field(octal(0o644, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(size, 12), 124, 12);
  field(octal(mtime, 12), 136, 12);
  h.fill(' ', 148, 156);                       // checksum: spaces while summing
  field('0', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function parseTarHeader(h) {
  if (h.every(b => b === 0)) return null;      // end of archive
  const str = (off, len) => h.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '');
  const stored = parseInt(str(148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  if (stored !== sum) throw new Error('not a Magector snapshot (tar header checksum)');
  return { name: str(0, 100), size: parseInt(str(124, 12).trim() || '0', 8), type: str(156, 1) || '0' };
}

// ─── save ───────────────────────────────────────────────────────

/**
 * Write the snapshot of `root` to `outFile`. The vector index must exist. Returns the metadata.
 * meta: { version, git } — the Magector version that built it, the commit of the root (or null).
 */
export async function saveSnapshot({ root, dbPath, outFile, version, git = null }) {
  const sources = snapshotSources(root, dbPath);
  if (!existsSync(sources['index.db'])) throw new Error(`no vector index at ${dbPath} — run \`magector index\` first`);
  const entries = [];
  for (const [name, file] of Object.entries(sources)) {
    if (!file || !existsSync(file)) continue;
    entries.push({ name, file, size: statSync(file).size });
  }
  const meta = {
    format: SNAPSHOT_FORMAT, version, root: path.resolve(root), git, createdAt: new Date().toISOString(),
    entries: entries.map(({ name, size }) => ({ name, size })),
  };
  const metaBytes = Buffer.from(JSON.stringify(meta, null, 2) + '\n');
  const pad = n => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
  async function* tar() {
    yield tarHeader('snapshot.json', metaBytes.length);
    yield metaBytes;
    yield pad(metaBytes.length);
    const checksums = {};
    for (const e of entries) {
      yield tarHeader(e.name, e.size);
      const hash = createHash('sha256');
      let read = 0;
      for await (const chunk of createReadStream(e.file)) { read += chunk.length; hash.update(chunk); yield chunk; }
      if (read !== e.size) throw new Error(`${e.name} changed while the snapshot was written`);
      checksums[e.name] = hash.digest('hex');
      yield pad(e.size);
    }
    const sums = Buffer.from(JSON.stringify(checksums, null, 2) + '\n');
    yield tarHeader(CHECKSUMS, sums.length);
    yield sums;
    yield pad(sums.length);
    yield Buffer.alloc(BLOCK * 2);
  }
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp`;
  try {
    const stages = [Readable.from(tar())];
    if (/\.(t?gz)$/i.test(outFile)) stages.push(createGzip({ level: 6 }));
    stages.push(createWriteStream(tmp));
    await pipeline(...stages);
    renameSync(tmp, outFile);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return meta;
}

// ─── read ───────────────────────────────────────────────────────

/**
 * Stream the archive's entries: onMeta(meta) for snapshot.json (it must come first), then
 * onEntry(name, size) → a writable file path (or null to skip). Every entry is checked against the
 * metadata's size, and at the end against checksums.json — the sha256 is computed on the bytes as
 * they pass, nothing is read twice. `stopAfterMeta` reads only the metadata.
 */
async function readArchive(file, { onMeta, onEntry = () => null, stopAfterMeta = false }) {
  const magic = Buffer.alloc(2);
  try {
    const fd = openSync(file, 'r');
    readSync(fd, magic, 0, 2, 0);
    closeSync(fd);
  } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  const input = createReadStream(file);
  const stream = magic[0] === 0x1f && magic[1] === 0x8b ? input.pipe(createGunzip()) : input;

  let buf = Buffer.alloc(0);
  let state = 'header';
  let cur = null;                              // { name, size, left, padLeft, hash, out }
  let meta = null;
  let ended = false;
  const sums = new Map();                      // entry name → sha256 of what was read
  let checksums = null;
  const finishEntry = async () => {
    if (cur.out) await new Promise((res, rej) => cur.out.end(err => (err ? rej(err) : res())));
    if (cur.name === 'snapshot.json') {
      try { meta = JSON.parse(cur.metaText); } catch { throw new Error('not a Magector snapshot (snapshot.json unreadable)'); }
      if (meta.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot format ${meta.format}, this Magector reads ${SNAPSHOT_FORMAT}`);
      await onMeta(meta);
    } else if (cur.name === CHECKSUMS) {
      try { checksums = JSON.parse(cur.metaText); } catch { throw new Error('the snapshot archive is damaged (checksums.json unreadable)'); }
    } else {
      sums.set(cur.name, cur.hash.digest('hex'));
    }
    cur = null;
  };
  try {
    for await (const chunk of stream) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (state === 'header') {
          if (buf.length < BLOCK) break;
          const h = parseTarHeader(buf.subarray(0, BLOCK));
          buf = buf.subarray(BLOCK);
          if (!h) { ended = true; break; }
          if (!meta && h.name !== 'snapshot.json') throw new Error('not a Magector snapshot (snapshot.json is not its first entry)');
          if (checksums) throw new Error(`unexpected entry in the snapshot: ${h.name}`);
          const expected = meta?.entries.find(e => e.name === h.name) || null;
          if (meta && !expected && h.name !== CHECKSUMS) throw new Error(`unexpected entry in the snapshot: ${h.name}`);
          if (expected && expected.size !== h.size) throw new Error(`${h.name}: size ${h.size}, the metadata says ${expected.size}`);
          const target = h.name === 'snapshot.json' || h.name === CHECKSUMS ? null : await onEntry(h.name, h.size);
          cur = {
            name: h.name, size: h.size, left: h.size, padLeft: (BLOCK - (h.size % BLOCK)) % BLOCK, expected,
            hash: createHash('sha256'), out: target ? createWriteStream(target) : null, metaText: '',
          };
          state = 'body';
          if (cur.left === 0) { state = 'pad'; }
        } else if (state === 'body') {
          if (!buf.length) break;
          const take = buf.subarray(0, Math.min(cur.left, buf.length));
          buf = buf.subarray(take.length);
          cur.left -= take.length;
          cur.hash.update(take);
          if (cur.name === 'snapshot.json' || cur.name === CHECKSUMS) cur.metaText += take.toString('utf8');
          if (cur.out && !cur.out.write(take)) await new Promise(r => cur.out.once('drain', r));
          if (cur.left === 0) state = 'pad';
        } else if (state === 'pad') {
          if (buf.length < cur.padLeft) break;
          buf = buf.subarray(cur.padLeft);
          await finishEntry();
          if (stopAfterMeta && meta) { input.destroy(); return { meta, complete: false }; }
          state = 'header';
        }
      }
      if (ended) break;
    }
  } catch (e) {
    if (cur?.out) cur.out.destroy();
    throw e;
  }
  if (!ended || cur) throw new Error('the snapshot archive is truncated');
  if (!meta) throw new Error('not a Magector snapshot (no snapshot.json)');
  if (!checksums) throw new Error('the snapshot archive is truncated (no checksums.json)');
  for (const e of meta.entries) {
    if (!sums.has(e.name)) throw new Error(`${e.name}: missing from the archive`);
    if (sums.get(e.name) !== checksums[e.name]) throw new Error(`${e.name}: checksum mismatch — the archive is damaged`);
  }
  return { meta, complete: true };
}

/** The metadata of a snapshot archive (snapshot.json). */
export async function readSnapshotInfo(file) {
  return (await readArchive(file, { onMeta: () => {}, stopAfterMeta: true })).meta;
}

// ─── restore ────────────────────────────────────────────────────

/**
 * Restore a snapshot into `root`. Everything is written next to the live files first (`*.restore`);
 * only when every entry is complete and matches its checksum do they replace the live ones (the vector
 * index through swapInIndex, the old one kept as .bak); a failure while they do puts every live file
 * back, and a manifest that cannot follow the index undoes the swap. Refuses a snapshot of another Magector
 * version — the index format and the PHP scan belong to the version that built them.
 * Returns { meta, restored: [names], rootChanged }.
 */
export async function restoreSnapshot({ root, dbPath, file, version }) {
  const sources = snapshotSources(root, dbPath);
  mkdirSync(path.join(root, '.magector'), { recursive: true });
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const staged = new Map();                    // entry name → staged path
  const stagedPath = name => (name === 'index.db' ? tempDbPathFor(dbPath)
    : name === 'index.manifest' ? manifestPath(tempDbPathFor(dbPath))
      : `${sources[name]}.restore`);
  const cleanup = () => { for (const p of staged.values()) rmSync(p, { force: true }); };
  let meta;
  try {
    ({ meta } = await readArchive(file, {
      onMeta: m => {
        if (m.version !== version) throw new Error(`snapshot of Magector ${m.version}, this is ${version} — rebuild it with this version`);
        if (!m.entries.some(e => e.name === 'index.db')) throw new Error('the snapshot holds no vector index');
      },
      onEntry: name => {
        if (!(name in sources)) return null;
        const p = stagedPath(name);
        rmSync(p, { force: true });
        staged.set(name, p);
        return p;
      },
    }));
  } catch (e) {
    cleanup();
    throw e;
  }
  // All entries are complete and checked: the PHP scan gets this root, then everything goes live.
  const restored = [];
  const rootChanged = meta.root !== path.resolve(root);
  if (staged.has('php-scan.json')) {
    const p = staged.get('php-scan.json');
    try {
      const scan = JSON.parse(readFileSync(p, 'utf-8'));
      if (rootChanged) { scan.root = path.resolve(root); writeFileSync(p, JSON.stringify(scan)); }
    } catch {
      rmSync(p, { force: true });
      staged.delete('php-scan.json');
    }
  }
  // The side files first, each live one kept aside, the index last (swapInIndex undoes its own
  // renames). A failure anywhere puts every live file back: a restore is all or nothing.
  const moved = [];                            // [live path, kept-aside path | null]
  const keepAside = live => {
    const prev = existsSync(live) ? `${live}.prev` : null;
    if (prev) renameSync(live, prev);
    moved.push([live, prev]);
  };
  const hadIndex = existsSync(dbPath);
  try {
    for (const name of ['index.sona', 'sqlite.db', 'php-scan.json']) {
      if (!staged.has(name)) continue;
      keepAside(sources[name]);
      renameSync(staged.get(name), sources[name]);
      staged.delete(name);
      restored.push(name);
    }
    keepAside(manifestPath(dbPath));           // swapInIndex drops the live manifest first; kept to put back
    const { manifestError } = swapInIndex(dbPath, staged.get('index.db'));
    if (manifestError) {
      // the new index without its manifest would take every changed file for current
      if (hadIndex) renameSync(`${dbPath}.bak`, dbPath); else rmSync(dbPath, { force: true });
      throw new Error(`index.manifest could not be put in place (${manifestError.message})`);
    }
  } catch (e) {
    for (const [live, prev] of moved.reverse()) {
      rmSync(live, { force: true });
      if (prev) renameSync(prev, live);
    }
    cleanup();
    throw e;
  }
  for (const [, prev] of moved) if (prev) rmSync(prev, { force: true });
  restored.unshift('index.db', ...(staged.has('index.manifest') ? ['index.manifest'] : []));
  return { meta, restored, rootChanged };
}

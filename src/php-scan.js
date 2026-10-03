/**
 * The PHP scan of a Magento root: the reverse class hierarchy, the `->dispatch(` sites and the classes
 * using each trait, from one read of every PHP file (tests and Magento's generated / var / pub /
 * setup / dev left out). Used by the MCP server (find_implementors, find_event_dispatchers) and by
 * `magector snapshot save`, which writes it to .magector/php-scan.json (src/php-scan-snapshot.js).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { addToClassHierarchy, parsePhpFile, phpTypeDecls } from './di-config.js';
import { extractPhpFacts } from './php-dispatch.js';

const SCAN_SKIP_TOP = new Set(['generated', 'var', 'pub', 'setup', 'dev']);
const SCAN_SKIP_DIRS = new Set(['test', 'tests', 'Test', 'Tests', 'node_modules']);

/** PHP files below root (relative), tests and Magento's generated / var / pub / setup / dev left out; symlinked directories not followed — as glob did, ~15× faster. */
export function walkPhpFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // in name order: which of two files declaring one class is read first must not depend on the filesystem
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name) || (!rel && SCAN_SKIP_TOP.has(e.name))) continue;
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.name.endsWith('.php') && (e.isFile() || e.isSymbolicLink())) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, '');
  return out;
}

/** An empty scan. */
export function emptyPhpScan() {
  return { hierarchy: { types: new Map(), children: new Map() }, dispatchSites: [], traitUsers: new Map(), dispatchFiles: new Map(), stamps: new Map(), typeFiles: new Set() };
}

/**
 * One PHP file into the scan: its dispatch sites, the traits its classes use, its types with parents.
 * `onFacts(absPath, facts)` receives the facts of a dispatching file (the server caches them).
 */
export function scanPhpFile(root, rel, scan, onFacts = null) {
  const abs = path.join(root, rel);
  let source, stamp;
  try { const st = statSync(abs); stamp = `${st.mtimeMs}:${st.size}`; source = readFileSync(abs, 'utf-8'); } catch { return; }
  scan.stamps?.set(rel, stamp);
  if (/->\s*dispatch\s*\(/.test(source)) {
    try {
      const facts = extractPhpFacts(source);
      for (const d of facts.dispatches) scan.dispatchSites.push({ ...d, file: rel });
      if (onFacts) onFacts(abs, facts);
      scan.dispatchFiles.set(rel, stamp);
    } catch { /* a file the scanner cannot read: its dispatches are not resolved */ }
  }
  const hasParents = /\b(?:extends|implements)\b/i.test(source);
  const usesTraits = /^\s+use\s+[\\\w]+(\s*,\s*[\\\w]+)*\s*[;{]/m.test(source);
  if (!hasParents && !usesTraits) return;
  scan.typeFiles?.add(rel);
  let types;
  try { types = parsePhpFile(source).types; } catch { return; }       // parsed once per file
  for (const t of types) {
    for (const tr of t.traits) {
      const k = tr.toLowerCase();
      if (!scan.traitUsers.has(k)) scan.traitUsers.set(k, []);
      scan.traitUsers.get(k).push(t.fqcn);
    }
  }
  if (hasParents) addToClassHierarchy(scan.hierarchy, rel, phpTypeDecls(types));
}

/**
 * The scan of every PHP file of root: { scan, files }. Yields to the event loop every `yieldEvery`
 * files, so a server keeps answering while it reads ~50k files.
 */
export async function buildPhpScan(root, { onFacts = null, yieldEvery = 300 } = {}) {
  const files = walkPhpFiles(root);
  const scan = emptyPhpScan();
  let n = 0;
  for (const rel of files) {
    if (yieldEvery && ++n % yieldEvery === 0) await new Promise(r => setImmediate(r));
    scanPhpFile(root, rel, scan, onFacts);
  }
  return { scan, files };
}

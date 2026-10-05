#!/usr/bin/env node
/**
 * Magector CLI — npx magector <command>
 *
 * All search/index/stats commands delegate to the Rust binary (magector-core).
 * The CLI resolves the binary and model paths, then shells out.
 */
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { resolveBinary } from './binary.js';
import { ensureModels, resolveModels } from './model.js';
import { init, setup } from './init.js';
import { checkForUpdate } from './update.js';
import { createRequire } from 'module';
import { getRunningIndexPid, writeIndexPidFile, removeIndexPidFile } from './index-lock.js';
import { defaultDbPath, dbPathForRoot } from './paths.js';
import { saveSnapshot, restoreSnapshot, readSnapshotInfo } from './index-snapshot.js';
import { buildPhpScan } from './php-scan.js';
import { writeSnapshot as writePhpScan, loadSnapshot as loadPhpScan, acquireScanLock, releaseScanLock, waitForScanLock } from './php-scan-snapshot.js';
const __cliPkg = createRequire(import.meta.url)('../package.json');

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
Magector — Semantic code search for Magento 2

Usage:
  npx magector init [path]       Full setup: index + IDE config
  npx magector index [path]      Index (or re-index) Magento codebase
  npx magector search <query>    Search indexed code
  npx magector describe [path]   Generate LLM descriptions for di.xml files
  npx magector mcp               Start MCP server (for Claude Code / Cursor)
  npx magector stats             Show index statistics
  npx magector snapshot save <file> [path]   Index, read the PHP scan, write both to one archive
  npx magector snapshot load <file> [path]   Restore an archive into [path]/.magector
  npx magector snapshot info <file>          Show what an archive holds
  npx magector setup [path]      IDE setup only (no indexing)
  npx magector help              Show this help

Search options:
  -l, --limit <n>      Number of search results (default: 10)
  -f, --format <fmt>   Output format: text, json (default: text)

Index options:
  --threads <n>        Max ONNX/rayon threads (default: half of CPU cores).
                       Lower this on shared developer machines to keep the
                       system responsive during indexing.
  --batch-size <n>     Embedding batch size (default: 256). Higher = faster
                       but more RAM.
  --force              Discard any existing index and rebuild from scratch.
                       Without --force, indexing auto-resumes from the last
                       incremental save (written every ~50 batches).

Snapshot options:
  --no-index           save: pack the index as it is, without updating it first
  --update             load: update the restored index for files changed since
                       (incremental — reads only what changed when mtimes match)
  Build once where it is fast (an image build), restore where the index is used.
  The archive is gzip when its name ends in .gz / .tgz. It must be restored by
  the same Magector version; the code should be the same files (same mtimes)
  for nothing to be read again.

Environment Variables:
  MAGENTO_ROOT             Path to Magento installation (default: cwd)
  MAGECTOR_DB              Path to index database (default: $MAGENTO_ROOT/.magector/index.db)
  MAGECTOR_BIN             Path to magector-core binary
  MAGECTOR_MODELS          Path to ONNX model directory
  MAGECTOR_THREADS         Max threads (overridden by --threads)
  MAGECTOR_BATCH_SIZE      Embedding batch size (overridden by --batch-size)
  MAGECTOR_INDEX_TIMEOUT   Indexing wall-clock timeout in ms (default: 14400000 = 4h)
  OMP_NUM_THREADS          Fallback thread limit if MAGECTOR_THREADS unset

Examples:
  npx magector init /var/www/magento
  npx magector search "product price calculation"
  npx magector search "checkout controller" -l 20
  npx magector index
  npx magector index --threads 4 --batch-size 128
  MAGECTOR_INDEX_TIMEOUT=28800000 npx magector index   # 8h timeout
  npx magector snapshot save /cache/magector.tar.gz /var/www/magento
  npx magector snapshot load /cache/magector.tar.gz /var/www/magento
  npx magector mcp
`);
}

/** `snapshot save|load|info <file> [path] [--no-index] [--update]` */
async function runSnapshot(argv) {
  const [sub, file, ...rest] = argv;
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const target = rest.find(a => !a.startsWith('--'));
  if (!['save', 'load', 'info'].includes(sub) || !file) {
    console.error('Usage: npx magector snapshot save|load <file> [path] [--no-index] [--update] | info <file>');
    process.exit(1);
  }
  const fmtSize = n => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
  if (sub === 'info') {
    const meta = await readSnapshotInfo(file);
    console.log(`Magector ${meta.version} snapshot of ${meta.root}${meta.git ? ` (git ${meta.git.slice(0, 12)})` : ''}, ${meta.createdAt}`);
    for (const e of meta.entries) console.log(`  ${e.name.padEnd(15)} ${fmtSize(e.size).padStart(10)}`);
    return;
  }
  const root = path.resolve(target || getConfig().magentoRoot);
  const dbPath = path.resolve(dbPathForRoot(root));
  const version = __cliPkg.version;
  const t0 = Date.now();

  if (sub === 'save') {
    if (!flags.has('--no-index')) await runIndex(root, {});
    // the PHP scan (find_implementors, find_event_dispatchers) — as the MCP server writes it
    if (!acquireScanLock(root)) { await waitForScanLock(root, 180000); acquireScanLock(root); }
    try {
      const t1 = Date.now();
      const { scan, files } = await buildPhpScan(root, { yieldEvery: 0 });
      if (!writePhpScan(root, scan, version)) throw new Error('could not write .magector/php-scan.json');
      console.log(`PHP scan: ${files.length} files, ${scan.dispatchSites.length} dispatch sites (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
    } finally {
      releaseScanLock(root);
    }
    const running = getRunningIndexPid(root);
    if (running) throw new Error(`an indexer (PID ${running}) is writing the index of ${root} — wait for it to finish`);
    writeIndexPidFile(root, process.pid);       // no background re-index while the index is read
    try {
      let git = null;
      try { git = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* not a git checkout */ }
      const meta = await saveSnapshot({ root, dbPath, outFile: path.resolve(file), version, git });
      console.log(`Snapshot: ${path.resolve(file)} — ${meta.entries.map(e => `${e.name} ${fmtSize(e.size)}`).join(', ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } finally {
      removeIndexPidFile(root);
    }
    return;
  }

  // load
  const running = getRunningIndexPid(root);
  if (running) throw new Error(`an indexer (PID ${running}) is writing the index of ${root} — wait for it to finish`);
  writeIndexPidFile(root, process.pid);
  let result;
  try {
    result = await restoreSnapshot({ root, dbPath, file: path.resolve(file), version });
  } finally {
    removeIndexPidFile(root);
  }
  const { meta, restored, rootChanged } = result;
  console.log(`Restored ${restored.join(', ')} from the snapshot of ${meta.root}${meta.git ? ` (git ${meta.git.slice(0, 12)})` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (rootChanged) console.log(`The snapshot was built for ${meta.root}; the PHP scan now refers to ${root}.`);
  if (restored.includes('php-scan.json')) {
    // stat only (mtime + size), no file read: the one cheap sign that the tree's mtimes survived
    const php = loadPhpScan(root, version);
    const stale = php.scan ? php.changed.length + php.deleted.length : 0;
    console.log(!php.scan ? `PHP scan: not usable here (${php.reason}) — read again on first use`
      : stale ? `PHP scan: ${php.changed.length} changed and ${php.deleted.length} deleted file(s) since the snapshot — read again on first use (other mtimes: \`--update\` re-hashes those files too)`
        : 'PHP scan: every file as in the snapshot — nothing to read again');
  }
  if (flags.has('--update')) await runIndex(root, {});
}

function getConfig() {
  return {
    dbPath: defaultDbPath(),
    magentoRoot: process.env.MAGENTO_ROOT || process.cwd()
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-l' || argv[i] === '--limit') {
      opts.limit = argv[++i];
    } else if (argv[i] === '-f' || argv[i] === '--format') {
      opts.format = argv[++i];
    } else if (argv[i] === '-v' || argv[i] === '--verbose') {
      opts.verbose = true;
    } else if (argv[i] === '--force') {
      opts.force = true;
    } else if (argv[i] === '--threads') {
      opts.threads = argv[++i];
    } else if (argv[i] === '--batch-size') {
      opts.batchSize = argv[++i];
    }
  }
  return opts;
}

async function runIndex(targetPath, opts = {}) {
  const config = getConfig();
  const root = targetPath || config.magentoRoot;
  const dbPath = dbPathForRoot(root);
  const binary = resolveBinary();
  const modelPath = await ensureModels();

  console.log(`\nIndexing: ${path.resolve(root)}`);
  console.log(`Database: ${path.resolve(dbPath)}\n`);

  // Ensure .magector/ directory exists
  const magectorDir = path.resolve(root, '.magector');
  mkdirSync(magectorDir, { recursive: true });

  // Refuse to run alongside another indexer (this CLI or an MCP server's
  // background reindex) on the same root — two indexers racing on the same
  // Magento tree can clobber each other's output even when writing to
  // different -d paths (shared descriptions DB, CPU/RAM contention).
  const resolvedRoot = path.resolve(root);
  const conflictPid = getRunningIndexPid(resolvedRoot);
  if (conflictPid) {
    console.error(
      `Another indexing process (PID ${conflictPid}) is already running for ${resolvedRoot}.\n` +
      `Wait for it to finish, or if it's stale/dead, remove .magector/reindex.pid.`
    );
    process.exit(1);
  }
  writeIndexPidFile(resolvedRoot, process.pid);

  // Default 4 hours — generous enough for ~80K-file enterprise codebases under
  // CPU constraint. Override via MAGECTOR_INDEX_TIMEOUT (milliseconds).
  const indexTimeout = parseInt(process.env.MAGECTOR_INDEX_TIMEOUT, 10) || 14400000;
  try {
    const indexArgs = [
      'index',
      '-m', path.resolve(root),
      '-d', path.resolve(dbPath),
      '-c', modelPath
    ];
    // Forward thread/batch limits to the Rust binary. The Rust side already
    // honors MAGECTOR_THREADS / OMP_NUM_THREADS via env, but explicit flags
    // give the user a CLI-level override and make the limit visible in logs.
    if (opts.threads != null) {
      indexArgs.push('--threads', String(opts.threads));
    }
    if (opts.batchSize != null) {
      indexArgs.push('--batch-size', String(opts.batchSize));
    }
    // --force discards any existing partial index and rebuilds from scratch.
    // Without it, the Rust indexer auto-resumes from the last incremental
    // save on disk and only re-embeds files that aren't in the DB yet.
    if (opts.force) {
      indexArgs.push('--force');
    }
    // Pass descriptions DB if it exists
    const descDbPath = path.resolve(root, '.magector', 'sqlite.db');
    if (existsSync(descDbPath)) {
      indexArgs.push('--descriptions-db', descDbPath);
    }
    execFileSync(binary, indexArgs, { timeout: indexTimeout, stdio: 'inherit' });
    console.log('\nIndexing complete.');
  } catch (err) {
    if (err.status) {
      console.error('Indexing failed.');
      removeIndexPidFile(resolvedRoot);
      process.exit(err.status);
    }
    if (err.message && err.message.includes('ETIMEDOUT')) {
      console.error(
        `Indexing timed out after ${indexTimeout / 1000}s.\n` +
        `Partial progress was saved to disk every ~50 batches — re-run\n` +
        `'npx magector index' to auto-resume from the last checkpoint.\n` +
        `\n` +
        `For large codebases or CPU-constrained environments, also consider:\n` +
        `  MAGECTOR_INDEX_TIMEOUT=28800000 npx magector index    # 8 hours\n` +
        `  npx magector index --threads 2                        # lower CPU usage`
      );
    } else {
      console.error(`Indexing error: ${err.message}`);
    }
    removeIndexPidFile(resolvedRoot);
    process.exit(1);
  }
  removeIndexPidFile(resolvedRoot);
}

function runSearch(query, opts = {}) {
  const config = getConfig();
  const binary = resolveBinary();
  const modelPath = resolveModels();

  if (!modelPath) {
    console.error('ONNX model not found. Run `npx magector init` or `npx magector index` first.');
    process.exit(1);
  }

  const searchArgs = [
    'search', query,
    '-d', path.resolve(config.dbPath),
    '-c', modelPath,
    '-l', String(opts.limit || 10),
    '-f', opts.format || 'text'
  ];

  try {
    const output = execFileSync(binary, searchArgs, {
      encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(output);
  } catch (err) {
    const output = err.stderr || err.stdout || err.message;
    console.error(`Search error: ${output}`);
    process.exit(1);
  }
}

function runStats() {
  const config = getConfig();
  const binary = resolveBinary();

  try {
    const output = execFileSync(binary, [
      'stats', '-d', path.resolve(config.dbPath)
    ], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(output);
  } catch (err) {
    const output = err.stderr || err.stdout || err.message;
    console.error(`Stats error: ${output}`);
    process.exit(1);
  }
}

async function runDescribe(targetPath) {
  const config = getConfig();
  const root = targetPath || config.magentoRoot;
  const binary = resolveBinary();
  const opts = parseArgs(args.slice(1));
  mkdirSync(path.resolve(root, '.magector'), { recursive: true });
  const outputPath = path.resolve(root, '.magector', 'sqlite.db');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required for description generation.');
    process.exit(1);
  }

  console.log(`\nGenerating LLM descriptions for di.xml files`);
  console.log(`Magento root: ${path.resolve(root)}`);
  console.log(`Output: ${outputPath}\n`);

  const describeArgs = [
    'describe',
    '-m', path.resolve(root),
    '-o', outputPath
  ];
  if (opts.force) describeArgs.push('--force');

  try {
    execFileSync(binary, describeArgs, { timeout: 3600000, stdio: 'inherit' });
    console.log('\nDescription generation complete.');
  } catch (err) {
    if (err.status) {
      console.error('Description generation failed.');
      process.exit(err.status);
    }
    console.error(`Description error: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  // Auto-update: check npm for newer version, re-exec if found
  await checkForUpdate(command, args);

  switch (command) {
    case 'init': {
      const initArgv = args.slice(1);
      const initTarget = initArgv.find(a => !a.startsWith('-'));
      const initOpts = parseArgs(initArgv);
      await init(initTarget, initOpts);
      break;
    }

    case 'index': {
      // First non-flag arg after `index` is the path; everything else is options.
      // Must skip values belonging to flags (e.g., "4" in "--threads 4").
      const indexArgv = args.slice(1);
      const indexOpts = parseArgs(indexArgv);
      let targetPath = undefined;
      for (let i = 0; i < indexArgv.length; i++) {
        if (indexArgv[i] === '--threads' || indexArgv[i] === '--batch-size') {
          i++; // skip the flag's value
        } else if (indexArgv[i].startsWith('-')) {
          // skip boolean flags like --force, --verbose
        } else {
          targetPath = indexArgv[i];
          break; // first non-flag, non-value arg is the path
        }
      }
      await runIndex(targetPath, indexOpts);
      break;
    }

    case 'search': {
      // Build query from non-flag arguments, skipping values that belong to flags
      const searchArgv = args.slice(1);
      const queryParts = [];
      for (let i = 0; i < searchArgv.length; i++) {
        if (searchArgv[i] === '-l' || searchArgv[i] === '--limit' ||
            searchArgv[i] === '-f' || searchArgv[i] === '--format') {
          i++; // skip the flag's value
        } else if (searchArgv[i].startsWith('-')) {
          // skip boolean flags like -v, --verbose
        } else {
          queryParts.push(searchArgv[i]);
        }
      }
      const query = queryParts.join(' ');
      if (!query) {
        console.error('Usage: npx magector search <query>');
        process.exit(1);
      }
      const opts = parseArgs(searchArgv);
      runSearch(query, opts);
      break;
    }

    case 'mcp':
      await import('./mcp-server.js');
      break;

    case 'describe':
      await runDescribe(args[1]);
      break;

    case 'stats':
      runStats();
      break;

    case 'setup':
      await setup(args[1]);
      break;

    case 'validate': {
      const { runFullValidation } = await import('./validation/validator.js');
      const verbose = args.includes('--verbose') || args.includes('-v');
      const keepData = args.includes('--keep');
      await runFullValidation({ verbose, keepTestData: keepData });
      break;
    }

    case 'benchmark':
      await import('./validation/benchmark.js');
      break;

    case 'snapshot': {
      await runSnapshot(args.slice(1));
      break;
    }

    case 'version':
    case '--version':
    case '-V':
      console.log(`magector v${__cliPkg.version}`);
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

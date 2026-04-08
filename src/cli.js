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

Environment Variables:
  MAGENTO_ROOT             Path to Magento installation (default: cwd)
  MAGECTOR_DB              Path to index database (default: ./.magector/index.db)
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
  npx magector mcp
`);
}

function getConfig() {
  return {
    dbPath: process.env.MAGECTOR_DB || './.magector/index.db',
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
  const binary = resolveBinary();
  const modelPath = await ensureModels();

  console.log(`\nIndexing: ${path.resolve(root)}`);
  console.log(`Database: ${path.resolve(config.dbPath)}\n`);

  // Ensure .magector/ directory exists
  const magectorDir = path.resolve(root, '.magector');
  mkdirSync(magectorDir, { recursive: true });

  // Default 4 hours — generous enough for ~80K-file enterprise codebases under
  // CPU constraint. Override via MAGECTOR_INDEX_TIMEOUT (milliseconds).
  const indexTimeout = parseInt(process.env.MAGECTOR_INDEX_TIMEOUT, 10) || 14400000;
  try {
    const indexArgs = [
      'index',
      '-m', path.resolve(root),
      '-d', path.resolve(config.dbPath),
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
    process.exit(1);
  }
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

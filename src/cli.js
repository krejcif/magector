#!/usr/bin/env node
/**
 * Magector CLI — npx magector <command>
 *
 * All search/index/stats commands delegate to the Rust binary (magector-core).
 * The CLI resolves the binary and model paths, then shells out.
 */
import { execFileSync, spawn } from 'child_process';
import path from 'path';
import { resolveBinary } from './binary.js';
import { ensureModels, resolveModels } from './model.js';
import { init, setup } from './init.js';

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
Magector — Semantic code search for Magento 2

Usage:
  npx magector init [path]       Full setup: index + IDE config
  npx magector index [path]      Index (or re-index) Magento codebase
  npx magector search <query>    Search indexed code
  npx magector mcp               Start MCP server (for Claude Code / Cursor)
  npx magector stats             Show index statistics
  npx magector setup [path]      IDE setup only (no indexing)
  npx magector help              Show this help

Options:
  -l, --limit <n>    Number of search results (default: 10)
  -f, --format <fmt> Output format: text, json (default: text)

Environment Variables:
  MAGENTO_ROOT     Path to Magento installation (default: cwd)
  MAGECTOR_DB      Path to index database (default: ./magector.db)
  MAGECTOR_BIN     Path to magector-core binary
  MAGECTOR_MODELS  Path to ONNX model directory

Examples:
  npx magector init /var/www/magento
  npx magector search "product price calculation"
  npx magector search "checkout controller" -l 20
  npx magector index
  npx magector mcp
`);
}

function getConfig() {
  return {
    dbPath: process.env.MAGECTOR_DB || './magector.db',
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
    }
  }
  return opts;
}

async function runIndex(targetPath) {
  const config = getConfig();
  const root = targetPath || config.magentoRoot;
  const binary = resolveBinary();
  const modelPath = await ensureModels();

  console.log(`\nIndexing: ${path.resolve(root)}`);
  console.log(`Database: ${path.resolve(config.dbPath)}\n`);

  try {
    execFileSync(binary, [
      'index',
      '-m', path.resolve(root),
      '-d', path.resolve(config.dbPath),
      '-c', modelPath
    ], { timeout: 600000, stdio: 'inherit' });
    console.log('\nIndexing complete.');
  } catch (err) {
    if (err.status) {
      console.error('Indexing failed.');
      process.exit(err.status);
    }
    console.error(`Indexing error: ${err.message}`);
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

async function main() {
  switch (command) {
    case 'init':
      await init(args[1]);
      break;

    case 'index':
      await runIndex(args[1]);
      break;

    case 'search': {
      const query = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
      if (!query) {
        console.error('Usage: npx magector search <query>');
        process.exit(1);
      }
      const opts = parseArgs(args.slice(1));
      runSearch(query, opts);
      break;
    }

    case 'mcp':
      await import('./mcp-server.js');
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

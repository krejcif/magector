#!/usr/bin/env node
import { MagentoIndexer } from './indexer.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const command = args[0];

const config = {
  dbPath: process.env.MAGECTOR_DB || './magector.db',
  magentoRoot: process.env.MAGENTO_ROOT || process.cwd()
};

async function index(targetPath) {
  const root = targetPath || config.magentoRoot;
  console.log(`\n🔍 Magector - Magento Code Indexer\n`);
  console.log(`Indexing: ${root}`);
  console.log(`Database: ${config.dbPath}\n`);

  const indexer = new MagentoIndexer({
    dbPath: config.dbPath,
    magentoRoot: root
  });

  await indexer.init();
  const stats = await indexer.indexDirectory();
  await indexer.close();

  console.log(`\n✅ Indexing complete!`);
  console.log(`   Files indexed: ${stats.indexed}`);
  console.log(`   Files skipped: ${stats.skipped}`);
}

async function search(query, options = {}) {
  console.log(`\n🔍 Searching: "${query}"\n`);

  const indexer = new MagentoIndexer({ dbPath: config.dbPath });
  await indexer.init();

  const results = await indexer.search(query, {
    limit: options.limit || 5,
    filter: options.type ? { type: options.type } : undefined
  });

  if (results.length === 0) {
    console.log('No results found.');
  } else {
    results.forEach((r, i) => {
      console.log(`\n--- Result ${i + 1} (score: ${r.score?.toFixed(3)}) ---`);
      console.log(`Path: ${r.path}`);
      if (r.module) console.log(`Module: ${r.module}`);
      if (r.className) console.log(`Class: ${r.className}`);
      if (r.methodName) console.log(`Method: ${r.methodName}`);
      console.log(`\n${r.content?.substring(0, 300)}...`);
    });
  }

  await indexer.close();
}

async function stats() {
  const indexer = new MagentoIndexer({ dbPath: config.dbPath });
  await indexer.init();
  const s = await indexer.getStats();
  console.log(`\n📊 Magector Stats`);
  console.log(`   Total vectors: ${s.totalVectors}`);
  console.log(`   Database: ${s.dbPath}`);
  await indexer.close();
}

async function setupClaude() {
  const mcpConfig = {
    mcpServers: {
      magector: {
        command: 'node',
        args: [path.resolve('./src/mcp-server.js')],
        env: {
          MAGECTOR_DB: path.resolve(config.dbPath),
          MAGENTO_ROOT: path.resolve(config.magentoRoot)
        }
      }
    }
  };

  const configPath = path.join(process.cwd(), '.mcp.json');
  await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));

  console.log(`\n✅ Claude Code MCP config created: ${configPath}`);
  console.log(`\nTo add to Claude Code globally, run:`);
  console.log(`  claude mcp add magector node ${path.resolve('./src/mcp-server.js')}`);
  console.log(`\nOr add to your Claude Code settings manually.`);
}

function showHelp() {
  console.log(`
Magector - Magento Code Indexer for Claude Code

Usage:
  npx magector index [path]     Index Magento codebase
  npx magector search <query>   Search indexed code
  npx magector stats            Show indexer statistics
  npx magector setup            Generate Claude Code MCP config
  npx magector mcp              Start MCP server (for Claude Code)
  npx magector validate         Run accuracy validation suite
  npx magector benchmark        Run performance benchmarks

Environment Variables:
  MAGENTO_ROOT    Path to Magento installation
  MAGECTOR_DB     Path to index database file

Examples:
  npx magector index /var/www/magento
  npx magector search "product price calculation"
  npx magector search "checkout controller" --type php
  npx magector setup
  npx magector validate --verbose
  npx magector benchmark
`);
}

async function main() {
  switch (command) {
    case 'index':
      await index(args[1]);
      break;
    case 'search':
      await search(args.slice(1).join(' '));
      break;
    case 'stats':
      await stats();
      break;
    case 'setup':
      await setupClaude();
      break;
    case 'mcp':
      await import('./mcp-server.js');
      break;
    case 'validate':
      const { runFullValidation } = await import('./validation/validator.js');
      const verbose = args.includes('--verbose') || args.includes('-v');
      const keepData = args.includes('--keep');
      await runFullValidation({ verbose, keepTestData: keepData });
      break;
    case 'benchmark':
      await import('./validation/benchmark.js');
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      showHelp();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

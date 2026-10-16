#!/usr/bin/env node
// Runs every test file, continuing past failures, and exits 1 if any failed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TEST_FILES = [
  'tests/unit.test.js',
  'tests/mcp-server.test.js',
  'tests/mcp-reindex-lock.test.js',
  'tests/trace-graphql.test.js',
  'tests/di-resolution.test.js',
  'tests/di-parsing.test.js',
  'tests/config-models.test.js',
  'tests/validate-config.test.js',
  'tests/dispatch-resolution.test.js',
  'tests/index-snapshot.test.js',
  'tests/mcp-serve-start.test.js',
];

function main() {
  const results = [];
  for (const file of TEST_FILES) {
    const start = Date.now();
    const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    results.push({ file, status: r.status === null ? 1 : r.status, ms: Date.now() - start });
  }

  console.log('\nTest summary');
  console.log('------------');
  const width = Math.max(...results.map(r => r.file.length));
  for (const r of results) {
    const label = r.status === 0 ? 'passed' : `FAILED (exit ${r.status})`;
    console.log(`${r.file.padEnd(width)}  ${label.padEnd(18)}  ${(r.ms / 1000).toFixed(1)}s`);
  }
  const failed = results.filter(r => r.status !== 0);
  console.log(`\n${results.length - failed.length}/${results.length} files passed`);
  process.exit(failed.length ? 1 : 0);
}

// Run main() only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

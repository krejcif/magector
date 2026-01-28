/**
 * Automated tests for Magector MCP Server tools
 *
 * Tests verify:
 * - MCP tool schemas and handler presence (source analysis)
 * - Rust core binary existence and CLI interface
 * - Analysis tools (diff, complexity) via ruvector JS
 * - Clean architecture (no JS indexer dependency)
 *
 * Usage:
 *   node tests/mcp-server.test.js
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');
const RUST_BINARY = path.join(__dirname, '..', 'rust-core', 'target', 'release', 'magector-core');
const DB_PATH = process.env.MAGECTOR_DB || './magector.db';

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  const color = status === 'PASS' ? '\x1b[32m' : status === 'FAIL' ? '\x1b[31m' : '\x1b[33m';
  console.log(`  ${color}${icon}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  results.push({ status, name, detail });
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else skipped++;
}

function assert(condition, testName, detail = '') {
  if (condition) {
    log('PASS', testName, detail);
  } else {
    log('FAIL', testName, detail);
  }
}

// ─── Rust Core Binary Tests ─────────────────────────────────────

async function testRustBinaryExists() {
  console.log('\n── Rust Core Binary ──');

  assert(existsSync(RUST_BINARY), 'Rust binary exists at expected path');

  // Test --help works
  try {
    const output = execFileSync(RUST_BINARY, ['--help'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    assert(output.includes('index') || output.includes('Index'), 'Binary has index command');
    assert(output.includes('search') || output.includes('Search'), 'Binary has search command');
    assert(output.includes('stats') || output.includes('Stats'), 'Binary has stats command');
    assert(output.includes('validate') || output.includes('Validate'), 'Binary has validate command');
  } catch (err) {
    log('FAIL', 'Binary --help', err.message);
  }
}

async function testRustStats() {
  console.log('\n── Rust Core Stats ──');

  try {
    const output = execFileSync(RUST_BINARY, ['stats', '-d', DB_PATH], {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    });
    assert(output.includes('Total vectors'), 'Stats output contains total vectors');
    assert(output.includes('Embedding dim'), 'Stats output contains embedding dim');
    assert(output.includes('384'), 'Embedding dim is 384');
  } catch (err) {
    // Stats might fail if DB doesn't exist — that's ok
    if (existsSync(DB_PATH)) {
      log('FAIL', 'Rust stats', err.message);
    } else {
      log('SKIP', 'Rust stats', 'No database at ' + DB_PATH);
    }
  }
}

// ─── MCP Server Source Tests ────────────────────────────────────

async function testMcpToolSchemas() {
  console.log('\n── MCP Tool Schema Validation ──');

  const source = await readFile(path.join(SRC_DIR, 'mcp-server.js'), 'utf-8');

  const expectedTools = [
    'magento_search',
    'magento_find_class',
    'magento_find_method',
    'magento_find_config',
    'magento_find_template',
    'magento_index',
    'magento_stats',
    'magento_find_plugin',
    'magento_find_observer',
    'magento_find_preference',
    'magento_find_api',
    'magento_find_controller',
    'magento_find_block',
    'magento_find_cron',
    'magento_find_graphql',
    'magento_find_db_schema',
    'magento_module_structure',
    'magento_analyze_diff',
    'magento_complexity'
  ];

  for (const tool of expectedTools) {
    assert(source.includes(`name: '${tool}'`), `Tool '${tool}' defined in server`);
  }

  // Verify case handlers exist for all tools
  for (const tool of expectedTools) {
    assert(source.includes(`case '${tool}':`), `Handler exists for '${tool}'`);
  }

  assert(expectedTools.length === 19, `Total tools: 19 (got ${expectedTools.length})`);

  // GNN tools should be removed
  const removedTools = ['magento_dependencies', 'magento_graph_query'];
  for (const tool of removedTools) {
    assert(!source.includes(`name: '${tool}'`), `Removed tool '${tool}' not present`);
  }
}

async function testMcpResources() {
  console.log('\n── MCP Resources ──');

  const source = await readFile(path.join(SRC_DIR, 'mcp-server.js'), 'utf-8');

  assert(source.includes("uri: 'magector://stats'"), 'Stats resource defined');
  assert(source.includes('ListResourcesRequestSchema'), 'ListResources handler exists');
  assert(source.includes('ReadResourceRequestSchema'), 'ReadResource handler exists');
}

// ─── Clean Architecture Tests ───────────────────────────────────

async function testNoJsIndexer() {
  console.log('\n── Clean Architecture (No JS Indexer) ──');

  const source = await readFile(path.join(SRC_DIR, 'mcp-server.js'), 'utf-8');

  // MCP server should NOT import the JS indexer
  assert(!source.includes("from './indexer.js'"), 'No import from indexer.js');
  assert(!source.includes('MagentoIndexer'), 'No MagentoIndexer reference');
  assert(!source.includes('new MagentoIndexer'), 'No MagentoIndexer instantiation');
  assert(!source.includes('getIndexer'), 'No getIndexer function');

  // MCP server should NOT use ruvector VectorDB or IntelligenceEngine
  assert(!source.includes('VectorDB'), 'No VectorDB reference');
  assert(!source.includes('createIntelligenceEngine'), 'No createIntelligenceEngine reference');

  // Should use Rust binary
  assert(source.includes('execFileSync'), 'Uses execFileSync for Rust core');
  assert(source.includes('rustSearch'), 'Has rustSearch function');
  assert(source.includes('rustIndex'), 'Has rustIndex function');
  assert(source.includes('rustStats'), 'Has rustStats function');
  assert(source.includes('magector-core'), 'References magector-core binary');

  // Should still use ruvector for analysis tools only
  assert(source.includes('ruvector/dist/core/diff-embeddings'), 'Uses ruvector diff-embeddings');
  assert(source.includes('ruvector/dist/analysis/complexity'), 'Uses ruvector complexity analysis');

  // GNN remnants should be gone
  assert(!source.includes('GraphDatabase'), 'No GraphDatabase');
  assert(!source.includes('RuvectorLayer'), 'No RuvectorLayer');
  assert(!source.includes('isGnnAvailable'), 'No isGnnAvailable');
  assert(!source.includes('searchWithGraph'), 'No searchWithGraph');
  assert(!source.includes('findDependencies'), 'No findDependencies');
  assert(!source.includes('GNN'), 'No GNN references');
}

async function testIndexerFileRemoved() {
  console.log('\n── Indexer File Removed ──');

  assert(!existsSync(path.join(SRC_DIR, 'indexer.js')), 'src/indexer.js does not exist');
}

// ─── Diff & Complexity Tool Tests ───────────────────────────────

async function testAnalyzeDiffSchema() {
  console.log('\n── MCP Tool: magento_analyze_diff ──');

  const source = await readFile(path.join(SRC_DIR, 'mcp-server.js'), 'utf-8');

  assert(source.includes("name: 'magento_analyze_diff'"), 'Tool defined');
  assert(source.includes("case 'magento_analyze_diff':"), 'Handler exists');
  assert(source.includes('commitHash'), 'Schema includes commitHash');
  assert(source.includes('riskScore'), 'Handler returns risk score');
  assert(source.includes('analyzeDiff'), 'Calls analyzeDiff function');
}

async function testComplexitySchema() {
  console.log('\n── MCP Tool: magento_complexity ──');

  const source = await readFile(path.join(SRC_DIR, 'mcp-server.js'), 'utf-8');

  assert(source.includes("name: 'magento_complexity'"), 'Tool defined');
  assert(source.includes("case 'magento_complexity':"), 'Handler exists');
  assert(source.includes('threshold'), 'Schema includes threshold');
  assert(source.includes('cyclomaticComplexity'), 'References cyclomatic complexity');
  assert(source.includes('analyzeComplexity'), 'Calls analyzeComplexity function');
}

async function testAnalyzeDiffIntegration() {
  console.log('\n── Diff Analysis Integration ──');

  try {
    const { analyzeCommit, getStagedDiff, analyzeFileDiff } = await import('ruvector/dist/core/diff-embeddings.js');

    assert(typeof analyzeCommit === 'function', 'analyzeCommit is a function');
    assert(typeof getStagedDiff === 'function', 'getStagedDiff is a function');
    assert(typeof analyzeFileDiff === 'function', 'analyzeFileDiff is a function');

    // Call getStagedDiff (should return empty string if nothing staged)
    const diff = getStagedDiff();
    assert(typeof diff === 'string', 'getStagedDiff returns a string');
  } catch (err) {
    log('FAIL', 'Diff analysis import', err.message);
  }
}

async function testComplexityIntegration() {
  console.log('\n── Complexity Analysis Integration ──');

  try {
    const { analyzeFiles, getComplexityRating } = await import('ruvector/dist/analysis/complexity.js');

    assert(typeof analyzeFiles === 'function', 'analyzeFiles is a function');
    assert(typeof getComplexityRating === 'function', 'getComplexityRating is a function');

    // Analyze the MCP server source itself
    const serverPath = path.join(SRC_DIR, 'mcp-server.js');
    const results = analyzeFiles([serverPath]);
    assert(Array.isArray(results), 'analyzeFiles returns array');

    if (results.length > 0) {
      const r = results[0];
      assert(typeof r.cyclomaticComplexity === 'number', 'Has cyclomaticComplexity');
      assert(typeof r.functions === 'number', 'Has function count');
      assert(typeof r.lines === 'number', 'Has line count');

      const rating = getComplexityRating(r.cyclomaticComplexity);
      assert(typeof rating === 'string', 'getComplexityRating returns string');
      assert(['low', 'medium', 'high', 'critical'].includes(rating), `Rating is valid: ${rating}`);
    }
  } catch (err) {
    log('FAIL', 'Complexity analysis import', err.message);
  }
}

// ─── Result Normalization Tests ─────────────────────────────────

async function testResultNormalization() {
  console.log('\n── Result Normalization ──');

  const source = await readFile(path.join(SRC_DIR, 'mcp-server.js'), 'utf-8');

  // Verify normalizeResult handles Rust snake_case to JS camelCase
  assert(source.includes('meta.file_type'), 'Handles Rust file_type field');
  assert(source.includes('meta.class_name'), 'Handles Rust class_name field');
  assert(source.includes('meta.method_name'), 'Handles Rust method_name field');
  assert(source.includes('meta.magento_type'), 'Handles Rust magento_type field');
  assert(source.includes('meta.is_plugin'), 'Handles Rust is_plugin field');
  assert(source.includes('meta.is_controller'), 'Handles Rust is_controller field');
  assert(source.includes('meta.is_observer'), 'Handles Rust is_observer field');
  assert(source.includes('meta.is_repository'), 'Handles Rust is_repository field');
  assert(source.includes('meta.is_resolver'), 'Handles Rust is_resolver field');
  assert(source.includes('meta.is_model'), 'Handles Rust is_model field');
  assert(source.includes('meta.is_block'), 'Handles Rust is_block field');
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         MAGECTOR MCP SERVER AUTO TESTS                   ║');
  console.log('║         (Rust core backend, no JS indexer)               ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // Rust core tests
  await testRustBinaryExists();
  await testRustStats();

  // MCP source verification
  await testMcpToolSchemas();
  await testMcpResources();

  // Clean architecture
  await testNoJsIndexer();
  await testIndexerFileRemoved();

  // Analysis tools
  await testAnalyzeDiffSchema();
  await testComplexitySchema();
  await testAnalyzeDiffIntegration();
  await testComplexityIntegration();

  // Result normalization
  await testResultNormalization();

  // Summary
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`  Total:   ${passed + failed + skipped} tests\n`);

  if (failed > 0) {
    console.log('  FAILED tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    });
    console.log('');
  }

  const exitCode = failed > 0 ? 1 : 0;
  console.log(failed === 0 ? '  All tests passed!' : `  ${failed} test(s) failed.`);
  process.exit(exitCode);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

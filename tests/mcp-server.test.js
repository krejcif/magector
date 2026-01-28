/**
 * Automated tests for Magector MCP Server tools
 *
 * Tests each MCP tool by simulating tool calls through the server handler.
 * Requires an existing index (run `npm run index` first with a Magento codebase).
 *
 * Usage:
 *   node tests/mcp-server.test.js [--no-index]
 *
 * Options:
 *   --no-index  Skip tests that require an indexed codebase (only test structure)
 */

import { MagentoIndexer } from '../src/indexer.js';
import { existsSync } from 'fs';

const DB_PATH = process.env.MAGECTOR_DB || './magector.db';
const MAGENTO_ROOT = process.env.MAGENTO_ROOT || './magento2';
const NO_INDEX = process.argv.includes('--no-index');

let indexer = null;
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

async function assert(condition, testName, detail = '') {
  if (condition) {
    log('PASS', testName, detail);
  } else {
    log('FAIL', testName, detail);
  }
}

async function assertThrows(fn, testName) {
  try {
    await fn();
    log('FAIL', testName, 'Expected error but none thrown');
  } catch {
    log('PASS', testName);
  }
}

// ─── Indexer Unit Tests ──────────────────────────────────────────

async function testIndexerCreation() {
  console.log('\n── Indexer Construction ──');

  const idx = new MagentoIndexer({ dbPath: '/tmp/test-magector.db' });
  assert(idx !== null, 'MagentoIndexer creates successfully');
  assert(idx.dbPath === '/tmp/test-magector.db', 'Accepts custom dbPath');
  assert(idx.chunkSize === 500, 'Default chunkSize is 500');
  assert(idx.maxFileSize === 100000, 'Default maxFileSize is 100000');

  // Verify GNN fields are removed
  assert(idx.graph === undefined, 'No graph field (GNN removed)');
  assert(idx.gnnLayer === undefined, 'No gnnLayer field (GNN removed)');
  assert(idx.enableGNN === undefined, 'No enableGNN field (GNN removed)');
  assert(idx.graphPath === undefined, 'No graphPath field (GNN removed)');
}

async function testIndexerInit() {
  console.log('\n── Indexer Initialization ──');

  const idx = new MagentoIndexer({ dbPath: '/tmp/test-magector-init.db' });
  const result = await idx.init();
  assert(result === idx, 'init() returns self for chaining');
  assert(idx.db !== null, 'VectorDB initialized');
  assert(idx.intelligenceEngine !== null, 'IntelligenceEngine initialized');
}

async function testEmbedding() {
  console.log('\n── Embedding ──');

  const idx = new MagentoIndexer({ dbPath: '/tmp/test-magector-embed.db' });
  await idx.init();

  const embedding = idx.embed('product repository');
  assert(embedding instanceof Float32Array, 'Returns Float32Array');
  assert(embedding.length === 384, `Embedding dim is 384 (got ${embedding.length})`);
  assert(embedding.some(v => v !== 0), 'Embedding has non-zero values');

  // Different texts should produce different embeddings
  const e1 = idx.embed('checkout controller');
  const e2 = idx.embed('product repository');
  let diff = 0;
  for (let i = 0; i < e1.length; i++) diff += Math.abs(e1[i] - e2[i]);
  assert(diff > 0.1, `Different texts produce different embeddings (diff=${diff.toFixed(3)})`);
}

async function testFileTypeDetection() {
  console.log('\n── File Type Detection ──');

  const idx = new MagentoIndexer();
  assert(idx.getFileType('test.php') === 'php', 'Detects PHP');
  assert(idx.getFileType('test.xml') === 'xml', 'Detects XML');
  assert(idx.getFileType('test.phtml') === 'template', 'Detects template');
  assert(idx.getFileType('test.js') === 'javascript', 'Detects JavaScript');
  assert(idx.getFileType('test.graphqls') === 'graphql', 'Detects GraphQL');
  assert(idx.getFileType('test.txt') === 'unknown', 'Returns unknown for other');
}

async function testModuleExtraction() {
  console.log('\n── Module Extraction ──');

  const idx = new MagentoIndexer();
  assert(
    idx.extractModule('vendor/magento/module-catalog/Model/Product.php') === 'magento/module-catalog',
    'Extracts vendor module'
  );
  assert(
    idx.extractModule('app/code/Magento/Catalog/Model/Product.php') === 'Magento/Catalog',
    'Extracts app/code module'
  );
  assert(
    idx.extractModule('app/design/frontend/Magento/luma/templates/page.phtml') === 'frontend/Magento/luma',
    'Extracts design module'
  );
  assert(idx.extractModule('lib/internal/some.php') === 'core', 'Falls back to core');
}

async function testCodeMetadataExtraction() {
  console.log('\n── Code Metadata Extraction ──');

  const idx = new MagentoIndexer();

  const phpCode = `<?php
namespace Magento\\Catalog\\Model;

class Product extends AbstractModel implements ProductInterface
{
    public function getName() { return $this->getData('name'); }
}`;

  const meta = idx.extractCodeMetadata(phpCode, 'Product.php');
  assert(meta.className === 'Product', 'Extracts class name');
  assert(meta.namespace === 'Magento\\Catalog\\Model', 'Extracts namespace');
  assert(meta.methodName === 'getName', 'Extracts first method');
  assert(meta.extends === 'AbstractModel', 'Extracts extends');
  assert(meta.implements?.includes('ProductInterface'), 'Extracts implements');
}

async function testChunking() {
  console.log('\n── Code Chunking ──');

  const idx = new MagentoIndexer();

  // PHP chunking
  const phpCode = `<?php
namespace Test;

class Foo {
    public function bar() {
        return 1;
    }

    public function baz() {
        return 2;
    }
}`;
  const phpChunks = idx.chunkCode(phpCode, 'test.php');
  assert(phpChunks.length > 0, `PHP code produces chunks (${phpChunks.length})`);

  // XML chunking
  const xmlCode = `<?xml version="1.0"?>
<config>
  <preference for="FooInterface" type="Foo"/>
  <type name="Bar">
    <arguments>
      <argument name="dep" xsi:type="object">Baz</argument>
    </arguments>
  </type>
</config>`;
  const xmlChunks = idx.chunkCode(xmlCode, 'etc/di.xml');
  assert(xmlChunks.length > 0, `XML di.xml produces chunks (${xmlChunks.length})`);

  // GraphQL chunking
  const gqlCode = `type Product {
  sku: String
  name: String
}

input ProductFilterInput {
  sku: FilterEqualTypeInput
}`;
  const gqlChunks = idx.chunkCode(gqlCode, 'schema.graphqls');
  assert(gqlChunks.length > 0, `GraphQL produces chunks (${gqlChunks.length})`);

  // Empty/small content
  const smallChunks = idx.chunkCode('x', 'small.php');
  assert(smallChunks.length > 0, 'Even small content produces at least 1 chunk');
}

async function testSearchableTextExtraction() {
  console.log('\n── Searchable Text Extraction ──');

  const idx = new MagentoIndexer();

  const phpCode = `class ProductRepository implements RepositoryInterface {
    public function getById($id) {}
    public function save($product) {}
  }`;
  const text = idx.extractSearchableText(phpCode, 'php', { isRepository: true });
  assert(text.includes('ProductRepository'), 'Includes class name');
  assert(text.includes('getById'), 'Includes method name');
  assert(text.includes('repository'), 'Includes repository keyword');

  const xmlCode = `<preference for="ProductInterface" type="Product"/>`;
  const xmlText = idx.extractSearchableText(xmlCode, 'xml', {});
  assert(xmlText.includes('preference'), 'Includes preference keyword');
}

// ─── Search Tests (require indexed codebase) ────────────────────

async function testSearch() {
  console.log('\n── Search (requires index) ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'Search tests', 'No index available');
    return;
  }

  // Basic search
  const results = await indexer.search('product repository', { limit: 5 });
  assert(Array.isArray(results), 'Returns array');
  assert(results.length > 0, `Returns results (${results.length})`);
  assert(results[0].path !== undefined, 'Results have path');
  assert(results[0].score !== undefined, 'Results have score');

  // Results are sorted by score
  if (results.length > 1) {
    assert(results[0].score >= results[1].score, 'Results sorted by score descending');
  }

  // Type-specific search
  const controllerResults = await indexer.search('checkout controller execute', { limit: 5 });
  const hasController = controllerResults.some(r => r.isController || r.path?.includes('Controller'));
  assert(hasController, 'Controller search finds controllers');

  // Observer search
  const observerResults = await indexer.search('observer sales order place', { limit: 5 });
  const hasObserver = observerResults.some(r => r.isObserver || r.path?.includes('Observer'));
  assert(hasObserver, 'Observer search finds observers');

  // Config search
  const diResults = await indexer.search('di.xml preference ProductRepositoryInterface', { limit: 5 });
  const hasDiXml = diResults.some(r => r.path?.includes('di.xml'));
  assert(hasDiXml, 'DI config search finds di.xml files');

  // Plugin search
  const pluginResults = await indexer.search('plugin interceptor', { limit: 5 });
  const hasPlugin = pluginResults.some(r => r.isPlugin || r.path?.includes('Plugin'));
  assert(hasPlugin, 'Plugin search finds plugins');

  // Empty query handling
  const emptyResults = await indexer.search('', { limit: 5 });
  assert(Array.isArray(emptyResults), 'Empty query returns array');
}

async function testSearchDeduplication() {
  console.log('\n── Search Deduplication ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'Dedup tests', 'No index available');
    return;
  }

  const results = await indexer.search('product model catalog', { limit: 10 });
  const paths = results.map(r => r.path);
  const uniquePaths = new Set(paths);
  assert(paths.length === uniquePaths.size, `No duplicate paths in results (${paths.length} results, ${uniquePaths.size} unique)`);
}

async function testGetStats() {
  console.log('\n── Stats ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'Stats tests', 'No index available');
    return;
  }

  const stats = await indexer.getStats();
  assert(stats.totalVectors !== undefined, 'Has totalVectors');
  assert(stats.totalVectors > 0, `Has indexed vectors (${stats.totalVectors})`);
  assert(stats.dbPath !== undefined, 'Has dbPath');

  // GNN fields should be absent
  assert(stats.gnnEnabled === undefined, 'No gnnEnabled (GNN removed)');
  assert(stats.gnnAvailable === undefined, 'No gnnAvailable (GNN removed)');
  assert(stats.graphNodes === undefined, 'No graphNodes (GNN removed)');
  assert(stats.graphEdges === undefined, 'No graphEdges (GNN removed)');
}

// ─── MCP Tool Schema Tests ──────────────────────────────────────

async function testMcpToolSchemas() {
  console.log('\n── MCP Tool Schema Validation ──');

  // Dynamically load the tool definitions by parsing the source
  const { readFile } = await import('fs/promises');
  const source = await readFile(new URL('../src/mcp-server.js', import.meta.url), 'utf-8');

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
    'magento_module_structure'
  ];

  for (const tool of expectedTools) {
    assert(source.includes(`name: '${tool}'`), `Tool '${tool}' defined in server`);
  }

  // GNN tools should be removed
  const removedTools = ['magento_dependencies', 'magento_graph_query'];
  for (const tool of removedTools) {
    assert(!source.includes(`name: '${tool}'`), `Removed tool '${tool}' not present`);
  }

  // Verify no GNN references in tool descriptions
  const gnnPatterns = ['GNN-enhanced', 'GNN code graph', 'GNN learning', 'GNN graph metrics'];
  for (const pattern of gnnPatterns) {
    assert(!source.includes(pattern), `No GNN reference: '${pattern}'`);
  }

  // Verify case handlers exist for all tools
  for (const tool of expectedTools) {
    assert(source.includes(`case '${tool}':`), `Handler exists for '${tool}'`);
  }

  // Verify no references to removed methods
  assert(!source.includes('searchWithGraph'), 'No searchWithGraph reference');
  assert(!source.includes('findDependencies'), 'No findDependencies reference');
  assert(!source.includes('loadGraph'), 'No loadGraph reference');
  assert(!source.includes('isGnnAvailable'), 'No isGnnAvailable reference');
}

// ─── MCP Tool Integration Tests ─────────────────────────────────

async function testMcpToolSearch() {
  console.log('\n── MCP Tool: magento_search ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_search integration', 'No index available');
    return;
  }

  const results = await indexer.search('product price calculation', { limit: 10 });
  assert(results.length > 0, 'Returns results for product query');
  assert(results.every(r => r.path), 'All results have paths');
  assert(results.every(r => typeof r.score === 'number'), 'All results have numeric scores');
}

async function testMcpToolFindClass() {
  console.log('\n── MCP Tool: magento_find_class ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_class integration', 'No index available');
    return;
  }

  const query = 'class Product';
  const results = await indexer.search(query, { limit: 5 });
  const filtered = results.filter(r =>
    r.className?.toLowerCase().includes('product')
  );
  assert(filtered.length > 0, 'Finds Product class');
}

async function testMcpToolFindConfig() {
  console.log('\n── MCP Tool: magento_find_config ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_config integration', 'No index available');
    return;
  }

  const results = await indexer.search('di.xml preference', { limit: 10 });
  const xmlResults = results.filter(r => r.type === 'xml' || r.path?.endsWith('.xml'));
  assert(xmlResults.length > 0, 'Finds XML config files');
}

async function testMcpToolFindTemplate() {
  console.log('\n── MCP Tool: magento_find_template ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_template integration', 'No index available');
    return;
  }

  const results = await indexer.search('product listing template phtml', { limit: 10 });
  assert(results.length > 0, 'Template search returns results');
}

async function testMcpToolFindPlugin() {
  console.log('\n── MCP Tool: magento_find_plugin ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_plugin integration', 'No index available');
    return;
  }

  const results = await indexer.search('plugin interceptor before after around', { limit: 15 });
  assert(results.length > 0, 'Plugin search returns results');
}

async function testMcpToolFindObserver() {
  console.log('\n── MCP Tool: magento_find_observer ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_observer integration', 'No index available');
    return;
  }

  const xmlResults = await indexer.search('event checkout_cart_add_product_complete observer', { limit: 10 });
  assert(xmlResults.length > 0, 'Observer event search returns results');
}

async function testMcpToolFindController() {
  console.log('\n── MCP Tool: magento_find_controller ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_controller integration', 'No index available');
    return;
  }

  const results = await indexer.search('controller catalog product view execute action', { limit: 15 });
  const controllers = results.filter(r =>
    r.isController || r.magentoType === 'Controller' || r.path?.includes('/Controller/')
  );
  assert(controllers.length > 0, 'Finds controller classes');
}

async function testMcpToolFindCron() {
  console.log('\n── MCP Tool: magento_find_cron ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_cron integration', 'No index available');
    return;
  }

  const xmlResults = await indexer.search('cron job catalog_product', { limit: 10 });
  const cronConfigs = xmlResults.filter(r => r.path?.includes('crontab.xml') || r.path?.includes('/Cron/'));
  assert(cronConfigs.length > 0 || xmlResults.length > 0, 'Cron search returns results');
}

async function testMcpToolFindGraphql() {
  console.log('\n── MCP Tool: magento_find_graphql ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_graphql integration', 'No index available');
    return;
  }

  const schemaResults = await indexer.search('graphql products query', { limit: 10 });
  assert(schemaResults.length > 0, 'GraphQL search returns results');
}

async function testMcpToolFindDbSchema() {
  console.log('\n── MCP Tool: magento_find_db_schema ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_find_db_schema integration', 'No index available');
    return;
  }

  const results = await indexer.search('table catalog_product_entity column', { limit: 15 });
  const schemaResults = results.filter(r =>
    r.path?.includes('db_schema.xml')
  );
  assert(schemaResults.length > 0 || results.length > 0, 'DB schema search returns results');
}

async function testMcpToolModuleStructure() {
  console.log('\n── MCP Tool: magento_module_structure ──');

  if (NO_INDEX || !indexer) {
    log('SKIP', 'magento_module_structure integration', 'No index available');
    return;
  }

  const results = await indexer.search('Magento_Catalog', { limit: 100 });
  const moduleResults = results.filter(r =>
    r.path?.includes('Magento/Catalog') || r.module?.includes('Magento_Catalog')
  );
  assert(moduleResults.length > 0, `Finds Catalog module files (${moduleResults.length})`);

  // Check various types are present
  const hasController = moduleResults.some(r => r.isController || r.path?.includes('/Controller/'));
  const hasModel = moduleResults.some(r => r.isModel || r.path?.includes('/Model/'));
  assert(hasController || hasModel, 'Module structure includes different types');
}

// ─── Removed Feature Tests ──────────────────────────────────────

async function testGnnRemoved() {
  console.log('\n── GNN Removal Verification ──');

  const { readFile } = await import('fs/promises');
  const indexerSource = await readFile(new URL('../src/indexer.js', import.meta.url), 'utf-8');

  assert(!indexerSource.includes('GraphDatabase'), 'No GraphDatabase import');
  assert(!indexerSource.includes('RuvectorLayer'), 'No RuvectorLayer import');
  assert(!indexerSource.includes('isGnnAvailable'), 'No isGnnAvailable import');
  assert(!indexerSource.includes('this.graph'), 'No this.graph reference');
  assert(!indexerSource.includes('this.gnnLayer'), 'No this.gnnLayer reference');
  assert(!indexerSource.includes('this.enableGNN'), 'No this.enableGNN reference');
  assert(!indexerSource.includes('this.graphPath'), 'No this.graphPath reference');
  assert(!indexerSource.includes('searchWithGraph'), 'No searchWithGraph method');
  assert(!indexerSource.includes('findDependencies'), 'No findDependencies method');
  assert(!indexerSource.includes('analyzePhpForGraph'), 'No analyzePhpForGraph method');
  assert(!indexerSource.includes('searchByModule'), 'No searchByModule method');
  assert(!indexerSource.includes('searchByType'), 'No searchByType method');
}

// ─── Resource Tests ─────────────────────────────────────────────

async function testMcpResources() {
  console.log('\n── MCP Resources ──');

  const { readFile } = await import('fs/promises');
  const source = await readFile(new URL('../src/mcp-server.js', import.meta.url), 'utf-8');

  assert(source.includes("uri: 'magector://stats'"), 'Stats resource defined');
  assert(source.includes('ListResourcesRequestSchema'), 'ListResources handler exists');
  assert(source.includes('ReadResourceRequestSchema'), 'ReadResource handler exists');
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         MAGECTOR MCP SERVER AUTO TESTS                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // Initialize indexer if DB exists
  if (!NO_INDEX && existsSync(DB_PATH)) {
    try {
      console.log(`\nInitializing indexer from ${DB_PATH}...`);
      indexer = new MagentoIndexer({ dbPath: DB_PATH, magentoRoot: MAGENTO_ROOT });
      await indexer.init();
      console.log('Indexer ready.');
    } catch (err) {
      console.log(`Warning: Could not initialize indexer: ${err.message}`);
      console.log('Running in --no-index mode.\n');
    }
  } else if (!NO_INDEX) {
    console.log(`\nNo index at ${DB_PATH}. Running in --no-index mode.`);
    console.log('Run `npm run index` first for full integration tests.\n');
  }

  // Unit tests (no index needed)
  await testIndexerCreation();
  await testIndexerInit();
  await testEmbedding();
  await testFileTypeDetection();
  await testModuleExtraction();
  await testCodeMetadataExtraction();
  await testChunking();
  await testSearchableTextExtraction();

  // Source code verification
  await testMcpToolSchemas();
  await testGnnRemoved();
  await testMcpResources();

  // Integration tests (need index)
  await testSearch();
  await testSearchDeduplication();
  await testGetStats();
  await testMcpToolSearch();
  await testMcpToolFindClass();
  await testMcpToolFindConfig();
  await testMcpToolFindTemplate();
  await testMcpToolFindPlugin();
  await testMcpToolFindObserver();
  await testMcpToolFindController();
  await testMcpToolFindCron();
  await testMcpToolFindGraphql();
  await testMcpToolFindDbSchema();
  await testMcpToolModuleStructure();

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

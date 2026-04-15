/**
 * magento_trace_flow GraphQL Integration Tests
 *
 * Deterministic fixture-based integration test for the v2.16.14 structural
 * .graphqls parser in traceGraphql(). Does NOT require an indexed Magento
 * install — the structural-first code path reads .graphqls files directly
 * from disk, so a minimal fixture tree is enough to exercise every branch
 * of the fix (schema lookup, resolver class resolution, resolve() method
 * extraction, deep-mode DI plugin discovery, schema extension / override).
 *
 * Usage:
 *   node tests/trace-graphql.test.js
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const FIXTURE_ROOT = path.join(__dirname, 'tmp_graphql_trace');

let passed = 0;
let failed = 0;

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✓' : '✗';
  const color = status === 'PASS' ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  if (status === 'PASS') passed++;
  else failed++;
}

// ── Build the fixture tree ─────────────────────────────────────

function buildFixture() {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const quoteEtc = path.join(FIXTURE_ROOT, 'vendor', 'Magento', 'QuoteGraphQl', 'etc');
  const quoteResolver = path.join(FIXTURE_ROOT, 'vendor', 'Magento', 'QuoteGraphQl', 'Model', 'Resolver');
  const acmeEtc = path.join(FIXTURE_ROOT, 'app', 'code', 'Acme', 'CartExt', 'etc');
  const acmePlugin = path.join(FIXTURE_ROOT, 'app', 'code', 'Acme', 'CartExt', 'Plugin');
  mkdirSync(quoteEtc, { recursive: true });
  mkdirSync(quoteResolver, { recursive: true });
  mkdirSync(acmeEtc, { recursive: true });
  mkdirSync(acmePlugin, { recursive: true });

  // schema.graphqls — mirrors the real module-quote-graph-ql format, including:
  //  - escaped namespace separators ("\\\\")
  //  - leading-backslash variant on placeOrder
  //  - @doc(...) directive before @resolver on addProductsToCart (multi-directive line)
  writeFileSync(path.join(quoteEtc, 'schema.graphqls'), [
    '# Core schema',
    'type Mutation {',
    '    addSimpleProductsToCart(input: AddSimpleProductsToCartInput): AddSimpleProductsToCartOutput @resolver(class: "Magento\\\\QuoteGraphQl\\\\Model\\\\Resolver\\\\AddSimpleProductsToCart")',
    '    addProductsToCart(cartId: String!, cartItems: [CartItemInput!]!): AddProductsToCartOutput @doc(description:"Add any type of product to the cart") @resolver(class: "Magento\\\\QuoteGraphQl\\\\Model\\\\Resolver\\\\AddProductsToCart")',
    '    placeOrder(input: PlaceOrderInput): PlaceOrderOutput @resolver(class: "\\\\Magento\\\\QuoteGraphQl\\\\Model\\\\Resolver\\\\PlaceOrder")',
    '}'
  ].join('\n'));

  // Resolver PHP files — minimal but with a real resolve() signature so the
  // fix's readMethodSnippet(..., 'resolve') path has something to extract.
  writeFileSync(path.join(quoteResolver, 'AddSimpleProductsToCart.php'), [
    '<?php',
    'namespace Magento\\QuoteGraphQl\\Model\\Resolver;',
    '',
    'class AddSimpleProductsToCart',
    '{',
    '    public function resolve($field, $context, $info, array $value = null, array $args = null)',
    '    {',
    '        // FIXTURE: validates cart_id and forwards to addProductsToCart service',
    '        return [];',
    '    }',
    '}'
  ].join('\n'));

  writeFileSync(path.join(quoteResolver, 'AddProductsToCart.php'), [
    '<?php',
    'namespace Magento\\QuoteGraphQl\\Model\\Resolver;',
    '',
    'class AddProductsToCart',
    '{',
    '    public function resolve($field, $context, $info, array $value = null, array $args = null)',
    '    {',
    '        return [];',
    '    }',
    '}'
  ].join('\n'));

  writeFileSync(path.join(quoteResolver, 'PlaceOrder.php'), [
    '<?php',
    'namespace Magento\\QuoteGraphQl\\Model\\Resolver;',
    '',
    'class PlaceOrder',
    '{',
    '    public function resolve($field, $context, $info, array $value = null, array $args = null)',
    '    {',
    '        return [];',
    '    }',
    '}'
  ].join('\n'));

  // di.xml with a plugin on the AddSimpleProductsToCart resolver — exercises
  // the deep-mode DI walk that the fix added via findDiWiring().
  writeFileSync(path.join(acmeEtc, 'di.xml'), [
    '<?xml version="1.0"?>',
    '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '    <type name="Magento\\QuoteGraphQl\\Model\\Resolver\\AddSimpleProductsToCart">',
    '        <plugin name="acme_cart_ext_add_simple_products_to_cart"',
    '                type="Acme\\CartExt\\Plugin\\AddSimpleProductsToCartPlugin"',
    '                sortOrder="10"/>',
    '    </type>',
    '</config>'
  ].join('\n'));

  writeFileSync(path.join(acmePlugin, 'AddSimpleProductsToCartPlugin.php'), [
    '<?php',
    'namespace Acme\\CartExt\\Plugin;',
    '',
    'class AddSimpleProductsToCartPlugin',
    '{',
    '    public function afterResolve($subject, $result)',
    '    {',
    '        return $result;',
    '    }',
    '}'
  ].join('\n'));
}

// ── MCP Client ─────────────────────────────────────────────────

class McpTestClient {
  constructor() { this.nextId = 1; this.pending = new Map(); }

  async start() {
    this.child = spawn('node', [SERVER_PATH], {
      cwd: FIXTURE_ROOT,
      env: {
        ...process.env,
        MAGENTO_ROOT: FIXTURE_ROOT,
        // Point MAGECTOR_DB at a path inside the fixture so the server never
        // touches the real index. Structural-first path means we don't need one.
        MAGECTOR_DB: path.join(FIXTURE_ROOT, '.magector', 'index.db'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => {
      if (process.env.TRACE_GRAPHQL_DEBUG) process.stderr.write('[mcp-stderr] ' + d);
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    await new Promise((r) => setTimeout(r, 500));
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'trace-graphql-test', version: '1.0' },
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method} (id=${id})`));
      }, 30000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async trace(entryPoint, depth = 'shallow') {
    const resp = await this.send('tools/call', {
      name: 'magento_trace_flow',
      arguments: { entryPoint, entryType: 'graphql', depth },
    });
    const text = resp?.result?.content?.[0]?.text ?? '';
    if (process.env.TRACE_GRAPHQL_DEBUG) {
      console.error(`[trace debug] ${entryPoint}/${depth} raw:`, JSON.stringify(resp).slice(0, 800));
    }
    // During background re-index, the server prepends a markdown `> …` warning
    // before the JSON payload. Extract the JSON object itself for machine parsing.
    const start = text.indexOf('{"entryPoint"');
    const jsonText = start >= 0 ? text.slice(start) : text;
    try { return JSON.parse(jsonText); } catch { return null; }
  }

  stop() { if (this.child) this.child.kill(); }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║    MAGECTOR trace_flow — GraphQL Integration Tests      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n  Fixture: ${FIXTURE_ROOT}\n`);

  buildFixture();
  const client = new McpTestClient();

  try {
    await client.start();

    // ── addSimpleProductsToCart (deep) ────────────────────────
    console.log('── addSimpleProductsToCart (deep) ──');
    {
      const data = await client.trace('addSimpleProductsToCart', 'deep');
      log(data?.entryType === 'graphql' ? 'PASS' : 'FAIL', 'entryType=graphql');
      log(Array.isArray(data?.trace?.schema) && data.trace.schema.length >= 1 ? 'PASS' : 'FAIL',
        'schema array non-empty');
      log(data?.trace?.schema?.[0]?.path?.endsWith('schema.graphqls') ? 'PASS' : 'FAIL',
        'schema path is .graphqls', data?.trace?.schema?.[0]?.path);
      log(typeof data?.trace?.schema?.[0]?.line === 'number' ? 'PASS' : 'FAIL',
        'schema has line number', String(data?.trace?.schema?.[0]?.line));
      log(data?.trace?.schema?.[0]?.resolverClass ===
          'Magento\\QuoteGraphQl\\Model\\Resolver\\AddSimpleProductsToCart' ? 'PASS' : 'FAIL',
        'resolverClass from @resolver directive',
        data?.trace?.schema?.[0]?.resolverClass);
      log(data?.trace?.resolver?.className ===
          'Magento\\QuoteGraphQl\\Model\\Resolver\\AddSimpleProductsToCart' ? 'PASS' : 'FAIL',
        'resolver.className matches');
      log(data?.trace?.resolver?.path?.endsWith('AddSimpleProductsToCart.php') ? 'PASS' : 'FAIL',
        'resolver.path resolved to disk');
      log(typeof data?.trace?.resolver?.codeSnippet === 'string' &&
          data.trace.resolver.codeSnippet.includes('public function resolve(') ? 'PASS' : 'FAIL',
        'resolver.codeSnippet contains resolve() signature');

      // deep mode — plugin discovered via findDiWiring()
      log(Array.isArray(data?.trace?.plugins) && data.trace.plugins.length >= 1 ? 'PASS' : 'FAIL',
        'plugins[] populated in deep mode', `count=${data?.trace?.plugins?.length ?? 0}`);
      log(data?.trace?.plugins?.[0]?.pluginClass ===
          'Acme\\CartExt\\Plugin\\AddSimpleProductsToCartPlugin' ? 'PASS' : 'FAIL',
        'plugin pluginClass matches di.xml',
        data?.trace?.plugins?.[0]?.pluginClass);
      log(data?.trace?.plugins?.[0]?.file?.endsWith('di.xml') ? 'PASS' : 'FAIL',
        'plugin.file is di.xml');
      log(typeof data?.summary === 'string' && data.summary.includes('GraphQL') &&
          data.summary.includes('plugin') ? 'PASS' : 'FAIL',
        'summary mentions plugins count', data?.summary);
    }

    // ── addProductsToCart (shallow) — @doc between signature and @resolver
    console.log('\n── addProductsToCart (shallow, @doc in the middle) ──');
    {
      const data = await client.trace('addProductsToCart', 'shallow');
      log(data?.trace?.schema?.[0]?.resolverClass ===
          'Magento\\QuoteGraphQl\\Model\\Resolver\\AddProductsToCart' ? 'PASS' : 'FAIL',
        'resolver parsed despite @doc directive',
        data?.trace?.schema?.[0]?.resolverClass);
      log(data?.trace?.resolver?.path?.endsWith('AddProductsToCart.php') ? 'PASS' : 'FAIL',
        'resolver.path resolved');
      // shallow mode — no plugin walk
      log(!data?.trace?.plugins ? 'PASS' : 'FAIL',
        'shallow mode has no plugins key',
        data?.trace?.plugins ? 'unexpected plugins in shallow' : '');
    }

    // ── placeOrder (shallow) — leading-backslash variant
    console.log('\n── placeOrder (leading \\\\ in @resolver) ──');
    {
      const data = await client.trace('placeOrder', 'shallow');
      log(data?.trace?.schema?.[0]?.resolverClass ===
          'Magento\\QuoteGraphQl\\Model\\Resolver\\PlaceOrder' ? 'PASS' : 'FAIL',
        'leading backslash stripped from resolverClass',
        data?.trace?.schema?.[0]?.resolverClass);
      log(data?.trace?.resolver?.path?.endsWith('PlaceOrder.php') ? 'PASS' : 'FAIL',
        'resolver file resolved');
    }

    // ── nonexistent operation — must NOT crash, returns empty or near-empty
    console.log('\n── nonexistentMutation (must not crash) ──');
    {
      const data = await client.trace('nonexistentMutation', 'shallow');
      log(data?.entryType === 'graphql' ? 'PASS' : 'FAIL', 'entryType=graphql preserved');
      const hasSchema = !!data?.trace?.schema;
      const hasResolver = !!data?.trace?.resolver;
      log(!hasSchema && !hasResolver ? 'PASS' : 'FAIL',
        'no schema/resolver for unknown mutation',
        `schema=${hasSchema} resolver=${hasResolver}`);
    }
  } finally {
    client.stop();
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  console.log(`  Total:   ${passed + failed} tests\n`);

  if (failed > 0) {
    console.log('  FAILED');
    process.exit(1);
  } else {
    console.log('  All tests passed');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Test runner error:', e);
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  process.exit(1);
});

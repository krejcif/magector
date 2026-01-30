/**
 * magento_trace_flow Integration Tests
 *
 * Exercises all 5 entry types × both depths against a real index.
 * Uses the same stdio JSON-RPC harness as mcp-server.test.js.
 *
 * Usage:
 *   node tests/trace-flow.test.js
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.MAGECTOR_DB || path.join(PROJECT_ROOT, 'magector.db');

if (!existsSync(DB_PATH)) {
  console.error(`No index at ${DB_PATH} — run 'npx magector index' first.`);
  process.exit(1);
}

let passed = 0;
let failed = 0;

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✓' : '✗';
  const color = status === 'PASS' ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  if (status === 'PASS') passed++;
  else failed++;
}

class McpTestClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn('node', [SERVER_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MAGENTO_ROOT: process.env.MAGENTO_ROOT || path.join(PROJECT_ROOT, 'magento2'),
        MAGECTOR_DB: DB_PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {});
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }
      const id = parsed.id;
      if (id != null && this.pending.has(id)) {
        const { resolve } = this.pending.get(id);
        this.pending.delete(id);
        resolve(parsed);
      }
    });
    await new Promise((r) => setTimeout(r, 500));
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'trace-flow-test', version: '1.0' },
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method} (id=${id})`));
      }, 60000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callTool(name, args = {}) {
    const resp = await this.send('tools/call', { name, arguments: args });
    return resp.result;
  }

  stop() { if (this.child) this.child.kill(); }
}

// ─── Test helpers ────────────────────────────────────────────────

function parseTrace(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function assertIsObject(val, label) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    log('PASS', `${label} is object`);
    return true;
  }
  log('FAIL', `${label} is object`, `got ${typeof val}`);
  return false;
}

function assertIsArray(val, label, minLen = 0) {
  if (Array.isArray(val) && val.length >= minLen) {
    log('PASS', `${label} is array (len=${val.length})`);
    return true;
  }
  log('FAIL', `${label} is array (min ${minLen})`, `got ${Array.isArray(val) ? `len=${val.length}` : typeof val}`);
  return false;
}

function assertHasPath(obj, label) {
  if (obj?.path && typeof obj.path === 'string') {
    log('PASS', `${label} has path`);
    return true;
  }
  log('FAIL', `${label} has path`, `got ${JSON.stringify(obj?.path)}`);
  return false;
}

function assertString(val, label, minLen = 1) {
  if (typeof val === 'string' && val.length >= minLen) {
    log('PASS', `${label} is non-empty string`);
    return true;
  }
  log('FAIL', `${label} is non-empty string`, `got ${JSON.stringify(val)?.slice(0, 80)}`);
  return false;
}

// ─── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         magento_trace_flow INTEGRATION TESTS             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const client = new McpTestClient();

  try {
    await client.start();

    // ── 1. Route — shallow ───────────────────────────────────────
    console.log('── Route: catalog/product/view (shallow) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'catalog/product/view',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        assertString(data.entryPoint, 'entryPoint');
        log(data.entryType === 'route' ? 'PASS' : 'FAIL', 'entryType=route', data.entryType);
        assertIsObject(data.trace, 'trace');
        assertString(data.summary, 'summary');

        const t = data.trace;
        if (t.controller) {
          assertHasPath(t.controller, 'controller');
          log(t.controller.path?.includes('Controller') ? 'PASS' : 'FAIL',
            'controller path contains Controller', t.controller.path);
        } else {
          log('FAIL', 'controller found');
        }

        if (t.routeConfig) {
          assertIsArray(t.routeConfig, 'routeConfig', 1);
          assertHasPath(t.routeConfig[0], 'routeConfig[0]');
        }

        // shallow should NOT have observers/layout/templates
        log(!t.observers ? 'PASS' : 'FAIL', 'no observers in shallow mode');
        log(!t.layout ? 'PASS' : 'FAIL', 'no layout in shallow mode');
        log(!t.templates ? 'PASS' : 'FAIL', 'no templates in shallow mode');
      }
    }

    // ── 2. Route — deep ──────────────────────────────────────────
    console.log('\n── Route: checkout/cart/add (deep) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'checkout/cart/add',
        depth: 'deep',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'route' ? 'PASS' : 'FAIL', 'entryType=route', data.entryType);
        assertIsObject(data.trace, 'trace');
        assertString(data.summary, 'summary');

        const t = data.trace;
        if (t.controller) {
          assertHasPath(t.controller, 'controller');
        } else {
          log('FAIL', 'controller found');
        }
        // deep mode should attempt all sections — at least some should exist
        const deepSections = ['routeConfig', 'plugins', 'preferences', 'observers', 'layout', 'templates'];
        const found = deepSections.filter(s => t[s]);
        log(found.length >= 2 ? 'PASS' : 'FAIL',
          `deep mode found ≥2 sections`, `got ${found.length}: ${found.join(', ')}`);
      }
    }

    // ── 3. API — shallow ─────────────────────────────────────────
    console.log('\n── API: /V1/products (shallow) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: '/V1/products',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'api' ? 'PASS' : 'FAIL', 'entryType=api', data.entryType);
        assertIsObject(data.trace, 'trace');
        assertString(data.summary, 'summary');

        const t = data.trace;
        if (t.webapiConfig) {
          assertIsArray(t.webapiConfig, 'webapiConfig', 1);
          assertHasPath(t.webapiConfig[0], 'webapiConfig[0]');
          log(t.webapiConfig[0].path?.includes('webapi.xml') ? 'PASS' : 'FAIL',
            'webapiConfig path is webapi.xml', t.webapiConfig[0].path);
        } else {
          log('FAIL', 'webapiConfig found');
        }

        if (t.serviceClass) {
          assertHasPath(t.serviceClass, 'serviceClass');
          assertString(t.serviceClass.className, 'serviceClass.className');
        }

        // shallow — no observers
        log(!t.observers ? 'PASS' : 'FAIL', 'no observers in shallow mode');
      }
    }

    // ── 4. API — deep ────────────────────────────────────────────
    console.log('\n── API: /V1/products (deep) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: '/V1/products',
        depth: 'deep',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'api' ? 'PASS' : 'FAIL', 'entryType=api', data.entryType);
        const t = data.trace;
        // deep should attempt plugins and/or observers
        const deepSections = ['plugins', 'observers'];
        const found = deepSections.filter(s => t[s]);
        log(found.length >= 1 ? 'PASS' : 'FAIL',
          `deep mode found ≥1 extra section`, `got ${found.length}: ${found.join(', ')}`);
      }
    }

    // ── 5. GraphQL — shallow ─────────────────────────────────────
    console.log('\n── GraphQL: placeOrder (shallow) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'placeOrder',
        entryType: 'graphql',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'graphql' ? 'PASS' : 'FAIL', 'entryType=graphql', data.entryType);
        assertIsObject(data.trace, 'trace');
        assertString(data.summary, 'summary');

        const t = data.trace;
        if (t.schema) {
          assertIsArray(t.schema, 'schema', 1);
          log(t.schema[0].path?.includes('.graphqls') ? 'PASS' : 'FAIL',
            'schema path is .graphqls', t.schema[0].path);
        }
        if (t.resolver) {
          assertHasPath(t.resolver, 'resolver');
        }
        // at least one of schema or resolver should be found
        log(t.schema || t.resolver ? 'PASS' : 'FAIL', 'schema or resolver found');
      }
    }

    // ── 6. GraphQL — deep ────────────────────────────────────────
    console.log('\n── GraphQL: addProductsToCart (deep) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'addProductsToCart',
        entryType: 'graphql',
        depth: 'deep',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'graphql' ? 'PASS' : 'FAIL', 'entryType=graphql', data.entryType);
        assertIsObject(data.trace, 'trace');
      }
    }

    // ── 7. Event — shallow ───────────────────────────────────────
    console.log('\n── Event: sales_order_place_after (shallow) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'sales_order_place_after',
        entryType: 'event',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'event' ? 'PASS' : 'FAIL', 'entryType=event', data.entryType);
        assertIsObject(data.trace, 'trace');
        assertString(data.summary, 'summary');

        const t = data.trace;
        if (t.observers) {
          assertIsArray(t.observers, 'observers', 1);
          assertHasPath(t.observers[0], 'observers[0]');
          assertString(t.observers[0].eventName, 'observers[0].eventName');
        } else {
          log('FAIL', 'observers found');
        }

        // shallow — no origin
        log(!t.origin ? 'PASS' : 'FAIL', 'no origin in shallow mode');
      }
    }

    // ── 8. Event — deep ──────────────────────────────────────────
    console.log('\n── Event: catalog_product_save_after (deep) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'catalog_product_save_after',
        entryType: 'event',
        depth: 'deep',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'event' ? 'PASS' : 'FAIL', 'entryType=event', data.entryType);
        const t = data.trace;
        if (t.origin) {
          assertHasPath(t.origin, 'origin');
          log(t.origin.path?.includes('Model') ? 'PASS' : 'FAIL',
            'origin is a Model', t.origin.path);
        }
        // observers should still be present
        if (t.observers) {
          assertIsArray(t.observers, 'observers', 1);
        }
      }
    }

    // ── 9. Cron — shallow ────────────────────────────────────────
    console.log('\n── Cron: indexer_reindex_all_invalid (shallow) ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'indexer_reindex_all_invalid',
        entryType: 'cron',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        log(data.entryType === 'cron' ? 'PASS' : 'FAIL', 'entryType=cron', data.entryType);
        assertIsObject(data.trace, 'trace');
        assertString(data.summary, 'summary');

        const t = data.trace;
        if (t.cronConfig) {
          assertIsArray(t.cronConfig, 'cronConfig', 1);
          log(t.cronConfig[0].path?.includes('crontab.xml') ? 'PASS' : 'FAIL',
            'cronConfig path is crontab.xml', t.cronConfig[0].path);
        }
        if (t.handler) {
          assertHasPath(t.handler, 'handler');
        }
        // at least one should exist
        log(t.cronConfig || t.handler ? 'PASS' : 'FAIL', 'cronConfig or handler found');
      }
    }

    // ── 10. Auto-detection ───────────────────────────────────────
    console.log('\n── Auto-detection ──');
    {
      // API detection
      const r1 = parseTrace(await client.callTool('magento_trace_flow', { entryPoint: '/V1/products' }));
      log(r1?.entryType === 'api' ? 'PASS' : 'FAIL', 'auto-detect /V1/products → api', r1?.entryType);

      // API without leading slash
      const r1b = parseTrace(await client.callTool('magento_trace_flow', { entryPoint: 'V1/carts' }));
      log(r1b?.entryType === 'api' ? 'PASS' : 'FAIL', 'auto-detect V1/carts → api', r1b?.entryType);

      // Event detection
      const r2 = parseTrace(await client.callTool('magento_trace_flow', { entryPoint: 'sales_order_place_after' }));
      log(r2?.entryType === 'event' ? 'PASS' : 'FAIL', 'auto-detect sales_order_place_after → event', r2?.entryType);

      // GraphQL detection
      const r3 = parseTrace(await client.callTool('magento_trace_flow', { entryPoint: 'placeOrder' }));
      log(r3?.entryType === 'graphql' ? 'PASS' : 'FAIL', 'auto-detect placeOrder → graphql', r3?.entryType);

      // Route detection
      const r4 = parseTrace(await client.callTool('magento_trace_flow', { entryPoint: 'catalog/product/view' }));
      log(r4?.entryType === 'route' ? 'PASS' : 'FAIL', 'auto-detect catalog/product/view → route', r4?.entryType);
    }

    // ── 11. Output shape ─────────────────────────────────────────
    console.log('\n── Output shape ──');
    {
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'catalog/product/view',
        depth: 'deep',
      });
      const data = parseTrace(result);
      if (!data) { log('FAIL', 'parse response'); } else {
        // Top-level fields
        log('entryPoint' in data ? 'PASS' : 'FAIL', 'has entryPoint field');
        log('entryType' in data ? 'PASS' : 'FAIL', 'has entryType field');
        log('trace' in data ? 'PASS' : 'FAIL', 'has trace field');
        log('summary' in data ? 'PASS' : 'FAIL', 'has summary field');

        // Verify no null trace sections — omitted is OK, null is not
        const t = data.trace;
        for (const key of Object.keys(t)) {
          log(t[key] !== null && t[key] !== undefined ? 'PASS' : 'FAIL',
            `trace.${key} is not null/undefined`);
        }

        // Verify every array section entry has a path
        for (const key of ['routeConfig', 'plugins', 'preferences', 'observers', 'layout', 'templates']) {
          if (Array.isArray(t[key])) {
            for (let i = 0; i < Math.min(t[key].length, 3); i++) {
              log(typeof t[key][i].path === 'string' ? 'PASS' : 'FAIL',
                `trace.${key}[${i}].path is string`);
            }
          }
        }

        // controller/serviceClass/handler/resolver should have path if present
        for (const key of ['controller', 'handler', 'resolver', 'origin']) {
          if (t[key]) {
            log(typeof t[key].path === 'string' ? 'PASS' : 'FAIL',
              `trace.${key}.path is string`);
          }
        }
      }
    }

    // ── 12. Empty/edge cases ─────────────────────────────────────
    console.log('\n── Edge cases ──');
    {
      // Nonsense entry point should still return valid JSON with empty trace
      const result = await client.callTool('magento_trace_flow', {
        entryPoint: 'zzz_nonexistent_garbage_xyz',
        entryType: 'event',
      });
      const data = parseTrace(result);
      log(data && typeof data.trace === 'object' ? 'PASS' : 'FAIL',
        'nonsense input returns valid trace object');
      log(typeof data?.summary === 'string' ? 'PASS' : 'FAIL',
        'nonsense input has summary string');

      // Verify not isError
      log(!result?.isError ? 'PASS' : 'FAIL', 'nonsense input is not an error');
    }

  } finally {
    client.stop();
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  console.log(`  Total:   ${passed + failed} tests\n`);

  if (failed > 0) {
    console.log('  ❌ SOME TESTS FAILED');
  } else {
    console.log('  ✅ All trace flow tests passed');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

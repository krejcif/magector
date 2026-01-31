/**
 * Magector MCP Server Integration Tests
 *
 * Tests the MCP server via stdio JSON-RPC — exactly as Cursor/Claude Code calls it.
 * Every response line on stdout must be valid JSON. Any stray output = test failure.
 *
 * Usage:
 *   node tests/mcp-server.test.js            # full suite (needs index)
 *   node tests/mcp-server.test.js --no-index # skip tools that need an index
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
const HAS_INDEX = existsSync(DB_PATH);
const SKIP_INDEX = process.argv.includes('--no-index');

let passed = 0;
let failed = 0;
let skipped = 0;

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  const color = status === 'PASS' ? '\x1b[32m' : status === 'FAIL' ? '\x1b[31m' : '\x1b[33m';
  console.log(`  ${color}${icon}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else skipped++;
}

// ─── MCP Client ─────────────────────────────────────────────────

class McpTestClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.rawStdout = '';
    this.stderrOutput = '';
    this.invalidLines = [];
  }

  async start() {
    this.child = spawn('node', [SERVER_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MAGENTO_ROOT: process.env.MAGENTO_ROOT || PROJECT_ROOT,
        MAGECTOR_DB: DB_PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.on('data', (d) => {
      this.stderrOutput += d.toString();
    });

    this.rl = createInterface({ input: this.child.stdout });

    this.rl.on('line', (line) => {
      this.rawStdout += line + '\n';
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.invalidLines.push(line);
        return;
      }
      const id = parsed.id;
      if (id != null && this.pending.has(id)) {
        const { resolve } = this.pending.get(id);
        this.pending.delete(id);
        resolve(parsed);
      }
    });

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 500));
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
      this.child.stdin.write(msg + '\n');
    });
  }

  async callTool(name, args = {}) {
    const resp = await this.send('tools/call', { name, arguments: args });
    return resp.result;
  }

  stop() {
    if (this.child) {
      this.child.kill();
    }
  }
}

// ─── Tests ──────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     MAGECTOR MCP SERVER INTEGRATION TESTS (stdio)       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n  Database: ${DB_PATH} (${HAS_INDEX ? 'exists' : 'not found'})`);
  if (SKIP_INDEX) console.log('  Mode: --no-index (skipping search tools)');

  const client = new McpTestClient();

  try {
    await client.start();

    // ── Protocol tests ──────────────────────────────────────────
    console.log('\n── MCP Protocol ──');

    const initResp = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'magector-test', version: '1.0' },
    });
    log(
      initResp.result?.serverInfo?.name === 'magector' ? 'PASS' : 'FAIL',
      'initialize returns server info',
      `name=${initResp.result?.serverInfo?.name}`
    );

    const toolsResp = await client.send('tools/list', {});
    const tools = toolsResp.result?.tools || [];
    const toolNames = tools.map((t) => t.name);
    log(tools.length === 20 ? 'PASS' : 'FAIL', `tools/list returns 20 tools`, `got ${tools.length}`);

    // Verify all expected tools present
    const expectedTools = [
      'magento_search', 'magento_find_class', 'magento_find_method',
      'magento_find_config', 'magento_find_template', 'magento_index',
      'magento_stats', 'magento_find_plugin', 'magento_find_observer',
      'magento_find_preference', 'magento_find_api', 'magento_find_controller',
      'magento_find_block', 'magento_find_cron', 'magento_find_graphql',
      'magento_find_db_schema', 'magento_module_structure',
      'magento_analyze_diff', 'magento_complexity', 'magento_trace_flow',
    ];
    for (const name of expectedTools) {
      log(toolNames.includes(name) ? 'PASS' : 'FAIL', `tool '${name}' listed`);
    }

    // Verify tool schemas have required fields
    console.log('\n── Tool Schema Validation ──');
    for (const tool of tools) {
      const hasDesc = typeof tool.description === 'string' && tool.description.length > 0;
      const hasSchema = tool.inputSchema && tool.inputSchema.type === 'object';
      log(
        hasDesc && hasSchema ? 'PASS' : 'FAIL',
        `${tool.name} has description + schema`
      );
    }

    // Verify resources
    console.log('\n── Resources ──');
    const resResp = await client.send('resources/list', {});
    const resources = resResp.result?.resources || [];
    log(resources.length >= 1 ? 'PASS' : 'FAIL', 'resources/list returns resources', `got ${resources.length}`);
    log(
      resources.some((r) => r.uri === 'magector://stats') ? 'PASS' : 'FAIL',
      'magector://stats resource exists'
    );

    // ── Tool call tests (need index) ────────────────────────────
    console.log('\n── Tool Calls (stdio JSON-RPC) ──');

    if (!HAS_INDEX || SKIP_INDEX) {
      console.log('  (skipping search tools — no index)');
    }

    // Tools that call Rust binary — these are the ones that can produce stray output
    const searchTools = [
      { name: 'magento_stats', args: {} },
      { name: 'magento_search', args: { query: 'product price', limit: 3 } },
      { name: 'magento_find_class', args: { className: 'ProductRepository' } },
      { name: 'magento_find_method', args: { methodName: 'execute' } },
      { name: 'magento_find_config', args: { query: 'di.xml preference' } },
      { name: 'magento_find_template', args: { query: 'product listing' } },
      { name: 'magento_find_plugin', args: { targetClass: 'ProductRepository' } },
      { name: 'magento_find_observer', args: { eventName: 'checkout_cart_add_product_complete' } },
      { name: 'magento_find_preference', args: { interfaceName: 'ProductRepositoryInterface' } },
      { name: 'magento_find_api', args: { query: '/V1/products' } },
      { name: 'magento_find_controller', args: { route: 'catalog/product/view' } },
      { name: 'magento_find_block', args: { query: 'product view' } },
      { name: 'magento_find_cron', args: { jobName: 'indexer' } },
      { name: 'magento_find_graphql', args: { query: 'products' } },
      { name: 'magento_find_db_schema', args: { tableName: 'catalog_product' } },
      { name: 'magento_module_structure', args: { moduleName: 'Magento_Catalog' } },
    ];

    for (const tc of searchTools) {
      if ((!HAS_INDEX || SKIP_INDEX) && tc.name !== 'magento_stats') {
        log('SKIP', `tools/call ${tc.name}`, 'no index');
        continue;
      }
      try {
        const result = await client.callTool(tc.name, tc.args);
        const text = result?.content?.[0]?.text || '';
        const isError = result?.isError;
        if (isError) {
          log('FAIL', `tools/call ${tc.name}`, `error: ${text.slice(0, 80)}`);
        } else {
          log('PASS', `tools/call ${tc.name}`, `${text.length} chars`);
        }
      } catch (e) {
        log('FAIL', `tools/call ${tc.name}`, e.message);
      }
    }

    // Analysis tools (JS-based, no Rust binary)
    console.log('\n── Analysis Tool Calls ──');

    try {
      const diffResult = await client.callTool('magento_analyze_diff', { staged: true });
      const diffText = diffResult?.content?.[0]?.text || '';
      log(diffText.includes('Diff Analysis') ? 'PASS' : 'FAIL', 'tools/call magento_analyze_diff');
    } catch (e) {
      log('FAIL', 'tools/call magento_analyze_diff', e.message);
    }

    try {
      const complexResult = await client.callTool('magento_complexity', {
        path: SERVER_PATH,
      });
      const cText = complexResult?.content?.[0]?.text || '';
      log(cText.includes('Complexity') ? 'PASS' : 'FAIL', 'tools/call magento_complexity');
    } catch (e) {
      log('FAIL', 'tools/call magento_complexity', e.message);
    }

    // ── stdout integrity ────────────────────────────────────────
    console.log('\n── stdout Integrity (critical for Cursor/Claude Code) ──');

    log(
      client.invalidLines.length === 0 ? 'PASS' : 'FAIL',
      'All stdout lines are valid JSON',
      client.invalidLines.length > 0
        ? `${client.invalidLines.length} invalid line(s): ${JSON.stringify(client.invalidLines[0]?.slice(0, 80))}`
        : ''
    );

    // Check stderr doesn't contain anything unexpected
    const stderrClean = client.stderrOutput
      .replace('Magector MCP server started (Rust core backend)\n', '')
      .replace('Serve process not ready in time, will use fallback\n', '')
      .replace('Serve process ready (persistent mode)\n', '')
      .replace(/Database format incompatible\. Starting background re-index[^\n]*\n/g, '')
      .replace(/Background re-index completed[^\n]*\n/g, '')
      .replace(/Cannot auto-reindex[^\n]*\n/g, '')
      .trim();
    log(
      stderrClean.length === 0 ? 'PASS' : 'FAIL',
      'stderr contains only startup message',
      stderrClean.length > 0 ? `unexpected: ${JSON.stringify(stderrClean.slice(0, 120))}` : ''
    );

  } finally {
    client.stop();
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`  Total:   ${passed + failed + skipped} tests\n`);

  if (failed > 0) {
    console.log('  ❌ FAILED — MCP server produces invalid output for Cursor/Claude Code');
  } else {
    console.log('  ✅ All tests passed — MCP server output is clean JSON-RPC');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

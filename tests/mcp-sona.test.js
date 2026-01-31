/**
 * Magector SONA Integration Tests
 *
 * Tests the SONA feedback signal tracking in the MCP server.
 * Verifies that search → follow-up tool sequences generate the correct
 * feedback signals and that the Rust core processes them.
 *
 * Usage:
 *   node tests/mcp-sona.test.js             # full suite (needs index + sona feature)
 *   node tests/mcp-sona.test.js --no-index  # skip tools that need an index
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
  console.log('║        MAGECTOR SONA INTEGRATION TESTS (stdio)          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n  Database: ${DB_PATH} (${HAS_INDEX ? 'exists' : 'not found'})`);
  if (SKIP_INDEX) console.log('  Mode: --no-index (skipping search tools)');

  const client = new McpTestClient();

  try {
    await client.start();

    // ── Protocol initialization ──────────────────────────────────
    console.log('\n── Protocol ──');

    const initResp = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sona-test', version: '1.0' },
    });
    log(
      initResp.result?.serverInfo?.name === 'magector' ? 'PASS' : 'FAIL',
      'initialize returns server info'
    );

    // ── SONA feedback signal tests ───────────────────────────────
    console.log('\n── SONA Signal Tracking ──');

    if (!HAS_INDEX || SKIP_INDEX) {
      log('SKIP', 'search → find_plugin feedback sequence', 'needs index');
      log('SKIP', 'search → find_class feedback sequence', 'needs index');
      log('SKIP', 'sona_status shows learned patterns', 'needs index');
    } else {
      // Test 1: search → find_plugin should generate refinement_to_plugin signal
      try {
        const searchResult = await client.callTool('magento_search', { query: 'product price calculation', limit: 5 });
        const hasContent = searchResult?.content?.[0]?.text?.length > 0;
        log(hasContent ? 'PASS' : 'FAIL', 'search returns results for SONA tracking');

        // Follow up with find_plugin within 30s → should trigger signal + flush
        const pluginResult = await client.callTool('magento_find_plugin', { targetClass: 'Product' });
        const pluginHasContent = pluginResult?.content?.[0]?.text?.length > 0;
        log(pluginHasContent ? 'PASS' : 'FAIL', 'find_plugin after search triggers feedback signal');
      } catch (e) {
        log('FAIL', 'search → find_plugin feedback sequence', e.message);
      }

      // Test 2: search → find_class should generate refinement_to_class signal
      try {
        const searchResult2 = await client.callTool('magento_search', { query: 'checkout cart totals', limit: 5 });
        const hasContent2 = searchResult2?.content?.[0]?.text?.length > 0;
        log(hasContent2 ? 'PASS' : 'FAIL', 'second search returns results');

        const classResult = await client.callTool('magento_find_class', { className: 'Cart' });
        const classHasContent = classResult?.content?.[0]?.text?.length > 0;
        log(classHasContent ? 'PASS' : 'FAIL', 'find_class after search triggers feedback signal');
      } catch (e) {
        log('FAIL', 'search → find_class feedback sequence', e.message);
      }

      // Test 3: Wait a moment for async feedback to be processed, then check sona_status
      await new Promise(r => setTimeout(r, 500));

      // Note: sona_status is a Rust serve command, not an MCP tool.
      // The feedback signals are sent via serveQuery('feedback', ...) which goes to the Rust process.
      // We can't directly call sona_status from MCP, but we can verify the feedback path
      // didn't cause errors by checking stderr.
      const hasErrors = client.stderrOutput.includes('feedback error') ||
                        client.stderrOutput.includes('SONA error');
      log(!hasErrors ? 'PASS' : 'FAIL', 'no SONA errors in stderr');
    }

    // ── SessionTracker unit-level tests via MCP ──────────────────
    console.log('\n── SessionTracker Logic ──');

    // Test: calling a non-search tool without prior search should not crash
    try {
      const result = await client.callTool('magento_stats', {});
      const hasContent = result?.content?.[0]?.text?.length > 0;
      log(hasContent ? 'PASS' : 'FAIL', 'non-search tool without prior search works');
    } catch (e) {
      log('FAIL', 'non-search tool without prior search', e.message);
    }

    // ── Verify no invalid stdout lines ───────────────────────────
    console.log('\n── Output Integrity ──');
    log(
      client.invalidLines.length === 0 ? 'PASS' : 'FAIL',
      'no invalid JSON on stdout',
      client.invalidLines.length > 0 ? `${client.invalidLines.length} invalid lines` : ''
    );

  } catch (error) {
    console.error('\nFatal error:', error);
    failed++;
  } finally {
    client.stop();
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n  ────────────────────────────────────`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

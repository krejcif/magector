/**
 * Magector LLM Feature Tests
 *
 * Tests LLM-specific features: query expansion, re-ranking, and code summarization.
 * Compares search quality with and without LLM features to measure improvement.
 *
 * Usage:
 *   node tests/mcp-llm.test.js           # full suite
 *   node tests/mcp-llm.test.js --verbose # show detailed output
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp-server.js');
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.MAGECTOR_DB || path.join(PROJECT_ROOT, '.magector', 'index.db');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

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
    this.child.stderr.on('data', (d) => { this.stderrOutput += d.toString(); });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { this.invalidLines.push(line); return; }
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
        reject(new Error(`Timeout: ${method} (id=${id})`));
      }, 60000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      this.child.stdin.write(msg + '\n');
    });
  }

  async callTool(name, args = {}) {
    const resp = await this.send('tools/call', { name, arguments: args });
    return resp.result;
  }

  stop() { if (this.child) this.child.kill(); }
}

// ─── Test Queries ────────────────────────────────────────────────

// Queries with ground truth — designed to test if LLM expansion/reranking helps
const SEARCH_QUERIES = [
  {
    query: 'product price calculation',
    expectPaths: ['Catalog/Model/Product', 'Pricing', 'Price'],
    description: 'Semantic query about product pricing logic',
  },
  {
    query: 'checkout cart totals',
    expectPaths: ['Quote', 'Cart', 'Total', 'Checkout'],
    description: 'Multi-concept checkout/cart/totals query',
  },
  {
    query: 'customer login authentication',
    expectPaths: ['Customer', 'Account', 'Login', 'Authentication', 'Session'],
    description: 'Auth-related query',
  },
  {
    query: 'order placement flow',
    expectPaths: ['Sales', 'Order', 'Place', 'Submit', 'Management'],
    description: 'Order creation pipeline',
  },
  {
    query: 'catalog category tree',
    expectPaths: ['Catalog', 'Category', 'Tree'],
    description: 'Category hierarchy query',
  },
  {
    query: 'add to cart',
    expectPaths: ['Checkout', 'Cart', 'Quote', 'Add'],
    description: 'Common user action query',
  },
  {
    query: 'payment method configuration',
    expectPaths: ['Payment', 'Config', 'Method'],
    description: 'Payment config query',
  },
  {
    query: 'inventory stock management',
    expectPaths: ['Inventory', 'Stock', 'CatalogInventory'],
    description: 'Stock/inventory query',
  },
  {
    query: 'email template sending',
    expectPaths: ['Email', 'Template', 'Transport', 'Mail'],
    description: 'Email system query',
  },
  {
    query: 'admin acl permissions',
    expectPaths: ['Authorization', 'Acl', 'Admin', 'User', 'Role'],
    description: 'Admin permissions query',
  },
];

// Files to test summarization on
const SUMMARIZE_FILES = [
  'magento2/app/code/Magento/Catalog/Model/Product.php',
  'magento2/app/code/Magento/Checkout/Controller/Cart/Add.php',
  'magento2/app/code/Magento/Customer/Model/Session.php',
  'magento2/app/code/Magento/Sales/Model/Order.php',
  'magento2/app/code/Magento/Quote/Model/Quote.php',
];

// ─── Scoring ──────────────────────────────────────────────────────

function scoreResults(results, expectPaths) {
  if (!results || results.length === 0) return { hits: 0, total: expectPaths.length, score: 0 };
  const allText = results.map(r => (r.path || r.file || '')).join(' ');
  let hits = 0;
  for (const fragment of expectPaths) {
    if (allText.toLowerCase().includes(fragment.toLowerCase())) hits++;
  }
  return { hits, total: expectPaths.length, score: hits / expectPaths.length };
}

function parseSearchResults(text) {
  try {
    const results = JSON.parse(text);
    if (Array.isArray(results)) return results;
  } catch {}
  // Extract paths from formatted text output
  const paths = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/(?:path|file)["']?\s*[:=]\s*["']?([^\s"',]+)/i);
    if (match) paths.push({ path: match[1] });
    // Also match "## N. path/to/file" pattern
    const mdMatch = line.match(/^##?\s*\d+\.\s*(.+\.(?:php|phtml|xml|js))/);
    if (mdMatch) paths.push({ path: mdMatch[1] });
    // Match "**path/to/file**" pattern
    const boldMatch = line.match(/\*\*([^\*]+\.(?:php|phtml|xml|js))\*\*/);
    if (boldMatch) paths.push({ path: boldMatch[1] });
  }
  return paths;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║       MAGECTOR LLM FEATURE ACCURACY TESTS               ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n  Database: ${DB_PATH} (${existsSync(DB_PATH) ? 'exists' : 'NOT FOUND'})`);

  if (!existsSync(DB_PATH)) {
    console.error('  ERROR: No database found. Run indexing first.');
    process.exit(1);
  }

  const client = new McpTestClient();

  try {
    await client.start();

    // Initialize MCP
    await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'llm-test', version: '1.0' },
    });

    // Wait for serve process (LLM model loading takes a few seconds)
    console.log('\n  Waiting for serve process + LLM engine...');
    await new Promise((r) => setTimeout(r, 8000));

    // Detect LLM availability from magector.log (serve process logs there)
    const logPath = path.join(PROJECT_ROOT, 'magector.log');
    let llmAvailable = false;
    if (existsSync(logPath)) {
      const { readFileSync } = await import('fs');
      const logContent = readFileSync(logPath, 'utf-8');
      llmAvailable = logContent.includes('LLM engine loaded') || logContent.includes('llm engine initialized');
    }
    // Also check stderr (test harness captures MCP server stderr)
    if (client.stderrOutput.includes('LLM engine loaded')) llmAvailable = true;
    console.log(`  LLM available: ${llmAvailable ? 'YES' : 'NO'}`);

    if (!llmAvailable) {
      console.log('\n  ⚠ LLM engine not loaded. Testing in degraded mode.');
      console.log('    Build with: cd rust-core && cargo build --release --features llm');
    }

    // ── 1. Baseline vs LLM-expanded search ──────────────────────
    console.log('\n── Search: Baseline vs LLM Query Expansion ──');

    const baselineScores = [];
    const expandedScores = [];
    const rerankScores = [];
    const bothScores = [];

    for (const q of SEARCH_QUERIES) {
      // Baseline (no LLM)
      const t0 = Date.now();
      const baseResult = await client.callTool('magento_search', { query: q.query, limit: 10 });
      const baseTime = Date.now() - t0;
      const baseText = baseResult?.content?.[0]?.text || '';
      const baseParsed = parseSearchResults(baseText);
      const baseScore = scoreResults(baseParsed, q.expectPaths);
      baselineScores.push(baseScore.score);

      // LLM expanded
      const t1 = Date.now();
      const expandResult = await client.callTool('magento_search', {
        query: q.query, limit: 10, llm_expand: true
      });
      const expandTime = Date.now() - t1;
      const expandText = expandResult?.content?.[0]?.text || '';
      const expandParsed = parseSearchResults(expandText);
      const expandScore = scoreResults(expandParsed, q.expectPaths);
      expandedScores.push(expandScore.score);

      // LLM reranked
      const t2 = Date.now();
      const rerankResult = await client.callTool('magento_search', {
        query: q.query, limit: 10, llm_rerank: true
      });
      const rerankTime = Date.now() - t2;
      const rerankText = rerankResult?.content?.[0]?.text || '';
      const rerankParsed = parseSearchResults(rerankText);
      const rerankScore = scoreResults(rerankParsed, q.expectPaths);
      rerankScores.push(rerankScore.score);

      // Both LLM expand + rerank
      const t3 = Date.now();
      const bothResult = await client.callTool('magento_search', {
        query: q.query, limit: 10, llm_expand: true, llm_rerank: true
      });
      const bothTime = Date.now() - t3;
      const bothText = bothResult?.content?.[0]?.text || '';
      const bothParsed = parseSearchResults(bothText);
      const bothScore = scoreResults(bothParsed, q.expectPaths);
      bothScores.push(bothScore.score);

      if (VERBOSE) {
        console.log(`\n    Query: "${q.query}" (${q.description})`);
        console.log(`      Baseline:     ${(baseScore.score * 100).toFixed(0)}% (${baseScore.hits}/${baseScore.total}) [${baseTime}ms]`);
        console.log(`      +Expansion:   ${(expandScore.score * 100).toFixed(0)}% (${expandScore.hits}/${expandScore.total}) [${expandTime}ms]`);
        console.log(`      +Rerank:      ${(rerankScore.score * 100).toFixed(0)}% (${rerankScore.hits}/${rerankScore.total}) [${rerankTime}ms]`);
        console.log(`      +Both:        ${(bothScore.score * 100).toFixed(0)}% (${bothScore.hits}/${bothScore.total}) [${bothTime}ms]`);
      }
    }

    const avgBaseline = (baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length * 100).toFixed(1);
    const avgExpanded = (expandedScores.reduce((a, b) => a + b, 0) / expandedScores.length * 100).toFixed(1);
    const avgRerank = (rerankScores.reduce((a, b) => a + b, 0) / rerankScores.length * 100).toFixed(1);
    const avgBoth = (bothScores.reduce((a, b) => a + b, 0) / bothScores.length * 100).toFixed(1);

    console.log(`\n  ┌─────────────────────────────────────┐`);
    console.log(`  │ Search Relevance Scores (${SEARCH_QUERIES.length} queries) │`);
    console.log(`  ├─────────────────────────────────────┤`);
    console.log(`  │ Baseline (no LLM):       ${avgBaseline.padStart(5)}%    │`);
    console.log(`  │ + Query Expansion:        ${avgExpanded.padStart(5)}%    │`);
    console.log(`  │ + Re-ranking:             ${avgRerank.padStart(5)}%    │`);
    console.log(`  │ + Expansion + Re-ranking: ${avgBoth.padStart(5)}%    │`);
    console.log(`  └─────────────────────────────────────┘`);

    const expandDelta = (avgExpanded - avgBaseline).toFixed(1);
    const rerankDelta = (avgRerank - avgBaseline).toFixed(1);
    const bothDelta = (avgBoth - avgBaseline).toFixed(1);

    log(parseFloat(avgBaseline) >= 50 ? 'PASS' : 'FAIL',
      `Baseline search relevance ≥ 50%`, `${avgBaseline}%`);
    log(parseFloat(avgExpanded) >= parseFloat(avgBaseline) ? 'PASS' : 'FAIL',
      `LLM expansion ≥ baseline`, `${avgExpanded}% (${expandDelta >= 0 ? '+' : ''}${expandDelta}%)`);
    log(parseFloat(avgRerank) >= parseFloat(avgBaseline) ? 'PASS' : 'FAIL',
      `LLM re-ranking ≥ baseline`, `${avgRerank}% (${rerankDelta >= 0 ? '+' : ''}${rerankDelta}%)`);
    log(parseFloat(avgBoth) >= parseFloat(avgBaseline) ? 'PASS' : 'FAIL',
      `LLM expansion + re-ranking ≥ baseline`, `${avgBoth}% (${bothDelta >= 0 ? '+' : ''}${bothDelta}%)`);

    // ── 2. LLM Code Summarization ────────────────────────────────
    console.log('\n── LLM Code Summarization ──');

    let summaryPassed = 0;
    let summaryFailed = 0;

    for (const filePath of SUMMARIZE_FILES) {
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (!existsSync(fullPath)) {
        log('SKIP', `summarize ${path.basename(filePath)}`, 'file not found');
        continue;
      }

      try {
        const t0 = Date.now();
        const result = await client.callTool('llm_summarize_code', { path: fullPath });
        const elapsed = Date.now() - t0;
        const text = result?.content?.[0]?.text || '';

        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = {}; }

        if (parsed.summary && parsed.summary.length > 10) {
          log('PASS', `summarize ${path.basename(filePath)}`, `${parsed.summary.length} chars [${elapsed}ms]`);
          summaryPassed++;
          if (VERBOSE) {
            console.log(`      Summary: ${parsed.summary.slice(0, 120)}...`);
          }
        } else if (parsed.error && parsed.error.includes('LLM not available')) {
          log('SKIP', `summarize ${path.basename(filePath)}`, 'LLM not available');
          skipped++;
        } else {
          log('FAIL', `summarize ${path.basename(filePath)}`, parsed.error || 'empty summary');
          summaryFailed++;
        }
      } catch (e) {
        log('FAIL', `summarize ${path.basename(filePath)}`, e.message);
        summaryFailed++;
      }
    }

    if (llmAvailable && summaryPassed > 0) {
      log('PASS', 'At least one file summarized successfully');
    } else if (llmAvailable) {
      log('FAIL', 'LLM available but summarization failed',
        'SmolLM-135M Q4 has known Candle compatibility issues — upgrade model or Candle version');
    }

    // ── 3. stdout integrity ──────────────────────────────────────
    console.log('\n── Output Integrity ──');
    log(
      client.invalidLines.length === 0 ? 'PASS' : 'FAIL',
      'All stdout lines are valid JSON',
      client.invalidLines.length > 0 ? `${client.invalidLines.length} invalid` : ''
    );

  } finally {
    client.stop();
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`  Total:   ${passed + failed + skipped} tests\n`);

  if (failed > 0) {
    console.log('  ❌ Some LLM feature tests failed');
  } else {
    console.log('  ✅ All LLM feature tests passed');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

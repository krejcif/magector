#!/usr/bin/env node
/**
 * Magector MCP Server
 *
 * Search tools delegate to the Rust core binary (magector-core).
 * Analysis tools (diff, complexity) use ruvector JS modules directly.
 * No JS indexer — Rust core is the single source of truth for search/index.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { glob } from 'glob';
import path from 'path';
import {
  analyzeCommit,
  getStagedDiff,
  analyzeFileDiff
} from 'ruvector/dist/core/diff-embeddings.js';
import {
  analyzeFiles as analyzeComplexityFiles,
  getComplexityRating
} from 'ruvector/dist/analysis/complexity.js';
import { resolveBinary } from './binary.js';
import { resolveModels } from './model.js';

const config = {
  dbPath: process.env.MAGECTOR_DB || './magector.db',
  magentoRoot: process.env.MAGENTO_ROOT || process.cwd(),
  get rustBinary() { return resolveBinary(); },
  get modelCache() { return resolveModels() || process.env.MAGECTOR_MODELS || './models'; }
};

// ─── Rust Core Integration ──────────────────────────────────────

// Env vars to suppress ONNX Runtime native logs that would pollute stdout/JSON-RPC
const rustEnv = {
  ...process.env,
  ORT_LOG_LEVEL: 'error',
  RUST_LOG: 'error',
};

/**
 * Query cache: avoid re-embedding identical queries.
 * Keyed by "query|limit", capped at 200 entries (LRU eviction).
 */
const searchCache = new Map();
const CACHE_MAX = 200;

function cacheSet(key, value) {
  if (searchCache.size >= CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
  searchCache.set(key, value);
}

// ─── Persistent Rust Serve Process ──────────────────────────────
// Keeps ONNX model + HNSW index loaded; eliminates ~2.6s cold start per query.
// Falls back to execFileSync if serve mode unavailable.

let serveProcess = null;
let serveReady = false;
let servePending = new Map();
let serveNextId = 1;
let serveReadline = null;

function startServeProcess() {
  try {
    const proc = spawn(config.rustBinary, [
      'serve',
      '-d', config.dbPath,
      '-c', config.modelCache
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: rustEnv });

    proc.on('error', () => { serveProcess = null; serveReady = false; });
    proc.on('exit', () => { serveProcess = null; serveReady = false; });
    proc.stderr.on('data', () => {}); // drain stderr

    serveReadline = createInterface({ input: proc.stdout });
    serveReadline.on('line', (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }

      // First line is ready signal
      if (parsed.ready) {
        serveReady = true;
        return;
      }

      // Route response to pending request by order (FIFO)
      if (servePending.size > 0) {
        const [id, resolver] = servePending.entries().next().value;
        servePending.delete(id);
        resolver.resolve(parsed);
      }
    });

    serveProcess = proc;
  } catch {
    serveProcess = null;
    serveReady = false;
  }
}

function serveQuery(command, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = serveNextId++;
    const timer = setTimeout(() => {
      servePending.delete(id);
      reject(new Error('Serve query timeout'));
    }, timeoutMs);
    servePending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); }
    });
    const msg = JSON.stringify({ command, ...params });
    serveProcess.stdin.write(msg + '\n');
  });
}

async function rustSearchAsync(query, limit = 10) {
  const cacheKey = `${query}|${limit}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  // Try persistent serve process first
  if (serveProcess && serveReady) {
    try {
      const resp = await serveQuery('search', { query, limit });
      if (resp.ok && resp.data) {
        cacheSet(cacheKey, resp.data);
        return resp.data;
      }
    } catch {
      // Fall through to execFileSync
    }
  }

  // Fallback: cold-start execFileSync
  return rustSearchSync(query, limit);
}

function rustSearchSync(query, limit = 10) {
  const cacheKey = `${query}|${limit}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }
  const result = execFileSync(config.rustBinary, [
    'search', query,
    '-d', config.dbPath,
    '-c', config.modelCache,
    '-l', String(limit),
    '-f', 'json'
  ], { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], env: rustEnv });
  const parsed = JSON.parse(result);
  cacheSet(cacheKey, parsed);
  return parsed;
}

// Keep backward compat: synchronous wrapper (used by tools)
function rustSearch(query, limit = 10) {
  return rustSearchSync(query, limit);
}

function rustIndex(magentoRoot) {
  searchCache.clear(); // invalidate cache on reindex
  const result = execFileSync(config.rustBinary, [
    'index',
    '-m', magentoRoot,
    '-d', config.dbPath,
    '-c', config.modelCache
  ], { encoding: 'utf-8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'], env: rustEnv });
  return result;
}

function rustStats() {
  const result = execFileSync(config.rustBinary, [
    'stats',
    '-d', config.dbPath
  ], { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], env: rustEnv });
  // Parse text output: "Total vectors: N" and "Embedding dim: N"
  const vectors = result.match(/Total vectors:\s*(\d+)/)?.[1] || '0';
  const dim = result.match(/Embedding dim:\s*(\d+)/)?.[1] || '384';
  return { totalVectors: parseInt(vectors), embeddingDim: parseInt(dim), dbPath: config.dbPath };
}

// ─── Analysis (ruvector JS) ─────────────────────────────────────

async function analyzeDiff(options = {}) {
  if (options.commitHash) {
    return analyzeCommit(options.commitHash);
  }
  const diff = getStagedDiff();
  if (!diff || diff.trim() === '') {
    return { files: [], totalAdditions: 0, totalDeletions: 0, riskScore: 0, message: 'No staged changes found' };
  }
  const fileSections = diff.split(/^diff --git /m).filter(Boolean);
  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const section of fileSections) {
    const fileMatch = section.match(/a\/(.+?)\s/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    const analysis = await analyzeFileDiff(filePath, section);
    files.push(analysis);
    totalAdditions += analysis.totalAdditions || 0;
    totalDeletions += analysis.totalDeletions || 0;
  }

  const maxRisk = files.length > 0 ? Math.max(...files.map(f => f.riskScore || 0)) : 0;
  return { files, totalAdditions, totalDeletions, riskScore: maxRisk };
}

async function analyzeComplexity(paths) {
  const results = analyzeComplexityFiles(paths);
  return results.map(r => ({
    ...r,
    rating: getComplexityRating(r.cyclomaticComplexity)
  }));
}

// ─── Result formatting helpers ──────────────────────────────────

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
    isPlugin: meta.is_plugin || meta.isPlugin,
    isController: meta.is_controller || meta.isController,
    isObserver: meta.is_observer || meta.isObserver,
    isRepository: meta.is_repository || meta.isRepository,
    isResolver: meta.is_resolver || meta.isResolver,
    isModel: meta.is_model || meta.isModel,
    isBlock: meta.is_block || meta.isBlock,
    area: meta.area,
    score: r.score
  };
}

/**
 * Re-rank results by boosting scores for metadata matches.
 * @param {Array} results - normalized results
 * @param {Object} boosts - e.g. { fileType: 'xml', pathContains: 'di.xml', isPlugin: true }
 * @param {number} weight - boost multiplier (default 0.3 = 30% score bump per match)
 */
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

function formatSearchResults(results) {
  if (!results || results.length === 0) {
    return 'No results found.';
  }

  return results.map((r, i) => {
    const header = `## Result ${i + 1} (score: ${r.score?.toFixed(3) || 'N/A'})`;

    const meta = [
      `**Path:** ${r.path || 'unknown'}`,
      r.module ? `**Module:** ${r.module}` : null,
      r.magentoType ? `**Magento Type:** ${r.magentoType}` : null,
      r.area && r.area !== 'global' ? `**Area:** ${r.area}` : null,
      r.className ? `**Class:** ${r.className}` : null,
      r.namespace ? `**Namespace:** ${r.namespace}` : null,
      r.methodName ? `**Method:** ${r.methodName}` : null,
      r.type ? `**File Type:** ${r.type}` : null,
    ].filter(Boolean).join('\n');

    let badges = '';
    if (r.isPlugin) badges += ' `plugin`';
    if (r.isController) badges += ' `controller`';
    if (r.isObserver) badges += ' `observer`';
    if (r.isRepository) badges += ' `repository`';
    if (r.isResolver) badges += ' `graphql-resolver`';

    return `${header}\n${meta}${badges}`;
  }).join('\n\n---\n\n');
}

// ─── MCP Server ─────────────────────────────────────────────────

const server = new Server(
  {
    name: 'magector',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'magento_search',
      description: 'Search Magento codebase semantically. Find classes, methods, configurations, templates by describing what you need.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query (e.g., "product price calculation", "checkout controller", "customer authentication")'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 10)',
            default: 10
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_class',
      description: 'Find a specific PHP class, interface, or trait in Magento',
      inputSchema: {
        type: 'object',
        properties: {
          className: {
            type: 'string',
            description: 'Class name to find (e.g., "ProductRepository", "AbstractModel")'
          },
          namespace: {
            type: 'string',
            description: 'Optional namespace filter'
          }
        },
        required: ['className']
      }
    },
    {
      name: 'magento_find_method',
      description: 'Find implementations of a specific method across Magento',
      inputSchema: {
        type: 'object',
        properties: {
          methodName: {
            type: 'string',
            description: 'Method name to find (e.g., "execute", "getPrice", "save")'
          },
          className: {
            type: 'string',
            description: 'Optional class name filter'
          }
        },
        required: ['methodName']
      }
    },
    {
      name: 'magento_find_config',
      description: 'Find XML configuration files and nodes in Magento',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Configuration to find (e.g., "di.xml preference", "routes.xml", "system.xml field")'
          },
          configType: {
            type: 'string',
            enum: ['di', 'routes', 'system', 'events', 'webapi', 'module', 'layout', 'other'],
            description: 'Type of configuration'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_template',
      description: 'Find PHTML templates in Magento',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Template description (e.g., "product listing", "checkout form", "customer account")'
          },
          area: {
            type: 'string',
            enum: ['frontend', 'adminhtml', 'base'],
            description: 'Magento area'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_index',
      description: 'Index or re-index Magento codebase for semantic search (uses Rust core)',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to Magento root (uses configured path if not specified)'
          },
        }
      }
    },
    {
      name: 'magento_stats',
      description: 'Get index statistics from Rust core',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'magento_find_plugin',
      description: 'Find plugins (interceptors) for a class or method - before/after/around methods',
      inputSchema: {
        type: 'object',
        properties: {
          targetClass: {
            type: 'string',
            description: 'Class being intercepted (e.g., "ProductRepository", "CartManagement")'
          },
          targetMethod: {
            type: 'string',
            description: 'Method being intercepted (e.g., "save", "getList")'
          }
        }
      }
    },
    {
      name: 'magento_find_observer',
      description: 'Find observers for a specific event',
      inputSchema: {
        type: 'object',
        properties: {
          eventName: {
            type: 'string',
            description: 'Event name (e.g., "checkout_cart_add_product_complete", "sales_order_place_after")'
          }
        },
        required: ['eventName']
      }
    },
    {
      name: 'magento_find_preference',
      description: 'Find DI preference overrides for an interface or class',
      inputSchema: {
        type: 'object',
        properties: {
          interfaceName: {
            type: 'string',
            description: 'Interface or class name to find preferences for (e.g., "ProductRepositoryInterface")'
          }
        },
        required: ['interfaceName']
      }
    },
    {
      name: 'magento_find_api',
      description: 'Find REST/SOAP API endpoints and their implementations',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'API endpoint URL pattern or service method (e.g., "/V1/products", "getList")'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            description: 'HTTP method filter'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_controller',
      description: 'Find controllers by route or action',
      inputSchema: {
        type: 'object',
        properties: {
          route: {
            type: 'string',
            description: 'Route path (e.g., "catalog/product/view", "checkout/cart/add")'
          },
          area: {
            type: 'string',
            enum: ['frontend', 'adminhtml'],
            description: 'Magento area'
          }
        },
        required: ['route']
      }
    },
    {
      name: 'magento_find_block',
      description: 'Find Block classes by name or template',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Block class name or functionality (e.g., "Product\\View", "cart totals")'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_cron',
      description: 'Find cron jobs by name or schedule',
      inputSchema: {
        type: 'object',
        properties: {
          jobName: {
            type: 'string',
            description: 'Cron job name or pattern (e.g., "catalog_product", "indexer")'
          }
        },
        required: ['jobName']
      }
    },
    {
      name: 'magento_find_graphql',
      description: 'Find GraphQL types, queries, mutations, or resolvers',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'GraphQL type, query, or mutation name (e.g., "products", "createCustomer", "CartItemInterface")'
          },
          schemaType: {
            type: 'string',
            enum: ['type', 'query', 'mutation', 'interface', 'resolver'],
            description: 'Type of GraphQL schema element'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_db_schema',
      description: 'Find database table definitions and columns',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'Table name pattern (e.g., "catalog_product", "sales_order")'
          }
        },
        required: ['tableName']
      }
    },
    {
      name: 'magento_module_structure',
      description: 'Get complete structure of a Magento module - all its classes, configs, templates',
      inputSchema: {
        type: 'object',
        properties: {
          moduleName: {
            type: 'string',
            description: 'Full module name (e.g., "Magento_Catalog", "Vendor_CustomModule")'
          }
        },
        required: ['moduleName']
      }
    },
    {
      name: 'magento_analyze_diff',
      description: 'Analyze git diffs for risk scoring, change classification, and per-file analysis. Works on commits or staged changes.',
      inputSchema: {
        type: 'object',
        properties: {
          commitHash: {
            type: 'string',
            description: 'Git commit hash to analyze. If omitted, analyzes staged changes.'
          },
          staged: {
            type: 'boolean',
            description: 'Analyze staged (git add) changes instead of a commit',
            default: true
          }
        }
      }
    },
    {
      name: 'magento_complexity',
      description: 'Analyze code complexity (cyclomatic complexity, function count, lines) for Magento files. Finds complex hotspots.',
      inputSchema: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'Magento module to analyze (e.g., "Magento_Catalog"). Finds all PHP files in the module.'
          },
          path: {
            type: 'string',
            description: 'Specific file or directory path to analyze'
          },
          threshold: {
            type: 'number',
            description: 'Minimum cyclomatic complexity to report (default: 0, show all)',
            default: 0
          }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'magento_search': {
        const raw = await rustSearchAsync(args.query, args.limit || 10);
        const results = raw.map(normalizeResult);
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results)
          }]
        };
      }

      case 'magento_find_class': {
        const ns = args.namespace || '';
        const query = `${args.className} ${ns}`.trim();
        const raw = await rustSearchAsync(query, 30);
        const classLower = args.className.toLowerCase();
        const results = raw.map(normalizeResult).filter(r =>
          r.className?.toLowerCase().includes(classLower) ||
          r.path?.toLowerCase().includes(classLower.replace(/\\/g, '/'))
        );
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.slice(0, 5))
          }]
        };
      }

      case 'magento_find_method': {
        const query = `method ${args.methodName} function ${args.className || ''}`.trim();
        const raw = await rustSearchAsync(query, 30);
        const methodLower = args.methodName.toLowerCase();
        let results = raw.map(normalizeResult).filter(r =>
          r.methodName?.toLowerCase() === methodLower ||
          r.methodName?.toLowerCase().includes(methodLower) ||
          r.methods?.some(m => m.toLowerCase() === methodLower || m.toLowerCase().includes(methodLower)) ||
          r.path?.toLowerCase().includes(methodLower)
        );
        // Boost exact method matches to top
        results = results.map(r => {
          const exact = r.methodName?.toLowerCase() === methodLower ||
            r.methods?.some(m => m.toLowerCase() === methodLower);
          return { ...r, score: (r.score || 0) + (exact ? 0.5 : 0) };
        }).sort((a, b) => b.score - a.score);
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.slice(0, 10))
          }]
        };
      }

      case 'magento_find_config': {
        let query = args.query;
        if (args.configType && args.configType !== 'other') {
          query = `${args.configType}.xml ${args.query}`;
        }
        const raw = await rustSearchAsync(query, 30);
        const pathBoost = args.configType ? [`${args.configType}.xml`] : ['.xml'];
        let normalized = raw.map(normalizeResult);
        // Prefer XML results when configType is specified, but don't hard-exclude
        if (args.configType) {
          const xmlOnly = normalized.filter(r =>
            r.type === 'xml' || r.path?.endsWith('.xml') || r.path?.includes('.xml')
          );
          if (xmlOnly.length > 0) normalized = xmlOnly;
        }
        const results = rerank(normalized, { fileType: 'xml', pathContains: pathBoost });
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.slice(0, 10))
          }]
        };
      }

      case 'magento_find_template': {
        let query = args.query;
        if (args.area) query = `${args.area} ${query}`;
        query += ' template phtml';
        const raw = await rustSearchAsync(query, 15);
        const results = rerank(raw.map(normalizeResult), { pathContains: ['.phtml'] });
        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.slice(0, 10))
          }]
        };
      }

      case 'magento_index': {
        const root = args.path || config.magentoRoot;
        const output = rustIndex(root);
        return {
          content: [{
            type: 'text',
            text: `Indexing complete (Rust core).\n\n${output}`
          }]
        };
      }

      case 'magento_stats': {
        const stats = rustStats();
        return {
          content: [{
            type: 'text',
            text: `Magector Stats (Rust core):\n- Total indexed vectors: ${stats.totalVectors}\n- Embedding dimensions: ${stats.embeddingDim}\n- Database path: ${stats.dbPath}`
          }]
        };
      }

      case 'magento_find_plugin': {
        let query = 'plugin interceptor';
        if (args.targetClass) query += ` ${args.targetClass}`;
        if (args.targetMethod) query += ` ${args.targetMethod} before after around`;

        const raw = await rustSearchAsync(query, 30);
        let results = raw.map(normalizeResult).filter(r =>
          r.isPlugin || r.path?.includes('/Plugin/') || r.path?.includes('di.xml')
        );
        results = rerank(results, { isPlugin: true, pathContains: ['/Plugin/', 'di.xml'] });

        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_observer': {
        const query = `event ${args.eventName} observer`;
        const raw = await rustSearchAsync(query, 30);
        let results = raw.map(normalizeResult).filter(r =>
          r.isObserver || r.path?.includes('/Observer/') || r.path?.includes('events.xml')
        );
        results = rerank(results, { isObserver: true, pathContains: ['events.xml', '/Observer/'] });

        return {
          content: [{
            type: 'text',
            text: `## Observers for event: ${args.eventName}\n\n` + formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_preference': {
        const query = `preference ${args.interfaceName} di.xml type`;
        const raw = await rustSearchAsync(query, 30);
        let results = raw.map(normalizeResult).filter(r =>
          r.path?.includes('di.xml')
        );
        results = rerank(results, { fileType: 'xml', pathContains: ['di.xml'] });

        return {
          content: [{
            type: 'text',
            text: `## Preferences for: ${args.interfaceName}\n\n` + formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_api': {
        let query = `webapi route ${args.query}`;
        if (args.method) query += ` method="${args.method}"`;

        const raw = await rustSearchAsync(query, 30);
        let results = rerank(raw.map(normalizeResult), { pathContains: ['webapi.xml'] });

        return {
          content: [{
            type: 'text',
            text: `## API Endpoints matching: ${args.query}\n\n` + formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_controller': {
        const parts = args.route.split('/');
        // Map route to Magento namespace: catalog/product/view → Catalog Controller Product View
        const namespaceParts = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1));
        const query = `${namespaceParts.join(' ')} controller execute action`;

        const raw = await rustSearchAsync(query, 30);
        let results = raw.map(normalizeResult).filter(r =>
          r.isController || r.path?.includes('/Controller/')
        );

        // Boost results whose path matches the route segments
        if (parts.length >= 2) {
          const pathPattern = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1));
          results.sort((a, b) => {
            const aPath = a.path || '';
            const bPath = b.path || '';
            const aMatches = pathPattern.filter(p => aPath.includes(p)).length;
            const bMatches = pathPattern.filter(p => bPath.includes(p)).length;
            return bMatches - aMatches;
          });
        }

        if (args.area) {
          results = results.filter(r => r.area === args.area || r.path?.includes(`/${args.area}/`));
        }

        return {
          content: [{
            type: 'text',
            text: `## Controllers for route: ${args.route}\n\n` + formatSearchResults(results)
          }]
        };
      }

      case 'magento_find_block': {
        const query = `block ${args.query}`;
        const raw = await rustSearchAsync(query, 30);
        let results = raw.map(normalizeResult).filter(r =>
          r.isBlock || r.path?.includes('/Block/')
        );
        results = rerank(results, { isBlock: true, pathContains: ['/Block/'] });

        return {
          content: [{
            type: 'text',
            text: formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_cron': {
        const query = `cron job ${args.jobName}`;
        const raw = await rustSearchAsync(query, 30);
        let results = raw.map(normalizeResult).filter(r =>
          r.path?.includes('crontab.xml') || r.path?.includes('/Cron/')
        );
        results = rerank(results, { pathContains: ['crontab.xml', '/Cron/'] });

        return {
          content: [{
            type: 'text',
            text: `## Cron jobs matching: ${args.jobName}\n\n` + formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_graphql': {
        let query = `graphql ${args.query}`;
        if (args.schemaType) query += ` ${args.schemaType}`;

        const raw = await rustSearchAsync(query, 40);
        let results = raw.map(normalizeResult).filter(r =>
          r.isResolver || r.path?.includes('/Resolver/') ||
          r.path?.includes('.graphqls') || r.type === 'graphql'
        );
        results = rerank(results, { isResolver: true, pathContains: ['.graphqls', '/Resolver/'] });

        return {
          content: [{
            type: 'text',
            text: `## GraphQL matching: ${args.query}\n\n` + formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_db_schema': {
        const query = `db_schema.xml table ${args.tableName} column declarative schema`;
        const raw = await rustSearchAsync(query, 40);
        let results = raw.map(normalizeResult).filter(r =>
          r.path?.includes('db_schema.xml')
        );
        results = rerank(results, { fileType: 'xml', pathContains: ['db_schema.xml'] });

        return {
          content: [{
            type: 'text',
            text: `## Database schema for: ${args.tableName}\n\n` + formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_module_structure': {
        const raw = await rustSearchAsync(args.moduleName, 100);
        const moduleName = args.moduleName.replace('_', '/');
        const results = raw.map(normalizeResult).filter(r =>
          r.path?.includes(moduleName) || r.module?.includes(args.moduleName)
        );

        const structure = {
          controllers: results.filter(r => r.isController || r.path?.includes('/Controller/')),
          models: results.filter(r => r.isModel || (r.path?.includes('/Model/') && !r.path?.includes('ResourceModel'))),
          blocks: results.filter(r => r.isBlock || r.path?.includes('/Block/')),
          plugins: results.filter(r => r.isPlugin || r.path?.includes('/Plugin/')),
          observers: results.filter(r => r.isObserver || r.path?.includes('/Observer/')),
          apis: results.filter(r => r.path?.includes('/Api/')),
          configs: results.filter(r => r.type === 'xml'),
          other: results.filter(r =>
            !r.isController && !r.isModel && !r.isBlock && !r.isPlugin && !r.isObserver &&
            !r.path?.includes('/Api/') && r.type !== 'xml' &&
            !r.path?.includes('/Controller/') && !r.path?.includes('/Model/') &&
            !r.path?.includes('/Block/') && !r.path?.includes('/Plugin/') &&
            !r.path?.includes('/Observer/')
          )
        };

        let text = `## Module Structure: ${args.moduleName}\n\n`;

        for (const [category, items] of Object.entries(structure)) {
          if (items.length > 0) {
            text += `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${items.length})\n`;
            items.slice(0, 10).forEach(item => {
              text += `- ${item.className || item.path} (${item.path})\n`;
            });
            if (items.length > 10) text += `  ... and ${items.length - 10} more\n`;
            text += '\n';
          }
        }

        if (results.length === 0) {
          text += 'No code found for this module. Try re-indexing or check the module name.';
        }

        return { content: [{ type: 'text', text }] };
      }

      case 'magento_analyze_diff': {
        const analysis = await analyzeDiff({
          commitHash: args.commitHash,
          staged: args.staged !== false
        });

        let text = '## Diff Analysis\n\n';
        text += `- **Total additions:** ${analysis.totalAdditions}\n`;
        text += `- **Total deletions:** ${analysis.totalDeletions}\n`;
        text += `- **Risk score:** ${(analysis.riskScore || 0).toFixed(2)}\n\n`;

        if (analysis.message) {
          text += `_${analysis.message}_\n\n`;
        }

        if (analysis.files && analysis.files.length > 0) {
          text += '### Per-file Analysis\n\n';
          for (const f of analysis.files) {
            text += `**${f.file}**\n`;
            text += `  - Category: \`${f.category || 'unknown'}\`\n`;
            text += `  - Risk: ${(f.riskScore || 0).toFixed(2)}`;
            text += ` | +${f.totalAdditions || 0} / -${f.totalDeletions || 0}\n`;
          }
        }

        return { content: [{ type: 'text', text }] };
      }

      case 'magento_complexity': {
        let filePaths = [];

        if (args.path) {
          const pathStat = await stat(args.path).catch(() => null);
          if (pathStat && pathStat.isDirectory()) {
            filePaths = await glob('**/*.php', { cwd: args.path, absolute: true, nodir: true });
          } else if (pathStat) {
            filePaths = [args.path];
          }
        } else if (args.module) {
          const modulePath = args.module.replace('_', '/');
          const root = config.magentoRoot;
          const patterns = [
            `vendor/magento/module-${args.module.split('_')[1]?.toLowerCase()}/**/*.php`,
            `app/code/${modulePath}/**/*.php`
          ];
          for (const pattern of patterns) {
            const found = await glob(pattern, { cwd: root, absolute: true, nodir: true });
            filePaths.push(...found);
          }
        }

        if (filePaths.length === 0) {
          return { content: [{ type: 'text', text: 'No files found to analyze. Specify a module or path.' }] };
        }

        const results = await analyzeComplexity(filePaths);
        const threshold = args.threshold || 0;
        const filtered = results
          .filter(r => r.cyclomaticComplexity >= threshold)
          .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity);

        let text = `## Complexity Analysis (${filtered.length} files)\n\n`;
        text += '| File | Complexity | Rating | Functions | Lines |\n';
        text += '|------|-----------|--------|-----------|-------|\n';

        for (const r of filtered.slice(0, 50)) {
          const shortPath = r.file.replace(config.magentoRoot + '/', '');
          text += `| ${shortPath} | ${r.cyclomaticComplexity} | ${r.rating} | ${r.functions} | ${r.lines} |\n`;
        }

        if (filtered.length > 50) {
          text += `\n_...and ${filtered.length - 50} more files_\n`;
        }

        return { content: [{ type: 'text', text }] };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${name}`
          }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'magector://stats',
      name: 'Index Statistics',
      description: 'Current index statistics from Rust core',
      mimeType: 'application/json'
    }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'magector://stats') {
    const stats = rustStats();
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(stats, null, 2)
      }]
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

async function main() {
  // Try to start persistent Rust serve process for fast queries
  try {
    startServeProcess();
    // Give it a moment to load model+index
    await new Promise(r => setTimeout(r, 100));
  } catch {
    // Non-fatal: falls back to execFileSync per query
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Magector MCP server started (Rust core backend)');
}

// Cleanup on exit
process.on('exit', () => {
  if (serveProcess) {
    serveProcess.kill();
  }
});

main().catch(console.error);

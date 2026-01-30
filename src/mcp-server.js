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
let serveReadyPromise = null;
let serveReadyResolve = null;

function startServeProcess() {
  serveReadyPromise = new Promise((resolve) => { serveReadyResolve = resolve; });
  try {
    const args = [
      'serve',
      '-d', config.dbPath,
      '-c', config.modelCache
    ];
    // Enable file watcher if magento root is configured
    if (config.magentoRoot && existsSync(config.magentoRoot)) {
      args.push('-m', config.magentoRoot);
    }
    const proc = spawn(config.rustBinary, args,
      { stdio: ['pipe', 'pipe', 'pipe'], env: rustEnv });

    proc.on('error', () => { serveProcess = null; serveReady = false; if (serveReadyResolve) { serveReadyResolve(false); serveReadyResolve = null; } });
    proc.on('exit', () => { serveProcess = null; serveReady = false; if (serveReadyResolve) { serveReadyResolve(false); serveReadyResolve = null; } });
    proc.stderr.on('data', () => {}); // drain stderr

    serveReadline = createInterface({ input: proc.stdout });
    serveReadline.on('line', (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }

      // First line is ready signal
      if (parsed.ready) {
        serveReady = true;
        if (serveReadyResolve) { serveReadyResolve(true); serveReadyResolve = null; }
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
    if (serveReadyResolve) { serveReadyResolve(false); serveReadyResolve = null; }
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

  // Wait for serve process if it's starting up but not yet ready
  if (serveProcess && !serveReady && serveReadyPromise) {
    await Promise.race([serveReadyPromise, new Promise(r => setTimeout(() => r(false), 10000))]);
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
    searchText: meta.search_text || meta.searchText || '',
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

    // Badges — concise role indicators
    const badges = [];
    if (r.isPlugin) badges.push('plugin');
    if (r.isController) badges.push('controller');
    if (r.isObserver) badges.push('observer');
    if (r.isRepository) badges.push('repository');
    if (r.isResolver) badges.push('graphql-resolver');
    if (r.isModel) badges.push('model');
    if (r.isBlock) badges.push('block');
    if (badges.length > 0) entry.badges = badges;

    // Snippet — first 300 chars of indexed content for quick assessment
    if (r.searchText) {
      entry.snippet = r.searchText.length > 300
        ? r.searchText.slice(0, 300) + '...'
        : r.searchText;
    }

    return entry;
  });

  return JSON.stringify({ results: formatted, count: formatted.length });
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
      description: 'Search Magento codebase semantically — find any PHP class, method, XML config, PHTML template, JS file, or GraphQL schema by describing what you need in natural language. Use this as a general-purpose search when no specialized tool fits. See also: magento_find_class, magento_find_method, magento_find_config for targeted searches.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query describing what you want to find. Examples: "product price calculation logic", "checkout controller", "customer authentication", "add to cart", "order placement flow"'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 10, max: 100)',
            default: 10
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_class',
      description: 'Find a PHP class, interface, abstract class, or trait by name in Magento. Locates repositories, models, resource models, blocks, helpers, controllers, API interfaces, and data objects. See also: magento_find_plugin (interceptors for this class), magento_find_preference (DI overrides), magento_find_method (methods in the class).',
      inputSchema: {
        type: 'object',
        properties: {
          className: {
            type: 'string',
            description: 'Full or partial PHP class name. Examples: "ProductRepository", "AbstractModel", "CartManagementInterface", "CustomerData", "StockItemRepository"'
          },
          namespace: {
            type: 'string',
            description: 'Optional PHP namespace filter to narrow results. Example: "Magento\\Catalog\\Model"'
          }
        },
        required: ['className']
      }
    },
    {
      name: 'magento_find_method',
      description: 'Find implementations of a PHP method or function across the Magento codebase. Searches method names, function definitions, and class method lists. See also: magento_find_class (parent class), magento_find_plugin (interceptors around this method).',
      inputSchema: {
        type: 'object',
        properties: {
          methodName: {
            type: 'string',
            description: 'PHP method or function name to find. Examples: "execute", "getPrice", "save", "getById", "getList", "beforeSave", "afterDelete", "toHtml", "dispatch"'
          },
          className: {
            type: 'string',
            description: 'Optional class name to narrow method search. Example: "ProductRepository"'
          }
        },
        required: ['methodName']
      }
    },
    {
      name: 'magento_find_config',
      description: 'Find XML configuration files and nodes in Magento — di.xml (dependency injection), events.xml (observers), routes.xml (routing), system.xml (admin config), webapi.xml (REST/SOAP), module.xml (module declarations), layout XML. See also: magento_find_observer (events.xml), magento_find_preference (di.xml), magento_find_api (webapi.xml).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What configuration to find. Examples: "di.xml preference for ProductRepository", "routes.xml catalog", "system.xml payment field", "events.xml checkout", "layout xml catalog_product_view"'
          },
          configType: {
            type: 'string',
            enum: ['di', 'routes', 'system', 'events', 'webapi', 'module', 'layout', 'other'],
            description: 'Type of XML configuration: di (dependency injection/preferences/virtualTypes), routes (URL routing), system (admin config fields/sections), events (event observers/listeners), webapi (REST/SOAP endpoint definitions), module (module.xml declarations/setup_version), layout (page layout XML/blocks/containers)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_template',
      description: 'Find PHTML template files in Magento for frontend or admin rendering. Locates view templates for product pages, checkout, customer account, cart, CMS, catalog listing, and more. See also: magento_find_block (Block class rendering the template).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Template description or filename pattern. Examples: "product listing", "checkout form", "customer account dashboard", "minicart", "breadcrumbs", "category view", "order summary"'
          },
          area: {
            type: 'string',
            enum: ['frontend', 'adminhtml', 'base'],
            description: 'Magento area: frontend (customer-facing storefront), adminhtml (admin panel), base (shared/fallback)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_index',
      description: 'Index or re-index the Magento codebase for semantic search. Run this after code changes to update the search index. Indexes PHP, XML, JS, PHTML, and GraphQL files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to Magento 2 root directory. Uses configured MAGENTO_ROOT if not specified.'
          },
        }
      }
    },
    {
      name: 'magento_stats',
      description: 'Get index statistics — total indexed vectors, embedding dimensions, and database path. Use this to verify the index is loaded and check its size.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'magento_find_plugin',
      description: 'Find Magento plugins (interceptors) that modify class behavior via before/after/around methods. Locates Plugin classes and di.xml interceptor declarations. See also: magento_find_class (target class details), magento_find_method (intercepted method), magento_find_config with configType=di.',
      inputSchema: {
        type: 'object',
        properties: {
          targetClass: {
            type: 'string',
            description: 'Class being intercepted by plugins. Examples: "ProductRepository", "CartManagement", "CustomerRepository", "OrderRepository", "Topmenu"'
          },
          targetMethod: {
            type: 'string',
            description: 'Specific method being intercepted. Examples: "save", "getList", "getById", "getHtml", "dispatch"'
          }
        }
      }
    },
    {
      name: 'magento_find_observer',
      description: 'Find event observers (listeners) for a Magento event. Locates Observer classes and events.xml declarations. See also: magento_find_config with configType=events for raw XML.',
      inputSchema: {
        type: 'object',
        properties: {
          eventName: {
            type: 'string',
            description: 'Magento event name. Examples: "checkout_cart_add_product_complete", "sales_order_place_after", "catalog_product_save_after", "customer_login", "controller_action_predispatch"'
          }
        },
        required: ['eventName']
      }
    },
    {
      name: 'magento_find_preference',
      description: 'Find DI preference overrides — which concrete class implements an interface or replaces another class via di.xml. See also: magento_find_class (implementation details), magento_find_config with configType=di.',
      inputSchema: {
        type: 'object',
        properties: {
          interfaceName: {
            type: 'string',
            description: 'Interface or class name to find preference/implementation for. Examples: "ProductRepositoryInterface", "StoreManagerInterface", "LoggerInterface", "OrderRepositoryInterface", "CustomerRepositoryInterface"'
          }
        },
        required: ['interfaceName']
      }
    },
    {
      name: 'magento_find_api',
      description: 'Find REST and SOAP API endpoint definitions in webapi.xml and their service class implementations. See also: magento_find_config with configType=webapi, magento_find_class (service class).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'API endpoint URL pattern or service method name. Examples: "/V1/products", "/V1/orders", "/V1/carts", "/V1/customers", "/V1/categories", "getList", "save"'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            description: 'Filter by HTTP method: GET (read), POST (create), PUT (update), DELETE (remove)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_controller',
      description: 'Find MVC controllers by frontend or admin route path. Maps URL routes to Controller action classes with execute() method. See also: magento_find_config with configType=routes.',
      inputSchema: {
        type: 'object',
        properties: {
          route: {
            type: 'string',
            description: 'URL route path in frontName/controller/action format. Examples: "catalog/product/view", "checkout/cart/add", "customer/account/login", "sales/order/view", "cms/page/view", "wishlist/index/add"'
          },
          area: {
            type: 'string',
            enum: ['frontend', 'adminhtml'],
            description: 'Magento area: frontend (storefront routes) or adminhtml (admin panel routes)'
          }
        },
        required: ['route']
      }
    },
    {
      name: 'magento_find_block',
      description: 'Find Magento Block classes used for view rendering and template logic. Blocks bridge controllers and templates. See also: magento_find_template (PHTML template rendered by the block), magento_find_config with configType=layout.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Block class name or functionality description. Examples: "Product\\View", "cart totals", "category listing", "customer account navigation", "order view", "Topmenu"'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_cron',
      description: 'Find scheduled cron jobs defined in crontab.xml and their handler classes in Cron/ directories. See also: magento_find_config for crontab.xml raw XML.',
      inputSchema: {
        type: 'object',
        properties: {
          jobName: {
            type: 'string',
            description: 'Cron job name or keyword. Examples: "catalog_product", "indexer", "sitemap", "currency", "newsletter", "reindex", "aggregate", "clean"'
          }
        },
        required: ['jobName']
      }
    },
    {
      name: 'magento_find_graphql',
      description: 'Find GraphQL schema definitions (.graphqls), types, queries, mutations, and resolver PHP classes. See also: magento_find_class (resolver implementation), magento_find_method (resolver execute method).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'GraphQL type, query, mutation, or interface name. Examples: "products", "createCustomer", "CartItemInterface", "cart", "categoryList", "placeOrder", "createEmptyCart"'
          },
          schemaType: {
            type: 'string',
            enum: ['type', 'query', 'mutation', 'interface', 'resolver'],
            description: 'Filter by GraphQL schema element: type (object types), query (read operations), mutation (write operations), interface (shared contracts), resolver (PHP resolver classes)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'magento_find_db_schema',
      description: 'Find database table definitions, columns, indexes, and constraints declared in db_schema.xml (Magento declarative schema). See also: magento_find_class (model/resource model for the table).',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'Database table name or pattern. Examples: "catalog_product_entity", "sales_order", "customer_entity", "quote", "cms_page", "inventory_source"'
          }
        },
        required: ['tableName']
      }
    },
    {
      name: 'magento_module_structure',
      description: 'Get the complete structure of a Magento module — lists all controllers, models, blocks, plugins, observers, API classes, XML configs, and templates. Provides an overview of module architecture.',
      inputSchema: {
        type: 'object',
        properties: {
          moduleName: {
            type: 'string',
            description: 'Full Magento module name in Vendor_Module format. Examples: "Magento_Catalog", "Magento_Sales", "Magento_Customer", "Magento_Checkout", "Vendor_CustomModule"'
          }
        },
        required: ['moduleName']
      }
    },
    {
      name: 'magento_analyze_diff',
      description: 'Analyze git diffs for risk scoring, change classification, and per-file impact analysis. Works on specific commits or staged changes. Useful for code review.',
      inputSchema: {
        type: 'object',
        properties: {
          commitHash: {
            type: 'string',
            description: 'Git commit hash to analyze. If omitted, analyzes currently staged (git add) changes instead.'
          },
          staged: {
            type: 'boolean',
            description: 'Set true to analyze staged changes, false to require commitHash. Default: true.',
            default: true
          }
        }
      }
    },
    {
      name: 'magento_complexity',
      description: 'Analyze code complexity — cyclomatic complexity, function count, and line count for PHP files. Identifies complex hotspots and rates each file. Use for refactoring prioritization.',
      inputSchema: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'Magento module to analyze. Finds all PHP files in the module. Examples: "Magento_Catalog", "Magento_Checkout", "Magento_Sales"'
          },
          path: {
            type: 'string',
            description: 'Specific file or directory path to analyze instead of a module name'
          },
          threshold: {
            type: 'number',
            description: 'Minimum cyclomatic complexity to report. Set higher (e.g., 10) to only see complex files. Default: 0 (show all)',
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
        const raw = await rustSearchAsync(query, 50);
        const methodLower = args.methodName.toLowerCase();
        // Hard-filter: only results that actually define/contain this method
        let results = raw.map(normalizeResult).filter(r =>
          r.methodName?.toLowerCase() === methodLower ||
          r.methods?.some(m => m.toLowerCase() === methodLower || m.toLowerCase().includes(methodLower))
        );
        // If not enough results from methods[], fall back to path-based matching
        if (results.length < 3) {
          const pathFallback = raw.map(normalizeResult).filter(r =>
            r.path?.toLowerCase().includes(methodLower) &&
            !results.some(existing => existing.path === r.path)
          );
          results = results.concat(pathFallback);
        }
        // Boost exact method matches to top
        results = results.map(r => {
          let bonus = 0;
          if (r.methods?.some(m => m.toLowerCase() === methodLower)) bonus += 0.5;
          if (r.methodName?.toLowerCase() === methodLower) bonus += 0.3;
          return { ...r, score: (r.score || 0) + bonus };
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
          query = `${args.configType}.xml xml config ${args.query}`;
        }
        const raw = await rustSearchAsync(query, 100);
        let normalized = raw.map(normalizeResult);
        // Hard-filter to XML results
        const xmlOnly = normalized.filter(r =>
          r.type === 'xml' || r.path?.endsWith('.xml') || r.path?.includes('.xml')
        );
        if (xmlOnly.length > 0) normalized = xmlOnly;
        // Hard-filter to specific config type when specified
        if (args.configType && args.configType !== 'other') {
          const configTypeFile = `${args.configType}.xml`;
          const typeSpecific = normalized.filter(r =>
            r.path?.includes(configTypeFile)
          );
          if (typeSpecific.length >= 3) normalized = typeSpecific;
        }
        const pathBoost = args.configType ? [`${args.configType}.xml`] : ['.xml'];
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
        const raw = await rustSearchAsync(query, 50);
        // Hard-filter to .phtml template files only
        let results = raw.map(normalizeResult).filter(r =>
          r.path?.includes('.phtml') || r.type === 'template'
        );
        results = rerank(results, { pathContains: ['.phtml'] });
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
            text: formatSearchResults(results.slice(0, 15))
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
            text: formatSearchResults(results.slice(0, 15))
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
            text: formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_find_controller': {
        const parts = args.route.split('/');
        // Map route to Magento namespace: catalog/product/view → Catalog Controller Product View
        const namespaceParts = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1));
        const query = `${namespaceParts.join(' ')} controller execute action`;

        const raw = await rustSearchAsync(query, 50);
        // Prefer path-based controller detection, fall back to isController flag
        let results = raw.map(normalizeResult).filter(r =>
          r.path?.includes('/Controller/')
        );
        if (results.length < 5) {
          // Add isController-flagged results not already included
          const extra = raw.map(normalizeResult).filter(r =>
            r.isController && !results.some(e => e.path === r.path)
          );
          results = results.concat(extra);
        }

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
            text: formatSearchResults(results)
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
            text: formatSearchResults(results.slice(0, 15))
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
            text: formatSearchResults(results.slice(0, 15))
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
            text: formatSearchResults(results.slice(0, 15))
          }]
        };
      }

      case 'magento_module_structure': {
        const raw = await rustSearchAsync(args.moduleName, 200);
        // Support both app/code (Magento/Catalog/) and vendor (module-catalog/) paths
        const modulePath = args.moduleName.replace('_', '/') + '/';
        const parts = args.moduleName.split('_');
        const vendorPath = parts.length === 2
          ? `module-${parts[1].toLowerCase()}/`
          : '';
        const results = raw.map(normalizeResult).filter(r => {
          const path = r.path || '';
          const mod = r.module || '';
          // Exact module match or directory-level path match (trailing slash prevents Catalog matching CatalogRule)
          return mod === args.moduleName ||
            path.includes(modulePath) ||
            (vendorPath && path.toLowerCase().includes(vendorPath));
        });

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

        // Build structured JSON output for module structure
        const structureOutput = {
          module: args.moduleName,
          totalFiles: results.length,
          categories: {}
        };
        for (const [category, items] of Object.entries(structure)) {
          if (items.length > 0) {
            structureOutput.categories[category] = {
              count: items.length,
              files: items.slice(0, 10).map(item => ({
                path: item.path,
                className: item.className || null,
                methods: item.methods?.length > 0 ? item.methods : undefined
              }))
            };
          }
        }

        // Return both JSON and formatted summary
        const jsonOutput = JSON.stringify({
          results: results.slice(0, 50).map((r, i) => ({
            rank: i + 1,
            path: r.path,
            className: r.className || undefined,
            magentoType: r.magentoType || undefined,
            module: r.module || undefined
          })),
          count: results.length,
          structure: structureOutput.categories
        });

        return { content: [{ type: 'text', text: jsonOutput }] };
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
    // Wait for the serve process to load ONNX model + HNSW index (up to 15s)
    if (serveReadyPromise) {
      const ready = await Promise.race([
        serveReadyPromise,
        new Promise(r => setTimeout(() => r(false), 15000))
      ]);
      if (ready) {
        console.error('Serve process ready (persistent mode)');
      } else {
        console.error('Serve process not ready in time, will use fallback');
      }
    }
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

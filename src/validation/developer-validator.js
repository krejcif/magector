#!/usr/bin/env node
/**
 * Developer Use Case Validation for Agentic Development
 * Tests real-world queries that developers make when using Claude Code or Cursor
 * Focus: Finding relevant code context for Magento 2 development
 */

import { MagentoIndexer } from '../indexer.js';

const DB_PATH = './magector.db';
const GRAPH_PATH = './magector-graph.json';

// Real developer use cases organized by development task
const DEVELOPER_QUERIES = [
  // ============================================
  // CATEGORY: Adding New Features
  // ============================================
  {
    id: 'dev-feat-1',
    query: 'how to add custom payment method',
    category: 'new_feature',
    description: 'Developer wants to implement a new payment method',
    expect: { pathContains: 'payment', anyOf: ['Method', 'Gateway', 'Model'] }
  },
  {
    id: 'dev-feat-2',
    query: 'create new product attribute programmatically',
    category: 'new_feature',
    description: 'Developer needs to add EAV attribute',
    expect: { pathContains: 'eav', anyOf: ['Attribute', 'Setup'] }
  },
  {
    id: 'dev-feat-3',
    query: 'add custom shipping carrier rate',
    category: 'new_feature',
    description: 'Developer wants to add shipping method',
    expect: { pathContains: 'shipping', anyOf: ['Carrier', 'Rate'] }
  },
  {
    id: 'dev-feat-4',
    query: 'webapi REST API endpoint products route',
    category: 'new_feature',
    description: 'Developer needs to create API endpoint',
    expect: { anyPathContains: ['webapi.xml', 'Api/'] }
  },
  {
    id: 'dev-feat-5',
    query: 'add GraphQL mutation for cart operations',
    category: 'new_feature',
    description: 'Developer wants to extend GraphQL',
    expect: { pathContains: 'graphql', anyOf: ['Resolver', 'Mutation', 'Cart'] }
  },
  {
    id: 'dev-feat-6',
    query: 'create admin grid UI component',
    category: 'new_feature',
    description: 'Developer needs admin listing page',
    expect: { anyPathContains: ['ui_component', 'Adminhtml', 'Grid'] }
  },
  {
    id: 'dev-feat-7',
    query: 'add custom console command CLI',
    category: 'new_feature',
    description: 'Developer wants to create CLI command',
    expect: { pathContains: 'console', anyOf: ['Command', 'Cli'] }
  },
  {
    id: 'dev-feat-8',
    query: 'implement cron job scheduled task',
    category: 'new_feature',
    description: 'Developer needs scheduled task',
    expect: { anyPathContains: ['crontab.xml', 'Cron/'] }
  },

  // ============================================
  // CATEGORY: Extending Existing Features
  // ============================================
  {
    id: 'dev-ext-1',
    query: 'plugin to modify product price calculation',
    category: 'extending',
    description: 'Developer wants to intercept price logic',
    expect: { pathContains: 'plugin', anyOf: ['Price', 'Product'] }
  },
  {
    id: 'dev-ext-2',
    query: 'observer for order placement event',
    category: 'extending',
    description: 'Developer needs to react to order events',
    expect: { anyPathContains: ['Observer', 'events.xml'] }
  },
  {
    id: 'dev-ext-3',
    query: 'preference to override customer model',
    category: 'extending',
    description: 'Developer wants to rewrite class',
    expect: { anyPathContains: ['di.xml', 'Customer/Model'] }
  },
  {
    id: 'dev-ext-4',
    query: 'extend checkout with custom step',
    category: 'extending',
    description: 'Developer adding checkout step',
    expect: { pathContains: 'checkout', anyOf: ['Step', 'Layout', 'Block'] }
  },
  {
    id: 'dev-ext-5',
    query: 'add custom totals collector quote',
    category: 'extending',
    description: 'Developer extending totals calculation',
    expect: { pathContains: 'quote', anyOf: ['Total', 'Collector', 'Model'] }
  },

  // ============================================
  // CATEGORY: Understanding Code Flow
  // ============================================
  {
    id: 'dev-flow-1',
    query: 'checkout cart add product controller action',
    category: 'code_flow',
    description: 'Understanding cart add flow',
    expect: { anyPathContains: ['Cart', 'Checkout/Controller', 'Add'] }
  },
  {
    id: 'dev-flow-2',
    query: 'checkout order placement process',
    category: 'code_flow',
    description: 'Understanding order creation',
    expect: { anyPathContains: ['Sales/Model/Order', 'Checkout/Model', 'PlaceOrder'] }
  },
  {
    id: 'dev-flow-3',
    query: 'product save process backend',
    category: 'code_flow',
    description: 'Understanding product save',
    expect: { pathContains: 'catalog', anyOf: ['Product', 'Save', 'Repository'] }
  },
  {
    id: 'dev-flow-4',
    query: 'customer registration login authentication',
    category: 'code_flow',
    description: 'Understanding auth flow',
    expect: { pathContains: 'customer', anyOf: ['Account', 'Login', 'Create'] }
  },
  {
    id: 'dev-flow-5',
    query: 'indexer reindex process full partial',
    category: 'code_flow',
    description: 'Understanding indexing',
    expect: { pathContains: 'indexer', anyOf: ['Action', 'Execute', 'Model'] }
  },

  // ============================================
  // CATEGORY: Configuration & Settings
  // ============================================
  {
    id: 'dev-cfg-1',
    query: 'system.xml admin configuration section field',
    category: 'config',
    description: 'Finding system config',
    expect: { pathContains: 'system.xml' }
  },
  {
    id: 'dev-cfg-2',
    query: 'dependency injection di.xml arguments',
    category: 'config',
    description: 'Finding DI configuration',
    expect: { pathContains: 'di.xml' }
  },
  {
    id: 'dev-cfg-3',
    query: 'webapi routes REST endpoint definition',
    category: 'config',
    description: 'Finding API routes',
    expect: { pathContains: 'webapi.xml' }
  },
  {
    id: 'dev-cfg-4',
    query: 'database schema table definition',
    category: 'config',
    description: 'Finding DB schema',
    expect: { pathContains: 'db_schema' }
  },
  {
    id: 'dev-cfg-5',
    query: 'acl.xml resource permission Magento admin',
    category: 'config',
    description: 'Finding ACL config',
    expect: { pathContains: 'acl.xml' }
  },
  {
    id: 'dev-cfg-6',
    query: 'layout XML block container update',
    category: 'config',
    description: 'Finding layout files',
    expect: { pathContains: 'layout' }
  },
  {
    id: 'dev-cfg-7',
    query: 'events.xml observer dispatch',
    category: 'config',
    description: 'Finding event config',
    expect: { pathContains: 'events.xml' }
  },

  // ============================================
  // CATEGORY: Debugging & Troubleshooting
  // ============================================
  {
    id: 'dev-debug-1',
    query: 'product final price calculation FinalPrice model',
    category: 'debugging',
    description: 'Finding price calculation logic',
    expect: { pathContains: 'catalog', anyOf: ['Price', 'FinalPrice'] }
  },
  {
    id: 'dev-debug-2',
    query: 'cart item validation error message',
    category: 'debugging',
    description: 'Finding cart validation',
    expect: { anyPathContains: ['Quote/Model', 'Cart', 'Validator'] }
  },
  {
    id: 'dev-debug-3',
    query: 'order status state change transition',
    category: 'debugging',
    description: 'Finding order state logic',
    expect: { pathContains: 'sales', anyOf: ['Order', 'State', 'Status'] }
  },
  {
    id: 'dev-debug-4',
    query: 'payment authorization failure handling',
    category: 'debugging',
    description: 'Finding payment error handling',
    expect: { pathContains: 'payment', anyOf: ['Gateway', 'Exception', 'Authorize'] }
  },
  {
    id: 'dev-debug-5',
    query: 'stock inventory validation out of stock',
    category: 'debugging',
    description: 'Finding stock validation',
    expect: { anyPathContains: ['Inventory', 'Stock', 'CatalogInventory'] }
  },

  // ============================================
  // CATEGORY: Database & Models
  // ============================================
  {
    id: 'dev-db-1',
    query: 'product entity model save load',
    category: 'database',
    description: 'Finding product model',
    expect: { pathContains: 'catalog', anyOf: ['Product', 'Model', 'Entity'] }
  },
  {
    id: 'dev-db-2',
    query: 'customer address repository CRUD',
    category: 'database',
    description: 'Finding address repository',
    expect: { pathContains: 'customer', anyOf: ['Address', 'Repository'] }
  },
  {
    id: 'dev-db-3',
    query: 'order item collection filter',
    category: 'database',
    description: 'Finding order item collection',
    expect: { pathContains: 'sales', anyOf: ['Order', 'Item', 'Collection'] }
  },
  {
    id: 'dev-db-4',
    query: 'search criteria filter sort page',
    category: 'database',
    description: 'Finding search criteria usage',
    expect: { anyOf: ['SearchCriteria', 'Filter', 'Repository'] }
  },
  {
    id: 'dev-db-5',
    query: 'EAV attribute value storage backend',
    category: 'database',
    description: 'Finding EAV storage',
    expect: { pathContains: 'eav', anyOf: ['Attribute', 'Backend', 'Value'] }
  },

  // ============================================
  // CATEGORY: Frontend & Templates
  // ============================================
  {
    id: 'dev-fe-1',
    query: 'product list template view frontend phtml',
    category: 'frontend',
    description: 'Finding product list template',
    expect: { anyPathContains: ['templates', 'phtml', 'product/list'] }
  },
  {
    id: 'dev-fe-2',
    query: 'minicart knockout JS component',
    category: 'frontend',
    description: 'Finding minicart JS',
    expect: { pathContains: 'checkout', anyOf: ['minicart', 'cart', 'js'] }
  },
  {
    id: 'dev-fe-3',
    query: 'checkout payment step UI component',
    category: 'frontend',
    description: 'Finding checkout payment UI',
    expect: { pathContains: 'checkout', anyOf: ['payment', 'step', 'js'] }
  },
  {
    id: 'dev-fe-4',
    query: 'block template for product view page',
    category: 'frontend',
    description: 'Finding product view template',
    expect: { pathContains: 'catalog', anyOf: ['Block', 'Product', 'View'] }
  },
  {
    id: 'dev-fe-5',
    query: 'form validation frontend JavaScript',
    category: 'frontend',
    description: 'Finding form validation',
    expect: { anyPathContains: ['validation', 'form', 'js'] }
  },

  // ============================================
  // CATEGORY: API & Integration
  // ============================================
  {
    id: 'dev-api-1',
    query: 'product API interface getById list',
    category: 'api',
    description: 'Finding product API',
    expect: { pathContains: 'catalog', anyOf: ['Api', 'Interface', 'Repository'] }
  },
  {
    id: 'dev-api-2',
    query: 'CustomerTokenService API integration token',
    category: 'api',
    description: 'Finding customer auth API',
    expect: { pathContains: 'customer', anyOf: ['Token', 'Api', 'Integration'] }
  },
  {
    id: 'dev-api-3',
    query: 'Quote Api CartManagement interface guest',
    category: 'api',
    description: 'Finding cart API',
    expect: { anyPathContains: ['Quote/Api', 'Cart', 'Management'] }
  },
  {
    id: 'dev-api-4',
    query: 'GraphQL resolver products query',
    category: 'api',
    description: 'Finding GraphQL resolver',
    expect: { pathContains: 'graphql', anyOf: ['Resolver', 'Product'] }
  },
  {
    id: 'dev-api-5',
    query: 'service contract interface implementation',
    category: 'api',
    description: 'Finding service contracts',
    expect: { pathContains: 'api', anyOf: ['Interface', 'Contract', 'Service'] }
  },

  // ============================================
  // CATEGORY: Module Structure
  // ============================================
  {
    id: 'dev-mod-1',
    query: 'module registration composer',
    category: 'module_structure',
    description: 'Finding module registration',
    expect: { anyOf: ['registration', 'module.xml', 'etc/'] }
  },
  {
    id: 'dev-mod-2',
    query: 'setup install upgrade schema data patch',
    category: 'module_structure',
    description: 'Finding setup scripts',
    expect: { anyPathContains: ['Setup', 'Patch', 'InstallSchema', 'UpgradeSchema'] }
  },

  // ============================================
  // CATEGORY: Specific Class/Method Lookup
  // ============================================
  {
    id: 'dev-class-1',
    query: 'Framework Model AbstractModel base class',
    category: 'class_lookup',
    description: 'Finding AbstractModel base class',
    expect: { anyPathContains: ['AbstractModel', 'Model/AbstractModel', 'Framework/Model'] }
  },
  {
    id: 'dev-class-2',
    query: 'ProductRepository implementation getById',
    category: 'class_lookup',
    description: 'Finding ProductRepository',
    expect: { pathContains: 'catalog', anyOf: ['ProductRepository', 'Repository'] }
  },
  {
    id: 'dev-class-3',
    query: 'Quote model loadByCustomerId',
    category: 'class_lookup',
    description: 'Finding Quote model',
    expect: { pathContains: 'quote', anyOf: ['Model', 'Quote'] }
  },
  {
    id: 'dev-class-4',
    query: 'Block AbstractBlock _toHtml render',
    category: 'class_lookup',
    description: 'Finding AbstractBlock',
    expect: { anyPathContains: ['Block', 'AbstractBlock'] }
  },
  {
    id: 'dev-class-5',
    query: 'Framework DataObject base class getData',
    category: 'class_lookup',
    description: 'Finding DataObject',
    expect: { anyPathContains: ['DataObject', 'Framework/DataObject', 'Framework'] }
  }
];

async function runDeveloperValidation() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     MAGECTOR - DEVELOPER USE CASE VALIDATION                   ║');
  console.log('║     Testing Real-World Agentic Development Queries             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const idx = new MagentoIndexer({
    dbPath: DB_PATH,
    graphPath: GRAPH_PATH,
    enableGNN: true
  });
  await idx.init();

  const stats = await idx.getStats();
  console.log(`Index: ${stats.totalVectors} vectors, GNN: ${stats.gnnAvailable ? 'enabled' : 'disabled'}`);
  console.log(`Graph: ${stats.graphNodes} nodes, ${stats.graphEdges} edges\n`);
  console.log('Running developer use case queries...\n');

  let passed = 0;
  let failed = 0;
  const categoryResults = {};
  const failures = [];
  const latencies = [];

  for (const q of DEVELOPER_QUERIES) {
    const start = Date.now();
    const results = await idx.searchWithGraph(q.query, { limit: 10 });
    const dur = Date.now() - start;
    latencies.push(dur);

    // Check expectations with flexible matching
    let ok = results.length > 0;
    if (ok && q.expect) {
      // pathContains - path must contain this string
      if (q.expect.pathContains) {
        ok = results.some(r => r.path?.toLowerCase().includes(q.expect.pathContains.toLowerCase()));
      }

      // anyPathContains - path must contain at least one of these strings
      if (ok && q.expect.anyPathContains) {
        ok = results.some(r =>
          q.expect.anyPathContains.some(p => r.path?.toLowerCase().includes(p.toLowerCase()))
        );
      }

      // anyOf - path or className must contain at least one of these
      if (ok && q.expect.anyOf) {
        ok = results.some(r =>
          q.expect.anyOf.some(term =>
            r.path?.toLowerCase().includes(term.toLowerCase()) ||
            r.className?.toLowerCase().includes(term.toLowerCase())
          )
        );
      }

      // classContains - className must contain this string
      if (ok && q.expect.classContains) {
        ok = results.some(r => r.className?.toLowerCase().includes(q.expect.classContains.toLowerCase()));
      }
    }

    if (ok) passed++; else { failed++; failures.push(q); }

    const cat = categoryResults[q.category] || { passed: 0, total: 0 };
    cat.total++;
    if (ok) cat.passed++;
    categoryResults[q.category] = cat;

    const status = ok ? '✓' : '✗';
    const topResult = results[0];
    const topPath = topResult?.path?.substring(0, 55) || 'no results';
    console.log(`  ${status} [${q.id}] "${q.query.substring(0, 45).padEnd(45)}" → ${topPath} ${dur}ms`);

    if (!ok && results.length > 0) {
      console.log(`         Expected: ${JSON.stringify(q.expect)}`);
      console.log(`         Got top3: ${results.slice(0, 3).map(r => r.path?.split('/').slice(-2).join('/')).join(', ')}`);
    }
  }

  // Summary
  const total = passed + failed;
  const passRate = ((passed / total) * 100).toFixed(1);

  latencies.sort((a, b) => a - b);
  const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);
  const p50Latency = latencies[Math.floor(latencies.length * 0.5)];
  const p99Latency = latencies[Math.floor(latencies.length * 0.99)];

  console.log(`
================================================================================
                     DEVELOPER USE CASE RESULTS
================================================================================

  Total:    ${total} queries
  Passed:   ${passed} (${passRate}%)
  Failed:   ${failed}
  Latency:  avg ${avgLatency}ms, p50 ${p50Latency}ms, p99 ${p99Latency}ms

  CATEGORIES:
`);

  const sortedCats = Object.entries(categoryResults).sort((a, b) => {
    const rateA = a[1].passed / a[1].total;
    const rateB = b[1].passed / b[1].total;
    return rateB - rateA;
  });

  for (const [name, cat] of sortedCats) {
    const rate = cat.passed / cat.total;
    const status = rate >= 0.8 ? '✓' : rate >= 0.5 ? '~' : '✗';
    const label = name.replace(/_/g, ' ').padEnd(20);
    console.log(`  ${status} ${label} ${cat.passed}/${cat.total} (${(rate * 100).toFixed(0)}%)`);
  }

  if (failures.length > 0 && failures.length <= 15) {
    console.log(`\n  FAILED QUERIES:`);
    for (const f of failures) {
      console.log(`    [${f.id}] "${f.query}"`);
      console.log(`         Use case: ${f.description}`);
    }
  } else if (failures.length > 15) {
    console.log(`\n  FAILED QUERIES: ${failures.length} total (showing first 10)`);
    for (const f of failures.slice(0, 10)) {
      console.log(`    [${f.id}] "${f.query}"`);
    }
  }

  // Developer readiness assessment
  console.log(`
================================================================================
                     AGENTIC DEVELOPMENT READINESS
================================================================================
`);

  const readinessScore = passed / total;
  let readinessLevel;
  if (readinessScore >= 0.9) {
    readinessLevel = '🟢 EXCELLENT - Ready for production agentic development';
  } else if (readinessScore >= 0.8) {
    readinessLevel = '🟡 GOOD - Suitable for most development tasks';
  } else if (readinessScore >= 0.7) {
    readinessLevel = '🟠 ACCEPTABLE - May need manual context supplementation';
  } else {
    readinessLevel = '🔴 NEEDS IMPROVEMENT - Reindex with better patterns';
  }

  console.log(`  Readiness: ${readinessLevel}`);
  console.log(`  Accuracy:  ${passRate}%`);
  console.log(`
  This score indicates how well the indexer can provide relevant
  code context for AI-assisted development with Claude Code or Cursor.
`);

  console.log('================================================================================\n');

  return { passed, failed, total, passRate: passed / total };
}

runDeveloperValidation().catch(console.error);

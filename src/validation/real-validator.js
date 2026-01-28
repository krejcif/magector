#!/usr/bin/env node
/**
 * Validation against real Magento 2 codebase
 * Tests known classes, methods, configs
 * Updated for ruvector VectorDB (path/class-based checks, no content)
 */

import { MagentoIndexer } from '../indexer.js';

const DB_PATH = './magector.db';
const GRAPH_PATH = './magector-graph.json';

// Real Magento classes and where they should be found
const REAL_QUERIES = [
  // Controllers
  {
    id: 'real-ctrl-1',
    query: 'product view controller execute',
    category: 'controller',
    expect: { pathContains: 'Controller' }
  },
  {
    id: 'real-ctrl-2',
    query: 'checkout cart add controller',
    category: 'controller',
    expect: { pathContains: 'Checkout' }
  },
  {
    id: 'real-ctrl-3',
    query: 'customer account login controller',
    category: 'controller',
    expect: { pathContains: 'Customer' }
  },

  // Repositories
  {
    id: 'real-repo-1',
    query: 'ProductRepository getById save',
    category: 'repository',
    expect: { pathContains: 'Catalog' }
  },
  {
    id: 'real-repo-2',
    query: 'CustomerRepository getById',
    category: 'repository',
    expect: { pathContains: 'Customer' }
  },
  {
    id: 'real-repo-3',
    query: 'OrderRepository getList',
    category: 'repository',
    expect: { pathContains: 'Sales' }
  },

  // Models
  {
    id: 'real-model-1',
    query: 'Product model getPrice getName',
    category: 'model',
    expect: { pathContains: 'Catalog' }
  },
  {
    id: 'real-model-2',
    query: 'Order model AbstractModel',
    category: 'model',
    expect: { pathContains: 'Sales' }
  },
  {
    id: 'real-model-3',
    query: 'Quote model totals calculation',
    category: 'model',
    expect: { pathContains: 'Quote' }
  },

  // Plugins
  {
    id: 'real-plugin-1',
    query: 'plugin interceptor authentication',
    category: 'plugin',
    expect: { pathContains: 'Plugin' }
  },
  {
    id: 'real-plugin-2',
    query: 'before after around plugin method',
    category: 'plugin',
    expect: { isPlugin: true }
  },

  // Observers
  {
    id: 'real-obs-1',
    query: 'observer sales order place',
    category: 'observer',
    expect: { pathContains: 'Observer' }
  },
  {
    id: 'real-obs-2',
    query: 'ObserverInterface execute event',
    category: 'observer',
    expect: { isObserver: true }
  },

  // DI Configuration
  {
    id: 'real-di-1',
    query: 'preference ProductRepositoryInterface',
    category: 'di',
    expect: { pathContains: 'di.xml' }
  },
  {
    id: 'real-di-2',
    query: 'di.xml type arguments proxy',
    category: 'di',
    expect: { pathContains: 'di.xml' }
  },

  // Events
  {
    id: 'real-event-1',
    query: 'event checkout_cart_save_after',
    category: 'events',
    expect: { pathContains: 'events.xml' }
  },
  {
    id: 'real-event-2',
    query: 'catalog_product_save_before event observer',
    category: 'events',
    expect: { pathContains: 'Catalog' }
  },

  // Web API
  {
    id: 'real-api-1',
    query: 'REST API products V1 route',
    category: 'webapi',
    expect: { pathContains: 'webapi.xml' }
  },
  {
    id: 'real-api-2',
    query: 'webapi route customer service',
    category: 'webapi',
    expect: { pathContains: 'Customer' }
  },

  // Blocks
  {
    id: 'real-block-1',
    query: 'product list block template',
    category: 'block',
    expect: { pathContains: 'Block' }
  },
  {
    id: 'real-block-2',
    query: 'cart sidebar block minicart',
    category: 'block',
    expect: { pathContains: 'Checkout' }
  },

  // GraphQL
  {
    id: 'real-gql-1',
    query: 'GraphQL products query resolver',
    category: 'graphql',
    expect: { pathContains: 'GraphQl' }
  },
  {
    id: 'real-gql-2',
    query: 'addProductsToCart mutation resolver',
    category: 'graphql',
    expect: { pathContains: 'GraphQl' }
  },

  // Cron
  {
    id: 'real-cron-1',
    query: 'cron reindex catalog product',
    category: 'cron',
    expect: { pathContains: 'crontab.xml' }
  },

  // Layout
  {
    id: 'real-layout-1',
    query: 'layout block catalog product view',
    category: 'layout',
    expect: { pathContains: 'layout' }
  },

  // System Config
  {
    id: 'real-config-1',
    query: 'system.xml section group field payment',
    category: 'config',
    expect: { pathContains: 'system.xml' }
  },

  // DB Schema
  {
    id: 'real-db-1',
    query: 'db_schema table catalog_product_entity',
    category: 'db_schema',
    expect: { pathContains: 'db_schema' }
  },

  // Setup
  {
    id: 'real-setup-1',
    query: 'DataPatchInterface apply upgrade',
    category: 'setup',
    expect: { pathContains: 'Setup' }
  },

  // Specific known classes
  {
    id: 'real-class-1',
    query: 'AbstractModel _construct _init',
    category: 'specific_class',
    expect: { classContains: 'AbstractModel' }
  },
  {
    id: 'real-class-2',
    query: 'SearchCriteriaBuilder create addFilter',
    category: 'specific_class',
    expect: { classContains: 'SearchCriteria' }
  },

  // Console Commands
  {
    id: 'real-console-1',
    query: 'console command setup upgrade',
    category: 'console',
    expect: { pathContains: 'Console' }
  },

  // EAV
  {
    id: 'real-eav-1',
    query: 'EAV attribute entity backend frontend',
    category: 'eav',
    expect: { pathContains: 'Eav' }
  },

  // Indexer
  {
    id: 'real-idx-1',
    query: 'indexer execute full reindex',
    category: 'indexer',
    expect: { pathContains: 'Indexer' }
  },

  // ACL
  {
    id: 'real-acl-1',
    query: 'acl resource Magento_Catalog',
    category: 'acl',
    expect: { pathContains: 'acl' }
  },

  // Payment
  {
    id: 'real-pay-1',
    query: 'payment method authorize capture',
    category: 'payment',
    expect: { pathContains: 'Payment' }
  },

  // Shipping
  {
    id: 'real-ship-1',
    query: 'shipping carrier rate collectRates',
    category: 'shipping',
    expect: { pathContains: 'Shipping' }
  },

  // Cache
  {
    id: 'real-cache-1',
    query: 'cache type clean flush tag',
    category: 'cache',
    expect: { pathContains: 'Cache' }
  },

  // Dependency queries through graph
  {
    id: 'real-dep-1',
    query: 'ProductRepository dependencies',
    category: 'dependencies',
    type: 'graph',
    className: 'ProductRepository'
  }
];

async function runRealValidation() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       MAGECTOR - REAL MAGENTO 2 ACCURACY TEST                 ║');
  console.log('║       Using ruvector VectorDB + CodeGraph + GNN               ║');
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
  console.log('Running queries against real Magento 2 code...\n');

  let passed = 0;
  let failed = 0;
  const categoryResults = {};
  const failures = [];
  const latencies = [];

  for (const q of REAL_QUERIES) {
    const start = Date.now();
    let results;

    if (q.type === 'graph') {
      const deps = await idx.findDependencies(q.className);
      const totalDeps = Object.values(deps).flat().length;
      const dur = Date.now() - start;
      latencies.push(dur);

      const ok = totalDeps > 0;
      if (ok) passed++; else { failed++; failures.push(q); }

      const cat = categoryResults[q.category] || { passed: 0, total: 0 };
      cat.total++;
      if (ok) cat.passed++;
      categoryResults[q.category] = cat;

      const status = ok ? '✓' : '✗';
      console.log(`  ${status} [${q.id}] "${q.query.substring(0, 45).padEnd(45)}" deps:${totalDeps} ${dur}ms`);
      continue;
    }

    results = await idx.searchWithGraph(q.query, { limit: 10 });
    const dur = Date.now() - start;
    latencies.push(dur);

    // Check expectations
    let ok = results.length > 0;
    if (ok && q.expect) {
      if (q.expect.pathContains) {
        ok = results.some(r => r.path?.toLowerCase().includes(q.expect.pathContains.toLowerCase()));
      }
      if (ok && q.expect.classContains) {
        ok = results.some(r =>
          r.className?.toLowerCase().includes(q.expect.classContains.toLowerCase()) ||
          r.path?.toLowerCase().includes(q.expect.classContains.toLowerCase())
        );
      }
      if (ok && q.expect.isPlugin) {
        ok = results.some(r => r.isPlugin === true);
      }
      if (ok && q.expect.isObserver) {
        ok = results.some(r => r.isObserver === true);
      }
      if (ok && q.expect.isController) {
        ok = results.some(r => r.isController === true);
      }
      if (ok && q.expect.isRepository) {
        ok = results.some(r => r.isRepository === true);
      }
    }

    if (ok) passed++; else { failed++; failures.push(q); }

    const cat = categoryResults[q.category] || { passed: 0, total: 0 };
    cat.total++;
    if (ok) cat.passed++;
    categoryResults[q.category] = cat;

    const status = ok ? '✓' : '✗';
    const topResult = results[0];
    const topPath = topResult?.path?.substring(0, 50) || 'no results';
    const topClass = topResult?.className || '';
    console.log(`  ${status} [${q.id}] "${q.query.substring(0, 45).padEnd(45)}" → ${topPath} [${topClass}] ${dur}ms`);
    if (!ok && results.length > 0) {
      console.log(`         Expected: ${JSON.stringify(q.expect)}`);
      console.log(`         Got top3: ${results.slice(0, 3).map(r => r.path?.substring(0, 60)).join(', ')}`);
    }
  }

  // Summary
  const total = passed + failed;
  const passRate = ((passed / total) * 100).toFixed(1);

  latencies.sort((a, b) => a - b);
  const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);
  const p99Latency = latencies[Math.floor(latencies.length * 0.99)];

  console.log(`
================================================================================
                          RESULTS
================================================================================

  Total:    ${total} queries
  Passed:   ${passed} (${passRate}%)
  Failed:   ${failed}
  Latency:  avg ${avgLatency}ms, p99 ${p99Latency}ms

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
    console.log(`  ${status} ${name.padEnd(20)} ${cat.passed}/${cat.total} (${(rate * 100).toFixed(0)}%)`);
  }

  if (failures.length > 0) {
    console.log(`\n  FAILED QUERIES:`);
    for (const f of failures) {
      console.log(`    [${f.id}] "${f.query}"`);
    }
  }

  console.log(`
================================================================================
`);

  return { passed, failed, total, passRate: passed / total };
}

runRealValidation().catch(console.error);

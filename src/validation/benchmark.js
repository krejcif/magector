#!/usr/bin/env node
/**
 * Comprehensive benchmark suite for Magector
 */

import { MagentoIndexer } from '../indexer.js';
import { generateCompleteMockModule, MOCK_MODULES } from './test-data-generator.js';
import { TEST_QUERIES } from './test-queries.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const BENCHMARK_DIR = '/private/tmp/magector-benchmark';

class BenchmarkSuite {
  constructor() {
    this.results = {
      indexing: {},
      search: {},
      memory: {},
      gnn: {}
    };
  }

  async setup(moduleCount = 5) {
    console.log(`\nSetting up benchmark with ${moduleCount} modules...`);

    if (existsSync(BENCHMARK_DIR)) {
      await rm(BENCHMARK_DIR, { recursive: true });
    }
    await mkdir(`${BENCHMARK_DIR}/app/code`, { recursive: true });

    let totalFiles = 0;
    const modules = MOCK_MODULES.slice(0, moduleCount);

    for (const moduleName of modules) {
      const files = generateCompleteMockModule(moduleName);
      totalFiles += files.length;

      for (const file of files) {
        const filePath = path.join(BENCHMARK_DIR, file.path);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, file.content);
      }
    }

    console.log(`  Generated ${totalFiles} files in ${moduleCount} modules`);
    return { modules: moduleCount, files: totalFiles };
  }

  async benchmarkIndexing() {
    console.log('\n📊 Benchmarking Indexing Performance...');

    const configurations = [
      { name: 'Basic (no GNN)', enableGNN: false },
      { name: 'Full GNN', enableGNN: true }
    ];

    for (const config of configurations) {
      const dbPath = `${BENCHMARK_DIR}/bench-${config.name.replace(/\s/g, '-')}.db`;
      const graphPath = `${BENCHMARK_DIR}/bench-${config.name.replace(/\s/g, '-')}-graph.json`;

      const indexer = new MagentoIndexer({
        dbPath,
        graphPath,
        magentoRoot: BENCHMARK_DIR,
        enableGNN: config.enableGNN
      });

      await indexer.init();

      const startTime = Date.now();
      const startMemory = process.memoryUsage().heapUsed;

      const stats = await indexer.indexDirectory();

      const endTime = Date.now();
      const endMemory = process.memoryUsage().heapUsed;

      this.results.indexing[config.name] = {
        duration: endTime - startTime,
        filesIndexed: stats.indexed,
        filesPerSecond: stats.indexed / ((endTime - startTime) / 1000),
        memoryUsed: (endMemory - startMemory) / 1024 / 1024,
        graphNodes: stats.graphNodes || 0,
        graphEdges: stats.graphEdges || 0
      };

      console.log(`  ${config.name}: ${endTime - startTime}ms (${stats.indexed} files)`);
    }

    return this.results.indexing;
  }

  async benchmarkSearch() {
    console.log('\n📊 Benchmarking Search Performance...');

    const indexer = new MagentoIndexer({
      dbPath: `${BENCHMARK_DIR}/bench-Full-GNN.db`,
      graphPath: `${BENCHMARK_DIR}/bench-Full-GNN-graph.json`,
      magentoRoot: BENCHMARK_DIR,
      enableGNN: true
    });
    await indexer.init();

    // Warm-up
    for (let i = 0; i < 10; i++) {
      await indexer.search('test query', { limit: 10 });
    }

    const searchTypes = [
      { name: 'Simple search', method: 'search', iterations: 100 },
      { name: 'Graph-enhanced', method: 'searchWithGraph', iterations: 100 }
    ];

    for (const searchType of searchTypes) {
      const latencies = [];

      for (let i = 0; i < searchType.iterations; i++) {
        const query = TEST_QUERIES[i % TEST_QUERIES.length];
        const start = process.hrtime.bigint();

        if (searchType.method === 'search') {
          await indexer.search(query.query, { limit: 10 });
        } else {
          await indexer.searchWithGraph(query.query, { limit: 10 });
        }

        const end = process.hrtime.bigint();
        latencies.push(Number(end - start) / 1e6); // Convert to ms
      }

      latencies.sort((a, b) => a - b);

      this.results.search[searchType.name] = {
        iterations: searchType.iterations,
        min: latencies[0].toFixed(2),
        max: latencies[latencies.length - 1].toFixed(2),
        avg: (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2),
        p50: latencies[Math.floor(latencies.length * 0.5)].toFixed(2),
        p90: latencies[Math.floor(latencies.length * 0.9)].toFixed(2),
        p99: latencies[Math.floor(latencies.length * 0.99)].toFixed(2),
        throughput: (1000 / (latencies.reduce((a, b) => a + b, 0) / latencies.length)).toFixed(1)
      };

      console.log(`  ${searchType.name}: avg ${this.results.search[searchType.name].avg}ms, p99 ${this.results.search[searchType.name].p99}ms`);
    }

    return this.results.search;
  }

  async benchmarkMemory() {
    console.log('\n📊 Benchmarking Memory Usage...');

    global.gc && global.gc();
    const baseline = process.memoryUsage();

    const indexer = new MagentoIndexer({
      dbPath: `${BENCHMARK_DIR}/bench-memory.db`,
      graphPath: `${BENCHMARK_DIR}/bench-memory-graph.json`,
      magentoRoot: BENCHMARK_DIR,
      enableGNN: true
    });

    await indexer.init();
    const afterInit = process.memoryUsage();

    await indexer.indexDirectory();
    const afterIndex = process.memoryUsage();

    // Run searches
    for (let i = 0; i < 100; i++) {
      await indexer.searchWithGraph(TEST_QUERIES[i % TEST_QUERIES.length].query, { limit: 10 });
    }
    const afterSearch = process.memoryUsage();

    this.results.memory = {
      baseline: {
        heapUsed: (baseline.heapUsed / 1024 / 1024).toFixed(2),
        heapTotal: (baseline.heapTotal / 1024 / 1024).toFixed(2),
        rss: (baseline.rss / 1024 / 1024).toFixed(2)
      },
      afterInit: {
        heapUsed: (afterInit.heapUsed / 1024 / 1024).toFixed(2),
        heapTotal: (afterInit.heapTotal / 1024 / 1024).toFixed(2),
        delta: ((afterInit.heapUsed - baseline.heapUsed) / 1024 / 1024).toFixed(2)
      },
      afterIndex: {
        heapUsed: (afterIndex.heapUsed / 1024 / 1024).toFixed(2),
        heapTotal: (afterIndex.heapTotal / 1024 / 1024).toFixed(2),
        delta: ((afterIndex.heapUsed - afterInit.heapUsed) / 1024 / 1024).toFixed(2)
      },
      afterSearch: {
        heapUsed: (afterSearch.heapUsed / 1024 / 1024).toFixed(2),
        heapTotal: (afterSearch.heapTotal / 1024 / 1024).toFixed(2),
        delta: ((afterSearch.heapUsed - afterIndex.heapUsed) / 1024 / 1024).toFixed(2)
      }
    };

    console.log(`  Heap after indexing: ${this.results.memory.afterIndex.heapUsed}MB`);
    console.log(`  Heap after 100 searches: ${this.results.memory.afterSearch.heapUsed}MB`);

    return this.results.memory;
  }

  async benchmarkGNN() {
    console.log('\n📊 Benchmarking GNN Features...');

    const indexer = new MagentoIndexer({
      dbPath: `${BENCHMARK_DIR}/bench-Full-GNN.db`,
      graphPath: `${BENCHMARK_DIR}/bench-Full-GNN-graph.json`,
      magentoRoot: BENCHMARK_DIR,
      enableGNN: true
    });
    await indexer.init();

    // Test graph loading
    const startLoad = Date.now();
    const graph = await indexer.loadGraph();
    const loadTime = Date.now() - startLoad;

    // Test dependency finding
    const depLatencies = [];
    const testClasses = ['Index', 'ItemRepository', 'ProductSaveObserver', 'ItemList'];

    for (const className of testClasses) {
      const start = Date.now();
      await indexer.findDependencies(className);
      depLatencies.push(Date.now() - start);
    }

    // Test graph traversal
    const traversalStart = Date.now();
    const edges = graph.edges.filter(e => e.type === 'extends').slice(0, 100);
    const traversalTime = Date.now() - traversalStart;

    this.results.gnn = {
      graphStats: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        nodeTypes: [...new Set(graph.nodes.map(n => n.type))],
        edgeTypes: [...new Set(graph.edges.map(e => e.type))]
      },
      performance: {
        graphLoadTime: loadTime,
        avgDependencyLookup: (depLatencies.reduce((a, b) => a + b, 0) / depLatencies.length).toFixed(2),
        graphTraversalTime: traversalTime
      }
    };

    console.log(`  Graph nodes: ${graph.nodes.length}, edges: ${graph.edges.length}`);
    console.log(`  Graph load: ${loadTime}ms, dependency lookup: ${this.results.gnn.performance.avgDependencyLookup}ms`);

    return this.results.gnn;
  }

  async generateReport() {
    const report = `
╔══════════════════════════════════════════════════════════════════════════════╗
║                       MAGECTOR BENCHMARK REPORT                              ║
╚══════════════════════════════════════════════════════════════════════════════╝

Generated: ${new Date().toISOString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INDEXING PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${Object.entries(this.results.indexing).map(([name, data]) => `
${name}:
  Duration:        ${data.duration}ms
  Files indexed:   ${data.filesIndexed}
  Files/second:    ${data.filesPerSecond.toFixed(1)}
  Memory delta:    ${data.memoryUsed.toFixed(2)}MB
  Graph nodes:     ${data.graphNodes}
  Graph edges:     ${data.graphEdges}
`).join('')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEARCH PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${Object.entries(this.results.search).map(([name, data]) => `
${name} (${data.iterations} iterations):
  Min:         ${data.min}ms
  Max:         ${data.max}ms
  Average:     ${data.avg}ms
  P50:         ${data.p50}ms
  P90:         ${data.p90}ms
  P99:         ${data.p99}ms
  Throughput:  ${data.throughput} queries/sec
`).join('')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEMORY USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Baseline heap:       ${this.results.memory.baseline.heapUsed}MB
  After init:          ${this.results.memory.afterInit.heapUsed}MB (+${this.results.memory.afterInit.delta}MB)
  After indexing:      ${this.results.memory.afterIndex.heapUsed}MB (+${this.results.memory.afterIndex.delta}MB)
  After 100 searches:  ${this.results.memory.afterSearch.heapUsed}MB (+${this.results.memory.afterSearch.delta}MB)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GNN FEATURES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Graph nodes:           ${this.results.gnn.graphStats.nodes}
  Graph edges:           ${this.results.gnn.graphStats.edges}
  Node types:            ${this.results.gnn.graphStats.nodeTypes.join(', ')}
  Edge types:            ${this.results.gnn.graphStats.edgeTypes.join(', ')}

  Graph load time:       ${this.results.gnn.performance.graphLoadTime}ms
  Avg dependency lookup: ${this.results.gnn.performance.avgDependencyLookup}ms
  Graph traversal:       ${this.results.gnn.performance.graphTraversalTime}ms

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    await mkdir('./validation-results', { recursive: true });
    await writeFile('./validation-results/benchmark-report.txt', report);
    await writeFile('./validation-results/benchmark-results.json', JSON.stringify(this.results, null, 2));

    return report;
  }

  async cleanup() {
    if (existsSync(BENCHMARK_DIR)) {
      await rm(BENCHMARK_DIR, { recursive: true });
    }
  }
}

async function runBenchmarks() {
  const suite = new BenchmarkSuite();

  try {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║              MAGECTOR BENCHMARK SUITE                          ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');

    await suite.setup(5);
    await suite.benchmarkIndexing();
    await suite.benchmarkSearch();
    await suite.benchmarkMemory();
    await suite.benchmarkGNN();

    const report = await suite.generateReport();
    console.log(report);

    console.log('Results saved to:');
    console.log('  - validation-results/benchmark-report.txt');
    console.log('  - validation-results/benchmark-results.json\n');

  } finally {
    await suite.cleanup();
  }
}

runBenchmarks().catch(console.error);

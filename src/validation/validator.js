#!/usr/bin/env node
/**
 * Main validation runner
 */

import { MagentoIndexer } from '../indexer.js';
import { generateCompleteMockModule, MOCK_MODULES } from './test-data-generator.js';
import { TEST_QUERIES, QUERY_CATEGORIES, generateEdgeCaseQueries } from './test-queries.js';
import {
  calculatePrecision,
  calculateRecall,
  calculateF1,
  calculateMRR,
  calculateNDCG,
  aggregateMetrics,
  gradeAccuracy,
  generateReport,
  isResultRelevant
} from './accuracy-calculator.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const VALIDATION_DIR = '/private/tmp/magector-validation';
const RESULTS_DIR = './validation-results';

export class MagectorValidator {
  constructor(options = {}) {
    this.indexer = null;
    this.testData = [];
    this.results = [];
    this.verbose = options.verbose || false;
  }

  async setup() {
    console.log('Setting up validation environment...\n');

    // Clean up previous test data
    if (existsSync(VALIDATION_DIR)) {
      await rm(VALIDATION_DIR, { recursive: true });
    }
    await mkdir(VALIDATION_DIR, { recursive: true });
    await mkdir(`${VALIDATION_DIR}/app/code`, { recursive: true });

    // Generate mock modules
    console.log('Generating mock Magento modules...');
    for (const moduleName of MOCK_MODULES) {
      const files = generateCompleteMockModule(moduleName);
      this.testData.push(...files);

      for (const file of files) {
        const filePath = path.join(VALIDATION_DIR, file.path);
        const dir = path.dirname(filePath);
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, file.content);
      }
      console.log(`  ✓ Generated ${moduleName} (${files.length} files)`);
    }

    console.log(`\nTotal test files: ${this.testData.length}`);

    // Initialize indexer
    console.log('\nInitializing indexer with GNN...');
    this.indexer = new MagentoIndexer({
      dbPath: `${VALIDATION_DIR}/magector-test.db`,
      graphPath: `${VALIDATION_DIR}/magector-test-graph.json`,
      magentoRoot: VALIDATION_DIR,
      enableGNN: true
    });
    await this.indexer.init();

    // Index the test data
    console.log('Indexing test data...');
    const stats = await this.indexer.indexDirectory(VALIDATION_DIR);
    console.log(`  Indexed: ${stats.indexed} files`);
    console.log(`  Graph nodes: ${stats.graphNodes}`);
    console.log(`  Graph edges: ${stats.graphEdges}\n`);

    return stats;
  }

  async runQuery(testQuery) {
    const startTime = Date.now();

    try {
      const results = await this.indexer.searchWithGraph(testQuery.query, { limit: 10 });
      const duration = Date.now() - startTime;

      // Calculate expected count based on test data
      const expectedCount = this.testData.filter(td =>
        isResultRelevant({ ...td.metadata, content: td.content }, testQuery)
      ).length;

      const precision = calculatePrecision(results, testQuery);
      const recall = calculateRecall(results, testQuery, Math.max(expectedCount, testQuery.minResults || 1));
      const f1 = calculateF1(precision, recall);
      const mrr = calculateMRR(results, testQuery);
      const ndcg = calculateNDCG(results, testQuery);

      // Determine pass/fail
      let passed = true;
      let failReason = '';

      if (testQuery.minResults && results.length < testQuery.minResults) {
        passed = false;
        failReason = `Expected min ${testQuery.minResults} results, got ${results.length}`;
      } else if (testQuery.maxResults !== undefined && results.length > testQuery.maxResults) {
        passed = false;
        failReason = `Expected max ${testQuery.maxResults} results, got ${results.length}`;
      } else if (precision < 0.3) {
        passed = false;
        failReason = `Precision too low: ${(precision * 100).toFixed(1)}%`;
      } else if (results.length > 0 && mrr === 0) {
        passed = false;
        failReason = 'No relevant results in top 10';
      }

      return {
        queryId: testQuery.id,
        query: testQuery.query,
        category: testQuery.category || 'unknown',
        resultCount: results.length,
        expectedCount,
        precision,
        recall,
        f1,
        mrr,
        ndcg,
        duration,
        passed,
        failReason,
        topResults: results.slice(0, 3).map(r => ({
          path: r.path,
          type: r.magentoType || r.type,
          score: r.score,
          relevant: isResultRelevant(r, testQuery)
        }))
      };
    } catch (error) {
      return {
        queryId: testQuery.id,
        query: testQuery.query,
        category: testQuery.category || 'unknown',
        passed: false,
        failReason: `Error: ${error.message}`,
        precision: 0,
        recall: 0,
        f1: 0,
        mrr: 0,
        ndcg: 0,
        duration: Date.now() - startTime
      };
    }
  }

  async runAllQueries() {
    console.log('Running validation queries...\n');
    const allQueries = [...TEST_QUERIES, ...generateEdgeCaseQueries()];

    let completed = 0;
    for (const query of allQueries) {
      const result = await this.runQuery(query);
      this.results.push(result);
      completed++;

      if (this.verbose) {
        const status = result.passed ? '✓' : '✗';
        console.log(`  ${status} [${query.id}] ${query.query.substring(0, 40).padEnd(40)} F1: ${(result.f1 * 100).toFixed(1).padStart(5)}%`);
      } else if (completed % 10 === 0) {
        process.stdout.write(`  Progress: ${completed}/${allQueries.length}\r`);
      }
    }

    console.log(`\nCompleted ${completed} queries.`);
    return this.results;
  }

  async runCategoryBenchmark(category) {
    const queries = TEST_QUERIES.filter(q => q.category === category);
    const results = [];

    for (const query of queries) {
      results.push(await this.runQuery(query));
    }

    return aggregateMetrics(results);
  }

  async runLatencyBenchmark(iterations = 100) {
    console.log(`\nRunning latency benchmark (${iterations} iterations)...`);

    const latencies = [];
    const sampleQueries = TEST_QUERIES.slice(0, 10);

    for (let i = 0; i < iterations; i++) {
      const query = sampleQueries[i % sampleQueries.length];
      const start = Date.now();
      await this.indexer.search(query.query, { limit: 10 });
      latencies.push(Date.now() - start);
    }

    latencies.sort((a, b) => a - b);

    return {
      min: latencies[0],
      max: latencies[latencies.length - 1],
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50: latencies[Math.floor(latencies.length * 0.5)],
      p90: latencies[Math.floor(latencies.length * 0.9)],
      p99: latencies[Math.floor(latencies.length * 0.99)]
    };
  }

  async generateFullReport() {
    const metrics = aggregateMetrics(this.results);
    const grade = gradeAccuracy(metrics);
    const report = generateReport(metrics, grade);

    // Ensure results directory exists
    await mkdir(RESULTS_DIR, { recursive: true });

    // Save detailed results
    const detailedResults = {
      timestamp: new Date().toISOString(),
      metrics,
      grade,
      results: this.results
    };

    await writeFile(
      `${RESULTS_DIR}/validation-results.json`,
      JSON.stringify(detailedResults, null, 2)
    );

    await writeFile(`${RESULTS_DIR}/validation-report.txt`, report);

    return { metrics, grade, report };
  }

  async cleanup() {
    if (existsSync(VALIDATION_DIR)) {
      await rm(VALIDATION_DIR, { recursive: true });
    }
  }
}

/**
 * Run full validation suite
 */
export async function runFullValidation(options = {}) {
  const validator = new MagectorValidator(options);

  try {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║           MAGECTOR ACCURACY VALIDATION SUITE                   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    // Setup
    await validator.setup();

    // Run queries
    await validator.runAllQueries();

    // Latency benchmark
    const latency = await validator.runLatencyBenchmark();
    console.log('\nLatency Results:');
    console.log(`  Min: ${latency.min}ms, Avg: ${latency.avg.toFixed(1)}ms, P99: ${latency.p99}ms`);

    // Generate report
    const { metrics, grade, report } = await validator.generateFullReport();

    // Print report
    console.log(report);

    // Print summary
    console.log('Results saved to:');
    console.log('  - validation-results/validation-report.txt');
    console.log('  - validation-results/validation-results.json\n');

    return { metrics, grade, latency };

  } finally {
    if (!options.keepTestData) {
      await validator.cleanup();
    }
  }
}

// CLI execution
if (process.argv[1].includes('validator.js')) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const keepData = process.argv.includes('--keep');

  runFullValidation({ verbose, keepTestData: keepData })
    .then(({ grade }) => {
      process.exit(grade.score >= 70 ? 0 : 1);
    })
    .catch(err => {
      console.error('Validation failed:', err);
      process.exit(1);
    });
}

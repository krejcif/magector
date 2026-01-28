/**
 * Accuracy calculation and metrics for validation
 */

/**
 * Calculate precision: relevant results / total results
 */
export function calculatePrecision(results, expectedConditions) {
  if (results.length === 0) return 0;

  const relevant = results.filter(r => isResultRelevant(r, expectedConditions));
  return relevant.length / results.length;
}

/**
 * Calculate recall: found relevant / total expected relevant
 */
export function calculateRecall(results, expectedConditions, totalExpected) {
  if (totalExpected === 0) return 1;

  const relevant = results.filter(r => isResultRelevant(r, expectedConditions));
  return Math.min(relevant.length / totalExpected, 1);
}

/**
 * Calculate F1 score: harmonic mean of precision and recall
 */
export function calculateF1(precision, recall) {
  if (precision + recall === 0) return 0;
  return 2 * (precision * recall) / (precision + recall);
}

/**
 * Calculate Mean Reciprocal Rank (MRR)
 */
export function calculateMRR(results, expectedConditions) {
  for (let i = 0; i < results.length; i++) {
    if (isResultRelevant(results[i], expectedConditions)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Calculate Normalized Discounted Cumulative Gain (NDCG)
 */
export function calculateNDCG(results, expectedConditions, k = 10) {
  const dcg = results.slice(0, k).reduce((sum, r, i) => {
    const relevance = isResultRelevant(r, expectedConditions) ? 1 : 0;
    return sum + relevance / Math.log2(i + 2);
  }, 0);

  // Ideal DCG (all relevant results at top)
  const relevantCount = results.filter(r => isResultRelevant(r, expectedConditions)).length;
  const idcg = Array(Math.min(relevantCount, k)).fill(1).reduce((sum, _, i) => {
    return sum + 1 / Math.log2(i + 2);
  }, 0);

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Check if a result matches expected conditions
 */
export function isResultRelevant(result, conditions) {
  // Check expected Magento types
  if (conditions.expectedTypes && conditions.expectedTypes.length > 0) {
    const hasType = conditions.expectedTypes.some(t =>
      result.magentoType === t ||
      result.type === t.toLowerCase() ||
      result.path?.includes(`/${t}/`)
    );
    if (hasType) return true;
  }

  // Check expected patterns
  if (conditions.expectedPatterns && conditions.expectedPatterns.length > 0) {
    const hasPattern = conditions.expectedPatterns.some(p =>
      result.patterns?.includes(p) ||
      result.isPlugin && p === 'plugin' ||
      result.isController && p === 'controller' ||
      result.isObserver && p === 'observer' ||
      result.isRepository && p === 'repository' ||
      result.isResolver && p === 'graphql_resolver' ||
      result.isModel && p === 'model' ||
      result.isBlock && p === 'block'
    );
    if (hasPattern) return true;
  }

  // Check expected classes
  if (conditions.expectedClasses && conditions.expectedClasses.length > 0) {
    const hasClass = conditions.expectedClasses.some(c =>
      result.className === c ||
      result.className?.includes(c) ||
      result.content?.includes(`class ${c}`)
    );
    if (hasClass) return true;
  }

  // Check expected methods
  if (conditions.expectedMethods && conditions.expectedMethods.length > 0) {
    const hasMethod = conditions.expectedMethods.some(m =>
      result.methodName === m ||
      result.content?.includes(`function ${m}`)
    );
    if (hasMethod) return true;
  }

  // Check expected file types
  if (conditions.expectedFileTypes && conditions.expectedFileTypes.length > 0) {
    const hasFileType = conditions.expectedFileTypes.includes(result.type);
    if (hasFileType) return true;
  }

  // Check expected content
  if (conditions.expectedInContent && conditions.expectedInContent.length > 0) {
    const contentLower = (result.content || '').toLowerCase();
    const hasContent = conditions.expectedInContent.every(c =>
      contentLower.includes(c.toLowerCase())
    );
    if (hasContent) return true;
  }

  // Check expected module
  if (conditions.expectedModule) {
    if (result.module === conditions.expectedModule ||
        result.path?.includes(conditions.expectedModule.replace('_', '/'))) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate relevance score for a result (0-1)
 */
export function calculateRelevanceScore(result, conditions) {
  let score = 0;
  let factors = 0;

  // Type match
  if (conditions.expectedTypes) {
    factors++;
    if (conditions.expectedTypes.some(t => result.magentoType === t)) {
      score += 1;
    } else if (conditions.expectedTypes.some(t => result.path?.includes(`/${t}/`))) {
      score += 0.7;
    }
  }

  // Pattern match
  if (conditions.expectedPatterns) {
    factors++;
    const patternMatch = conditions.expectedPatterns.filter(p =>
      result.patterns?.includes(p) || result[`is${p.charAt(0).toUpperCase() + p.slice(1)}`]
    ).length;
    score += patternMatch / conditions.expectedPatterns.length;
  }

  // Class match
  if (conditions.expectedClasses) {
    factors++;
    if (conditions.expectedClasses.some(c => result.className === c)) {
      score += 1;
    } else if (conditions.expectedClasses.some(c => result.className?.includes(c))) {
      score += 0.5;
    }
  }

  // Content match
  if (conditions.expectedInContent) {
    factors++;
    const contentLower = (result.content || '').toLowerCase();
    const contentMatch = conditions.expectedInContent.filter(c =>
      contentLower.includes(c.toLowerCase())
    ).length;
    score += contentMatch / conditions.expectedInContent.length;
  }

  // Module match
  if (conditions.expectedModule) {
    factors++;
    if (result.module === conditions.expectedModule) {
      score += 1;
    }
  }

  return factors === 0 ? 0 : score / factors;
}

/**
 * Aggregate metrics across multiple queries
 */
export function aggregateMetrics(queryResults) {
  const metrics = {
    totalQueries: queryResults.length,
    passedQueries: 0,
    avgPrecision: 0,
    avgRecall: 0,
    avgF1: 0,
    avgMRR: 0,
    avgNDCG: 0,
    byCategory: {},
    failed: []
  };

  let sumPrecision = 0;
  let sumRecall = 0;
  let sumF1 = 0;
  let sumMRR = 0;
  let sumNDCG = 0;

  for (const qr of queryResults) {
    sumPrecision += qr.precision;
    sumRecall += qr.recall;
    sumF1 += qr.f1;
    sumMRR += qr.mrr;
    sumNDCG += qr.ndcg;

    if (qr.passed) {
      metrics.passedQueries++;
    } else {
      metrics.failed.push({
        id: qr.queryId,
        query: qr.query,
        reason: qr.failReason
      });
    }

    // Aggregate by category
    if (!metrics.byCategory[qr.category]) {
      metrics.byCategory[qr.category] = {
        count: 0,
        passed: 0,
        avgPrecision: 0,
        avgRecall: 0,
        avgF1: 0
      };
    }
    const cat = metrics.byCategory[qr.category];
    cat.count++;
    if (qr.passed) cat.passed++;
    cat.avgPrecision += qr.precision;
    cat.avgRecall += qr.recall;
    cat.avgF1 += qr.f1;
  }

  // Calculate averages
  const n = queryResults.length;
  metrics.avgPrecision = sumPrecision / n;
  metrics.avgRecall = sumRecall / n;
  metrics.avgF1 = sumF1 / n;
  metrics.avgMRR = sumMRR / n;
  metrics.avgNDCG = sumNDCG / n;
  metrics.passRate = metrics.passedQueries / n;

  // Category averages
  for (const cat of Object.values(metrics.byCategory)) {
    cat.avgPrecision /= cat.count;
    cat.avgRecall /= cat.count;
    cat.avgF1 /= cat.count;
    cat.passRate = cat.passed / cat.count;
  }

  return metrics;
}

/**
 * Grade the overall accuracy
 */
export function gradeAccuracy(metrics) {
  const f1 = metrics.avgF1;
  const passRate = metrics.passRate;

  // Weighted score
  const score = (f1 * 0.6 + passRate * 0.4) * 100;

  let grade, description;
  if (score >= 95) {
    grade = 'A+';
    description = 'Excellent - Production ready';
  } else if (score >= 90) {
    grade = 'A';
    description = 'Very Good - Minor improvements possible';
  } else if (score >= 85) {
    grade = 'B+';
    description = 'Good - Some edge cases need work';
  } else if (score >= 80) {
    grade = 'B';
    description = 'Above Average - Noticeable gaps';
  } else if (score >= 75) {
    grade = 'C+';
    description = 'Average - Significant improvements needed';
  } else if (score >= 70) {
    grade = 'C';
    description = 'Below Average - Major issues';
  } else if (score >= 60) {
    grade = 'D';
    description = 'Poor - Fundamental problems';
  } else {
    grade = 'F';
    description = 'Failing - Requires complete rework';
  }

  return {
    score: Math.round(score * 10) / 10,
    grade,
    description,
    breakdown: {
      f1Contribution: Math.round(f1 * 60 * 10) / 10,
      passRateContribution: Math.round(passRate * 40 * 10) / 10
    }
  };
}

/**
 * Generate detailed report
 */
export function generateReport(metrics, grade) {
  let report = `
================================================================================
                    MAGECTOR ACCURACY VALIDATION REPORT
================================================================================

OVERALL GRADE: ${grade.grade} (${grade.score}/100)
${grade.description}

--------------------------------------------------------------------------------
AGGREGATE METRICS
--------------------------------------------------------------------------------
  Total Queries:     ${metrics.totalQueries}
  Passed:            ${metrics.passedQueries} (${(metrics.passRate * 100).toFixed(1)}%)
  Failed:            ${metrics.failed.length}

  Precision:         ${(metrics.avgPrecision * 100).toFixed(2)}%
  Recall:            ${(metrics.avgRecall * 100).toFixed(2)}%
  F1 Score:          ${(metrics.avgF1 * 100).toFixed(2)}%
  MRR:               ${(metrics.avgMRR * 100).toFixed(2)}%
  NDCG@10:           ${(metrics.avgNDCG * 100).toFixed(2)}%

--------------------------------------------------------------------------------
PERFORMANCE BY CATEGORY
--------------------------------------------------------------------------------
`;

  const categories = Object.entries(metrics.byCategory).sort((a, b) => b[1].avgF1 - a[1].avgF1);
  for (const [name, cat] of categories) {
    const status = cat.passRate >= 0.8 ? '✓' : cat.passRate >= 0.5 ? '~' : '✗';
    report += `  ${status} ${name.padEnd(20)} F1: ${(cat.avgF1 * 100).toFixed(1).padStart(5)}%  Pass: ${cat.passed}/${cat.count}\n`;
  }

  if (metrics.failed.length > 0) {
    report += `
--------------------------------------------------------------------------------
FAILED QUERIES
--------------------------------------------------------------------------------
`;
    for (const fail of metrics.failed.slice(0, 10)) {
      report += `  [${fail.id}] "${fail.query.substring(0, 40)}${fail.query.length > 40 ? '...' : ''}"\n`;
      report += `         Reason: ${fail.reason}\n`;
    }
    if (metrics.failed.length > 10) {
      report += `  ... and ${metrics.failed.length - 10} more\n`;
    }
  }

  report += `
--------------------------------------------------------------------------------
RECOMMENDATIONS
--------------------------------------------------------------------------------
`;

  // Generate recommendations based on weak categories
  const weakCategories = categories.filter(([_, cat]) => cat.avgF1 < 0.7);
  if (weakCategories.length > 0) {
    report += `  Improve indexing for: ${weakCategories.map(([name]) => name).join(', ')}\n`;
  }

  if (metrics.avgPrecision < 0.7) {
    report += `  - Precision is low: Consider stricter filtering and better chunking\n`;
  }
  if (metrics.avgRecall < 0.7) {
    report += `  - Recall is low: Consider broader search terms and synonym expansion\n`;
  }
  if (metrics.avgMRR < 0.5) {
    report += `  - MRR is low: Top results are not relevant, review ranking algorithm\n`;
  }

  report += `
================================================================================
`;

  return report;
}

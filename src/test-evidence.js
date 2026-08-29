import { createHash } from 'node:crypto';

export const TEST_EVIDENCE_VERSION = 'test-evidence/v1';
export const QUALITY_EVIDENCE_KINDS = Object.freeze([
  'browser-e2e',
  'accessibility-scan',
  'visual-regression',
  'load-test',
  'deployment-smoke',
  'security-scan'
]);

const RESULT_LABELS = Object.freeze({
  PASSED: '通过',
  FAILED: '失败',
  SKIPPED: '跳过',
  TODO: '待实现',
  UNOBSERVED: '未采集'
});

export function parseTestReport(text, { format = 'tap', observedAt = new Date().toISOString() } = {}) {
  const normalizedFormat = String(format).trim().toLowerCase();
  if (normalizedFormat === 'tap') return parseTapTestReport(text, { observedAt });
  if (['junit', 'junit-xml'].includes(normalizedFormat)) return parseJunitTestReport(text, { observedAt });
  throw new Error(`Unsupported test report format: ${format}`);
}

export function parseTapTestReport(text, { observedAt = new Date().toISOString() } = {}) {
  const results = [];
  let currentTitle = null;
  let lastResult = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const subtest = /^# Subtest: (.+)$/.exec(line);
    if (subtest) {
      currentTitle = decodeTapText(subtest[1]);
      continue;
    }
    const outcome = /^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line);
    if (outcome) {
      const directive = outcome[3]?.toUpperCase() ?? null;
      const status = directive === 'SKIP'
        ? 'SKIPPED'
        : directive === 'TODO' ? 'TODO' : outcome[1] === 'ok' ? 'PASSED' : 'FAILED';
      const title = currentTitle || decodeTapText(outcome[2]);
      lastResult = {
        id: evidenceId('tap', title, results.length),
        title,
        status,
        durationMs: null,
        observedAt,
        source: 'tap'
      };
      results.push(lastResult);
      currentTitle = null;
      continue;
    }
    const duration = /^\s*duration_ms:\s*([0-9.]+)/.exec(line);
    if (duration && lastResult) lastResult.durationMs = Number(duration[1]);
  }
  return testReport('tap', results, observedAt);
}

export function parseJunitTestReport(text, { observedAt = new Date().toISOString() } = {}) {
  const results = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match;
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    const attributes = xmlAttributes(match[1]);
    const body = match[2] ?? '';
    const title = decodeXml(attributes.name ?? attributes.classname ?? 'Unnamed test');
    const status = /<(?:failure|error)\b/i.test(body)
      ? 'FAILED'
      : /<skipped\b/i.test(body) ? 'SKIPPED' : 'PASSED';
    results.push({
      id: evidenceId('junit', `${attributes.classname ?? ''}:${title}`, results.length),
      title,
      suite: attributes.classname ? decodeXml(attributes.classname) : null,
      file: attributes.file ? normalizePath(decodeXml(attributes.file)) : null,
      status,
      durationMs: attributes.time === undefined ? null : Number(attributes.time) * 1000,
      observedAt,
      source: 'junit'
    });
  }
  return testReport('junit', results, observedAt);
}

export function parseCoverageReport(text, { format = 'lcov', observedAt = new Date().toISOString() } = {}) {
  const normalizedFormat = String(format).trim().toLowerCase();
  if (normalizedFormat === 'lcov') return parseLcovCoverage(text, { observedAt });
  if (normalizedFormat === 'cobertura') return parseCoberturaCoverage(text, { observedAt });
  if (normalizedFormat === 'jacoco') return parseJaCoCoCoverage(text, { observedAt });
  if (['node', 'node-test', 'node-test-coverage'].includes(normalizedFormat)) {
    return parseNodeTestCoverage(text, { observedAt });
  }
  throw new Error(`Unsupported coverage report format: ${format}`);
}

export function parseMutationReport(text, { format = 'stryker', observedAt = new Date().toISOString() } = {}) {
  const normalizedFormat = String(format).trim().toLowerCase();
  if (!['stryker', 'stryker-json'].includes(normalizedFormat)) {
    throw new Error(`Unsupported mutation report format: ${format}`);
  }
  const payload = parseJsonReport(text, 'mutation');
  const mutants = [];
  for (const [file, fileReport] of Object.entries(payload.files ?? {})) {
    for (const mutant of fileReport?.mutants ?? []) {
      mutants.push({
        id: mutant.id ?? evidenceId('mutation', `${file}:${mutant.location?.start?.line ?? ''}`, mutants.length),
        file: normalizePath(file),
        line: Number(mutant.location?.start?.line) || null,
        column: Number(mutant.location?.start?.column) || null,
        mutatorName: mutant.mutatorName ?? null,
        replacement: mutant.replacement ?? null,
        status: normalizeMutationStatus(mutant.status),
        description: mutant.description ?? null
      });
    }
  }
  const count = (status) => mutants.filter((entry) => entry.status === status).length;
  const killed = count('KILLED');
  const survived = count('SURVIVED');
  const noCoverage = count('NO_COVERAGE');
  const timedOut = count('TIMED_OUT');
  const denominator = killed + survived + noCoverage + timedOut;
  return {
    format: 'stryker',
    observedAt,
    summary: {
      total: mutants.length,
      killed,
      survived,
      noCoverage,
      timedOut,
      ignored: count('IGNORED'),
      errors: count('ERROR'),
      mutationScore: denominator > 0 ? Number((killed / denominator * 100).toFixed(2)) : null
    },
    survivors: mutants.filter((entry) => ['SURVIVED', 'NO_COVERAGE'].includes(entry.status)),
    mutants
  };
}

export function parseQualityEvidence(text, { kind, observedAt = new Date().toISOString(), tool = null } = {}) {
  const normalizedKind = String(kind ?? '').trim().toLowerCase();
  if (!QUALITY_EVIDENCE_KINDS.includes(normalizedKind)) {
    throw new Error(`Unsupported quality evidence kind: ${kind}`);
  }
  const payload = parseJsonReport(text, normalizedKind);
  const summary = summarizeQualityEvidence(normalizedKind, payload);
  return {
    id: evidenceId(normalizedKind, `${observedAt}:${tool ?? ''}`, 0),
    kind: normalizedKind,
    tool: tool ?? payload.tool ?? inferQualityTool(normalizedKind),
    observedAt,
    status: summary.failed > 0 || summary.passed === false ? 'FAILED' : 'PASSED',
    summary,
    artifacts: normalizeArtifacts(payload.artifacts)
  };
}

export function parseLcovCoverage(text, { observedAt = new Date().toISOString() } = {}) {
  const files = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = coverageAccumulator(normalizePath(line.slice(3)));
      continue;
    }
    if (!current) continue;
    if (line.startsWith('DA:')) {
      const hits = Number(line.slice(3).split(',')[1]);
      current.lines.total += 1;
      if (hits > 0) current.lines.covered += 1;
    } else if (line.startsWith('BRDA:')) {
      const taken = line.slice(5).split(',')[3];
      current.branches.total += 1;
      if (taken !== '-' && Number(taken) > 0) current.branches.covered += 1;
    } else if (line.startsWith('FNDA:')) {
      current.functions.total += 1;
      if (Number(line.slice(5).split(',')[0]) > 0) current.functions.covered += 1;
    } else if (line === 'end_of_record') {
      files.push(finalizeCoverageFile(current));
      current = null;
    }
  }
  if (current) files.push(finalizeCoverageFile(current));
  return coverageReport('lcov', files, observedAt);
}

export function parseCoberturaCoverage(text, { observedAt = new Date().toISOString() } = {}) {
  const files = [];
  const pattern = /<class\b([^>]*?)>([\s\S]*?)<\/class>/gi;
  let match;
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    const attributes = xmlAttributes(match[1]);
    if (!attributes.filename) continue;
    const body = match[2];
    const lineEntries = [...body.matchAll(/<line\b([^>]*?)\/?\s*>/gi)].map((entry) => xmlAttributes(entry[1]));
    const lineCovered = lineEntries.filter((entry) => Number(entry.hits) > 0).length;
    const branchEntries = lineEntries.filter((entry) => entry.branch === 'true');
    const branchCovered = branchEntries.filter((entry) => coveragePercent(entry['condition-coverage']) > 0).length;
    files.push(finalizeCoverageFile({
      path: normalizePath(decodeXml(attributes.filename)),
      lines: { covered: lineCovered, total: lineEntries.length },
      branches: { covered: branchCovered, total: branchEntries.length },
      functions: counterFromRate(attributes['method-rate'])
    }));
  }
  return coverageReport('cobertura', files, observedAt);
}

export function parseJaCoCoCoverage(text, { observedAt = new Date().toISOString() } = {}) {
  const files = [];
  const packagePattern = /<package\b([^>]*?)>([\s\S]*?)<\/package>/gi;
  let packageMatch;
  while ((packageMatch = packagePattern.exec(String(text ?? ''))) !== null) {
    const packageName = decodeXml(xmlAttributes(packageMatch[1]).name ?? '');
    const sourcePattern = /<sourcefile\b([^>]*?)>([\s\S]*?)<\/sourcefile>/gi;
    let sourceMatch;
    while ((sourceMatch = sourcePattern.exec(packageMatch[2])) !== null) {
      const sourceName = decodeXml(xmlAttributes(sourceMatch[1]).name ?? '');
      const counters = jacocoCounters(sourceMatch[2]);
      files.push(finalizeCoverageFile({
        path: normalizePath([packageName, sourceName].filter(Boolean).join('/')),
        lines: counters.LINE,
        branches: counters.BRANCH,
        functions: counters.METHOD
      }));
    }
  }
  return coverageReport('jacoco', files, observedAt);
}

export function parseNodeTestCoverage(text, { observedAt = new Date().toISOString() } = {}) {
  const files = [];
  let directory = '';
  let inReport = false;
  let reportedSummary = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    if (/start of coverage report/.test(rawLine)) {
      inReport = true;
      continue;
    }
    if (/end of coverage report/.test(rawLine)) break;
    if (!inReport) continue;
    const line = rawLine.replace(/^#\s?/, '');
    const columns = line.split('|').map((entry) => entry.trim());
    if (columns.length < 4 || columns[0] === 'file' || /^[-]+$/.test(columns[0])) continue;
    if (columns[0] === 'all files') {
      if ([columns[1], columns[2], columns[3]].every((value) => Number.isFinite(Number(value)))) {
        reportedSummary = {
          fileCount: files.length,
          linePercent: Number(columns[1]),
          branchPercent: Number(columns[2]),
          functionPercent: Number(columns[3])
        };
      }
      continue;
    }
    if (!columns[1]) {
      directory = normalizePath(columns[0]);
      continue;
    }
    if (![columns[1], columns[2], columns[3]].every((value) => Number.isFinite(Number(value)))) continue;
    files.push({
      path: normalizePath([directory, columns[0]].filter(Boolean).join('/')),
      linePercent: Number(columns[1]),
      branchPercent: Number(columns[2]),
      functionPercent: Number(columns[3])
    });
  }
  const report = coverageReport('node-test-coverage', files, observedAt);
  return reportedSummary ? { ...report, summary: { ...reportedSummary, fileCount: files.length } } : report;
}

export function applyTestEvidence(catalog, evidence, { now = new Date().toISOString(), staleAfterDays = 30 } = {}) {
  if (!evidence || evidence.version !== TEST_EVIDENCE_VERSION) return structuredClone(catalog);
  const observations = [
    ...(evidence.testReport?.results ?? []),
    ...(evidence.history ?? []).flatMap((entry) => entry?.testReport?.results ?? entry?.results ?? [])
  ];
  const observationsByTitle = new Map();
  for (const observation of observations) {
    const key = normalizeTitle(observation.title);
    if (!observationsByTitle.has(key)) observationsByTitle.set(key, []);
    observationsByTitle.get(key).push(observation);
  }
  const coverageFiles = evidence.coverageReport?.files ?? [];
  const tests = catalog.tests.map((test) => {
    const candidates = observationsByTitle.get(normalizeTitle(test.title)) ?? [];
    const relevant = candidates.filter((entry) => !entry.file || sameFile(entry.file, test.file));
    const observationsForTest = relevant.length > 0 ? relevant : candidates;
    const observation = observationsForTest
      .slice()
      .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] ?? null;
    const coveredModules = (test.sourceModules ?? [])
      .map((module) => coverageFiles.find((entry) => sameSourceModule(entry.path, module)))
      .filter(Boolean)
      .map((entry) => ({
        path: entry.path,
        linePercent: entry.linePercent,
        branchPercent: entry.branchPercent,
        functionPercent: entry.functionPercent,
        scope: 'suite'
      }));
    return {
      ...test,
      status: observation?.status ?? 'UNOBSERVED',
      statusLabel: RESULT_LABELS[observation?.status ?? 'UNOBSERVED'],
      runtimeEvidence: observation ? {
        result: observation.status,
        durationMs: observation.durationMs,
        observedAt: observation.observedAt,
        source: observation.source,
        coverage: coveredModules,
        freshness: evidenceFreshness(observation.observedAt, now, staleAfterDays),
        flaky: hasFlakyHistory(observationsForTest),
        quarantined: observationsForTest.some((entry) => entry.quarantined === true),
        mutationSurvivors: mutationSurvivorsForTest(test, evidence.mutationReport)
      } : null
    };
  });
  const observedCount = tests.filter((test) => test.status !== 'UNOBSERVED').length;
  return {
    ...catalog,
    source: {
      ...catalog.source,
      executionStatus: evidence.testReport?.summary?.failed > 0 ? 'FAILED' : observedCount > 0 ? 'OBSERVED' : 'UNOBSERVED',
      executionStatusLabel: evidence.testReport?.summary?.failed > 0 ? '存在失败' : observedCount > 0 ? '已采集运行结果' : '未采集运行结果',
      evidenceAt: evidence.generatedAt
    },
    summary: { ...catalog.summary, observedCount },
    runtimeEvidence: {
      generatedAt: evidence.generatedAt,
      command: evidence.command ?? null,
      declarationCount: evidence.declarationCount ?? null,
      runnerEntryCount: evidence.runnerEntryCount ?? evidence.testReport?.summary?.total ?? null,
      testReport: evidence.testReport?.summary ?? null,
      coverage: evidence.coverageReport?.summary ?? null,
      coverageFormat: evidence.coverageReport?.format ?? null,
      mutation: evidence.mutationReport?.summary ?? null,
      mutationFormat: evidence.mutationReport?.format ?? null,
      qualityEvidence: (evidence.qualityEvidence ?? []).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        tool: entry.tool,
        observedAt: entry.observedAt,
        status: entry.status,
        summary: entry.summary,
        artifacts: entry.artifacts ?? [],
        freshness: evidenceFreshness(entry.observedAt, now, staleAfterDays)
      })),
      evidenceKinds: [
        ...(evidence.testReport ? ['test-result'] : []),
        ...(evidence.coverageReport ? ['coverage'] : []),
        ...(evidence.runnerEntryCount !== null && evidence.runnerEntryCount !== undefined ? ['suite-discovery'] : []),
        ...(evidence.mutationReport ? ['mutation'] : []),
        ...(evidence.qualityEvidence ?? []).map((entry) => entry.kind)
      ]
    },
    tests
  };
}

export function createTestEvidence({
  generatedAt = new Date().toISOString(),
  command = null,
  declarationCount = null,
  runnerEntryCount = null,
  testReport,
  coverageReport = null,
  mutationReport = null,
  qualityEvidence = [],
  history = []
}) {
  return {
    version: TEST_EVIDENCE_VERSION,
    generatedAt,
    command,
    declarationCount,
    runnerEntryCount,
    testReport,
    coverageReport,
    mutationReport,
    qualityEvidence,
    history
  };
}

export function buildEvidenceScenarioCandidates(evidence, catalog) {
  const candidates = [];
  for (const survivor of evidence?.mutationReport?.survivors ?? []) {
    const behaviorKey = `mutation:${survivor.file}:${survivor.line ?? 0}:${survivor.mutatorName ?? 'unknown'}`;
    const scenarioId = evidenceScenarioId(behaviorKey);
    candidates.push({
      scenarioId,
      fingerprint: scenarioId,
      behaviorKey,
      title: `${survivor.file}:${survivor.line ?? '?'} 的变异未被测试发现`,
      categoryIds: ['deployment-suite-health'],
      preconditions: [{ kind: 'mutation', mutatorName: survivor.mutatorName }],
      action: { kind: 'kill-mutation', replacement: survivor.replacement ?? null },
      expected: { outcome: 'mutation-killed' },
      riskIds: ['behavior-regression'],
      sourceEvidence: [{
        type: 'mutation',
        uri: survivor.file,
        ...(survivor.line ? { line: survivor.line } : {}),
        symbol: survivor.mutatorName ?? survivor.status
      }],
      matchedTestIds: (catalog?.tests ?? [])
        .filter((test) => (test.sourceModules ?? []).some((module) => sameSourceModule(survivor.file, module)))
        .map((test) => test.id)
        .slice(0, 8),
      coverageState: 'partial',
      reviewState: 'PROPOSED',
      suppression: null
    });
  }
  for (const test of catalog?.tests ?? []) {
    if (!test.runtimeEvidence?.flaky) continue;
    const behaviorKey = `flake:${test.id}`;
    const scenarioId = evidenceScenarioId(behaviorKey);
    candidates.push({
      scenarioId,
      fingerprint: scenarioId,
      behaviorKey,
      title: `${test.title} 存在通过与失败交替`,
      categoryIds: ['deployment-suite-health'],
      preconditions: [{ kind: 'repeated-run' }],
      action: { kind: 'stabilize-test', testId: test.id },
      expected: { outcome: 'stable-repeat' },
      riskIds: ['behavior-regression'],
      sourceEvidence: [{ type: 'test', uri: test.file, line: test.line, symbol: test.title }],
      matchedTestIds: [test.id],
      coverageState: 'partial',
      reviewState: 'PROPOSED',
      suppression: null
    });
  }
  return candidates;
}

function summarizeQualityEvidence(kind, payload) {
  if (kind === 'accessibility-scan') {
    const violations = Array.isArray(payload.violations) ? payload.violations : [];
    return {
      passed: violations.length === 0,
      failed: violations.length,
      violations: violations.length,
      serious: violations.filter((entry) => ['serious', 'critical'].includes(entry.impact)).length
    };
  }
  if (kind === 'browser-e2e') {
    const tests = collectPlaywrightTests(payload.suites ?? []);
    const failed = tests.filter((entry) => entry.status && entry.status !== 'expected').length;
    return { passed: failed === 0, failed, total: tests.length };
  }
  if (kind === 'load-test') {
    const thresholds = Object.values(payload.metrics ?? {}).flatMap((metric) => Object.values(metric?.thresholds ?? {}));
    const failed = thresholds.filter((entry) => entry?.ok === false).length;
    return {
      passed: failed === 0,
      failed,
      thresholds: thresholds.length,
      checksRate: numberOrNull(payload.metrics?.checks?.values?.rate),
      httpRequestDurationP95: numberOrNull(payload.metrics?.http_req_duration?.values?.['p(95)'])
    };
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const explicitFailure = payload.ok === false || String(payload.status ?? '').toUpperCase() === 'FAILED';
  const failedResults = results.filter((entry) => ['FAIL', 'FAILED', 'ERROR', 'MISMATCH'].includes(String(entry.status ?? '').toUpperCase())).length;
  const failed = explicitFailure ? Math.max(1, failedResults) : failedResults + findings.length;
  return {
    passed: failed === 0,
    failed,
    total: results.length || Number(payload.total) || findings.length,
    findings: findings.length
  };
}

function collectPlaywrightTests(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests ?? []),
    ...collectPlaywrightTests(suite.suites ?? [])
  ]);
}

function normalizeMutationStatus(value) {
  return ({
    Killed: 'KILLED',
    Survived: 'SURVIVED',
    NoCoverage: 'NO_COVERAGE',
    Timeout: 'TIMED_OUT',
    Ignored: 'IGNORED',
    CompileError: 'ERROR',
    RuntimeError: 'ERROR'
  })[String(value)] ?? String(value ?? 'ERROR').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function mutationSurvivorsForTest(test, report) {
  if (!report?.survivors?.length) return [];
  return report.survivors
    .filter((entry) => (test.sourceModules ?? []).some((module) => sameSourceModule(entry.file, module)))
    .slice(0, 20)
    .map((entry) => ({ file: entry.file, line: entry.line, mutatorName: entry.mutatorName, status: entry.status }));
}

function hasFlakyHistory(observations) {
  const statuses = new Set(observations.map((entry) => entry.status).filter((status) => ['PASSED', 'FAILED'].includes(status)));
  return statuses.size > 1;
}

function evidenceFreshness(observedAt, now, staleAfterDays) {
  const observed = Date.parse(observedAt);
  const current = Date.parse(now);
  const ageDays = Number.isFinite(observed) && Number.isFinite(current)
    ? Math.max(0, (current - observed) / 86_400_000)
    : null;
  return {
    state: ageDays === null ? 'UNKNOWN' : ageDays > staleAfterDays ? 'STALE' : 'CURRENT',
    ageDays: ageDays === null ? null : Number(ageDays.toFixed(1)),
    staleAfterDays
  };
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => typeof entry === 'string'
    ? { uri: entry }
    : { uri: String(entry?.uri ?? ''), label: entry?.label ? String(entry.label) : null })
    .filter((entry) => entry.uri);
}

function inferQualityTool(kind) {
  return ({
    'browser-e2e': 'playwright',
    'accessibility-scan': 'axe',
    'visual-regression': 'visual-comparison',
    'load-test': 'k6',
    'deployment-smoke': 'deployment-smoke',
    'security-scan': 'security-scan'
  })[kind];
}

function parseJsonReport(text, name) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : structuredClone(text);
  } catch {
    throw new Error(`${name} report must be valid JSON`);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function testReport(format, results, observedAt) {
  const counts = (status) => results.filter((entry) => entry.status === status).length;
  return {
    format,
    observedAt,
    summary: {
      total: results.length,
      passed: counts('PASSED'),
      failed: counts('FAILED'),
      skipped: counts('SKIPPED'),
      todo: counts('TODO'),
      durationMs: results.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0)
    },
    results
  };
}

function coverageReport(format, files, observedAt) {
  return {
    format,
    observedAt,
    summary: aggregateCoverage(files),
    files
  };
}

function coverageAccumulator(path) {
  return {
    path,
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 }
  };
}

function finalizeCoverageFile(entry) {
  return {
    path: entry.path,
    linePercent: percent(entry.lines),
    branchPercent: percent(entry.branches),
    functionPercent: percent(entry.functions)
  };
}

function aggregateCoverage(files) {
  if (files.length === 0) return { fileCount: 0, linePercent: null, branchPercent: null, functionPercent: null };
  return {
    fileCount: files.length,
    linePercent: average(files.map((entry) => entry.linePercent)),
    branchPercent: average(files.map((entry) => entry.branchPercent)),
    functionPercent: average(files.map((entry) => entry.functionPercent))
  };
}

function counterFromRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? { covered: rate, total: 1 } : { covered: 0, total: 0 };
}

function jacocoCounters(body) {
  const counters = {
    LINE: { covered: 0, total: 0 },
    BRANCH: { covered: 0, total: 0 },
    METHOD: { covered: 0, total: 0 }
  };
  for (const match of body.matchAll(/<counter\b([^>]*?)\/?\s*>/gi)) {
    const attributes = xmlAttributes(match[1]);
    if (!counters[attributes.type]) continue;
    const covered = Number(attributes.covered) || 0;
    const missed = Number(attributes.missed) || 0;
    counters[attributes.type].covered += covered;
    counters[attributes.type].total += covered + missed;
  }
  return counters;
}

function percent(counter) {
  return counter?.total > 0 ? Number((counter.covered / counter.total * 100).toFixed(2)) : null;
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  return numbers.length > 0
    ? Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(2))
    : null;
}

function coveragePercent(value) {
  return Number(/([0-9.]+)%/.exec(String(value ?? ''))?.[1] ?? 0);
}

function xmlAttributes(value) {
  const attributes = {};
  for (const match of String(value ?? '').matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    attributes[match[1]] = match[3];
  }
  return attributes;
}

function decodeXml(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function decodeTapText(value) {
  return String(value ?? '').replace(/\\([#\\])/g, '$1').trim();
}

function normalizeTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameFile(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`);
}

function sameSourceModule(coveragePath, sourceModule) {
  const left = normalizePath(coveragePath).replace(/^\.\//, '');
  const right = normalizePath(sourceModule).replace(/^\.\//, '');
  return left === right
    || left.endsWith(`/${right}`)
    || left.replace(/\.[^.\/]+$/, '') === right.replace(/\.[^.\/]+$/, '');
}

function evidenceId(source, title, index) {
  return `evidence_${createHash('sha1').update(`${source}:${title}:${index}`).digest('hex').slice(0, 14)}`;
}

function evidenceScenarioId(value) {
  return `scenario_${createHash('sha256').update(`runtime-evidence/v1\u0000${value}`).digest('hex').slice(0, 20)}`;
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

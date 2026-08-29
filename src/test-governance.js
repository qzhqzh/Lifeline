export const TEST_COVERAGE_STATES = Object.freeze([
  'covered', 'partial', 'missing', 'unobserved', 'obsolete'
]);

export const TEST_QUALITY_CATEGORIES = Object.freeze([
  category('domain-invariants', '领域规则与状态不变量', ['test-result', 'coverage']),
  category('persistence-concurrency', '持久化、并发与恢复', ['test-result', 'coverage']),
  category('api-contracts', 'API、MCP、CLI 与外部契约', ['test-result', 'coverage']),
  category('security-abuse', '安全与滥用防护', ['test-result', 'security-scan']),
  category('browser-ux', '真实浏览器 UX / E2E', ['browser-e2e']),
  category('accessibility-visual-i18n', '无障碍、视觉、响应式与国际化', ['accessibility-scan', 'visual-regression']),
  category('performance-resilience', '性能、规模与韧性', ['load-test']),
  category('deployment-suite-health', '部署运维与测试套件有效性', ['suite-discovery', 'deployment-smoke', 'mutation'])
]);

const CATEGORY_RULES = Object.freeze([
  rule('persistence-concurrency', /persist|store|storage|database|transaction|atomic|idempoten|concurr|parallel|race|lock|lease|restart|recover|migration|reconcil|持久|存储|并发|迁移|恢复/i),
  rule('api-contracts', /\b(?:api|http|mcp|cli|endpoint|openapi|schema|contract|request|response|adapter)\b|接口|契约|协议/i),
  rule('security-abuse', /auth|token|scope|origin|permission|secret|csrf|xss|abuse|rate.?limit|权限|鉴权|令牌|滥用/i),
  rule('browser-ux', /browser|playwright|drag|drop|scroll|render|dialog|drawer|canvas|webgl|sigma|keyboard|touch|offline|界面|拖动|画布/i),
  rule('accessibility-visual-i18n', /accessib|\baxe\b|aria|focus|contrast|visual|responsive|viewport|mobile|i18n|locale|rtl|dpr|无障碍|视觉|响应式|键盘/i),
  rule('performance-resilience', /perform|latency|throughput|capacity|memory|fps|load|stress|spike|soak|1k|10k|large|bounded|cache|性能|容量|负载|缓存/i),
  rule('deployment-suite-health', /docker|compose|deploy|health|backup|restore|rollback|coverage|mutation|flake|quarantine|test.?catalog|test.?map|test.?runner|部署|回滚|备份|测试目录/i),
  rule('domain-invariants', /state|status|transition|schedule|phase|depend|progress|priority|validation|invariant|状态|流转|排期|依赖|进度|校验/i)
]);

export function enrichTestGovernance(catalog, { evidenceKinds = [] } = {}) {
  const tests = (catalog.tests ?? []).map((test) => enrichTest(test));
  const availableEvidenceKinds = new Set([
    ...evidenceKinds,
    ...(catalog.runtimeEvidence?.evidenceKinds ?? [])
  ]);
  if (tests.some((test) => test.runtimeEvidence)) availableEvidenceKinds.add('test-result');
  if (catalog.runtimeEvidence?.coverage?.fileCount > 0) availableEvidenceKinds.add('coverage');
  if (catalog.runtimeEvidence?.runnerEntryCount !== null && catalog.runtimeEvidence?.runnerEntryCount !== undefined) {
    availableEvidenceKinds.add('suite-discovery');
  }
  const qualityCategories = TEST_QUALITY_CATEGORIES.map((definition) => {
    const categoryTests = tests.filter((test) => test.qualityCategoryIds.includes(definition.id));
    const observedTests = categoryTests.filter((test) => test.status !== 'UNOBSERVED');
    const failedTests = observedTests.filter((test) => test.status === 'FAILED');
    const flakyTests = observedTests.filter((test) => test.runtimeEvidence?.flaky);
    const quarantinedTests = observedTests.filter((test) => test.runtimeEvidence?.quarantined);
    const staleTests = observedTests.filter((test) => test.runtimeEvidence?.freshness?.state === 'STALE');
    const missingEvidenceKinds = definition.requiredEvidenceKinds.filter((kind) => !availableEvidenceKinds.has(kind));
    const categoryQualityEvidence = (catalog.runtimeEvidence?.qualityEvidence ?? [])
      .filter((entry) => definition.requiredEvidenceKinds.includes(entry.kind));
    const failedEvidenceKinds = categoryQualityEvidence
      .filter((entry) => entry.status === 'FAILED')
      .map((entry) => entry.kind);
    const staleEvidenceKinds = categoryQualityEvidence
      .filter((entry) => entry.freshness?.state === 'STALE')
      .map((entry) => entry.kind);
    const mutationScore = catalog.runtimeEvidence?.mutation?.mutationScore ?? null;
    const mutationGateFailed = definition.id === 'deployment-suite-health'
      && Number.isFinite(mutationScore)
      && mutationScore < 60;
    const coverageState = categoryTests.length === 0
      ? 'missing'
      : observedTests.length === 0
        ? 'unobserved'
        : staleTests.length === observedTests.length
          ? 'unobserved'
          : missingEvidenceKinds.length > 0
            || observedTests.length < categoryTests.length
            || failedTests.length > 0
            || flakyTests.length > 0
            || quarantinedTests.length > 0
            || failedEvidenceKinds.length > 0
            || staleEvidenceKinds.length > 0
            || mutationGateFailed
          ? 'partial'
          : 'covered';
    const evidenceAt = [
      ...observedTests.map((test) => test.runtimeEvidence?.observedAt),
      ...categoryQualityEvidence.map((entry) => entry.observedAt)
    ]
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    const gateReasons = [
      ...missingEvidenceKinds.map((kind) => `MISSING:${kind}`),
      ...failedEvidenceKinds.map((kind) => `FAILED:${kind}`),
      ...staleEvidenceKinds.map((kind) => `STALE:${kind}`),
      ...(failedTests.length ? [`FAILED_TESTS:${failedTests.length}`] : []),
      ...(flakyTests.length ? [`FLAKY_TESTS:${flakyTests.length}`] : []),
      ...(quarantinedTests.length ? [`QUARANTINED_TESTS:${quarantinedTests.length}`] : []),
      ...(staleTests.length ? [`STALE_TESTS:${staleTests.length}`] : []),
      ...(mutationGateFailed ? [`MUTATION_SCORE_BELOW:60`] : [])
    ];
    const gateStatus = failedTests.length > 0 || failedEvidenceKinds.length > 0 || mutationGateFailed
      ? 'FAIL'
      : gateReasons.length > 0 || coverageState !== 'covered'
        ? 'WARN'
        : 'PASS';
    return {
      ...definition,
      coverageState,
      testCount: categoryTests.length,
      observedCount: observedTests.length,
      failedCount: failedTests.length,
      flakyCount: flakyTests.length,
      quarantinedCount: quarantinedTests.length,
      evidenceAt,
      evidenceKinds: definition.requiredEvidenceKinds.filter((kind) => availableEvidenceKinds.has(kind)),
      missingEvidenceKinds,
      staleEvidenceKinds,
      qualityGate: {
        status: gateStatus,
        reasons: gateReasons,
        thresholds: definition.id === 'deployment-suite-health' ? { mutationScoreMin: 60 } : {}
      },
      testIds: categoryTests.map((test) => test.id)
    };
  });

  return {
    ...catalog,
    governanceVersion: 'test-governance/v1',
    qualityCategories,
    qualitySummary: Object.fromEntries(TEST_COVERAGE_STATES.map((state) => [
      state,
      qualityCategories.filter((entry) => entry.coverageState === state).length
    ])),
    tests
  };
}

export function classifyTestQuality(test) {
  const evidenceText = [
    test.file,
    test.title,
    test.domainId,
    ...(test.scenarioIds ?? []),
    ...(test.sourceModules ?? []),
    ...(test.calls ?? []),
    ...(test.assertions ?? []),
    ...(test.riskTags ?? [])
  ].join(' ');
  const qualityCategoryIds = [];
  for (const { categoryId, pattern } of CATEGORY_RULES) {
    if (pattern.test(evidenceText)) addUnique(qualityCategoryIds, categoryId);
  }
  if (qualityCategoryIds.length === 0) qualityCategoryIds.push('domain-invariants');
  return {
    testLevel: classifyTestLevel(evidenceText),
    qualityCategoryIds: qualityCategoryIds.slice(0, 5),
    riskIds: classifyRiskIds(evidenceText),
    environment: classifyEnvironments(evidenceText),
    assertionKinds: classifyAssertionKinds(evidenceText, test.assertions ?? [])
  };
}

function enrichTest(test) {
  const classified = classifyTestQuality(test);
  return {
    ...test,
    ...classified,
    sourceEvidence: {
      file: test.file,
      line: test.line,
      imports: [...(test.sourceModules ?? [])],
      calls: [...(test.calls ?? [])],
      assertions: [...(test.assertions ?? [])]
    }
  };
}

function classifyTestLevel(value) {
  if (/perform|load|stress|soak|benchmark|fps|latency/i.test(value)) return 'performance';
  if (/playwright|browser|e2e|end.?to.?end/i.test(value)) return 'e2e';
  if (/contract|openapi|mcp|schema/i.test(value)) return 'contract';
  if (/http|api|integration|database|store|migration|vertical.?slice/i.test(value)) return 'integration';
  return 'unit';
}

function classifyRiskIds(value) {
  const risks = [];
  if (/auth|token|scope|permission|secret|origin|csrf|xss/i.test(value)) risks.push('auth');
  if (/persist|store|database|migration|backup|restore|data.?loss/i.test(value)) risks.push('data-loss');
  if (/concurr|parallel|race|lock|lease|atomic|stale|conflict/i.test(value)) risks.push('concurrency');
  if (/contract|version|compat|schema|migration|openapi/i.test(value)) risks.push('compatibility');
  if (/perform|latency|capacity|memory|fps|load|stress/i.test(value)) risks.push('performance');
  return risks.length > 0 ? risks : ['behavior-regression'];
}

function classifyEnvironments(value) {
  const environments = ['node'];
  if (/browser|html|css|ui|canvas|webgl|sigma|playwright/i.test(value)) environments.push('browser');
  if (/database|store|storage|sqlite|postgres|migration/i.test(value)) environments.push('database');
  if (/external|upstream|provider|websocket|http|mcp/i.test(value)) environments.push('external-service');
  return [...new Set(environments)];
}

function classifyAssertionKinds(value, assertions) {
  const kinds = [];
  if (/status|state|transition|phase|schedule/i.test(value)) kinds.push('state');
  if (/reject|throw|error|invalid|fail|not found|forbid/i.test(value)) kinds.push('error');
  if (/persist|write|create|update|delete|event|evidence|side.?effect/i.test(value)) kinds.push('side-effect');
  if (/visual|render|css|pixel|screenshot|snapshot/i.test(value)) kinds.push('visual');
  if (/duration|timeout|latency|performance|fps/i.test(value)) kinds.push('timing');
  if (assertions.length > 0 || kinds.length === 0) kinds.push('output');
  return [...new Set(kinds)];
}

function category(id, label, requiredEvidenceKinds) {
  return { id, label, requiredEvidenceKinds };
}

function rule(categoryId, pattern) {
  return { categoryId, pattern };
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

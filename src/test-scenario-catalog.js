import { createHash } from 'node:crypto';

export const SCENARIO_CATALOG_VERSION = 'scenario-catalog/v1';
export const SCENARIO_EXTRACTOR_VERSION = 'deterministic-scenarios/v1';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

export function buildScenarioCatalog({
  project = {},
  testCatalog,
  openApi = null,
  sourceDocuments = [],
  seedScenarios = [],
  generatedAt = new Date().toISOString()
}) {
  const projectKey = project.repositoryUrl ?? project.id ?? project.name ?? 'project';
  const candidates = [
    ...extractOpenApiScenarios(openApi),
    ...sourceDocuments.flatMap(extractSourceScenarios),
    ...seedScenarios.map(normalizeSeedScenario)
  ];
  const unique = new Map();
  for (const candidate of candidates) {
    const id = scenarioFingerprint(projectKey, candidate);
    if (!unique.has(id)) unique.set(id, {
      scenarioId: id,
      fingerprint: id,
      title: candidate.title,
      categoryIds: candidate.categoryIds,
      preconditions: candidate.preconditions,
      action: candidate.action,
      expected: candidate.expected,
      riskIds: candidate.riskIds,
      sourceEvidence: candidate.sourceEvidence,
      behaviorKey: candidate.behaviorKey,
      matchedTestIds: [],
      coverageState: 'missing',
      reviewState: 'PROPOSED',
      suppression: null
    });
  }
  return matchScenarioCatalog({
    version: SCENARIO_CATALOG_VERSION,
    extractorVersion: SCENARIO_EXTRACTOR_VERSION,
    generatedAt,
    project: {
      id: project.id ?? null,
      name: project.name ?? null,
      repositoryUrl: project.repositoryUrl ?? null
    },
    scenarios: [...unique.values()].sort((left, right) => left.scenarioId.localeCompare(right.scenarioId))
  }, testCatalog);
}

export function matchScenarioCatalog(scenarioCatalog, testCatalog) {
  if (!scenarioCatalog || scenarioCatalog.version !== SCENARIO_CATALOG_VERSION) return scenarioCatalog;
  const tests = testCatalog?.tests ?? [];
  const scenarios = scenarioCatalog.scenarios.map((scenario) => {
    const matches = tests
      .map((test) => ({ test, score: scenarioMatchScore(scenario, test) }))
      .filter((entry) => entry.score >= 4)
      .sort((left, right) => right.score - left.score || left.test.id.localeCompare(right.test.id));
    const matched = matches.slice(0, 8);
    const observed = matched.filter((entry) => entry.test.status !== 'UNOBSERVED');
    const coverageState = matched.length === 0
      ? 'missing'
      : observed.length === 0
        ? 'unobserved'
        : matched[0].score >= 7 && hasExpectedAssertion(scenario, matched[0].test)
          ? 'covered'
          : 'partial';
    return {
      ...scenario,
      matchedTestIds: matched.map((entry) => entry.test.id),
      coverageState
    };
  });
  return {
    ...scenarioCatalog,
    summary: {
      scenarioCount: scenarios.length,
      covered: scenarios.filter((entry) => entry.coverageState === 'covered').length,
      partial: scenarios.filter((entry) => entry.coverageState === 'partial').length,
      missing: scenarios.filter((entry) => entry.coverageState === 'missing').length,
      unobserved: scenarios.filter((entry) => entry.coverageState === 'unobserved').length,
      obsolete: scenarios.filter((entry) => entry.coverageState === 'obsolete').length
    },
    scenarios
  };
}

export function extractOpenApiScenarios(openApi) {
  if (!openApi?.paths || typeof openApi.paths !== 'object') return [];
  const scenarios = [];
  for (const [path, pathItem] of Object.entries(openApi.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      const responses = operation.responses && typeof operation.responses === 'object'
        ? Object.keys(operation.responses)
        : [];
      for (const status of responses) {
        const categoryIds = ['api-contracts'];
        const riskIds = [];
        if (['401', '403'].includes(status)) {
          categoryIds.push('security-abuse');
          riskIds.push('auth');
        }
        if (['409', '422'].includes(status)) {
          categoryIds.push('domain-invariants');
          riskIds.push('data-consistency');
        }
        scenarios.push({
          behaviorKey: `openapi:${method}:${normalizePathTemplate(path)}:${status}`,
          title: `${method.toUpperCase()} ${path} 返回 ${status}`,
          categoryIds,
          preconditions: operation.security ? [{ kind: 'security', required: true }] : [],
          action: { kind: 'http', method: method.toUpperCase(), path },
          expected: { status },
          riskIds: riskIds.length > 0 ? riskIds : ['compatibility'],
          sourceEvidence: [{
            type: 'openapi',
            uri: 'openapi.json',
            pointer: `#/paths/${escapeJsonPointer(path)}/${method}/responses/${status}`,
            symbol: `${method.toUpperCase()} ${path} ${status}`
          }]
        });
      }
      const parameters = [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : [])
      ];
      for (const parameter of parameters.filter((entry) => entry?.required)) {
        scenarios.push({
          behaviorKey: `openapi:${method}:${normalizePathTemplate(path)}:missing:${parameter.in}:${parameter.name}`,
          title: `${method.toUpperCase()} ${path} 拒绝缺少 ${parameter.name}`,
          categoryIds: ['api-contracts', 'domain-invariants'],
          preconditions: [{ kind: 'missing-input', location: parameter.in, name: parameter.name }],
          action: { kind: 'http', method: method.toUpperCase(), path },
          expected: { outcome: 'validation-error' },
          riskIds: ['compatibility'],
          sourceEvidence: [{
            type: 'openapi',
            uri: 'openapi.json',
            pointer: `#/paths/${escapeJsonPointer(path)}/${method}/parameters`,
            symbol: `${method.toUpperCase()} ${path} ${parameter.in}:${parameter.name}`
          }]
        });
      }
    }
  }
  return scenarios;
}

export function extractSourceScenarios(document) {
  const uri = document?.uri ?? 'source';
  const content = String(document?.content ?? '');
  const scenarios = [];
  const transitionPattern = /\[WORK_ITEM_STATUS\.([A-Z_]+)\]\s*:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = transitionPattern.exec(content)) !== null) {
    const from = match[1];
    const targets = [...match[2].matchAll(/WORK_ITEM_STATUS\.([A-Z_]+)/g)].map((entry) => entry[1]);
    for (const to of targets) {
      scenarios.push({
        behaviorKey: `state-transition:${from}:${to}:allowed`,
        title: `允许任务从 ${from} 流转到 ${to}`,
        categoryIds: ['domain-invariants'],
        preconditions: [{ kind: 'state', value: from }],
        action: { kind: 'state-transition', from, to },
        expected: { outcome: 'allowed', state: to },
        riskIds: ['data-consistency'],
        sourceEvidence: [sourceEvidence(uri, content, match.index, `WORK_ITEM_STATUS.${from}`)]
      });
    }
    scenarios.push({
      behaviorKey: `state-transition:${from}:unsupported:rejected`,
      title: `拒绝任务从 ${from} 进入未允许状态`,
      categoryIds: ['domain-invariants'],
      preconditions: [{ kind: 'state', value: from }],
      action: { kind: 'state-transition', from, to: 'UNSUPPORTED' },
      expected: { outcome: 'error', code: 'INVALID_TRANSITION' },
      riskIds: ['data-consistency'],
      sourceEvidence: [sourceEvidence(uri, content, match.index, `WORK_ITEM_STATUS.${from}`)]
    });
  }
  const guardPattern = /if\s*\(([^\n]{1,240})\)\s*(?:\{\s*)?throw new DomainError\([^\n]*?['"]([A-Z][A-Z0-9_]+)['"]/g;
  while ((match = guardPattern.exec(content)) !== null) {
    const condition = normalizeBehaviorText(match[1]);
    const code = match[2];
    scenarios.push({
      behaviorKey: `guard:${code}:${condition}`,
      title: `触发 ${code} 守卫时拒绝操作`,
      categoryIds: ['domain-invariants'],
      preconditions: [{ kind: 'guard', condition }],
      action: { kind: 'guarded-operation' },
      expected: { outcome: 'error', code },
      riskIds: ['data-consistency'],
      sourceEvidence: [sourceEvidence(uri, content, match.index, code)]
    });
  }
  return scenarios;
}

function normalizeSeedScenario(input) {
  if (!input?.behaviorKey || !input?.title || !Array.isArray(input.sourceEvidence) || input.sourceEvidence.length === 0) {
    throw new Error('Seed scenarios require behaviorKey, title, and sourceEvidence');
  }
  return {
    behaviorKey: normalizeBehaviorText(input.behaviorKey),
    title: String(input.title).trim(),
    categoryIds: unique(input.categoryIds?.length ? input.categoryIds : ['domain-invariants']),
    preconditions: structuredClone(input.preconditions ?? []),
    action: structuredClone(input.action ?? {}),
    expected: structuredClone(input.expected ?? {}),
    riskIds: unique(input.riskIds?.length ? input.riskIds : ['behavior-regression']),
    sourceEvidence: structuredClone(input.sourceEvidence)
  };
}

function scenarioMatchScore(scenario, test) {
  const scenarioTokens = tokenize([
    scenario.title,
    scenario.behaviorKey,
    JSON.stringify(scenario.action),
    JSON.stringify(scenario.expected)
  ].join(' '));
  const testTokens = new Set(tokenize([
    test.title,
    test.file,
    ...(test.sourceModules ?? []),
    ...(test.calls ?? []),
    ...(test.assertions ?? [])
  ].join(' ')));
  let score = scenarioTokens.reduce((sum, token) => sum + (testTokens.has(token) ? 1 : 0), 0);
  if ((scenario.categoryIds ?? []).some((id) => test.qualityCategoryIds?.includes(id))) score += 2;
  for (const evidence of scenario.sourceEvidence ?? []) {
    if ((test.sourceModules ?? []).some((module) => sameSource(module, evidence.uri))) score += 3;
  }
  if (scenario.expected?.status && testTokens.has(String(scenario.expected.status))) score += 2;
  if (scenario.expected?.code && testTokens.has(String(scenario.expected.code).toLowerCase())) score += 2;
  return score;
}

function hasExpectedAssertion(scenario, test) {
  const kinds = new Set(test.assertionKinds ?? []);
  if (scenario.expected?.outcome === 'error' || Number(scenario.expected?.status) >= 400) return kinds.has('error') || kinds.has('output');
  if (scenario.expected?.state) return kinds.has('state');
  return kinds.size > 0;
}

function scenarioFingerprint(projectKey, scenario) {
  const payload = [
    projectKey,
    SCENARIO_EXTRACTOR_VERSION,
    normalizeBehaviorText(scenario.behaviorKey),
    stableJson(scenario.preconditions),
    stableJson(scenario.action),
    stableJson(scenario.expected),
    (scenario.sourceEvidence ?? []).map((entry) => entry.symbol ?? entry.pointer ?? entry.type).sort().join('|')
  ].join('\u0000');
  return `scenario_${createHash('sha256').update(payload).digest('hex').slice(0, 20)}`;
}

function sourceEvidence(uri, content, index, symbol) {
  return {
    type: 'source',
    uri,
    line: content.slice(0, index).split(/\r?\n/).length,
    symbol
  };
}

function normalizePathTemplate(value) {
  return String(value).replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
}

function normalizeBehaviorText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenize(value) {
  return unique((String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

const STOP_WORDS = new Set([
  'api', 'the', 'and', 'for', 'with', 'from', 'into', 'test', 'tests',
  '返回', '允许', '拒绝', '任务', '操作', '状态'
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameSource(left, right) {
  const normalizedLeft = String(left ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedRight = String(right ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`);
}

function escapeJsonPointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function unique(values) {
  return [...new Set(values)];
}

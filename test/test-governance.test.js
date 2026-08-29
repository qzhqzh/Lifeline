import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEST_EVIDENCE_VERSION,
  applyTestEvidence,
  createTestEvidence,
  parseCoberturaCoverage,
  parseJaCoCoCoverage,
  parseJunitTestReport,
  parseLcovCoverage,
  parseMutationReport,
  parseQualityEvidence,
  parseTapTestReport
} from '../src/test-evidence.js';
import { enrichTestGovernance } from '../src/test-governance.js';
import { buildScenarioCatalog } from '../src/test-scenario-catalog.js';
import { TestGovernanceWorkflowService } from '../src/test-governance-workflow.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('TAP and JUnit results normalize status, duration, and evidence time', () => {
  const tap = parseTapTestReport(`TAP version 13
# Subtest: persists one record
ok 1 - persists one record
  ---
  duration_ms: 12.5
  ...
# Subtest: rejects invalid input
not ok 2 - rejects invalid input
  ---
  duration_ms: 4
  ...`, { observedAt: '2026-08-29T00:00:00.000Z' });
  const junit = parseJunitTestReport(`
    <testsuite tests="2">
      <testcase classname="billing" name="creates invoice" time="0.025" />
      <testcase classname="billing" name="rejects invoice"><failure message="invalid" /></testcase>
    </testsuite>
  `, { observedAt: '2026-08-29T00:00:00.000Z' });

  assert.deepEqual(tap.summary, {
    total: 2, passed: 1, failed: 1, skipped: 0, todo: 0, durationMs: 16.5
  });
  assert.equal(tap.results[0].observedAt, '2026-08-29T00:00:00.000Z');
  assert.equal(junit.summary.total, 2);
  assert.equal(junit.results[0].durationMs, 25);
  assert.equal(junit.results[1].status, 'FAILED');
});

test('LCOV, Cobertura, and JaCoCo coverage adapters preserve source-level facts', () => {
  const lcov = parseLcovCoverage(`SF:src/billing.js
FNDA:1,save
FNDA:0,remove
DA:1,1
DA:2,0
BRDA:1,0,0,1
BRDA:1,0,1,0
end_of_record`);
  const cobertura = parseCoberturaCoverage(`
    <coverage><packages><package><classes>
      <class filename="src/auth.py" method-rate="0.5"><lines>
        <line number="1" hits="1"/><line number="2" hits="0" branch="true" condition-coverage="0%"/>
      </lines></class>
    </classes></package></packages></coverage>
  `);
  const jacoco = parseJaCoCoCoverage(`
    <report><package name="app/core"><sourcefile name="Service.java">
      <counter type="LINE" missed="2" covered="8"/>
      <counter type="BRANCH" missed="1" covered="3"/>
      <counter type="METHOD" missed="0" covered="4"/>
    </sourcefile></package></report>
  `);

  assert.deepEqual(lcov.files[0], {
    path: 'src/billing.js', linePercent: 50, branchPercent: 50, functionPercent: 50
  });
  assert.equal(cobertura.files[0].path, 'src/auth.py');
  assert.equal(cobertura.files[0].linePercent, 50);
  assert.equal(jacoco.files[0].path, 'app/core/Service.java');
  assert.equal(jacoco.files[0].linePercent, 80);
  assert.equal(jacoco.files[0].branchPercent, 75);
});

test('mutation, browser, accessibility, visual, load, deployment, and security evidence normalize into facts', () => {
  const mutation = parseMutationReport(JSON.stringify({
    files: {
      'src/auth.js': {
        mutants: [
          { id: '1', status: 'Killed', mutatorName: 'BooleanLiteral', location: { start: { line: 8, column: 2 } } },
          { id: '2', status: 'Survived', mutatorName: 'ConditionalExpression', location: { start: { line: 12, column: 4 } } }
        ]
      }
    }
  }));
  const browser = parseQualityEvidence(JSON.stringify({
    suites: [{ specs: [{ tests: [{ status: 'expected' }, { status: 'unexpected' }] }] }]
  }), { kind: 'browser-e2e' });
  const axe = parseQualityEvidence(JSON.stringify({ violations: [{ impact: 'critical' }] }), { kind: 'accessibility-scan' });
  const visual = parseQualityEvidence(JSON.stringify({ results: [{ status: 'MATCH' }] }), { kind: 'visual-regression' });
  const load = parseQualityEvidence(JSON.stringify({
    metrics: {
      checks: { values: { rate: 0.99 }, thresholds: { 'rate>0.95': { ok: true } } },
      http_req_duration: { values: { 'p(95)': 240 } }
    }
  }), { kind: 'load-test' });
  const deployment = parseQualityEvidence(JSON.stringify({ ok: true }), { kind: 'deployment-smoke' });
  const security = parseQualityEvidence(JSON.stringify({ findings: [] }), { kind: 'security-scan' });

  assert.equal(mutation.summary.mutationScore, 50);
  assert.equal(mutation.survivors[0].file, 'src/auth.js');
  assert.equal(browser.status, 'FAILED');
  assert.equal(axe.summary.serious, 1);
  assert.equal(visual.status, 'PASSED');
  assert.equal(load.summary.httpRequestDurationP95, 240);
  assert.equal(deployment.status, 'PASSED');
  assert.equal(security.status, 'PASSED');
});

test('flake, quarantine, staleness, and category gates stay separate from a total score', () => {
  const catalog = fixtureCatalog();
  const latest = {
    format: 'tap',
    observedAt: '2026-08-29T00:00:00.000Z',
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, durationMs: 1 },
    results: [{
      title: catalog.tests[0].title,
      file: catalog.tests[0].file,
      status: 'PASSED',
      durationMs: 1,
      observedAt: '2026-08-29T00:00:00.000Z',
      source: 'tap',
      quarantined: true
    }]
  };
  const governed = enrichTestGovernance(applyTestEvidence(catalog, createTestEvidence({
    generatedAt: '2026-08-29T00:00:00.000Z',
    runnerEntryCount: 1,
    testReport: latest,
    history: [{ results: [{ ...latest.results[0], status: 'FAILED', observedAt: '2026-08-01T00:00:00.000Z' }] }],
    qualityEvidence: [parseQualityEvidence(JSON.stringify({ ok: true }), {
      kind: 'deployment-smoke', observedAt: '2026-07-01T00:00:00.000Z'
    })]
  }), { now: '2026-08-29T00:00:00.000Z', staleAfterDays: 14 }));
  const testEntry = governed.tests[0];
  const deployment = governed.qualityCategories.find((entry) => entry.id === 'deployment-suite-health');

  assert.equal(testEntry.runtimeEvidence.flaky, true);
  assert.equal(testEntry.runtimeEvidence.quarantined, true);
  assert.equal(deployment.qualityGate.status, 'WARN');
  assert.ok(deployment.qualityGate.reasons.some((reason) => reason.startsWith('STALE:')));
  assert.equal('score' in governed.qualitySummary, false);
});

test('runtime evidence and the eight-category taxonomy remain traceable without a total score', () => {
  const catalog = fixtureCatalog();
  const testReport = parseTapTestReport(catalog.tests.map((entry, index) => (
    `# Subtest: ${entry.title}\nok ${index + 1} - ${entry.title}\n  ---\n  duration_ms: 1\n  ...`
  )).join('\n'), { observedAt: '2026-08-29T01:00:00.000Z' });
  const evidenced = applyTestEvidence(catalog, {
    version: TEST_EVIDENCE_VERSION,
    generatedAt: '2026-08-29T01:00:00.000Z',
    declarationCount: catalog.tests.length,
    runnerEntryCount: catalog.tests.length,
    testReport,
    coverageReport: parseLcovCoverage('SF:src/domain.js\nDA:1,1\nend_of_record')
  });
  const governed = enrichTestGovernance(evidenced);

  assert.equal(governed.summary.observedCount, catalog.tests.length);
  assert.equal(governed.qualityCategories.length, 8);
  assert.ok(governed.qualityCategories.every((entry) => entry.testCount > 0));
  assert.ok(governed.qualityCategories.every((entry) => entry.evidenceAt));
  assert.ok(governed.tests.every((entry) => entry.sourceEvidence.file && entry.qualityCategoryIds.length > 0));
  assert.equal('score' in governed.qualitySummary, false);
  assert.doesNotMatch(JSON.stringify(governed), /confidence|modelRef|recommendation/i);
});

test('deterministic scenarios have stable fingerprints and expose a seeded missing case', () => {
  const catalog = enrichTestGovernance(fixtureCatalog());
  const seed = {
    behaviorKey: 'storage:write:disk-full:error',
    title: '磁盘写满时原子写入不得损坏现有状态',
    categoryIds: ['persistence-concurrency'],
    action: { kind: 'write-state' },
    expected: { outcome: 'error', statePreserved: true },
    sourceEvidence: [{ type: 'requirement', uri: 'docs/storage.md', symbol: 'atomic-write' }]
  };
  const input = {
    project: { id: 'fixture', repositoryUrl: 'https://example.com/fixture' },
    testCatalog: catalog,
    openApi: {
      paths: {
        '/api/items/{itemId}': {
          get: {
            parameters: [{ in: 'path', name: 'itemId', required: true }],
            responses: { 200: { description: 'ok' }, 404: { description: 'missing' } }
          }
        }
      }
    },
    seedScenarios: [seed],
    generatedAt: '2026-08-29T00:00:00.000Z'
  };
  const first = buildScenarioCatalog(input);
  const second = buildScenarioCatalog({
    ...input,
    seedScenarios: [{ ...seed, title: '文案调整后仍是同一个缺口' }],
    generatedAt: '2026-08-29T02:00:00.000Z'
  });
  const missing = first.scenarios.find((entry) => entry.behaviorKey === seed.behaviorKey);
  const repeated = second.scenarios.find((entry) => entry.behaviorKey === seed.behaviorKey);

  assert.ok(missing);
  assert.equal(missing.coverageState, 'missing');
  assert.equal(missing.scenarioId, repeated.scenarioId);
  assert.equal(new Set(first.scenarios.map((entry) => entry.scenarioId)).size, first.scenarios.length);
  assert.ok(first.scenarios.every((entry) => entry.sourceEvidence.length > 0));
  assert.equal(first.scenarios.every((entry) => entry.reviewState === 'PROPOSED'), true);
});

test('scenario proposals deduplicate, hide analyzer metadata, and never create a task before RED is proven', async (t) => {
  const fixture = await governanceFixture(t);
  const scenario = workflowScenario('scenario-stable-auth-boundary');
  const first = await fixture.workflow.syncScenarioCatalog(fixture.project.id, {
    extractorVersion: 'fixture/v1',
    scenarios: [scenario]
  });
  const second = await fixture.workflow.syncScenarioCatalog(fixture.project.id, {
    extractorVersion: 'fixture/v1',
    scenarios: [{ ...scenario, title: '文案变化不会重复创建' }]
  });
  const proposals = await fixture.workflow.listScenarioProposals(fixture.project.id);

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(proposals.length, 1);
  assert.equal('analysis' in proposals[0], false);
  assert.equal((await fixture.lifeline.listWorkItems(fixture.project.id)).length, 0);

  await fixture.workflow.reviewScenarioProposal(fixture.project.id, proposals[0].id, { action: 'START_REVIEW' });
  await fixture.workflow.reviewScenarioProposal(fixture.project.id, proposals[0].id, {
    action: 'ACCEPT',
    reason: '关键权限边界需要保护'
  });
  const draft = await fixture.workflow.createTestDraft(fixture.project.id, proposals[0].id, {
    framework: 'NODE_TEST',
    suggestedPath: 'test/project-access.test.js',
    command: ['node', '--test', 'test/project-access.test.js'],
    expectedFailure: 'expected 403 but received 200'
  });
  assert.match(draft.testDraft.content, /assert\.fail/);
  assert.equal((await fixture.lifeline.listWorkItems(fixture.project.id)).length, 0);

  const wrongFailure = await fixture.workflow.recordScenarioRun(fixture.project.id, proposals[0].id, {
    stage: 'BASELINE',
    outcome: 'FAILED',
    observedFailure: 'module cannot be imported',
    expectedFailureMatched: true,
    sourceUri: 'ci://run/1'
  });
  assert.equal(wrongFailure.proposal.status, 'NEEDS_CORRECTION');
  assert.equal((await fixture.lifeline.listWorkItems(fixture.project.id)).length, 0);
});

test('a matching RED proof creates one implementation task, then GREEN evidence can be verified', async (t) => {
  const fixture = await governanceFixture(t);
  const proposed = await fixture.workflow.proposeScenario(fixture.project.id, {
    ...workflowScenario('scenario-red-green'),
    analyzer: 'semantic-gap-adapter',
    analyzerVersion: '1.0.0',
    model: 'internal-model-name',
    rationale: 'cross-module permission boundary'
  });
  await fixture.workflow.reviewScenarioProposal(fixture.project.id, proposed.id, { action: 'START_REVIEW' });
  await fixture.workflow.reviewScenarioProposal(fixture.project.id, proposed.id, {
    action: 'ACCEPT', reason: '来源与风险均已复核'
  });
  await fixture.workflow.createTestDraft(fixture.project.id, proposed.id, {
    framework: 'NODE_TEST',
    suggestedPath: 'test/project-access.test.js',
    command: ['node', '--test', 'test/project-access.test.js'],
    expectedFailure: 'expected 403 but received 200'
  });
  const red = await fixture.workflow.recordScenarioRun(fixture.project.id, proposed.id, {
    stage: 'BASELINE',
    outcome: 'FAILED',
    observedFailure: 'expected 403 but received 200',
    sourceUri: 'ci://run/red',
    phaseId: fixture.phase.id
  });
  const replayed = await fixture.workflow.listScenarioProposals(fixture.project.id);

  assert.equal(red.proposal.status, 'IMPLEMENTING');
  assert.ok(red.implementationTask.id);
  assert.equal(replayed[0].implementationTaskId, red.implementationTask.id);
  assert.equal((await fixture.lifeline.listWorkItems(fixture.project.id)).length, 1);
  const redReplay = await fixture.workflow.recordScenarioRun(fixture.project.id, proposed.id, {
    stage: 'BASELINE',
    outcome: 'FAILED',
    observedFailure: 'expected 403 but received 200',
    sourceUri: 'ci://run/red',
    phaseId: fixture.phase.id
  });
  assert.equal(redReplay.replayed, true);
  assert.equal(redReplay.proposal.implementationTaskId, red.implementationTask.id);
  assert.equal((await fixture.lifeline.listWorkItems(fixture.project.id)).length, 1);
  assert.equal((await fixture.store.read()).testEvidenceHistory.length, 1);

  const green = await fixture.workflow.recordScenarioRun(fixture.project.id, proposed.id, {
    stage: 'IMPLEMENTATION',
    outcome: 'PASSED',
    command: ['node', '--test', 'test/project-access.test.js'],
    sourceUri: 'ci://run/green',
    commitSha: 'abc123'
  });
  assert.equal(green.proposal.status, 'GREEN');
  const verified = await fixture.workflow.verifyScenario(fixture.project.id, proposed.id, {
    method: 'DETERMINISTIC_TEST',
    summary: 'Focused test and affected HTTP boundary passed.'
  });
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(JSON.stringify(verified).includes('internal-model-name'), false);
});

test('a baseline that already passes stops without manufacturing an implementation task', async (t) => {
  const fixture = await governanceFixture(t);
  const proposed = await fixture.workflow.proposeScenario(fixture.project.id, workflowScenario('scenario-existing'));
  await fixture.workflow.reviewScenarioProposal(fixture.project.id, proposed.id, { action: 'START_REVIEW' });
  await fixture.workflow.reviewScenarioProposal(fixture.project.id, proposed.id, { action: 'ACCEPT', reason: '检查现状' });
  await fixture.workflow.createTestDraft(fixture.project.id, proposed.id, {
    framework: 'NODE_TEST',
    suggestedPath: 'test/existing.test.js',
    command: ['node', '--test', 'test/existing.test.js'],
    expectedFailure: 'expected missing behavior'
  });
  const result = await fixture.workflow.recordScenarioRun(fixture.project.id, proposed.id, {
    stage: 'BASELINE',
    outcome: 'PASSED',
    sourceUri: 'ci://run/already-green'
  });

  assert.equal(result.proposal.status, 'COVERED_EXISTING');
  assert.equal((await fixture.lifeline.listWorkItems(fixture.project.id)).length, 0);
});

function fixtureCatalog() {
  const entries = [
    ['state transition preserves invariants', 'test/domain.test.js', ['src/domain.js']],
    ['atomic store recovers concurrent writes', 'test/store.test.js', ['src/store.js']],
    ['MCP HTTP contract rejects malformed request', 'test/mcp-http.test.js', ['src/server.js']],
    ['auth token scope blocks abusive origin', 'test/agent-auth.test.js', ['src/agent-auth.js']],
    ['browser drag scroll and canvas interaction', 'test/client-ui.test.js', ['public/client.js']],
    ['ARIA focus responsive visual i18n', 'test/accessibility.test.js', ['public/app.js']],
    ['large 10k layout performance capacity', 'test/performance.test.js', ['src/quality-map-layout.js']],
    ['Docker Compose health rollback test catalog', 'test/deployment.test.js', ['src/server.js']]
  ];
  return {
    version: 2,
    configured: true,
    generatedAt: '2026-08-29T00:00:00.000Z',
    project: { name: 'Fixture', repositoryUrl: 'https://example.com/fixture' },
    source: { executionStatus: 'UNOBSERVED' },
    summary: {
      testCount: entries.length,
      fileCount: entries.length,
      domainCount: 1,
      scenarioCount: 1,
      transferCount: 0,
      observedCount: 0
    },
    domains: [{ id: 'fixture', label: 'Fixture', color: '#43a9ff', testCount: entries.length }],
    scenarios: [{ id: 'fixture', label: 'Fixture', color: '#43a9ff', testCount: entries.length }],
    tests: entries.map(([title, file, sourceModules], index) => ({
      id: `test-${index}`,
      title,
      file,
      line: index + 1,
      domainId: 'fixture',
      scenarioIds: ['fixture'],
      riskTags: [],
      sourceModules,
      calls: [],
      assertions: ['assert.equal'],
      status: 'UNOBSERVED',
      statusLabel: '未采集'
    }))
  };
}

function workflowScenario(fingerprint) {
  return {
    scenarioId: fingerprint,
    fingerprint,
    title: '无项目权限时拒绝读取客户画布',
    categoryIds: ['security-abuse'],
    preconditions: [{ kind: 'anonymous' }],
    action: { kind: 'http', path: '/api/projects/:id/canvas-session' },
    expected: { status: 403 },
    riskIds: ['auth'],
    sourceEvidence: [{ type: 'openapi', uri: 'openapi.json', pointer: '#/paths/canvas-session' }],
    matchedTestIds: [],
    coverageState: 'missing',
    extractorVersion: 'fixture/v1'
  };
}

async function governanceFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-governance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'state.json'));
  const lifeline = new LifelineService({ store });
  const workflow = new TestGovernanceWorkflowService({ store, lifelineService: lifeline });
  await lifeline.start();
  await workflow.start();
  const project = await lifeline.createProject({ name: 'Governed project' });
  const phase = await lifeline.createPhase({ projectId: project.id, title: '测试先行', phaseOrder: 1 });
  return { store, lifeline, workflow, project, phase };
}

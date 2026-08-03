import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockExecutor } from '../src/executor.js';
import { getPortfolioV2Template } from '../src/portfolio-v2-template.js';
import { LifelineService } from '../src/service.js';
import { JsonStore, migrateState } from '../src/store.js';

const logger = { error() {} };

test('portfolio bootstrap is atomic, idempotent, and restart-safe', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-pv2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const service = await createService(file, 'user-a');

  const [first, second] = await Promise.all([
    service.bootstrapPortfolioV2({ idempotencyKey: 'double-click' }),
    service.bootstrapPortfolioV2({ idempotencyKey: 'double-click' })
  ]);
  assert.equal([first, second].filter((result) => result.created).length, 1);
  assert.equal(first.receipt.id, second.receipt.id);
  assert.deepEqual((await service.listProjects()).map((project) => project.name), ['Lifeline', 'EchoMe', 'Totemora']);

  const restarted = await createService(file, 'user-a');
  const status = await restarted.getBootstrapStatus();
  assert.equal(status.available, false);
  assert.equal(status.appliedAt, first.appliedAt);
  assert.deepEqual((await restarted.dashboard()).bootstrap.portfolioV2, status);
  const importedState = JSON.parse(await readFile(file));
  const lifeline = importedState.projects.find((project) => project.name === 'Lifeline');
  assert.equal(importedState.workItems.find((item) => item.id === lifeline.currentTaskId).title, 'Agent 完成后自动进入复核并更新项目进度');
  assert.equal(importedState.workItems.find((item) => item.title === '周期扫描仓库并去重生成 Bug 候选').status, 'RECURRING');
  assert.equal(importedState.workItems.filter((item) => item.projectId === lifeline.id && item.planning.phaseOrder === 6).every((item) => item.status === 'DEFERRED'), true);
  const terminalIds = new Set(importedState.workItems
    .filter((item) => ['VERIFIED', 'RELEASED'].includes(item.status))
    .map((item) => item.id));
  assert.equal(importedState.evidence.every((entry) => terminalIds.has(entry.workItemId)), true);

  const otherUser = await createService(file, 'user-b');
  const other = await otherUser.bootstrapPortfolioV2({ idempotencyKey: 'other-user' });
  assert.equal(other.created, true);
  assert.notEqual(other.receipt.userId, first.receipt.userId);
  assert.equal(JSON.parse(await readFile(file)).bootstrapReceipts.length, 2);
});

test('legacy data migrates without fake runs and records modified-template conflicts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-pv2-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const legacyProject = {
    id: 'project_legacy',
    name: 'Lifeline Demo',
    repositoryUrl: 'https://github.com/qzhqzh/Lifeline',
    description: 'User changed this description',
    strategicValue: 10,
    status: 'ACTIVE',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  };
  await writeFile(file, JSON.stringify({
    schemaVersion: 2,
    projects: [legacyProject],
    workItems: [{
      id: 'work_legacy',
      projectId: legacyProject.id,
      title: 'Run the first durable mock workflow',
      objective: 'Validate a work item, persist every workflow checkpoint, produce evidence, and replay the run in the UI.',
      acceptanceCriteria: ['The old run remains visible'],
      testCommands: ['npm test'],
      riskTier: 'low',
      weight: 1,
      resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 },
      status: 'VERIFIED',
      currentRunId: 'run_existing',
      createdAt: legacyProject.createdAt,
      updatedAt: legacyProject.updatedAt
    }],
    runs: [{ id: 'run_existing', workItemId: 'work_legacy', status: 'SUCCEEDED' }],
    evidence: [{ id: 'evidence_existing', runId: 'run_existing', workItemId: 'work_legacy', type: 'TEST', score: 1 }],
    events: []
  }));

  const service = await createService(file, 'user-a');
  const result = await service.bootstrapPortfolioV2();
  const state = JSON.parse(await readFile(file));
  assert.equal(result.conflicts.some((entry) => entry.reason === 'USER_MODIFIED_LEGACY_TEMPLATE'), true);
  assert.equal(state.projects.find((project) => project.id === legacyProject.id).name, 'Lifeline Demo');
  assert.equal(state.runs.some((run) => run.id === 'run_existing'), true);
  assert.equal(state.completionRecords.every((record) => record.completionMethod === 'IMPORTED_HISTORY'), true);
  assert.equal(state.completionRecords.some((record) => record.taskId === 'work_legacy'), false);
  assert.equal(state.schemaVersion, 5);
});

test('modified legacy portfolio reports conflicts without losing MCP tasks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-pv2-current-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const timestamp = '2026-08-01T00:00:00.000Z';
  const source = {
    schemaVersion: 2,
    projects: [
      legacyProject('project_lifeline_demo', 'Lifeline Demo', 'https://github.com/qzhqzh/Lifeline', 10, timestamp),
      legacyProject('project_release_radar', 'Release Radar · 示例', null, 7, timestamp),
      legacyProject('project_knowledge_lab', 'Knowledge Lab · 示例', null, 5, timestamp)
    ],
    workItems: [],
    runs: [],
    evidence: [],
    events: []
  };
  const sourceLifeline = source.projects.find((project) => project.name === 'Lifeline Demo');
  await writeFile(file, JSON.stringify(source));

  const service = await createService(file, 'local-owner');
  const mcpPhase = await service.createPhase({
    projectId: sourceLifeline.id,
    title: 'S4 开放 Agent 接口',
    goal: 'Allow Agents to plan and report work through MCP.',
    phaseOrder: 4,
    source: { kind: 'codex-plan', planId: 'test:mcp-before-bootstrap' }
  }, { actor: 'local-owner', idempotencyKey: 'test:mcp-before-bootstrap:phase' });
  const mcpTask = await service.createWorkItem({
    projectId: sourceLifeline.id,
    title: '保留载入前由 MCP 新增的正式任务',
    objective: 'Ensure a valid Agent plan survives the later Portfolio V2 bootstrap migration.',
    acceptanceCriteria: ['The task remains attached to the migrated Lifeline project'],
    testCommands: ['npm test'],
    riskTier: 'medium',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 2 },
    planning: { phaseId: mcpPhase.id, phaseOrder: 4, taskOrder: 10, kind: 'feature', priority: 'P1' },
    source: { kind: 'codex-plan', planId: 'test:mcp-before-bootstrap' }
  }, { actor: 'local-owner', idempotencyKey: 'test:mcp-before-bootstrap:task' });
  const first = await service.bootstrapPortfolioV2({ idempotencyKey: 'current-fixture' });
  const repeated = await service.bootstrapPortfolioV2({ idempotencyKey: 'current-fixture' });
  const state = JSON.parse(await readFile(file));
  const activeProjects = state.projects.filter((project) => project.status !== 'ARCHIVED');
  const template = getPortfolioV2Template();
  const expectedCounts = Object.fromEntries(template.map((project) => [project.name, project.workItems.length]));
  const managedNames = new Set(template.map((project) => project.name));
  const managedProjects = activeProjects.filter((project) => managedNames.has(project.name));

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.receipt.id, first.receipt.id);
  assert.equal(first.conflicts.length, 3);
  assert.deepEqual(managedProjects.map((project) => project.name), ['Lifeline', 'EchoMe', 'Totemora']);
  assert.equal(state.workItems.find((item) => item.id === mcpTask.id)?.projectId, sourceLifeline.id);
  assert.equal(state.projects.find((project) => project.id === sourceLifeline.id).name, 'Lifeline Demo');
  assert.equal(
    state.workItems.filter((item) => item.projectId === activeProjects.find((project) => project.name === 'EchoMe').id).length,
    expectedCounts.EchoMe
  );
  assert.equal(
    state.workItems.filter((item) => item.projectId === activeProjects.find((project) => project.name === 'Totemora').id).length,
    expectedCounts.Totemora
  );
});

function legacyProject(id, name, repositoryUrl, strategicValue, timestamp) {
  return {
    id,
    name,
    repositoryUrl,
    description: '',
    strategicValue,
    status: 'ACTIVE',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

test('schema migration is idempotent and unfinished history does not raise progress', async () => {
  const legacy = {
    schemaVersion: 1,
    projects: [{ id: 'project_p', name: 'Project', strategicValue: 5 }],
    workItems: [{ id: 'work_p', projectId: 'project_p', title: 'Legacy task', objective: 'A legacy task objective' }]
  };
  const first = migrateState(legacy);
  const second = migrateState(first.state);
  assert.equal(first.state.schemaVersion, 5);
  assert.equal(second.changed, false);
  assert.equal(first.state.phases[0].rank, 101376);

  const withRankedPhase = migrateState({
    schemaVersion: 2,
    phases: [{ id: 'phase_existing', projectId: 'project_p', title: 'Legacy task', rank: 1024 }],
    projects: [{ id: 'project_p', name: 'Project', strategicValue: 5 }],
    workItems: [{ id: 'work_ranked', projectId: 'project_p', title: 'Ranked task', objective: 'A ranked task objective', planning: { phase: 'Legacy task', phaseOrder: 1 } }]
  });
  assert.equal(withRankedPhase.state.phases.length, 1);
  assert.equal(withRankedPhase.state.workItems[0].phaseId, 'phase_existing');
});

test('schema migration repairs active tasks that have no durable active run', () => {
  const input = {
    schemaVersion: 4,
    projects: [{ id: 'project_p', name: 'Project', strategicValue: 5, scheduleVersion: 7 }],
    workItems: [{
      id: 'work_running',
      projectId: 'project_p',
      title: 'Detached active task',
      objective: 'Do not leave a task locked when no executor run can finish it.',
      status: 'RUNNING',
      currentRunId: 'run_missing'
    }],
    runs: [],
    events: []
  };

  const first = migrateState(input);
  assert.equal(first.state.workItems[0].status, 'PLANNED');
  assert.equal(first.state.workItems[0].currentRunId, null);
  assert.equal(first.state.projects[0].scheduleVersion, 8);
  assert.equal(first.state.events.at(-1).type, 'work_item.active_run_repaired');
  assert.equal(migrateState(first.state).changed, false);
});

async function createService(file, localUserId) {
  const service = new LifelineService({
    store: new JsonStore(file),
    executor: new MockExecutor({ delayMs: 0 }),
    logger,
    localUserId
  });
  await service.start();
  return service;
}

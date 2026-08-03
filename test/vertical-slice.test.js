import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };

test('first vertical slice persists events, evidence, and verified progress', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const service = await createService(file);

  const project = await service.createProject({ name: 'Lifeline', strategicValue: 10 });
  const item = await service.createWorkItem({
    projectId: project.id,
    title: 'First execution workflow',
    objective: 'Persist every workflow checkpoint and produce objective evidence.',
    acceptanceCriteria: ['Status reaches VERIFIED', 'Events can be replayed'],
    testCommands: ['npm test'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
  });

  const reported = await service.submitCompletion(item.id, {
    startedAt: '2026-08-03T10:00:00.000Z',
    completedAt: '2026-08-03T10:12:00.000Z',
    modelRef: 'gpt-agent-test',
    resultSummary: 'The real Agent workflow completed successfully.',
    evidence: [{ type: 'TEST_COMMAND', summary: 'Focused workflow test passed.', metadata: { exitCode: 0 } }]
  });
  const verified = await service.verifyTask(item.id, {
    completionRecordId: reported.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'The focused workflow test passed.'
  });
  const run = await service.getRun(reported.run.id);

  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.kind, 'AGENT');
  assert.equal(run.events.at(-1).type, 'completion.submitted');
  assert.deepEqual(run.evidence.map((entry) => entry.type), ['TEST_COMMAND', 'VERIFICATION']);
  assert.equal(verified.completionRecord.durationMs, 12 * 60 * 1000);
  assert.equal((await service.getWorkItem(item.id)).status, 'VERIFIED');
  assert.equal((await service.getProject(project.id)).currentTaskId, item.id);
  assert.equal((await service.dashboard()).projects[0].verifiedProgress, 1);

  const restarted = await createService(file);
  const restoredRun = await restarted.getRun(run.id);
  assert.equal(restoredRun.status, 'SUCCEEDED');
  assert.equal(restoredRun.events.length, run.events.length);
  assert.equal((await restarted.dashboard()).projects[0].verifiedProgress, 1);
});

test('a real Agent failure blocks the work item without synthetic evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Failure demo' });
  const item = await service.createWorkItem({
    projectId: project.id,
    title: 'Simulate [fail:test]',
    objective: 'Verify that a failed test blocks promotion without losing checkpoints.',
    acceptanceCriteria: ['Failure is persisted'],
    testCommands: ['npm test'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
  });
  const reported = await service.submitCompletion(item.id, {
    outcome: 'FAILED',
    startedAt: '2026-08-03T10:00:00.000Z',
    completedAt: '2026-08-03T10:03:00.000Z',
    modelRef: 'gpt-agent-test',
    resultSummary: 'The focused test exposed a real failure.',
    evidence: []
  });
  const run = await service.getRun(reported.run.id);

  assert.equal(run.status, 'FAILED');
  assert.equal((await service.getWorkItem(item.id)).status, 'BLOCKED');
  assert.deepEqual(run.evidence, []);
  assert.equal(run.error.code, 'AGENT_REPORTED_FAILURE');
});

test('recurring work creates a new run for every verified cycle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-recurring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const service = new LifelineService({ store, logger: silentLogger });
  await service.start();
  const project = await service.createProject({ name: 'Recurring work' });
  const item = await service.createWorkItem({
    projectId: project.id,
    title: 'Scan repository periodically',
    objective: 'Repeat the same verified repository scan without losing prior runs.',
    acceptanceCriteria: ['Each scan is recorded'],
    testCommands: ['npm test'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
  });
  await store.mutate((state) => {
    const task = state.workItems.find((entry) => entry.id === item.id);
    task.status = 'RECURRING';
    task.recurrence = { enabled: true };
  });

  const firstStarted = await service.startTask(item.id, { modelRef: 'gpt-agent-test' });
  const firstReported = await service.submitCompletion(item.id, {
    runId: firstStarted.run.id,
    resultSummary: 'First repository scan completed.',
    evidence: [{ type: 'TEST_COMMAND', summary: 'First scan passed.', metadata: { exitCode: 0 } }]
  });
  await service.verifyTask(item.id, {
    completionRecordId: firstReported.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'First scan verified.'
  });
  const first = await service.getRun(firstStarted.run.id);
  assert.equal((await service.getWorkItem(item.id)).status, 'RECURRING');
  const secondStarted = await service.startTask(item.id, { modelRef: 'gpt-agent-test' });
  const secondReported = await service.submitCompletion(item.id, {
    runId: secondStarted.run.id,
    resultSummary: 'Second repository scan completed.',
    evidence: [{ type: 'TEST_COMMAND', summary: 'Second scan passed.', metadata: { exitCode: 0 } }]
  });
  await service.verifyTask(item.id, {
    completionRecordId: secondReported.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'Second scan verified.'
  });
  const second = await service.getRun(secondStarted.run.id);

  assert.notEqual(first.id, second.id);
  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);
  assert.equal((await service.getWorkItem(item.id)).status, 'RECURRING');
  assert.equal((await service.dashboard()).projects[0].verifiedProgress, 1);
  assert.equal((await service.dashboard()).projects[0].unfinishedWorkItemCount, 0);
});

test('restart never routes a durable Agent run through the mock executor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-agent-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const firstService = await createService(file);
  const project = await firstService.createProject({ name: 'Agent restart safety' });
  const item = await firstService.createWorkItem({
    projectId: project.id,
    title: 'Wait for Agent completion',
    objective: 'Keep the Agent run pending across a service restart until the Agent submits evidence.',
    acceptanceCriteria: ['Restart does not synthesize completion'],
    testCommands: ['npm test'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
  });
  const started = await firstService.startTask(item.id, { executor: 'mock', modelRef: 'gpt-agent-test' });
  assert.equal(started.run.kind, 'AGENT');

  const restarted = await createService(file);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const pendingRun = await restarted.getRun(started.run.id);
  assert.equal(pendingRun.status, 'RUNNING');
  assert.equal(pendingRun.stage, 0);
  assert.equal(pendingRun.evidence.length, 0);
  assert.equal((await restarted.getWorkItem(item.id)).status, 'RUNNING');

  const completion = await restarted.submitCompletion(item.id, {
    runId: started.run.id,
    resultSummary: 'Agent supplied real completion evidence after restart.',
    evidence: [{ type: 'TEST_COMMAND', summary: 'Restart safety test passed.', metadata: { exitCode: 0 } }]
  });
  assert.equal(completion.task.status, 'REVIEW');
  assert.equal(completion.run.status, 'SUCCEEDED');

  const verified = await restarted.verifyTask(item.id, {
    completionRecordId: completion.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'The focused restart test passed.'
  });
  assert.equal(verified.task.status, 'VERIFIED');
  assert.equal((await restarted.getProject(project.id)).currentTaskId, item.id);
});

async function createService(file) {
  const service = new LifelineService({
    store: new JsonStore(file), logger: silentLogger
  });
  await service.start();
  return service;
}

test('startup isolates legacy Mock Runs without rewriting history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const projectId = 'project_resume';
  const workItemId = 'work_resume';
  const runId = 'run_resume';
  const timestamp = new Date().toISOString();
  const { writeFile } = await import('node:fs/promises');

  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    projects: [{
      id: projectId,
      name: 'Resume project',
      repositoryUrl: null,
      description: '',
      strategicValue: 5,
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    workItems: [{
      id: workItemId,
      projectId,
      title: 'Resume from test checkpoint',
      objective: 'Resume the queued durable workflow after a process restart.',
      nonGoals: [],
      acceptanceCriteria: ['The run resumes'],
      testCommands: ['npm test'],
      riskTier: 'low',
      weight: 1,
      resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 },
      status: 'QUEUED',
      currentRunId: runId,
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    runs: [{
      id: runId,
      workItemId,
      executor: 'mock',
      status: 'QUEUED',
      stage: 2,
      attempt: 1,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp
    }],
    evidence: [
      { id: 'e1', key: `${runId}:PLAN`, runId, workItemId, type: 'PLAN', score: 0.15, summary: 'Plan', metadata: {}, createdAt: timestamp },
      { id: 'e2', key: `${runId}:BRANCH`, runId, workItemId, type: 'BRANCH', score: 0.35, summary: 'Branch', metadata: {}, createdAt: timestamp }
    ],
    events: []
  }, null, 2));

  const store = new JsonStore(file);
  const service = new LifelineService({ store, logger: silentLogger });
  await service.start();
  const run = await service.getRun(runId);
  const task = await service.getWorkItem(workItemId);
  const firstState = await store.read();
  assert.equal(run.status, 'CANCELLED');
  assert.equal(run.kind, 'INTERNAL_MOCK');
  assert.equal(run.legacyMock, true);
  assert.deepEqual(run.evidence.map((entry) => entry.type), ['PLAN', 'BRANCH']);
  assert.ok(run.evidence.every((entry) => entry.metadata.legacyMock === true));
  assert.equal(task.status, 'PLANNED');
  assert.equal(task.currentRunId, null);
  assert.deepEqual(task.legacyMockRunIds, [runId]);
  assert.equal((await service.dashboard()).projects[0].verifiedProgress, 0);
  assert.equal(firstState.events.filter((event) => event.type === 'work_item.mock_history_isolated').length, 1);

  const restartedStore = new JsonStore(file);
  const restarted = new LifelineService({ store: restartedStore, logger: silentLogger });
  await restarted.start();
  const secondState = await restartedStore.read();
  assert.equal(secondState.events.filter((event) => event.type === 'work_item.mock_history_isolated').length, 1);
});

test('portfolio demo is idempotent and ordered by strategic value', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));

  const first = await service.seedDemo();
  const second = await service.seedDemo();
  const dashboard = await service.dashboard();
  const workItems = await service.listWorkItems(first.project.id);

  assert.equal(first.addedProjects, 3);
  assert.equal(second.addedProjects, 0);
  assert.equal(second.addedWorkItems, 0);
  assert.deepEqual(first.queuedRunIds, []);
  assert.deepEqual(dashboard.projects.map((project) => project.strategicValue), [10, 7, 5]);
  assert.equal(workItems[0].planning.phase, '方向收敛');
  assert.equal(workItems.at(-1).planning.phase, '持续扫描');
});

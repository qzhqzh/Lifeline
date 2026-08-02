import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockExecutor } from '../src/executor.js';
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

  await service.markReady(item.id);
  const queued = await service.queueWorkItem(item.id);
  const run = await waitForTerminal(service, queued.id);

  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.events.at(-1).type, 'run.succeeded');
  assert.deepEqual(run.evidence.map((entry) => entry.type), ['PLAN', 'BRANCH', 'TEST', 'REVIEW']);
  assert.equal((await service.getWorkItem(item.id)).status, 'VERIFIED');
  assert.equal((await service.dashboard()).projects[0].verifiedProgress, 0.8);

  const restarted = await createService(file);
  const restoredRun = await restarted.getRun(run.id);
  assert.equal(restoredRun.status, 'SUCCEEDED');
  assert.equal(restoredRun.events.length, run.events.length);
  assert.equal((await restarted.dashboard()).projects[0].verifiedProgress, 0.8);
});

test('executor failure blocks the work item and keeps prior evidence', async (t) => {
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
  await service.markReady(item.id);
  const queued = await service.queueWorkItem(item.id);
  const run = await waitForTerminal(service, queued.id);

  assert.equal(run.status, 'FAILED');
  assert.equal((await service.getWorkItem(item.id)).status, 'BLOCKED');
  assert.deepEqual(run.evidence.map((entry) => entry.type), ['PLAN', 'BRANCH']);
  assert.equal(run.error.code, 'SIMULATED_EXECUTOR_FAILURE');
});

test('recurring work creates a new run for every verified cycle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-recurring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const service = new LifelineService({
    store,
    executor: new MockExecutor({ delayMs: 0 }),
    logger: silentLogger
  });
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

  const first = await waitForTerminal(service, (await service.queueWorkItem(item.id)).id);
  assert.equal((await service.getWorkItem(item.id)).status, 'RECURRING');
  const second = await waitForTerminal(service, (await service.queueWorkItem(item.id)).id);

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
  const started = await firstService.startTask(item.id, { modelRef: 'gpt-agent-test' });

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
});

async function createService(file) {
  const service = new LifelineService({
    store: new JsonStore(file),
    executor: new MockExecutor({ delayMs: 0 }),
    logger: silentLogger
  });
  await service.start();
  return service;
}

async function waitForTerminal(service, runId) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const run = await service.getRun(runId);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run did not finish: ${runId}`);
}

test('startup resumes a queued run from its persisted checkpoint', async (t) => {
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

  const service = await createService(file);
  const run = await waitForTerminal(service, runId);
  assert.equal(run.status, 'SUCCEEDED');
  assert.deepEqual(run.evidence.map((entry) => entry.type), ['PLAN', 'BRANCH', 'TEST', 'REVIEW']);
  assert.equal((await service.getWorkItem(workItemId)).status, 'VERIFIED');
});

test('portfolio demo is idempotent and ordered by strategic value', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));

  const first = await service.seedDemo();
  await waitForTerminal(service, first.queuedRunIds[0]);
  const second = await service.seedDemo();
  const dashboard = await service.dashboard();
  const workItems = await service.listWorkItems(first.project.id);

  assert.equal(first.addedProjects, 3);
  assert.equal(second.addedProjects, 0);
  assert.equal(second.addedWorkItems, 0);
  assert.deepEqual(dashboard.projects.map((project) => project.strategicValue), [10, 7, 5]);
  assert.equal(workItems[0].planning.phase, '方向收敛');
  assert.equal(workItems.at(-1).planning.phase, '持续扫描');
});

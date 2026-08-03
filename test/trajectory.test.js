import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };
const windowEnd = '2026-08-03T20:00:00.000Z';

test('trajectory aggregates only real Agent results and calculates coverage, gaps, and concurrency', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-trajectory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'state.json'));
  const service = new LifelineService({ store, logger: silentLogger });
  await service.start();

  const primary = await service.createProject({ name: 'Primary', strategicValue: 10 });
  const secondary = await service.createProject({ name: 'Secondary', strategicValue: 6 });
  const first = await createTask(service, primary.id, 'First real result');
  const second = await createTask(service, secondary.id, 'Overlapping real result');
  const failed = await createTask(service, primary.id, 'Failed real result');
  const mockOnly = await createTask(service, primary.id, 'Legacy mock result');
  const imported = await createTask(service, secondary.id, 'Imported history');
  const future = await createTask(service, secondary.id, 'Future-dated result');

  const firstResult = await report(service, first.id, '2026-08-03T10:00:00.000Z', '2026-08-03T12:00:00.000Z');
  await service.verifyTask(first.id, {
    completionRecordId: firstResult.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'First result verified.'
  });
  const secondResult = await report(service, second.id, '2026-08-03T11:00:00.000Z', '2026-08-03T13:00:00.000Z');
  await service.verifyTask(second.id, {
    completionRecordId: secondResult.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'Second result verified.'
  });
  await service.submitCompletion(failed.id, {
    outcome: 'FAILED',
    startedAt: '2026-08-03T15:00:00.000Z',
    completedAt: '2026-08-03T16:00:00.000Z',
    modelRef: 'gpt-real',
    resultSummary: 'A real Agent reported failure.'
  });
  await report(service, future.id, '2026-08-03T19:00:00.000Z', '2026-08-03T21:00:00.000Z');

  await store.mutate((state) => {
    state.runs.push({
      id: 'run_legacy_mock', workItemId: mockOnly.id, kind: 'INTERNAL_MOCK', executor: 'mock',
      status: 'SUCCEEDED', startedAt: '2026-08-03T17:00:00.000Z', finishedAt: '2026-08-03T18:00:00.000Z'
    });
    state.completionRecords.push({
      id: 'completion_legacy_mock', taskId: mockOnly.id, workItemId: mockOnly.id,
      runId: 'run_legacy_mock', completionMethod: 'AGENT_RUN', outcome: 'COMPLETED',
      startedAt: '2026-08-03T17:00:00.000Z', completedAt: '2026-08-03T18:00:00.000Z'
    });
    state.completionRecords.push({
      id: 'completion_imported', taskId: imported.id, workItemId: imported.id,
      runId: null, completionMethod: 'IMPORTED_HISTORY', outcome: 'COMPLETED',
      startedAt: '2026-08-03T18:00:00.000Z', completedAt: '2026-08-03T19:00:00.000Z'
    });
  });

  const trajectory = await service.getTrajectory('24h', { now: windowEnd });

  assert.equal(trajectory.window, '24h');
  assert.equal(trajectory.startedAt, '2026-08-02T20:00:00.000Z');
  assert.equal(trajectory.completedAt, windowEnd);
  assert.deepEqual(trajectory.summary, {
    coverageRatio: 0.1667,
    recordedDurationMs: 4 * 60 * 60 * 1000,
    unrecordedDurationMs: 20 * 60 * 60 * 1000,
    peakConcurrency: 2,
    completedTaskCount: 2,
    failedTaskCount: 1,
    blockedTaskCount: 0,
    projectCount: 2
  });
  assert.deepEqual(trajectory.projects.map((project) => project.name), ['Primary', 'Secondary']);
  assert.deepEqual(trajectory.projects.flatMap((project) => project.intervals.map((entry) => entry.taskTitle)), [
    'First real result', 'Failed real result', 'Overlapping real result'
  ]);
  assert.equal(trajectory.projects[0].intervals[0].verificationStatus, 'VERIFIED');
  assert.equal(trajectory.projects[0].intervals[1].verificationStatus, 'NOT_APPLICABLE');
  assert.deepEqual(trajectory.projects[0].intervals[0].evidence.map((entry) => entry.type), ['TEST_COMMAND', 'VERIFICATION']);
  assert.equal(trajectory.gaps.length, 3);
  assert.ok(trajectory.gaps.every((gap) => gap.label === '未记录推进'));
  assert.equal(trajectory.gaps.reduce((sum, gap) => sum + gap.durationMs, 0), 20 * 60 * 60 * 1000);
});

test('trajectory accepts supported windows and rejects unknown windows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-trajectory-window-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new LifelineService({
    store: new JsonStore(join(directory, 'state.json')),
    logger: silentLogger
  });
  await service.start();

  assert.equal((await service.getTrajectory('7d', { now: windowEnd })).window, '7d');
  assert.equal((await service.getTrajectory('30d', { now: windowEnd })).window, '30d');
  await assert.rejects(service.getTrajectory('1h', { now: windowEnd }), (error) => error.code === 'INVALID_INPUT');
});

async function createTask(service, projectId, title) {
  return service.createWorkItem({
    projectId,
    title,
    objective: `Record ${title} as a truthful Agent result.`,
    acceptanceCriteria: [`${title} is queryable in the trajectory`],
    testCommands: ['node --test test/trajectory.test.js'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
  });
}

async function report(service, taskId, startedAt, completedAt) {
  return service.submitCompletion(taskId, {
    startedAt,
    completedAt,
    modelRef: 'gpt-real',
    reasoningEffort: 'medium',
    resultSummary: 'A real Agent completed the task.',
    artifactUris: ['src/example.js'],
    evidence: [{ type: 'TEST_COMMAND', summary: 'Focused test passed.', metadata: { exitCode: 0 } }]
  });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockExecutor } from '../src/executor.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };

test('updating a phase bumps the schedule, syncs task labels, and records before/after audit data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-phase-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const service = await createService(file, store);
  const project = await service.createProject({ name: 'Phase editing' });
  const phase = await service.createPhase({
    projectId: project.id,
    title: 'Planning',
    goal: 'Clarify the delivery scope.',
    phaseOrder: 1
  });
  await service.createWorkItem(taskInput(project.id, phase.id, 'First phase task', 1, 'Planning'));
  await service.createWorkItem(taskInput(project.id, phase.id, 'Second phase task', 2, 'Planning'));

  const beforeSchedule = await service.getSchedule(project.id);
  const updated = await service.updatePhase(phase.id, {
    expectedScheduleVersion: beforeSchedule.scheduleVersion,
    title: 'Delivery',
    goal: 'Ship the reviewed implementation.'
  }, { actor: 'editor', idempotencyKey: 'phase-edit-1' });
  const afterSchedule = await service.getSchedule(project.id);

  assert.equal(afterSchedule.scheduleVersion, beforeSchedule.scheduleVersion + 1);
  assert.equal(updated.title, 'Delivery');
  assert.equal(updated.goal, 'Ship the reviewed implementation.');
  assert.equal(afterSchedule.phases[0].title, 'Delivery');
  assert.equal(afterSchedule.phases[0].goal, 'Ship the reviewed implementation.');
  assert.ok(updated.updatedAt);
  assert.deepEqual(
    afterSchedule.phases[0].tasks.map((task) => task.planning.phase),
    ['Delivery', 'Delivery']
  );

  const state = await store.read();
  const audit = state.events.find((event) => event.type === 'phase.updated');
  assert.ok(audit, 'phase.updated audit event should be persisted');
  assert.equal(audit.metadata.phaseId, phase.id);
  assert.equal(audit.metadata.projectId, project.id);
  assert.equal(audit.metadata.beforeVersion, beforeSchedule.scheduleVersion);
  assert.equal(audit.metadata.afterVersion, afterSchedule.scheduleVersion);
  assert.deepEqual(audit.metadata.before, {
    title: 'Planning',
    goal: 'Clarify the delivery scope.'
  });
  assert.deepEqual(audit.metadata.after, {
    title: 'Delivery',
    goal: 'Ship the reviewed implementation.'
  });
});

test('phase edits reject stale schedule versions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-phase-edit-conflict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Phase conflict' });
  const phase = await service.createPhase({
    projectId: project.id,
    title: 'Initial phase',
    goal: 'Initial goal',
    phaseOrder: 1
  });
  const before = await service.getSchedule(project.id);
  await service.updatePhase(phase.id, {
    expectedScheduleVersion: before.scheduleVersion,
    title: 'First edit',
    goal: 'First goal'
  });
  const after = await service.getSchedule(project.id);

  await assert.rejects(
    service.updatePhase(phase.id, {
      expectedScheduleVersion: before.scheduleVersion,
      title: 'Stale edit',
      goal: 'Must not overwrite the first edit.'
    }),
    (error) => error.code === 'SCHEDULE_VERSION_CONFLICT'
      && error.details.expectedScheduleVersion === before.scheduleVersion
      && error.details.actualScheduleVersion === after.scheduleVersion
  );
  const unchanged = await service.getSchedule(project.id);
  assert.equal(unchanged.scheduleVersion, after.scheduleVersion);
  assert.equal(unchanged.phases[0].title, 'First edit');
  assert.equal(unchanged.phases[0].goal, 'First goal');
});

test('replaying a phase update with the same idempotency key does not bump the schedule again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-phase-edit-idempotency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const service = await createService(file, store);
  const project = await service.createProject({ name: 'Phase idempotency' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Before', goal: 'Before goal', phaseOrder: 1 });
  const before = await service.getSchedule(project.id);
  const input = {
    expectedScheduleVersion: before.scheduleVersion,
    title: 'After',
    goal: 'After goal'
  };
  const options = { actor: 'editor', idempotencyKey: 'phase-edit-replay' };

  const first = await service.updatePhase(phase.id, input, options);
  const afterFirst = await service.getSchedule(project.id);
  const replay = await service.updatePhase(phase.id, {
    ...input,
    expectedScheduleVersion: 0
  }, options);
  const afterReplay = await service.getSchedule(project.id);

  assert.equal(first.title, 'After');
  assert.equal(replay.title, 'After');
  assert.equal(afterFirst.scheduleVersion, before.scheduleVersion + 1);
  assert.equal(afterReplay.scheduleVersion, afterFirst.scheduleVersion);
  assert.equal((await store.read()).events.filter((event) => event.type === 'phase.updated').length, 1);
});

test('cancelled phases cannot be edited', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-phase-edit-cancelled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Cancelled phase edit' });
  const phase = await service.createPhase({
    projectId: project.id,
    title: 'Cancelled',
    goal: 'This phase is closed.',
    phaseOrder: 1,
    status: 'CANCELLED'
  });
  const before = await service.getSchedule(project.id);

  await assert.rejects(
    service.updatePhase(phase.id, {
      expectedScheduleVersion: before.scheduleVersion,
      title: 'Should remain cancelled',
      goal: 'Must not be edited.'
    }),
    (error) => error.code === 'PHASE_NOT_EDITABLE'
  );
  const unchanged = await service.getProject(project.id);
  assert.equal(unchanged.scheduleVersion, before.scheduleVersion);
  assert.equal((await service.listPhases(project.id)).length, 0);
});

function taskInput(projectId, phaseId, title, taskOrder, phaseTitle) {
  return {
    projectId,
    phaseId,
    title,
    objective: `Complete ${title} with evidence tied to the phase goal.`,
    acceptanceCriteria: [`${title} is observable and verified`],
    testCommands: ['node --test test/phase-edit.test.js'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 },
    planning: {
      phaseId,
      phase: phaseTitle,
      phaseOrder: 1,
      taskOrder,
      kind: 'feature',
      priority: 'P1',
      commitment: 'TENTATIVE'
    }
  };
}

async function createService(file, store = new JsonStore(file)) {
  const service = new LifelineService({
    store,
    executor: new MockExecutor({ delayMs: 0 }),
    localUserId: 'local-owner',
    logger: silentLogger
  });
  await service.start();
  return service;
}

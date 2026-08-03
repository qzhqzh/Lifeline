import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockExecutor } from '../src/executor.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };

test('task contracts support versioned edit, in-phase reorder, and audited cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-schedule-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Schedule editing' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const first = await service.createWorkItem(taskInput(project.id, phase.id, 'First task', 1));
  const second = await service.createWorkItem(taskInput(project.id, phase.id, 'Second task', 2));

  const schedule = await service.getSchedule(project.id);
  const updated = await service.updateWorkItem(first.id, {
    expectedScheduleVersion: schedule.scheduleVersion,
    title: 'First task, clarified',
    objective: 'Deliver the clarified first task with observable acceptance evidence.',
    planning: { taskOrder: 99 }
  }, { actor: 'editor', idempotencyKey: 'edit-first' });
  assert.equal(updated.title, 'First task, clarified');
  assert.equal(updated.planning.taskOrder, 1, 'taskOrder changes must go through the complete reorder operation');

  await assert.rejects(
    service.updateWorkItem(second.id, {
      expectedScheduleVersion: schedule.scheduleVersion,
      title: 'Stale edit must fail'
    }),
    (error) => error.code === 'SCHEDULE_VERSION_CONFLICT' && error.details.actualScheduleVersion > schedule.scheduleVersion
  );

  const afterEdit = await service.getSchedule(project.id);
  const reordered = await service.reorderPhaseTasks(project.id, {
    phaseId: phase.id,
    orderedTaskIds: [second.id, first.id],
    expectedScheduleVersion: afterEdit.scheduleVersion
  }, { actor: 'editor', idempotencyKey: 'reorder-delivery' });
  assert.deepEqual(reordered.phases[0].tasks.map((task) => task.id), [second.id, first.id]);

  await assert.rejects(
    service.reorderPhaseTasks(project.id, {
      phaseId: phase.id,
      orderedTaskIds: [second.id, second.id],
      expectedScheduleVersion: reordered.scheduleVersion
    }),
    (error) => error.code === 'INVALID_TASK_ORDER'
  );

  const cancelled = await service.cancelWorkItem(second.id, {
    reason: 'Removed after reprioritization.',
    expectedScheduleVersion: reordered.scheduleVersion
  }, { actor: 'editor', idempotencyKey: 'cancel-second' });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.deepEqual((await service.listWorkItems(project.id)).map((task) => task.id), [first.id]);
  assert.equal((await service.getSchedule(project.id)).taskCount, 1);

  const details = await service.getTaskDetails(second.id);
  assert.equal(details.task.cancelReason, 'Removed after reprioritization.');
  assert.equal(details.auditEvents.at(-1).type, 'work_item.cancelled');

  const replay = await service.cancelWorkItem(second.id, {
    reason: 'This replay must not create another mutation.',
    expectedScheduleVersion: 0
  }, { actor: 'editor', idempotencyKey: 'cancel-second' });
  assert.equal(replay.cancelReason, 'Removed after reprioritization.');
});

test('new tasks cannot target a cancelled phase', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-cancelled-phase-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Cancelled phase guard' });
  const phase = await service.createPhase({
    projectId: project.id,
    title: 'Cancelled delivery',
    phaseOrder: 1,
    status: 'CANCELLED'
  });

  await assert.rejects(
    service.createWorkItem(taskInput(project.id, phase.id, 'Hidden task', 1)),
    (error) => error.code === 'INVALID_INPUT' && error.message.includes('cancelled')
  );
});

test('deferred tasks remain editable and cancellable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-deferred-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const service = await createService(file, store);
  const project = await service.createProject({ name: 'Future plan' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Later', phaseOrder: 1 });
  const task = await service.createWorkItem(taskInput(project.id, phase.id, 'Deferred task', 1));
  await store.mutate((state) => {
    state.workItems.find((entry) => entry.id === task.id).status = 'DEFERRED';
  });

  const edited = await service.updateWorkItem(task.id, {
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion,
    title: 'Deferred task, clarified'
  });
  assert.equal(edited.status, 'DEFERRED');
  const cancelled = await service.cancelWorkItem(task.id, {
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion,
    reason: 'The future plan is no longer needed.'
  });
  assert.equal(cancelled.status, 'CANCELLED');
});

test('issue reference can be added and cleared without changing the rest of the task contract', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-issue-reference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Issue reference' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Review', phaseOrder: 1 });
  const task = await service.createWorkItem({
    ...taskInput(project.id, phase.id, 'Track review finding', 1),
    issue: 'https://github.com/example/lifeline/issues/7'
  });
  const originalObjective = task.objective;

  const cleared = await service.updateWorkItem(task.id, {
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion,
    issue: null
  });
  assert.equal(cleared.issue, null);
  assert.equal(cleared.objective, originalObjective);
  assert.deepEqual(cleared.acceptanceCriteria, task.acceptanceCriteria);
  assert.equal(cleared.provenance.edits.length, 0, 'link metadata must not masquerade as a content edit');

  const cancelled = await service.cancelWorkItem(task.id, {
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion,
    reason: 'Keep the finding as locked review history.'
  });
  const linked = await service.updateWorkItem(cancelled.id, {
    expectedScheduleVersion: (await service.getProject(project.id)).scheduleVersion,
    issue: 'https://github.com/example/lifeline/issues/8'
  });
  assert.equal(linked.status, 'CANCELLED');
  assert.equal(linked.issue, 'https://github.com/example/lifeline/issues/8');
  assert.equal(linked.objective, originalObjective);
  assert.deepEqual(linked.acceptanceCriteria, task.acceptanceCriteria);
  assert.equal(linked.provenance.edits.length, 0, 'locked issue metadata must not become a content edit');

  await assert.rejects(
    service.updateWorkItem(linked.id, {
      expectedScheduleVersion: (await service.getProject(project.id)).scheduleVersion,
      issue: 'https://github.com/example/lifeline/issues/9',
      title: 'Unsafe cancelled edit'
    }),
    (error) => error.code === 'TASK_NOT_EDITABLE'
  );
});

test('dashboard recommendation prioritizes stars, scheduled dates, and human tasks without reordering the phase', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-star-priority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Priority signals' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const aiTask = await service.createWorkItem(
    taskInput(project.id, phase.id, 'AI proposed task', 1),
    { actor: 'agent', client: 'mcp', source: { kind: 'codex-mcp' } }
  );
  const humanTask = await service.createWorkItem(
    { ...taskInput(project.id, phase.id, 'Human starred task', 2), starred: true },
    { actor: 'owner', client: 'web', source: { kind: 'web-ui' } }
  );

  assert.equal((await service.dashboard()).projects[0].nextWorkItemId, humanTask.id);
  assert.equal((await service.getWorkItem(humanTask.id)).provenance.edits.length, 0);
  assert.deepEqual(
    (await service.getSchedule(project.id)).phases[0].tasks.map((task) => task.id),
    [aiTask.id, humanTask.id],
    'priority signals must not rewrite the user-visible phase order'
  );

  const scheduled = await service.updateWorkItem(humanTask.id, {
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion,
    starred: false,
    scheduledFor: '2020-01-01'
  });
  assert.equal((await service.dashboard()).projects[0].nextWorkItemId, scheduled.id);

  await service.updateWorkItem(humanTask.id, {
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion,
    scheduledFor: null
  });
  assert.equal((await service.dashboard()).projects[0].nextWorkItemId, humanTask.id, 'human work wins an otherwise equal tie');
  assert.equal((await service.getWorkItem(humanTask.id)).provenance.edits.length, 0, 'priority metadata is not a content edit');
});

test('running and historical tasks stay protected from contract edits and removal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-schedule-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Protected schedule' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Active work', phaseOrder: 1 });
  const task = await service.createWorkItem(taskInput(project.id, phase.id, 'Running task', 1));
  const schedule = await service.getSchedule(project.id);
  await service.startTask(task.id, { modelRef: 'gpt-5-test' }, { actor: 'agent', idempotencyKey: 'start-running' });

  await assert.rejects(
    service.updateWorkItem(task.id, { expectedScheduleVersion: schedule.scheduleVersion, title: 'Unsafe edit' }),
    (error) => error.code === 'TASK_NOT_EDITABLE'
  );
  await assert.rejects(
    service.cancelWorkItem(task.id, { expectedScheduleVersion: schedule.scheduleVersion, reason: 'Unsafe removal' }),
    (error) => error.code === 'TASK_NOT_CANCELLABLE'
  );
});

test('every active or terminal locked status rejects content edits, cancellation, and reordering', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-all-locked-statuses-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const service = await createService(file, store);
  const project = await service.createProject({ name: 'Locked status matrix' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const task = await service.createWorkItem(taskInput(project.id, phase.id, 'Locked task', 1));

  for (const status of ['QUEUED', 'RUNNING', 'REVIEW', 'RECURRING', 'VERIFIED', 'RELEASED', 'ARCHIVED', 'CANCELLED']) {
    await store.mutate((state) => {
      state.workItems.find((entry) => entry.id === task.id).status = status;
    });
    const scheduleVersion = (await service.getProject(project.id)).scheduleVersion;
    await assert.rejects(
      service.updateWorkItem(task.id, { expectedScheduleVersion: scheduleVersion, title: `Unsafe ${status} edit` }),
      (error) => error.code === 'TASK_NOT_EDITABLE'
    );
    await assert.rejects(
      service.cancelWorkItem(task.id, { expectedScheduleVersion: scheduleVersion, reason: `Unsafe ${status} removal` }),
      (error) => error.code === 'TASK_NOT_CANCELLABLE'
    );
    await assert.rejects(
      service.reorderPhaseTasks(project.id, {
        phaseId: phase.id,
        orderedTaskIds: [task.id],
        expectedScheduleVersion: scheduleVersion
      }),
      (error) => error.code === 'INVALID_TASK_ORDER'
    );
  }
});

test('task provenance distinguishes human and AI creation without treating reorder as content editing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-task-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const service = await createService(file);
  const project = await service.createProject({ name: 'Task provenance' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const human = await service.createWorkItem(
    { ...taskInput(project.id, phase.id, 'Human task', 1), source: { kind: 'codex-mcp' } },
    { actor: 'owner', client: 'web', source: { kind: 'web-ui' } }
  );
  const ai = await service.createWorkItem(
    { ...taskInput(project.id, phase.id, 'AI task', 2), source: { kind: 'web-ui' } },
    { actor: 'agent', client: 'mcp', source: { kind: 'codex-mcp' } }
  );
  assert.equal(human.provenance.origin, 'HUMAN');
  assert.equal(ai.provenance.origin, 'AI');
  assert.equal(ai.provenance.contentAdjustedByHuman, false);

  const beforeReorder = await service.getSchedule(project.id);
  await service.reorderPhaseTasks(project.id, {
    phaseId: phase.id,
    orderedTaskIds: [ai.id, human.id],
    expectedScheduleVersion: beforeReorder.scheduleVersion
  }, { actor: 'owner', client: 'web', source: { kind: 'web-ui' } });
  assert.equal((await service.getWorkItem(ai.id)).provenance.contentAdjustedByHuman, false);

  const beforeNoOp = await service.getSchedule(project.id);
  const unchanged = await service.updateWorkItem(ai.id, {
    expectedScheduleVersion: beforeNoOp.scheduleVersion
  }, { actor: 'owner', client: 'web', source: { kind: 'web-ui' } });
  assert.equal(unchanged.provenance.contentAdjustedByHuman, false);
  assert.equal((await service.getSchedule(project.id)).scheduleVersion, beforeNoOp.scheduleVersion);

  const laterPhase = await service.createPhase({ projectId: project.id, title: 'Later', phaseOrder: 2 });
  const beforeMove = await service.getSchedule(project.id);
  const moved = await service.updateWorkItem(ai.id, {
    expectedScheduleVersion: beforeMove.scheduleVersion,
    phaseId: laterPhase.id,
    source: { kind: 'codex-mcp' }
  }, { actor: 'owner', client: 'web', source: { kind: 'web-ui' } });
  assert.equal(moved.provenance.contentAdjustedByHuman, false);
  assert.equal(moved.provenance.edits.length, 0);
  assert.equal(moved.lastMutationSource.kind, 'web-ui');

  const beforeEdit = await service.getSchedule(project.id);
  const adjusted = await service.updateWorkItem(ai.id, {
    expectedScheduleVersion: beforeEdit.scheduleVersion,
    title: 'AI task, human clarified'
  }, { actor: 'owner', client: 'web', source: { kind: 'web-ui' } });
  assert.equal(adjusted.provenance.origin, 'AI');
  assert.equal(adjusted.provenance.contentAdjustedByHuman, true);
  assert.equal(adjusted.provenance.lastContentEditorType, 'HUMAN');
  assert.equal(adjusted.provenance.edits.length, 1);

  const restarted = await createService(file);
  const persisted = await restarted.getTaskDetails(ai.id);
  assert.equal(persisted.task.provenance.contentAdjustedByHuman, true);
  assert.equal(persisted.auditEvents.at(-1).metadata.source.kind, 'web-ui');
});

function taskInput(projectId, phaseId, title, taskOrder) {
  return {
    projectId,
    phaseId,
    title,
    objective: `Complete ${title} with enough detail for an executable contract.`,
    acceptanceCriteria: [`${title} is observable and verified`],
    testCommands: ['node --test test/schedule-edit.test.js'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 },
    planning: {
      phaseId,
      phase: 'Delivery',
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

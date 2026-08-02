import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockExecutor } from '../src/executor.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };

test('dependency and parallel policy fields default for legacy task inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-defaults-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const service = await createService(file);
  const project = await service.createProject({ name: 'Dependency defaults' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });

  const created = await service.createWorkItem(taskInput(project.id, phase.id, 'Legacy task', 1));
  assert.deepEqual(created.dependsOnTaskIds, []);
  assert.equal(created.parallelPolicy, 'AUTO');

  const restored = await (await createService(file)).getWorkItem(created.id);
  assert.deepEqual(restored.dependsOnTaskIds, []);
  assert.equal(restored.parallelPolicy, 'AUTO');
});

test('same-project dependencies and explicit parallel policies persist in the schedule', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-same-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Same project dependencies' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const predecessor = await service.createWorkItem(taskInput(project.id, phase.id, 'Build prerequisite', 1, {
    parallelPolicy: 'PARALLEL_ALLOWED'
  }));
  const dependent = await service.createWorkItem(taskInput(project.id, phase.id, 'Consume prerequisite', 2, {
    dependsOnTaskIds: [predecessor.id],
    parallelPolicy: 'SEQUENTIAL'
  }));

  assert.deepEqual(dependent.dependsOnTaskIds, [predecessor.id]);
  assert.equal(dependent.parallelPolicy, 'SEQUENTIAL');
  const schedule = await service.getSchedule(project.id);
  assert.deepEqual(schedule.phases[0].tasks.map((task) => task.id), [predecessor.id, dependent.id]);
  assert.deepEqual(schedule.phases[0].parallelTaskIds, [predecessor.id]);
  assert.equal(schedule.phases[0].tasks[0].parallelPolicy, 'PARALLEL_ALLOWED');
  assert.equal(schedule.phases[0].tasks[1].parallelPolicy, 'SEQUENTIAL');
});

test('an incomplete dependency blocks markReady and startTask', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Dependency gate' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const predecessor = await service.createWorkItem(taskInput(project.id, phase.id, 'Pending prerequisite', 1));
  const dependent = await service.createWorkItem(taskInput(project.id, phase.id, 'Blocked consumer', 2, {
    dependsOnTaskIds: [predecessor.id]
  }));

  await assert.rejects(
    service.markReady(dependent.id),
    (error) => error.code === 'UNSATISFIED_TASK_DEPENDENCIES'
  );
  await assert.rejects(
    service.startTask(dependent.id, { modelRef: 'gpt-dependency-test' }),
    (error) => error.code === 'UNSATISFIED_TASK_DEPENDENCIES'
  );
  assert.equal((await service.getWorkItem(dependent.id)).status, 'PLANNED');
});

test('a completed dependency allows markReady and startTask', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-complete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Completed dependency' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const predecessor = await service.createWorkItem(taskInput(project.id, phase.id, 'Complete prerequisite', 1));
  const dependent = await service.createWorkItem(taskInput(project.id, phase.id, 'Unblocked consumer', 2, {
    dependsOnTaskIds: [predecessor.id]
  }));

  await service.markReady(predecessor.id);
  const queued = await service.queueWorkItem(predecessor.id);
  const run = await waitForTerminal(service, queued.id);
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal((await service.getWorkItem(predecessor.id)).status, 'VERIFIED');

  const ready = await service.markReady(dependent.id);
  assert.equal(ready.status, 'READY');
  assert.deepEqual((await service.getSchedule(project.id)).phases[0].parallelTaskIds, [dependent.id]);
  const started = await service.startTask(dependent.id, { modelRef: 'gpt-dependency-test' });
  assert.equal(started.task.status, 'RUNNING');
});

test('dependencies cannot cross projects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-project-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const firstProject = await service.createProject({ name: 'Dependency source project' });
  const firstPhase = await service.createPhase({ projectId: firstProject.id, title: 'Delivery', phaseOrder: 1 });
  const predecessor = await service.createWorkItem(taskInput(firstProject.id, firstPhase.id, 'Foreign prerequisite', 1));
  const secondProject = await service.createProject({ name: 'Dependent project' });
  const secondPhase = await service.createPhase({ projectId: secondProject.id, title: 'Delivery', phaseOrder: 1 });

  await assert.rejects(
    service.createWorkItem(taskInput(secondProject.id, secondPhase.id, 'Cross-project consumer', 1, {
      dependsOnTaskIds: [predecessor.id]
    })),
    (error) => error.code === 'INVALID_TASK_DEPENDENCY'
  );
});

test('a task cannot depend on itself', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-self-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Self dependency' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const task = await service.createWorkItem(taskInput(project.id, phase.id, 'Self dependent task', 1));
  const schedule = await service.getSchedule(project.id);

  await assert.rejects(
    service.updateWorkItem(task.id, {
      expectedScheduleVersion: schedule.scheduleVersion,
      dependsOnTaskIds: [task.id]
    }),
    (error) => error.code === 'TASK_DEPENDENCY_CYCLE'
  );
});

test('dependency updates reject a DAG cycle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-cycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Dependency cycle' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const first = await service.createWorkItem(taskInput(project.id, phase.id, 'Cycle first', 1));
  const second = await service.createWorkItem(taskInput(project.id, phase.id, 'Cycle second', 2, {
    dependsOnTaskIds: [first.id]
  }));
  const schedule = await service.getSchedule(project.id);

  await assert.rejects(
    service.updateWorkItem(first.id, {
      expectedScheduleVersion: schedule.scheduleVersion,
      dependsOnTaskIds: [second.id]
    }),
    (error) => error.code === 'TASK_DEPENDENCY_CYCLE'
  );
});

test('a dependency must appear before its dependent task', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Dependency order' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const laterTask = await service.createWorkItem(taskInput(project.id, phase.id, 'Later prerequisite', 2));

  await assert.rejects(
    service.createWorkItem(taskInput(project.id, phase.id, 'Earlier consumer', 1, {
      dependsOnTaskIds: [laterTask.id]
    })),
    (error) => error.code === 'INVALID_DEPENDENCY_ORDER'
  );
});

test('in-phase reorder cannot place a dependent before its dependency', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-reorder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Dependency reorder' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const predecessor = await service.createWorkItem(taskInput(project.id, phase.id, 'Ordered prerequisite', 1));
  const dependent = await service.createWorkItem(taskInput(project.id, phase.id, 'Ordered consumer', 2, {
    dependsOnTaskIds: [predecessor.id]
  }));
  const schedule = await service.getSchedule(project.id);

  await assert.rejects(
    service.reorderPhaseTasks(project.id, {
      phaseId: phase.id,
      orderedTaskIds: [dependent.id, predecessor.id],
      expectedScheduleVersion: schedule.scheduleVersion
    }),
    (error) => error.code === 'INVALID_DEPENDENCY_ORDER'
  );
});

test('cancelling a task with active dependents is rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dependency-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Dependency cancellation' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 1 });
  const predecessor = await service.createWorkItem(taskInput(project.id, phase.id, 'Protected prerequisite', 1));
  await service.createWorkItem(taskInput(project.id, phase.id, 'Active dependent', 2, {
    dependsOnTaskIds: [predecessor.id]
  }));
  const schedule = await service.getSchedule(project.id);

  await assert.rejects(
    service.cancelWorkItem(predecessor.id, {
      reason: 'Cannot remove a prerequisite while it is still needed.',
      expectedScheduleVersion: schedule.scheduleVersion
    }),
    (error) => error.code === 'TASK_HAS_DEPENDENTS'
  );
  assert.equal((await service.getWorkItem(predecessor.id)).status, 'PLANNED');
});

function taskInput(projectId, phaseId, title, taskOrder, overrides = {}) {
  return {
    projectId,
    phaseId,
    title,
    objective: `Complete ${title} with an observable dependency-aware execution contract.`,
    acceptanceCriteria: [`${title} is observable and verified`],
    testCommands: ['node --test test/dependency-schedule.test.js'],
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
    },
    ...overrides
  };
}

async function createService(file) {
  const service = new LifelineService({
    store: new JsonStore(file),
    executor: new MockExecutor({ delayMs: 0 }),
    localUserId: 'local-owner',
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

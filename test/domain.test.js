import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainError,
  WORK_ITEM_STATUS,
  calculateProjectProgress,
  createWorkItem,
  hydrateWorkItemMetadata,
  transitionWorkItem,
  validateReadyContract
} from '../src/domain.js';

test('state machine accepts the execution happy path', () => {
  let item = createWorkItem(validWorkItemInput());
  item = transitionWorkItem(item, WORK_ITEM_STATUS.READY);
  item = transitionWorkItem(item, WORK_ITEM_STATUS.QUEUED);
  item = transitionWorkItem(item, WORK_ITEM_STATUS.RUNNING);
  item = transitionWorkItem(item, WORK_ITEM_STATUS.REVIEW);
  item = transitionWorkItem(item, WORK_ITEM_STATUS.VERIFIED);
  assert.equal(item.status, WORK_ITEM_STATUS.VERIFIED);
});

test('state machine rejects an unverifiable shortcut', () => {
  const item = createWorkItem(validWorkItemInput());
  assert.throws(
    () => transitionWorkItem(item, WORK_ITEM_STATUS.VERIFIED),
    (error) => error instanceof DomainError && error.code === 'INVALID_TRANSITION'
  );
});

test('deferred work stays adjustable and recurring work returns after review', () => {
  let deferred = createWorkItem(validWorkItemInput());
  deferred = transitionWorkItem(deferred, WORK_ITEM_STATUS.DEFERRED);
  deferred = transitionWorkItem(deferred, WORK_ITEM_STATUS.PLANNED);
  assert.equal(deferred.status, WORK_ITEM_STATUS.PLANNED);

  let recurring = transitionWorkItem(deferred, WORK_ITEM_STATUS.READY);
  recurring = transitionWorkItem(recurring, WORK_ITEM_STATUS.QUEUED);
  recurring = transitionWorkItem(recurring, WORK_ITEM_STATUS.RUNNING);
  recurring = transitionWorkItem(recurring, WORK_ITEM_STATUS.REVIEW);
  recurring = transitionWorkItem(recurring, WORK_ITEM_STATUS.RECURRING);
  recurring = transitionWorkItem(recurring, WORK_ITEM_STATUS.QUEUED);
  assert.equal(recurring.status, WORK_ITEM_STATUS.QUEUED);
});

test('ready contract requires acceptance criteria and test commands', () => {
  const item = createWorkItem({
    ...validWorkItemInput(),
    acceptanceCriteria: [],
    testCommands: []
  });
  assert.throws(
    () => validateReadyContract(item),
    (error) => error.code === 'INVALID_EXECUTION_CONTRACT' && error.details.violations.length === 2
  );
});

test('project progress uses weighted maximum evidence score', () => {
  const items = [
    { id: 'a', weight: 2, status: WORK_ITEM_STATUS.VERIFIED },
    { id: 'b', weight: 1, status: WORK_ITEM_STATUS.PLANNED }
  ];
  const evidence = [
    { workItemId: 'a', score: 0.35 },
    { workItemId: 'a', score: 0.8 },
    { workItemId: 'b', score: 0.15 }
  ];
  assert.equal(calculateProjectProgress(items, evidence), 0.5833);
});

test('recurring work counts as complete while deferred work remains future scope', () => {
  const items = [
    { id: 'cycle', weight: 2, status: WORK_ITEM_STATUS.RECURRING },
    { id: 'future', weight: 1, status: WORK_ITEM_STATUS.DEFERRED }
  ];
  assert.equal(calculateProjectProgress(items, []), 0.6667);
});

test('work items receive a two-level schedule and routing recommendation', () => {
  const item = createWorkItem({
    ...validWorkItemInput(),
    planning: {
      phase: 'Bug patrol',
      phaseOrder: 2,
      taskOrder: 3,
      kind: 'bug',
      priority: 'P0',
      commitment: 'COMMITTED'
    }
  });

  assert.deepEqual(item.planning, {
    phase: 'Bug patrol',
    phaseOrder: 2,
    taskOrder: 3,
    kind: 'bug',
    priority: 'P0',
    commitment: 'COMMITTED'
  });
  assert.equal(item.recommendation.capability, 'code-repair');
  assert.equal(item.recommendation.executor, 'luna_worker');
  assert.equal(item.recommendation.reasoningEffort, 'medium');
  assert.equal(item.recommendation.compute, 'low');
  assert.equal(item.recommendation.validationProfile, 'V1');
  assert.equal(item.recommendation.policyVersion, 'risk-tier-v1');
});

test('high-risk work routes to the main model and a release-grade validation profile', () => {
  const item = createWorkItem({
    ...validWorkItemInput(),
    riskTier: 'high',
    planning: { kind: 'bug' }
  });
  assert.equal(item.recommendation.executor, 'codex');
  assert.equal(item.recommendation.reasoningEffort, 'high');
  assert.equal(item.recommendation.compute, 'high');
  assert.equal(item.recommendation.validationProfile, 'V3');
});

test('legacy automatic routing is recalibrated without losing its estimate', () => {
  const item = hydrateWorkItemMetadata({
    ...validWorkItemInput(),
    recommendation: {
      capability: 'agentic-coding',
      executor: 'codex',
      reasoningEffort: 'high',
      compute: 'high',
      estimateMinutes: 25,
      approach: 'Legacy generated route'
    }
  });
  assert.equal(item.recommendation.executor, 'luna_worker');
  assert.equal(item.recommendation.validationProfile, 'V1');
  assert.equal(item.recommendation.estimateMinutes, 25);
});

test('legacy work items hydrate with backward-compatible planning defaults', () => {
  const item = hydrateWorkItemMetadata({ id: 'legacy', title: 'Existing task' });
  assert.equal(item.issue, null);
  assert.deepEqual(item.dependsOnTaskIds, []);
  assert.equal(item.parallelPolicy, 'AUTO');
  assert.equal(item.planning.phase, '待排期');
  assert.equal(item.planning.phaseOrder, 99);
  assert.equal(item.recommendation.capability, 'agentic-coding');
});

test('work item dependency metadata is normalized without adding another schedule level', () => {
  const item = createWorkItem({
    ...validWorkItemInput(),
    dependsOnTaskIds: ['work_foundation'],
    parallelPolicy: 'PARALLEL_ALLOWED'
  });
  assert.deepEqual(item.dependsOnTaskIds, ['work_foundation']);
  assert.equal(item.parallelPolicy, 'PARALLEL_ALLOWED');
  assert.throws(
    () => createWorkItem({ ...validWorkItemInput(), dependsOnTaskIds: ['work_same', 'work_same'] }),
    (error) => error.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => createWorkItem({ ...validWorkItemInput(), parallelPolicy: 'UNBOUNDED' }),
    (error) => error.code === 'INVALID_INPUT'
  );
});

test('work item issue reference is optional and normalized independently', () => {
  const withoutIssue = createWorkItem(validWorkItemInput());
  const withIssue = createWorkItem({
    ...validWorkItemInput(),
    issue: '  https://github.com/example/repository/issues/42  '
  });
  assert.equal(withoutIssue.issue, null);
  assert.equal(withIssue.issue, 'https://github.com/example/repository/issues/42');
  assert.deepEqual(withIssue.acceptanceCriteria, withoutIssue.acceptanceCriteria);
});

test('work item star and scheduled date are optional scheduling signals', () => {
  const defaultTask = createWorkItem(validWorkItemInput());
  const prioritizedTask = createWorkItem({
    ...validWorkItemInput(),
    starred: true,
    scheduledFor: '2026-08-03'
  });
  assert.equal(defaultTask.starred, false);
  assert.equal(defaultTask.scheduledFor, null);
  assert.equal(prioritizedTask.starred, true);
  assert.equal(prioritizedTask.scheduledFor, '2026-08-03');
  assert.throws(
    () => createWorkItem({ ...validWorkItemInput(), scheduledFor: '2026-02-30' }),
    (error) => error.code === 'INVALID_INPUT'
  );
});

function validWorkItemInput() {
  return {
    projectId: 'project_test',
    title: 'Implement vertical slice',
    objective: 'Complete an evidence-driven workflow with durable state.',
    acceptanceCriteria: ['The workflow reaches VERIFIED'],
    testCommands: ['npm test'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
  };
}

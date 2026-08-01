import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainError,
  WORK_ITEM_STATUS,
  calculateProjectProgress,
  createWorkItem,
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

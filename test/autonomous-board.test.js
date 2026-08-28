import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_BATCH,
  DISPATCH_POLICY_VERSION,
  PROJECT_HEALTH,
  deriveAutonomousBoard,
  deriveEfficiencyMetrics,
  derivePhaseStatus
} from '../src/autonomous-board.js';

const NOW = '2026-08-12T12:00:00.000Z';

test('dispatch excludes incomplete contracts and unmet dependencies before applying capacity', () => {
  const state = fixtureState();
  const first = task('first', 'project-a', 'phase-a', {
    priority: 'P0',
    compute: 'high'
  });
  const second = task('second', 'project-b', 'phase-b', {
    priority: 'P1',
    compute: 'low',
    dependsOnTaskIds: ['dependency']
  });
  const dependency = task('dependency', 'project-b', 'phase-b', {
    status: 'PLANNED',
    priority: 'P0',
    compute: 'low'
  });
  const incomplete = task('incomplete', 'project-a', 'phase-a', {
    acceptanceCriteria: []
  });
  const missingResource = task('missing-resource', 'project-b', 'phase-b', {
    resourceProfile: null
  });
  state.workItems.push(first, second, dependency, incomplete, missingResource);

  const board = deriveAutonomousBoard(state, { now: NOW });
  const firstDecision = board.decisions.find((entry) => entry.taskId === 'first');
  const secondDecision = board.decisions.find((entry) => entry.taskId === 'second');
  const incompleteDecision = board.decisions.find((entry) => entry.taskId === 'incomplete');
  const missingResourceDecision = board.decisions.find((entry) => entry.taskId === 'missing-resource');

  assert.equal(firstDecision.batch, DISPATCH_BATCH.NEXT);
  assert.equal(firstDecision.policyVersion, DISPATCH_POLICY_VERSION);
  assert.equal(secondDecision.batch, DISPATCH_BATCH.BACKLOG);
  assert.ok(secondDecision.reasonCodes.includes('DEPENDENCY_BLOCKED'));
  assert.equal(incompleteDecision.batch, DISPATCH_BATCH.BACKLOG);
  assert.ok(incompleteDecision.reasonCodes.includes('CONTRACT_INCOMPLETE'));
  assert.equal(missingResourceDecision.batch, DISPATCH_BATCH.BACKLOG);
  assert.ok(missingResourceDecision.reasonCodes.includes('CONTRACT_INCOMPLETE'));
});

test('deferred and blocked work stay in BACKLOG while an already claimed task stays only in NOW', () => {
  const state = fixtureState();
  state.workItems.push(
    task('deferred', 'project-a', 'phase-a', { status: 'DEFERRED' }),
    task('blocked', 'project-b', 'phase-b', { status: 'BLOCKED' }),
    task('claimed', 'project-a', 'phase-a', { status: 'RUNNING', currentRunId: 'run-claimed' })
  );
  state.runs.push({
    id: 'run-claimed',
    workItemId: 'claimed',
    kind: 'AGENT',
    status: 'RUNNING',
    modelRef: 'gpt-active',
    claimedAt: '2026-08-12T11:30:00.000Z',
    leaseExpiresAt: '2026-08-12T13:00:00.000Z'
  });

  const board = deriveAutonomousBoard(state, { now: NOW });
  const deferred = board.decisions.find((entry) => entry.taskId === 'deferred');
  const blocked = board.decisions.find((entry) => entry.taskId === 'blocked');
  const claimed = board.decisions.find((entry) => entry.taskId === 'claimed');
  assert.equal(deferred.batch, DISPATCH_BATCH.BACKLOG);
  assert.ok(deferred.reasonCodes.includes('STATUS_DEFERRED'));
  assert.equal(blocked.batch, DISPATCH_BATCH.BACKLOG);
  assert.ok(blocked.reasonCodes.includes('STATUS_BLOCKED'));
  assert.equal(claimed.batch, DISPATCH_BATCH.NOW);
  assert.equal(board.lanes.next.some((entry) => entry.taskId === 'claimed'), false);
});

test('an expired claim is immediately presented as READY without waiting for a write mutation', () => {
  const state = fixtureState();
  state.workItems.push(task('expired', 'project-a', 'phase-a', {
    status: 'RUNNING',
    currentRunId: 'run-expired'
  }));
  state.runs.push({
    id: 'run-expired',
    workItemId: 'expired',
    kind: 'AGENT',
    status: 'RUNNING',
    modelRef: 'gpt-expired',
    claimedAt: '2026-08-12T10:00:00.000Z',
    leaseExpiresAt: '2026-08-12T11:00:00.000Z'
  });

  const board = deriveAutonomousBoard(state, { now: NOW });
  const decision = board.decisions.find((entry) => entry.taskId === 'expired');
  const project = board.projects.find((entry) => entry.id === 'project-a');
  assert.equal(decision.batch, DISPATCH_BATCH.NEXT);
  assert.equal(decision.status, 'READY');
  assert.equal(decision.effectiveStatus, 'READY');
  assert.equal(decision.leaseExpiresAt, null);
  assert.equal(board.summary.runningCount, 0);
  assert.equal(project.phases[0].computedStatus, 'PLANNED');
});

test('hard deadlines and stars are explicit ranking signals', () => {
  const state = fixtureState();
  state.workItems.push(
    task('ordinary', 'project-a', 'phase-a'),
    task('deadline', 'project-b', 'phase-b', { scheduledFor: '2026-08-12' }),
    task('starred', 'project-a', 'phase-a', { starred: true, parallelPolicy: 'PARALLEL_ALLOWED' })
  );
  const board = deriveAutonomousBoard(state, { now: NOW });
  const deadline = board.decisions.find((entry) => entry.taskId === 'deadline');
  const starred = board.decisions.find((entry) => entry.taskId === 'starred');
  const ordinary = board.decisions.find((entry) => entry.taskId === 'ordinary');
  assert.ok(deadline.reasonCodes.includes('HARD_DEADLINE'));
  assert.ok(starred.reasonCodes.includes('STARRED'));
  assert.equal(starred.batch, DISPATCH_BATCH.NEXT);
  assert.equal(ordinary.batch, DISPATCH_BATCH.RESERVE);
});

test('dispatch enforces one change task per project unless parallel work is explicitly allowed', () => {
  const state = fixtureState();
  state.workItems.push(
    task('serial-a', 'project-a', 'phase-a', { priority: 'P0', compute: 'low' }),
    task('serial-b', 'project-a', 'phase-a', { priority: 'P1', compute: 'low' }),
    task('parallel', 'project-a', 'phase-a', {
      priority: 'P2',
      compute: 'medium',
      parallelPolicy: 'PARALLEL_ALLOWED'
    })
  );

  const board = deriveAutonomousBoard(state, { now: NOW });
  assert.equal(board.decisions.find((entry) => entry.taskId === 'serial-a').batch, 'NEXT');
  assert.equal(board.decisions.find((entry) => entry.taskId === 'serial-b').batch, 'RESERVE');
  assert.ok(board.decisions.find((entry) => entry.taskId === 'serial-b').reasonCodes.includes('PROJECT_CAPACITY_FULL'));
  assert.equal(board.decisions.find((entry) => entry.taskId === 'parallel').batch, 'NEXT');
});

test('phase and project states are derived from task truth and progress age', () => {
  const state = fixtureState();
  state.workItems.push(
    task('done-a', 'project-a', 'phase-a', { status: 'VERIFIED', updatedAt: '2026-08-10T00:00:00.000Z' }),
    task('done-b', 'project-a', 'phase-a', { status: 'RELEASED', updatedAt: '2026-08-10T01:00:00.000Z' }),
    task('stale', 'project-b', 'phase-b', { status: 'PLANNED', updatedAt: '2026-08-01T00:00:00.000Z' })
  );
  state.completionRecords.push({
    id: 'completion-a',
    taskId: 'done-b',
    outcome: 'COMPLETED',
    completedAt: '2026-08-10T01:00:00.000Z',
    verifiedAt: '2026-08-10T02:00:00.000Z'
  });

  const board = deriveAutonomousBoard(state, { now: NOW });
  const complete = board.projects.find((project) => project.id === 'project-a');
  const stalled = board.projects.find((project) => project.id === 'project-b');

  assert.equal(complete.health, PROJECT_HEALTH.COMPLETE);
  assert.equal(complete.phases[0].computedStatus, 'COMPLETED');
  assert.equal(stalled.health, PROJECT_HEALTH.STALLED);
  assert.equal(board.summary.stalledProjectCount, 1);
});

test('a portfolio with only deferred work is dormant instead of falsely stalled', () => {
  const state = fixtureState();
  state.workItems.push(
    task('verified-progress', 'project-a', 'phase-a', { status: 'VERIFIED' }),
    task('later', 'project-a', 'phase-a', { status: 'DEFERRED' })
  );
  state.completionRecords.push({
    id: 'verified-progress-record',
    taskId: 'verified-progress',
    verifiedAt: '2026-08-11T10:00:00.000Z'
  });

  const project = deriveAutonomousBoard(state, { now: NOW }).projects.find((entry) => entry.id === 'project-a');
  assert.equal(project.health, PROJECT_HEALTH.DORMANT);
  assert.equal(project.currentTaskId, 'verified-progress');
  assert.equal(project.latestVerifiedTaskId, 'verified-progress');
  assert.equal(project.phases[0].currentTaskId, null);
});

test('an empty project is dormant instead of falsely complete', () => {
  const state = fixtureState();
  state.projects.find((entry) => entry.id === 'project-a').currentTaskId = 'cancelled-history';
  const project = deriveAutonomousBoard(state, { now: NOW }).projects.find((entry) => entry.id === 'project-a');
  assert.equal(project.health, PROJECT_HEALTH.DORMANT);
  assert.equal(project.currentTaskId, null);
});

test('risk participates in explainable ordering when other scheduling signals tie', () => {
  const state = fixtureState();
  state.workItems.push(
    task('low-risk', 'project-a', 'phase-a', { riskTier: 'low', priority: 'P1' }),
    task('high-risk', 'project-b', 'phase-b', { riskTier: 'high', priority: 'P1' })
  );

  const decisions = deriveAutonomousBoard(state, {
    now: NOW,
    policy: { executionSlots: { high: 0, medium: 1, low: 0 } }
  }).decisions;
  const highRisk = decisions.find((entry) => entry.taskId === 'high-risk');
  const lowRisk = decisions.find((entry) => entry.taskId === 'low-risk');
  assert.equal(highRisk.batch, DISPATCH_BATCH.NEXT);
  assert.equal(lowRisk.batch, DISPATCH_BATCH.RESERVE);
  assert.ok(highRisk.reasonCodes.includes('RISK_HIGH'));
});

test('review age follows completion time even when later metadata edits changed updatedAt', () => {
  const state = fixtureState();
  state.workItems.push(task('review', 'project-a', 'phase-a', {
    status: 'REVIEW',
    updatedAt: '2026-08-12T11:00:00.000Z'
  }));
  state.completionRecords.push({
    id: 'review-completion',
    taskId: 'review',
    completedAt: '2026-08-10T11:00:00.000Z'
  });

  const board = deriveAutonomousBoard(state, { now: NOW });
  const project = board.projects.find((entry) => entry.id === 'project-a');
  const decision = board.decisions.find((entry) => entry.taskId === 'review');

  assert.equal(project.health, PROJECT_HEALTH.AT_RISK);
  assert.equal(decision.batch, DISPATCH_BATCH.NEXT);
  assert.equal(decision.mode, 'REVIEW');
  assert.ok(decision.reasonCodes.includes('REVIEW_REQUIRED'));
});

test('recent Mock completion cannot hide an overdue real review', () => {
  const state = fixtureState();
  state.workItems.push(task('review', 'project-a', 'phase-a', {
    status: 'REVIEW',
    updatedAt: '2026-08-10T11:00:00.000Z'
  }));
  state.runs.push({ id: 'mock-review-run', workItemId: 'review', kind: 'INTERNAL_MOCK' });
  state.completionRecords.push({
    id: 'mock-review-completion',
    taskId: 'review',
    runId: 'mock-review-run',
    completedAt: '2026-08-12T11:59:00.000Z'
  });

  const project = deriveAutonomousBoard(state, { now: NOW }).projects.find((entry) => entry.id === 'project-a');
  assert.equal(project.health, PROJECT_HEALTH.AT_RISK);
});

test('derivePhaseStatus reports blocked and active phases consistently', () => {
  assert.equal(derivePhaseStatus([{ status: 'BLOCKED' }, { status: 'DEFERRED' }]), 'BLOCKED');
  assert.equal(derivePhaseStatus([{ status: 'DEFERRED' }, { status: 'DEFERRED' }]), 'DEFERRED');
  assert.equal(derivePhaseStatus([{ status: 'VERIFIED' }, { status: 'RUNNING' }]), 'ACTIVE');
});

test('efficiency metrics ignore Mock history and withhold calibration below the sample threshold', () => {
  const state = fixtureState();
  state.workItems.push(task('real-task', 'project-a', 'phase-a', { compute: 'low' }));
  state.runs.push(
    { id: 'run-real', workItemId: 'real-task', kind: 'AGENT', modelRef: 'gpt-real', startedAt: '2026-08-12T10:00:00.000Z' },
    { id: 'run-mock', workItemId: 'real-task', kind: 'INTERNAL_MOCK', modelRef: 'mock', startedAt: '2026-08-12T10:00:00.000Z' }
  );
  state.completionRecords.push(
    {
      id: 'real', taskId: 'real-task', runId: 'run-real', completionMethod: 'AGENT_RUN',
      outcome: 'COMPLETED', startedAt: '2026-08-12T10:00:00.000Z', completedAt: '2026-08-12T11:00:00.000Z', durationMs: 3_600_000
    },
    {
      id: 'mock', taskId: 'real-task', runId: 'run-mock', completionMethod: 'AGENT_RUN',
      outcome: 'COMPLETED', startedAt: '2026-08-12T10:00:00.000Z', completedAt: '2026-08-12T11:00:00.000Z', durationMs: 3_600_000
    }
  );
  state.events.push({
    id: 'restore-real-task',
    type: 'work_item.restored',
    workItemId: 'real-task',
    createdAt: '2026-08-12T11:30:00.000Z'
  });

  const metrics = deriveEfficiencyMetrics(state, { now: NOW });
  assert.equal(metrics.summary.sampleCount, 1);
  assert.equal(metrics.confidence, 'INSUFFICIENT');
  assert.deepEqual(metrics.calibrations, []);
  assert.equal(metrics.summary.reopenCount, 1);
  assert.equal(metrics.summary.reopenRate, 1);
  assert.equal(metrics.summary.observedBusyMs, 3_600_000);
  assert.equal(metrics.groups.projects[0].reopenRate, 1);
  assert.equal(metrics.groups.taskKinds[0].unreportedIntervalCount, 2);
  assert.equal(metrics.unreportedIntervals.length, 2);
  assert.equal(metrics.unreportedIntervals[0].semantics, 'UNKNOWN_NOT_IDLE');
  assert.equal(metrics.summary.unrecordedTimeSemantics, 'UNKNOWN_NOT_IDLE');
});

test('portfolio saturation includes active real runs but not active Mock or time after lease expiry', () => {
  const state = fixtureState();
  state.runs.push(
    {
      id: 'active-real', workItemId: 'active-task', kind: 'AGENT', status: 'RUNNING',
      claimedAt: '2026-08-12T10:00:00.000Z', leaseExpiresAt: '2026-08-12T11:00:00.000Z'
    },
    {
      id: 'active-mock', workItemId: 'mock-task', kind: 'INTERNAL_MOCK', status: 'RUNNING',
      startedAt: '2026-08-12T10:00:00.000Z'
    }
  );

  const metrics = deriveEfficiencyMetrics(state, { now: NOW, windowMs: 4 * 60 * 60 * 1000 });
  assert.equal(metrics.summary.sampleCount, 0);
  assert.equal(metrics.summary.observedBusyMs, 60 * 60 * 1000);
  assert.equal(metrics.summary.observedWindowCoverage, 0.25);
  assert.equal(metrics.summary.observedSlotSaturation, 0.0625);
  assert.equal(metrics.summary.unreportedIntervalCount, 2);
});

test('latest verified progress follows verification time, not the next dispatch candidate', () => {
  const state = fixtureState();
  state.workItems.push(
    task('older-verified', 'project-a', 'phase-a', { status: 'VERIFIED', updatedAt: '2026-08-11T08:00:00.000Z' }),
    task('latest-verified', 'project-a', 'phase-a', { status: 'VERIFIED', updatedAt: '2026-08-11T09:00:00.000Z' }),
    task('next-work', 'project-a', 'phase-a', { status: 'PLANNED', priority: 'P0' })
  );
  state.completionRecords.push(
    { id: 'record-old', taskId: 'older-verified', verifiedAt: '2026-08-11T10:00:00.000Z' },
    { id: 'record-latest', taskId: 'latest-verified', verifiedAt: '2026-08-11T11:00:00.000Z' }
  );

  const project = deriveAutonomousBoard(state, { now: NOW }).projects.find((entry) => entry.id === 'project-a');
  assert.equal(project.currentTaskId, 'next-work');
  assert.equal(project.latestVerifiedTaskId, 'latest-verified');
});

test('latest verified fallback follows schedule order and ignores later metadata edits', () => {
  const state = fixtureState();
  state.workItems.push(
    task('late-in-schedule', 'project-a', 'phase-a', {
      status: 'VERIFIED',
      planning: { phaseOrder: 2, taskOrder: 1 },
      updatedAt: '2026-08-10T00:00:00.000Z'
    }),
    task('recently-edited-old-task', 'project-a', 'phase-a', {
      status: 'VERIFIED',
      planning: { phaseOrder: 1, taskOrder: 1 },
      updatedAt: '2026-08-12T11:59:00.000Z'
    })
  );

  const project = deriveAutonomousBoard(state, { now: NOW }).projects.find((entry) => entry.id === 'project-a');
  assert.equal(project.latestVerifiedTaskId, 'late-in-schedule');
  assert.equal(project.currentTaskId, 'late-in-schedule');
});

test('Mock completion history cannot become latest verified progress or hide a stalled project', () => {
  const state = fixtureState();
  state.workItems.push(
    task('real-verified', 'project-a', 'phase-a', { status: 'VERIFIED' }),
    task('mock-reset-to-planned', 'project-a', 'phase-a', { status: 'PLANNED' })
  );
  state.runs.push({
    id: 'mock-run', workItemId: 'mock-reset-to-planned', kind: 'INTERNAL_MOCK', status: 'SUCCEEDED'
  });
  state.completionRecords.push(
    { id: 'real-record', taskId: 'real-verified', verifiedAt: '2026-08-01T01:00:00.000Z' },
    {
      id: 'mock-record', taskId: 'mock-reset-to-planned', runId: 'mock-run',
      verifiedAt: '2026-08-12T11:59:00.000Z', completedAt: '2026-08-12T11:58:00.000Z'
    }
  );
  state.events.push({
    id: 'mock-progress', type: 'run.started', runId: 'mock-run',
    workItemId: 'mock-reset-to-planned', createdAt: '2026-08-12T11:59:30.000Z'
  });

  const project = deriveAutonomousBoard(state, { now: NOW }).projects.find((entry) => entry.id === 'project-a');
  assert.equal(project.latestVerifiedTaskId, 'real-verified');
  assert.equal(project.lastProgressAt, '2026-08-01T01:00:00.000Z');
  assert.equal(project.health, PROJECT_HEALTH.STALLED);
});

test('five real samples calibrate model, compute and estimate for the same task kind', () => {
  const state = fixtureState();
  for (let index = 0; index < 5; index += 1) {
    const taskId = `history-${index}`;
    const runId = `run-${index}`;
    state.workItems.push(task(taskId, 'project-a', 'phase-a', {
      status: 'VERIFIED',
      compute: 'low',
      recommendation: { compute: 'low', estimateMinutes: 30 }
    }));
    state.runs.push({
      id: runId,
      workItemId: taskId,
      kind: 'AGENT',
      modelRef: 'gpt-history-winner',
      startedAt: `2026-08-11T0${index}:00:00.000Z`,
      finishedAt: `2026-08-11T0${index + 1}:00:00.000Z`
    });
    state.completionRecords.push({
      id: `completion-${index}`,
      taskId,
      runId,
      completionMethod: 'AGENT_RUN',
      outcome: 'COMPLETED',
      modelRef: 'gpt-history-winner',
      startedAt: `2026-08-11T0${index}:00:00.000Z`,
      completedAt: `2026-08-11T0${index + 1}:00:00.000Z`,
      verifiedAt: `2026-08-11T0${index + 1}:05:00.000Z`,
      durationMs: 60 * 60 * 1000
    });
  }
  state.workItems.push(task('future-feature', 'project-b', 'phase-b', {
    status: 'PLANNED',
    compute: 'medium',
    recommendation: { compute: 'medium', estimateMinutes: 30 }
  }));
  state.workItems.push(task('future-high-risk', 'project-b', 'phase-b', {
    status: 'PLANNED',
    riskTier: 'high',
    compute: 'high',
    recommendation: { compute: 'high', estimateMinutes: 30 }
  }));

  const board = deriveAutonomousBoard(state, { now: NOW });
  const decision = board.decisions.find((entry) => entry.taskId === 'future-feature');
  assert.equal(board.efficiency.confidence, 'ENOUGH');
  assert.equal(decision.recommendedModelRef, 'gpt-history-winner');
  assert.equal(decision.compute, 'low');
  assert.equal(decision.estimateMinutes, 60);
  assert.equal(decision.recommendationSource, 'HISTORY_CALIBRATED');
  assert.ok(decision.reasonCodes.includes('HISTORY_CALIBRATED_MODEL'));
  assert.ok(decision.reasonCodes.includes('HISTORY_CALIBRATED_COMPUTE'));
  assert.ok(decision.reasonCodes.includes('HISTORY_CALIBRATED_ESTIMATE'));
  const highRiskDecision = board.decisions.find((entry) => entry.taskId === 'future-high-risk');
  assert.equal(highRiskDecision.recommendedModelRef, null);
  assert.equal(highRiskDecision.compute, 'high');
  assert.equal(highRiskDecision.estimateMinutes, 30);
  assert.equal(highRiskDecision.recommendationSource, 'RULE_DEFAULT');
});

test('five failed samples are enough to measure but never enough to recommend that route', () => {
  const state = fixtureState();
  for (let index = 0; index < 5; index += 1) {
    const taskId = `failed-history-${index}`;
    const runId = `failed-run-${index}`;
    state.workItems.push(task(taskId, 'project-a', 'phase-a', { status: 'BLOCKED', compute: 'low' }));
    state.runs.push({
      id: runId, workItemId: taskId, kind: 'AGENT', modelRef: 'gpt-always-fails',
      startedAt: `2026-08-11T0${index}:00:00.000Z`, finishedAt: `2026-08-11T0${index}:20:00.000Z`
    });
    state.completionRecords.push({
      id: `failed-completion-${index}`, taskId, runId, completionMethod: 'AGENT_RUN',
      outcome: 'FAILED', modelRef: 'gpt-always-fails',
      startedAt: `2026-08-11T0${index}:00:00.000Z`, completedAt: `2026-08-11T0${index}:20:00.000Z`
    });
  }
  state.workItems.push(task('future-after-failures', 'project-b', 'phase-b', {
    recommendation: { compute: 'medium', estimateMinutes: 30 }
  }));

  const board = deriveAutonomousBoard(state, { now: NOW });
  const decision = board.decisions.find((entry) => entry.taskId === 'future-after-failures');
  assert.equal(board.efficiency.confidence, 'ENOUGH');
  assert.equal(decision.recommendedModelRef, null);
  assert.equal(decision.compute, 'medium');
  assert.equal(decision.recommendationSource, 'RULE_DEFAULT');
  assert.equal(board.efficiency.routingCalibrations.some((entry) => (
    ['MODEL_PREFERENCE', 'COMPUTE_PREFERENCE'].includes(entry.kind)
  )), false);
});

function fixtureState() {
  return {
    projects: [
      {
        id: 'project-a',
        name: 'A',
        status: 'ACTIVE',
        strategicValue: 10,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      },
      {
        id: 'project-b',
        name: 'B',
        status: 'ACTIVE',
        strategicValue: 6,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    ],
    phases: [
      { id: 'phase-a', projectId: 'project-a', title: 'A1', rank: 1024, status: 'ACTIVE' },
      { id: 'phase-b', projectId: 'project-b', title: 'B1', rank: 1024, status: 'ACTIVE' }
    ],
    workItems: [],
    runs: [],
    completionRecords: [],
    events: []
  };
}

function task(id, projectId, phaseId, overrides = {}) {
  return {
    id,
    projectId,
    phaseId,
    title: id,
    objective: 'Complete the declared objective',
    acceptanceCriteria: ['Result is independently verifiable'],
    testCommands: [],
    dependsOnTaskIds: [],
    parallelPolicy: 'AUTO',
    status: 'PLANNED',
    riskTier: 'medium',
    starred: false,
    planning: {
      phaseId,
      phase: phaseId,
      phaseOrder: 1,
      taskOrder: 1,
      kind: 'feature',
      priority: 'P1',
      commitment: 'TENTATIVE'
    },
    recommendation: {
      executor: 'codex',
      compute: 'medium',
      estimateMinutes: 30
    },
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 5 },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
    planning: {
      phaseId,
      phase: phaseId,
      phaseOrder: 1,
      taskOrder: 1,
      kind: 'feature',
      priority: overrides.priority ?? 'P1',
      commitment: 'TENTATIVE',
      ...(overrides.planning ?? {})
    },
    recommendation: {
      executor: 'codex',
      compute: overrides.compute ?? 'medium',
      estimateMinutes: 30,
      ...(overrides.recommendation ?? {})
    }
  };
}

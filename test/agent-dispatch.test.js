import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };

test('three concurrent Agents atomically claim different NEXT tasks', async (t) => {
  const { service } = await fixtureService(t, {
    projects: [project('project-a'), project('project-b'), project('project-c')],
    phases: [phase('phase-a', 'project-a'), phase('phase-b', 'project-b'), phase('phase-c', 'project-c')],
    workItems: [
      task('task-a', 'project-a', 'phase-a', 'low'),
      task('task-b', 'project-b', 'phase-b', 'low'),
      task('task-c', 'project-c', 'phase-c', 'medium')
    ]
  });

  const claims = await Promise.all(['a', 'b', 'c'].map((agentId) => service.claimNextTask({
    agentId,
    modelRef: `model-${agentId}`,
    idempotencyKey: `claim-${agentId}`,
    claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: agentId, idempotencyKey: `claim-${agentId}` })));

  assert.equal(new Set(claims.map((claim) => claim.task?.id)).size, 3);
  assert.equal(claims.every((claim) => claim.run?.status === 'RUNNING'), true);
  assert.equal(claims.every((claim) => claim.task?.status === 'RUNNING'), true);
});

test('claim lease is max(30 minutes, estimate × 2), can extend, and safely expires', async (t) => {
  const { service, file } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'low', { estimateMinutes: 20 })]
  });
  const claim = await service.claimNextTask({
    agentId: 'agent-a', modelRef: 'gpt-test', claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'claim-a' });
  assert.equal(claim.lease.leaseExpiresAt, '2026-08-12T12:40:00.000Z');

  const extended = await service.extendTaskLease(claim.run.id, {
    agentId: 'agent-a', extensionMinutes: 20, extendedAt: '2026-08-12T12:10:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'extend-a' });
  assert.equal(extended.lease.leaseExpiresAt, '2026-08-12T13:00:00.000Z');

  await service.rebalancePortfolio({ now: '2026-08-12T13:01:00.000Z' }, {
    actor: 'scheduler', idempotencyKey: 'rebalance-expired'
  });
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.workItems.find((entry) => entry.id === 'task-a').status, 'READY');
  assert.equal(state.workItems.find((entry) => entry.id === 'task-a').currentRunId, null);
  assert.equal(state.runs.find((entry) => entry.id === claim.run.id).status, 'CANCELLED');
  assert.equal(state.runs.find((entry) => entry.id === claim.run.id).error, null);
  assert.equal(state.events.some((entry) => entry.type === 'run.lease_expired'), true);

  const replacement = await service.claimNextTask({
    agentId: 'agent-b', modelRef: 'gpt-replacement', claimedAt: '2026-08-12T13:01:30.000Z'
  }, { actor: 'agent-b', idempotencyKey: 'claim-b' });
  assert.equal(replacement.task.id, 'task-a');
  assert.notEqual(replacement.run.id, claim.run.id);

  await assert.rejects(() => service.submitCompletion('task-a', {
    runId: claim.run.id,
    agentId: 'agent-a',
    outcome: 'COMPLETED',
    resultSummary: 'Late completion',
    completedAt: '2026-08-12T13:02:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'late-result' }), /expired|running/i);
  const current = JSON.parse(await readFile(file, 'utf8')).workItems.find((entry) => entry.id === 'task-a');
  assert.equal(current.currentRunId, replacement.run.id);
  assert.equal(current.status, 'RUNNING');
});

test('read APIs hide an expired execution lease while preserving stored audit references', async (t) => {
  const expiredTask = task('task-expired', 'project-a', 'phase-a', 'low', {
    status: 'RUNNING',
    currentRunId: 'run-expired'
  });
  const { service } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [expiredTask],
    runs: [{
      id: 'run-expired', workItemId: expiredTask.id, kind: 'AGENT', status: 'RUNNING',
      agentId: 'old-agent', modelRef: 'old-model', claimedAt: '2000-01-01T00:00:00.000Z',
      leaseExpiresAt: '2000-01-01T01:00:00.000Z'
    }]
  });

  const listed = (await service.listWorkItems('project-a'))[0];
  assert.equal(listed.status, 'READY');
  assert.equal(listed.storedStatus, 'RUNNING');
  assert.equal(listed.currentRunId, null);
  assert.equal(listed.storedCurrentRunId, 'run-expired');

  const schedule = await service.getSchedule('project-a');
  const scheduled = schedule.phases[0].tasks[0];
  assert.equal(schedule.phases[0].computedStatus, 'PLANNED');
  assert.equal(scheduled.status, 'READY');
  assert.equal(scheduled.currentRun, null);
  assert.ok(schedule.phases[0].parallelTaskIds.includes(expiredTask.id));

  const details = await service.getTaskDetails(expiredTask.id);
  assert.equal(details.task.status, 'READY');
  assert.equal(details.run, null);
  assert.equal(details.storedRun.id, 'run-expired');
});

test('history-calibrated estimate is persisted and determines the claim lease', async (t) => {
  const historyTasks = [];
  const historyRuns = [];
  const historyCompletions = [];
  for (let index = 0; index < 5; index += 1) {
    const taskId = `history-${index}`;
    const runId = `history-run-${index}`;
    historyTasks.push(task(taskId, 'project-history', 'phase-history', 'low', { status: 'VERIFIED' }));
    historyRuns.push({
      id: runId,
      workItemId: taskId,
      kind: 'AGENT',
      modelRef: 'gpt-history-winner',
      startedAt: `2026-08-11T0${index}:00:00.000Z`,
      finishedAt: `2026-08-11T0${index + 1}:00:00.000Z`
    });
    historyCompletions.push({
      id: `history-completion-${index}`,
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
  const { service, file } = await fixtureService(t, {
    projects: [project('project-history'), project('project-future')],
    phases: [phase('phase-history', 'project-history'), phase('phase-future', 'project-future')],
    workItems: [
      ...historyTasks,
      task('future-feature', 'project-future', 'phase-future', 'medium', { estimateMinutes: 30 })
    ],
    runs: historyRuns,
    completionRecords: historyCompletions
  });

  await service.rebalancePortfolio({ now: '2026-08-12T12:00:00.000Z' }, {
    actor: 'scheduler', idempotencyKey: 'calibrated-rebalance'
  });
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  const persistedDecision = persisted.workItems.find((entry) => entry.id === 'future-feature').decision;
  assert.equal(persistedDecision.recommendedModelRef, 'gpt-history-winner');
  assert.equal(persistedDecision.compute, 'low');
  assert.equal(persistedDecision.estimateMinutes, 60);
  assert.equal(persistedDecision.recommendationSource, 'HISTORY_CALIBRATED');

  const claim = await service.claimNextTask({
    agentId: 'agent-a', modelRef: 'gpt-history-winner', claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'calibrated-claim' });
  assert.equal(claim.task.id, 'future-feature');
  assert.equal(claim.decision.estimateMinutes, 60);
  assert.equal(claim.lease.leaseExpiresAt, '2026-08-12T14:00:00.000Z');
});

test('claim filters capability, compute, risk and project in one atomic selection', async (t) => {
  const matching = task('matching', 'project-b', 'phase-b', 'low', {
    riskTier: 'low',
    recommendation: {
      executor: 'luna_worker', capability: 'code-repair', compute: 'low', reasoningEffort: 'medium', estimateMinutes: 20, policyVersion: 'risk-tier-v1'
    }
  });
  const { service } = await fixtureService(t, {
    projects: [project('project-a'), project('project-b')],
    phases: [phase('phase-a', 'project-a'), phase('phase-b', 'project-b')],
    workItems: [
      task('wrong-compute', 'project-a', 'phase-a', 'high'),
      matching
    ]
  });

  const claim = await service.claimNextTask({
    agentId: 'repair-agent',
    modelRef: 'gpt-repair',
    computeClasses: ['low'],
    riskTiers: ['low'],
    capabilities: ['code-repair'],
    projectIds: ['project-b'],
    claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'repair-agent', idempotencyKey: 'filtered-claim' });
  assert.equal(claim.task.id, 'matching');
  assert.equal(claim.decision.compute, 'low');
});

test('lease extensions never exceed eight hours from the original claim', async (t) => {
  const { service } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'low')]
  });
  const claim = await service.claimNextTask({
    agentId: 'agent-a', modelRef: 'gpt-test', claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'bounded-claim' });
  const extended = await service.extendTaskLease(claim.run.id, {
    agentId: 'agent-a', extensionMinutes: 480, extendedAt: '2026-08-12T12:10:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'bounded-extend' });
  assert.equal(extended.lease.leaseExpiresAt, '2026-08-12T20:00:00.000Z');
  const replay = await service.extendTaskLease(claim.run.id, {
    agentId: 'agent-a', extensionMinutes: 480, extendedAt: '2026-08-12T12:10:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'bounded-extend' });
  assert.equal(replay.lease.leaseExpiresAt, extended.lease.leaseExpiresAt);
  await assert.rejects(() => service.extendTaskLease(claim.run.id, {
    agentId: 'agent-a', extensionMinutes: 1, extendedAt: '2026-08-12T12:11:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'bounded-extend-again' }), /8 hour limit/i);
});

test('lease extension retries do not create duplicate audit events', async (t) => {
  const { service, file } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'low')]
  });
  const claim = await service.claimNextTask({
    agentId: 'agent-a', modelRef: 'gpt-test', claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'agent-a', idempotencyKey: 'idempotent-lease-claim' });
  const input = { agentId: 'agent-a', extensionMinutes: 15, extendedAt: '2026-08-12T12:10:00.000Z' };
  const options = { actor: 'agent-a', idempotencyKey: 'idempotent-lease-extension' };
  const first = await service.extendTaskLease(claim.run.id, input, options);
  const second = await service.extendTaskLease(claim.run.id, input, options);
  assert.equal(second.lease.leaseExpiresAt, first.lease.leaseExpiresAt);
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.events.filter((event) => event.type === 'run.lease_extended').length, 1);
});

test('remote Agent mutations use the server clock instead of reported claim and completion times', async (t) => {
  const { service } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'low')]
  });
  const beforeClaimMs = Date.now();
  const claim = await service.claimNextTask({
    agentId: 'agent-a',
    modelRef: 'gpt-test',
    claimedAt: '2000-01-01T00:00:00.000Z'
  }, {
    actor: 'agent-a',
    idempotencyKey: 'server-clock-claim',
    authoritativeAgentClock: true
  });
  assert.ok(Date.parse(claim.lease.claimedAt) >= beforeClaimMs);

  const beforeCompletionMs = Date.now();
  const completed = await service.submitCompletion('task-a', {
    runId: claim.run.id,
    agentId: 'agent-a',
    outcome: 'COMPLETED',
    resultSummary: 'Server-owned timing completed.',
    startedAt: '2000-01-01T00:00:00.000Z',
    completedAt: '2000-01-01T00:01:00.000Z'
  }, {
    actor: 'agent-a',
    idempotencyKey: 'server-clock-completion',
    authoritativeAgentClock: true
  });
  assert.ok(Date.parse(completed.completionRecord.completedAt) >= beforeCompletionMs);
  assert.equal(completed.completionRecord.startedAt, claim.run.startedAt);
});

test('defer and resume preserve before/after audit, reason, policy and reversal metadata', async (t) => {
  const { service, file } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'low')]
  });
  const deferred = await service.updateWorkItem('task-a', {
    expectedScheduleVersion: 0,
    status: 'DEFERRED',
    reason: 'Hold for a low-compute window.'
  }, { actor: 'scheduler', idempotencyKey: 'defer-a' });
  assert.equal(deferred.status, 'DEFERRED');
  const deferredBoard = await service.getDispatchBoard({ now: '2026-08-12T12:00:00.000Z' });
  const deferChange = deferredBoard.recentChanges.find((entry) => entry.type === 'work_item.deferred');
  assert.equal(deferChange.reversible, true);
  assert.equal(deferChange.reversalAction, 'RESUME');
  assert.equal(deferChange.actor, 'scheduler');
  assert.equal(deferChange.effect.status, 'DEFERRED');

  const resumed = await service.updateWorkItem('task-a', {
    expectedScheduleVersion: 1,
    status: 'PLANNED',
    reason: 'Capacity is available again.'
  }, { actor: 'scheduler', idempotencyKey: 'resume-a' });
  assert.equal(resumed.status, 'PLANNED');
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  const changes = persisted.events.filter((entry) => entry.type === 'work_item.updated');
  assert.deepEqual(changes.map((entry) => [entry.metadata.before.status, entry.metadata.after.status]), [
    ['PLANNED', 'DEFERRED'],
    ['DEFERRED', 'PLANNED']
  ]);
  assert.equal(changes.every((entry) => entry.metadata.policyVersion === 'autonomous-board-v1'), true);
  assert.deepEqual(changes.map((entry) => entry.metadata.actor), ['scheduler', 'scheduler']);
  assert.deepEqual(changes.map((entry) => entry.metadata.reason), [
    'Hold for a low-compute window.',
    'Capacity is available again.'
  ]);
});

test('dashboard, project list and schedule expose the same derived project and phase truth', async (t) => {
  const { service } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [
      task('verified', 'project-a', 'phase-a', 'low', { status: 'VERIFIED' }),
      task('next', 'project-a', 'phase-a', 'low', { planning: { phaseId: 'phase-a', phase: 'phase-a', phaseOrder: 1, taskOrder: 2, kind: 'feature', priority: 'P0', commitment: 'COMMITTED' } })
    ],
    completionRecords: [{
      id: 'verified-record',
      taskId: 'verified',
      completionMethod: 'IMPORTED_HISTORY',
      outcome: 'COMPLETED',
      completedAt: '2026-08-12T10:00:00.000Z',
      verifiedAt: '2026-08-12T10:05:00.000Z'
    }]
  });

  const [dashboard, projects, schedule] = await Promise.all([
    service.dashboard(),
    service.listProjects(),
    service.getSchedule('project-a')
  ]);
  const dashboardProject = dashboard.projects[0];
  const listedProject = projects[0];
  assert.equal(dashboardProject.health, listedProject.health);
  assert.equal(schedule.project.health, listedProject.health);
  assert.equal(dashboardProject.currentTaskId, listedProject.currentTaskId);
  assert.equal(schedule.project.currentTaskId, listedProject.currentTaskId);
  assert.equal(dashboardProject.latestVerifiedTaskId, 'verified');
  assert.equal(schedule.project.latestVerifiedTaskId, 'verified');
  assert.equal(dashboardProject.phases[0].computedStatus, schedule.phases[0].computedStatus);
  assert.equal(schedule.phases[0].computedStatus, 'PLANNED');
  assert.equal(dashboardProject.lastProgressAt, '2026-08-12T10:05:00.000Z');
});

test('cancelled tasks restore with both audit events preserved', async (t) => {
  const { service, file } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'low')]
  });
  await service.cancelWorkItem('task-a', {
    expectedScheduleVersion: 0,
    reason: 'No longer scheduled'
  }, { actor: 'owner', idempotencyKey: 'cancel-a' });
  const restored = await service.restoreWorkItem('task-a', {
    expectedScheduleVersion: 1,
    reason: 'Priority returned'
  }, { actor: 'owner', idempotencyKey: 'restore-a' });
  assert.equal(restored.status, 'PLANNED');
  assert.equal(restored.cancelReason, 'No longer scheduled');
  assert.equal(restored.restoreReason, 'Priority returned');
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.events.some((entry) => entry.type === 'work_item.cancelled'), true);
  assert.equal(state.events.some((entry) => entry.type === 'work_item.restored'), true);
});

test('rebalance persists explainable decision before and after values without thought traces', async (t) => {
  const { service, file } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'high')]
  });
  const board = await service.rebalancePortfolio({ now: '2026-08-12T12:00:00.000Z' }, {
    actor: 'scheduler', idempotencyKey: 'audit-rebalance'
  });
  const state = JSON.parse(await readFile(file, 'utf8'));
  const decisionEvent = state.events.find((entry) => entry.type === 'dispatch.decision_changed');
  assert.equal(decisionEvent.workItemId, 'task-a');
  assert.equal(decisionEvent.metadata.before, null);
  assert.equal(decisionEvent.metadata.after.batch, 'NEXT');
  assert.deepEqual(decisionEvent.metadata.after.reasonCodes, board.decisions[0].reasonCodes);
  assert.equal(decisionEvent.metadata.after.compute, board.decisions[0].compute);
  assert.equal(decisionEvent.metadata.after.estimateMinutes, board.decisions[0].estimateMinutes);
  assert.equal(decisionEvent.metadata.after.recommendationSource, board.decisions[0].recommendationSource);
  assert.equal('reasoning' in decisionEvent.metadata, false);
  assert.equal('thought' in decisionEvent.metadata, false);
  assert.equal(board.recentChanges.some((entry) => entry.id === decisionEvent.id), true);
});

test('rebalance clears stale terminal decisions and leaves archived phases untouched', async (t) => {
  const archived = project('project-archived');
  archived.status = 'ARCHIVED';
  const terminalTask = task('task-terminal', 'project-active', 'phase-active', 'low', {
    status: 'VERIFIED',
    dispatch: { batch: 'NOW', rank: 1 },
    decision: {
      batch: 'NOW', rank: 1, reasonCodes: ['READY'], compute: 'low',
      policyVersion: 'autonomous-board-v1', decidedAt: '2026-08-12T10:00:00.000Z'
    }
  });
  const archivedPhase = phase('phase-archived', 'project-archived');
  archivedPhase.status = 'COMPLETED';
  const { service, file } = await fixtureService(t, {
    projects: [project('project-active'), archived],
    phases: [phase('phase-active', 'project-active'), archivedPhase],
    workItems: [
      terminalTask,
      task('archived-task', 'project-archived', 'phase-archived', 'low', { status: 'VERIFIED' })
    ]
  });

  await service.rebalancePortfolio({ now: '2026-08-12T12:00:00.000Z' }, {
    actor: 'scheduler', idempotencyKey: 'clear-stale-decision'
  });
  const visible = await service.getWorkItem('task-terminal');
  assert.equal(visible.dispatch, null);
  assert.equal(visible.decision, null);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.workItems.find((entry) => entry.id === 'task-terminal').decision, null);
  assert.equal(persisted.phases.find((entry) => entry.id === 'phase-archived').status, 'COMPLETED');
  const clearEvent = persisted.events.find((event) => (
    event.type === 'dispatch.decision_changed' && event.workItemId === 'task-terminal'
  ));
  assert.equal(clearEvent.metadata.before.batch, 'NOW');
  assert.equal(clearEvent.metadata.after, null);
});

test('review claim rejects the execution Agent and accepts an independent reviewer', async (t) => {
  const completion = {
    id: 'completion-a',
    taskId: 'task-a',
    workItemId: 'task-a',
    runId: 'run-execution',
    completionMethod: 'AGENT_RUN',
    outcome: 'COMPLETED',
    agentId: 'executor-a',
    submittedBy: 'executor-a',
    completedAt: '2026-08-12T11:00:00.000Z',
    testEvidenceIds: [],
    reviewEvidenceIds: [],
    resultSummary: 'Implemented'
  };
  const { service } = await fixtureService(t, {
    projects: [project('project-a')],
    phases: [phase('phase-a', 'project-a')],
    workItems: [task('task-a', 'project-a', 'phase-a', 'high', { status: 'REVIEW', currentRunId: 'run-execution' })],
    runs: [{
      id: 'run-execution', workItemId: 'task-a', kind: 'AGENT', status: 'SUCCEEDED',
      agentId: 'executor-a', modelRef: 'gpt-executor', startedAt: '2026-08-12T10:00:00.000Z',
      finishedAt: '2026-08-12T11:00:00.000Z'
    }],
    completionRecords: [completion]
  });

  const selfReview = await service.claimNextTask({
    mode: 'REVIEW', agentId: 'executor-a', modelRef: 'gpt-review', claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'executor-a', idempotencyKey: 'review-self' });
  assert.equal(selfReview.task, null);

  const review = await service.claimNextTask({
    mode: 'REVIEW', agentId: 'reviewer-b', modelRef: 'gpt-review', claimedAt: '2026-08-12T12:00:00.000Z'
  }, { actor: 'reviewer-b', idempotencyKey: 'review-independent' });
  assert.equal(review.task.id, 'task-a');
  assert.equal(review.task.status, 'REVIEW');
  assert.equal(review.run.kind, 'AGENT_REVIEW');
});

test('three execution Agents report concurrently and an independent Agent verifies every result', async (t) => {
  const { service } = await fixtureService(t, {
    projects: [project('project-a'), project('project-b'), project('project-c')],
    phases: [phase('phase-a', 'project-a'), phase('phase-b', 'project-b'), phase('phase-c', 'project-c')],
    workItems: [
      task('task-a', 'project-a', 'phase-a', 'low'),
      task('task-b', 'project-b', 'phase-b', 'low'),
      task('task-c', 'project-c', 'phase-c', 'medium')
    ]
  });
  const claimedAt = new Date().toISOString();
  const claims = await Promise.all(['a', 'b', 'c'].map((agentId) => service.claimNextTask({
    agentId: `executor-${agentId}`,
    modelRef: `model-${agentId}`,
    claimedAt
  }, { actor: `executor-${agentId}`, idempotencyKey: `e2e-claim-${agentId}` })));

  const completions = await Promise.all(claims.map((claim, index) => service.submitCompletion(claim.task.id, {
    runId: claim.run.id,
    agentId: claim.run.agentId,
    outcome: 'COMPLETED',
    resultSummary: `Execution ${index + 1} completed`,
    completedAt: new Date().toISOString(),
    evidence: [{
      type: 'TEST_COMMAND',
      summary: `Focused verification ${index + 1} passed`,
      metadata: { command: `focused-${index + 1}`, exitCode: 0 }
    }]
  }, { actor: claim.run.agentId, idempotencyKey: `e2e-complete-${index}` })));
  assert.equal(completions.every((result) => result.task.status === 'REVIEW'), true);
  assert.equal(completions.every((result) => ['NEXT', 'RESERVE'].includes(result.task.dispatch?.batch)), true);

  const verifiedTaskIds = [];
  for (let index = 0; index < completions.length; index += 1) {
    const review = await service.claimNextTask({
      mode: 'REVIEW',
      agentId: 'independent-reviewer',
      modelRef: 'review-model',
      claimedAt: new Date().toISOString()
    }, { actor: 'independent-reviewer', idempotencyKey: `e2e-review-claim-${index}` });
    assert.ok(review.task);
    const completion = completions.find((entry) => entry.task.id === review.task.id);
    const verified = await service.verifyTask(review.task.id, {
      completionRecordId: completion.completionRecord.id,
      agentId: 'independent-reviewer',
      verificationMethod: 'DETERMINISTIC_TEST',
      summary: 'Independent reviewer confirmed the passing focused evidence.',
      evidenceIds: completion.evidence.map((entry) => entry.id)
    }, { actor: 'independent-reviewer', idempotencyKey: `e2e-review-verify-${index}` });
    assert.equal(verified.task.dispatch, null);
    assert.equal(verified.task.decision, null);
    verifiedTaskIds.push(verified.task.id);
  }
  assert.equal(new Set(verifiedTaskIds).size, 3);
  assert.equal((await service.listWorkItems()).every((entry) => entry.status === 'VERIFIED'), true);
});

async function fixtureService(t, overrides) {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-dispatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  await writeFile(file, JSON.stringify({
    schemaVersion: 7,
    projects: [], phases: [], workItems: [], runs: [], evidence: [], completionRecords: [],
    bootstrapReceipts: [], migrationConflicts: [], migrationSnapshots: [], scanProposals: [],
    subscriptionAccounts: [], subscriptionLatestSnapshots: [], subscriptionHourlySnapshots: [],
    subscriptionCollectors: [], events: [],
    ...overrides
  }));
  const service = new LifelineService({ store: new JsonStore(file), logger: silentLogger });
  await service.start();
  return { service, file };
}

function project(id) {
  return {
    id, name: id, status: 'ACTIVE', strategicValue: 8, scheduleVersion: 0,
    createdAt: '2026-08-12T09:00:00.000Z', updatedAt: '2026-08-12T09:00:00.000Z'
  };
}

function phase(id, projectId) {
  return { id, projectId, title: id, goal: '', rank: 1024, phaseOrder: 1, status: 'ACTIVE' };
}

function task(id, projectId, phaseId, compute, overrides = {}) {
  return {
    id, projectId, phaseId, title: id, objective: 'Complete this autonomous task safely',
    nonGoals: [], acceptanceCriteria: ['Focused verification passes'], testCommands: [],
    issue: null, starred: false, scheduledFor: null, dependsOnTaskIds: [], parallelPolicy: 'AUTO',
    riskTier: 'medium', weight: 1, resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 5 },
    planning: { phaseId, phase: phaseId, phaseOrder: 1, taskOrder: 1, kind: 'feature', priority: 'P0', commitment: 'COMMITTED' },
    recommendation: { executor: 'codex', capability: 'agentic-coding', compute, reasoningEffort: 'medium', estimateMinutes: overrides.estimateMinutes ?? 30, policyVersion: 'risk-tier-v1' },
    status: 'PLANNED', currentRunId: null,
    createdAt: '2026-08-12T09:00:00.000Z', updatedAt: '2026-08-12T09:00:00.000Z',
    ...overrides
  };
}

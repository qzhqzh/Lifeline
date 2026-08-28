import { WORK_ITEM_STATUS, executionContractViolations } from './domain.js';

export const PROJECT_HEALTH = Object.freeze({
  ON_TRACK: 'ON_TRACK',
  AT_RISK: 'AT_RISK',
  BLOCKED: 'BLOCKED',
  STALLED: 'STALLED',
  DORMANT: 'DORMANT',
  COMPLETE: 'COMPLETE'
});

export const DISPATCH_BATCH = Object.freeze({
  NOW: 'NOW',
  NEXT: 'NEXT',
  RESERVE: 'RESERVE',
  BACKLOG: 'BACKLOG'
});

export const DISPATCH_POLICY_VERSION = 'autonomous-board-v1';

export const DEFAULT_DISPATCH_POLICY = Object.freeze({
  executionSlots: Object.freeze({ high: 1, medium: 1, low: 2 }),
  reviewSlots: 1,
  maxConcurrentChangesPerProject: 1,
  reviewRiskAfterMs: 24 * 60 * 60 * 1000,
  stalledAfterMs: 72 * 60 * 60 * 1000
});

const CALIBRATION_MIN_SAMPLES = 5;
const EFFICIENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set([
  WORK_ITEM_STATUS.VERIFIED,
  WORK_ITEM_STATUS.RELEASED,
  WORK_ITEM_STATUS.ARCHIVED,
  WORK_ITEM_STATUS.CANCELLED
]);

const DEPENDENCY_COMPLETE_STATUSES = new Set([
  WORK_ITEM_STATUS.RECURRING,
  WORK_ITEM_STATUS.VERIFIED,
  WORK_ITEM_STATUS.RELEASED,
  WORK_ITEM_STATUS.ARCHIVED
]);

const EXECUTION_CANDIDATE_STATUSES = new Set([
  WORK_ITEM_STATUS.PLANNED,
  WORK_ITEM_STATUS.READY
]);

const ACTIVE_EXECUTION_STATUSES = new Set([
  WORK_ITEM_STATUS.QUEUED,
  WORK_ITEM_STATUS.RUNNING
]);

const REORDERABLE_STATUSES = new Set([
  WORK_ITEM_STATUS.DISCOVERED,
  WORK_ITEM_STATUS.TRIAGED,
  WORK_ITEM_STATUS.PLANNED,
  WORK_ITEM_STATUS.READY,
  WORK_ITEM_STATUS.BLOCKED,
  WORK_ITEM_STATUS.DEFERRED
]);

const REAL_PROGRESS_EVENT_TYPES = new Set([
  'run.started',
  'run.reported',
  'completion.submitted',
  'run.blocked',
  'run.failed',
  'work_item.verified',
  'work_item.cycle_verified'
]);

/**
 * Derive the complete autonomous portfolio view without mutating stored data.
 * This is the single policy boundary shared by REST, MCP and the browser UI.
 */
export function deriveAutonomousBoard(state, options = {}) {
  const now = normalizeNow(options.now);
  const nowMs = Date.parse(now);
  const policy = normalizePolicy(options.policy);
  const efficiency = deriveEfficiencyMetrics(state, { now, policy });
  const projects = (state.projects ?? []).filter((project) => project.status !== 'ARCHIVED');
  const activeProjectIds = new Set(projects.map((project) => project.id));
  const tasks = (state.workItems ?? []).filter((task) => (
    activeProjectIds.has(task.projectId) && task.status !== WORK_ITEM_STATUS.CANCELLED
  ));
  const taskById = new Map((state.workItems ?? []).map((task) => [task.id, task]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const phaseById = new Map((state.phases ?? []).map((phase) => [phase.id, phase]));
  const runById = new Map((state.runs ?? []).map((run) => [run.id, run]));
  const projectLastProgress = new Map(projects.map((project) => [
    project.id,
    lastProjectProgressAt(state, project.id)
  ]));
  const reviewEnteredAtByTaskId = latestCompletionTimeByTask(state);

  const taskFacts = tasks.map((task) => taskDispatchFacts({
    task,
    taskById,
    project: projectById.get(task.projectId),
    run: task.currentRunId ? runById.get(task.currentRunId) : null,
    efficiency,
    now,
    nowMs
  }));
  const factsByTaskId = new Map(taskFacts.map((facts) => [facts.task.id, facts]));
  const effectiveTasks = taskFacts.map((facts) => facts.task);

  const nowEntries = taskFacts
    .filter((facts) => facts.active)
    .sort(compareDispatchFacts)
    .map((facts, index) => dispatchEntry(facts, DISPATCH_BATCH.NOW, index + 1, now));

  const usedExecutionSlots = { high: 0, medium: 0, low: 0 };
  const activeChangesByProject = new Map();
  let usedReviewSlots = 0;
  for (const facts of taskFacts.filter((entry) => entry.active)) {
    if (facts.mode === 'REVIEW') {
      usedReviewSlots += 1;
      continue;
    }
    usedExecutionSlots[facts.compute] += 1;
    activeChangesByProject.set(
      facts.task.projectId,
      (activeChangesByProject.get(facts.task.projectId) ?? 0) + 1
    );
  }

  const availableExecutionSlots = Object.fromEntries(
    Object.entries(policy.executionSlots).map(([compute, total]) => [
      compute,
      Math.max(0, total - usedExecutionSlots[compute])
    ])
  );
  let availableReviewSlots = Math.max(0, policy.reviewSlots - usedReviewSlots);

  const candidates = taskFacts.filter((facts) => facts.eligible).sort(compareDispatchFacts);
  const nextEntries = [];
  const reserveEntries = [];
  for (const facts of candidates) {
    if (facts.mode === 'REVIEW') {
      if (availableReviewSlots > 0) {
        availableReviewSlots -= 1;
        nextEntries.push(dispatchEntry(facts, DISPATCH_BATCH.NEXT, nextEntries.length + 1, now));
      } else {
        reserveEntries.push(dispatchEntry(
          withReason(facts, 'REVIEW_CAPACITY_FULL'),
          DISPATCH_BATCH.RESERVE,
          reserveEntries.length + 1,
          now
        ));
      }
      continue;
    }

    const activeInProject = activeChangesByProject.get(facts.task.projectId) ?? 0;
    const projectAtCapacity = activeInProject >= policy.maxConcurrentChangesPerProject
      && facts.task.parallelPolicy !== 'PARALLEL_ALLOWED';
    if (projectAtCapacity) {
      reserveEntries.push(dispatchEntry(
        withReason(facts, 'PROJECT_CAPACITY_FULL'),
        DISPATCH_BATCH.RESERVE,
        reserveEntries.length + 1,
        now
      ));
      continue;
    }
    if (availableExecutionSlots[facts.compute] <= 0) {
      reserveEntries.push(dispatchEntry(
        withReason(facts, `${facts.compute.toUpperCase()}_COMPUTE_CAPACITY_FULL`),
        DISPATCH_BATCH.RESERVE,
        reserveEntries.length + 1,
        now
      ));
      continue;
    }
    availableExecutionSlots[facts.compute] -= 1;
    activeChangesByProject.set(facts.task.projectId, activeInProject + 1);
    nextEntries.push(dispatchEntry(facts, DISPATCH_BATCH.NEXT, nextEntries.length + 1, now));
  }

  const scheduledTaskIds = new Set([
    ...nowEntries,
    ...nextEntries,
    ...reserveEntries
  ].map((entry) => entry.taskId));
  const backlogEntries = taskFacts
    .filter((facts) => !scheduledTaskIds.has(facts.task.id) && !isTerminalTask(facts.task))
    .sort(compareDispatchFacts)
    .map((facts, index) => dispatchEntry(facts, DISPATCH_BATCH.BACKLOG, index + 1, now));

  const decisions = [...nowEntries, ...nextEntries, ...reserveEntries, ...backlogEntries];
  const decisionByTaskId = new Map(decisions.map((entry) => [entry.taskId, entry]));
  const projectViews = projects.map((project) => {
    const projectTasks = effectiveTasks.filter((task) => task.projectId === project.id);
    const lastProgressAt = projectLastProgress.get(project.id);
    const latestVerifiedTask = latestVerifiedTaskForProject(state, projectTasks);
    const health = deriveProjectHealth({
      project,
      tasks: projectTasks,
      factsByTaskId,
      lastProgressAt,
      reviewEnteredAtByTaskId,
      nowMs,
      policy
    });
    const phases = (state.phases ?? [])
      .filter((phase) => phase.projectId === project.id && phase.status !== 'CANCELLED')
      .sort(comparePhases)
      .map((phase) => {
        const phaseTasks = projectTasks.filter((task) => taskPhaseId(task) === phase.id);
        return {
          ...phase,
          computedStatus: derivePhaseStatus(phaseTasks),
          taskCount: phaseTasks.length,
          currentTaskId: currentTaskForPhase(phaseTasks, decisionByTaskId)?.id ?? null
        };
      });
    return {
      ...project,
      health,
      lastProgressAt,
      computedStatus: health === PROJECT_HEALTH.COMPLETE ? 'COMPLETE' : 'ACTIVE',
      currentTaskId: currentTaskForProject(projectTasks, decisionByTaskId)?.id ?? latestVerifiedTask?.id ?? null,
      latestVerifiedTaskId: latestVerifiedTask?.id ?? null,
      phases,
      dispatch: summarizeProjectDispatch(project.id, decisions)
    };
  }).sort(compareProjects);

  const stalledProjects = projectViews.filter((project) => project.health === PROJECT_HEALTH.STALLED);
  const recommendations = {
    running: nowEntries.find((entry) => entry.mode === 'EXECUTION') ?? null,
    highCompute: nextEntries.find((entry) => entry.compute === 'high' && entry.mode === 'EXECUTION') ?? null,
    lowCompute: nextEntries.find((entry) => entry.compute === 'low' && entry.mode === 'EXECUTION') ?? null,
    review: nextEntries.find((entry) => entry.mode === 'REVIEW') ?? null
  };

  return {
    generatedAt: now,
    policy: {
      version: DISPATCH_POLICY_VERSION,
      ...policy
    },
    summary: {
      projectCount: projects.length,
      runningCount: nowEntries.filter((entry) => entry.mode === 'EXECUTION').length,
      reviewCount: taskFacts.filter((facts) => facts.task.status === WORK_ITEM_STATUS.REVIEW).length,
      nextCount: nextEntries.length,
      stalledProjectCount: stalledProjects.length,
      freeSlots: {
        execution: availableExecutionSlots,
        review: availableReviewSlots
      }
    },
    recommendations,
    projects: projectViews,
    lanes: {
      now: nowEntries,
      next: nextEntries,
      reserve: reserveEntries,
      backlog: backlogEntries
    },
    decisions,
    recentChanges: deriveRecentScheduleChanges(state),
    efficiency
  };
}

export function deriveEfficiencyMetrics(state, options = {}) {
  const now = normalizeNow(options.now);
  const nowMs = Date.parse(now);
  const windowMs = positiveNumber(options.windowMs, EFFICIENCY_WINDOW_MS);
  const startedMs = nowMs - windowMs;
  const runById = new Map((state.runs ?? []).map((run) => [run.id, run]));
  const taskById = new Map((state.workItems ?? []).map((task) => [task.id, task]));
  const projectById = new Map((state.projects ?? []).map((project) => [project.id, project]));
  const reopenEvents = (state.events ?? []).filter((event) => (
    event.type === 'work_item.restored'
      && Number.isFinite(Date.parse(event.createdAt ?? ''))
      && Date.parse(event.createdAt) >= startedMs
      && Date.parse(event.createdAt) <= nowMs
  ));
  const reopenedTaskIds = new Set(reopenEvents.map((event) => event.workItemId).filter(Boolean));
  const samples = (state.completionRecords ?? []).flatMap((record) => {
    const run = record.runId ? runById.get(record.runId) : null;
    const task = taskById.get(record.taskId ?? record.workItemId);
    const completedMs = Date.parse(record.completedAt ?? record.submittedAt ?? '');
    if (!task || !run || run.kind !== 'AGENT' || run.legacyMock === true || record.completionMethod !== 'AGENT_RUN') return [];
    if (!Number.isFinite(completedMs) || completedMs < startedMs || completedMs > nowMs) return [];
    const startedAtMs = Date.parse(record.startedAt ?? run.startedAt ?? '');
    const durationMs = Number.isFinite(Number(record.durationMs))
      ? Number(record.durationMs)
      : Number.isFinite(startedAtMs) ? Math.max(0, completedMs - startedAtMs) : null;
    const reviewDurationMs = record.verifiedAt && Number.isFinite(Date.parse(record.verifiedAt))
      ? Math.max(0, Date.parse(record.verifiedAt) - completedMs)
      : null;
    return [{
      taskId: task.id,
      projectId: task.projectId,
      projectName: projectById.get(task.projectId)?.name ?? task.projectId,
      kind: task.planning?.kind ?? 'feature',
      riskTier: task.riskTier ?? 'medium',
      modelRef: record.modelRef ?? run.modelRef ?? 'unknown',
      compute: run.claimDecision?.compute ?? task.recommendation?.compute ?? 'medium',
      estimateMinutes: Number(run.claimDecision?.estimateMinutes ?? task.recommendation?.estimateMinutes) || null,
      outcome: record.outcome ?? 'COMPLETED',
      reopened: reopenedTaskIds.has(task.id),
      durationMs,
      reviewDurationMs,
      startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
      completedAt: new Date(completedMs).toISOString()
    }];
  });

  const metricWindow = { startedMs, nowMs };
  const rawExecutionIntervals = [
    ...executionIntervalsForSamples(samples, metricWindow),
    ...activeExecutionIntervals(state, metricWindow)
  ];
  const executionIntervals = mergeIntervals(rawExecutionIntervals);
  const observedBusyMs = intervalCoverageMs(rawExecutionIntervals);
  const observedCoveredMs = intervalCoverageMs(executionIntervals);
  const unreportedIntervals = complementIntervals(executionIntervals, metricWindow).map((interval) => ({
    startedAt: new Date(interval.startMs).toISOString(),
    completedAt: new Date(interval.endMs).toISOString(),
    durationMs: interval.endMs - interval.startMs,
    semantics: 'UNKNOWN_NOT_IDLE'
  }));
  const executionSlotCount = Object.values(normalizePolicy(options.policy).executionSlots)
    .reduce((sum, count) => sum + count, 0);
  const groups = {
    projects: aggregateEfficiency(samples, (sample) => sample.projectId, (sample) => sample.projectName, 'PROJECT', metricWindow),
    taskKinds: aggregateEfficiency(samples, (sample) => sample.kind, (sample) => sample.kind, 'TASK_KIND', metricWindow),
    models: aggregateEfficiency(samples, (sample) => sample.modelRef, (sample) => sample.modelRef, 'MODEL', metricWindow),
    computeClasses: aggregateEfficiency(samples, (sample) => sample.compute, (sample) => sample.compute, 'COMPUTE', metricWindow)
  };
  const overall = efficiencyAggregate(samples, 'all', '全部真实任务', 'OVERALL', metricWindow);
  const calibrations = [...groups.taskKinds, ...groups.models, ...groups.computeClasses]
    .filter((group) => group.sampleCount >= CALIBRATION_MIN_SAMPLES)
    .flatMap(calibrationForGroup);
  const sampleTaskIds = new Set(samples.map((sample) => sample.taskId));
  const reopenedSampleTaskCount = new Set([...reopenedTaskIds].filter((taskId) => sampleTaskIds.has(taskId))).size;

  return {
    window: '30d',
    startedAt: new Date(startedMs).toISOString(),
    completedAt: now,
    sampleThreshold: CALIBRATION_MIN_SAMPLES,
    confidence: samples.length >= CALIBRATION_MIN_SAMPLES ? 'ENOUGH' : 'INSUFFICIENT',
    summary: {
      ...overall,
      reopenCount: reopenEvents.length,
      reopenRate: ratio(reopenedSampleTaskCount, sampleTaskIds.size),
      observedBusyMs,
      observedSlotSaturation: executionSlotCount > 0 ? ratio(observedBusyMs, windowMs * executionSlotCount) : null,
      observedWindowCoverage: ratio(observedCoveredMs, windowMs),
      unrecordedTimeMs: Math.max(0, windowMs - observedCoveredMs),
      unreportedIntervalCount: unreportedIntervals.length,
      longestUnreportedMs: Math.max(0, ...unreportedIntervals.map((interval) => interval.durationMs)),
      unrecordedTimeSemantics: 'UNKNOWN_NOT_IDLE'
    },
    groups,
    unreportedIntervals,
    calibrations,
    routingCalibrations: deriveRoutingCalibrations(samples, metricWindow)
  };
}

export function derivePhaseStatus(tasks) {
  if (tasks.length === 0) return 'NOT_STARTED';
  if (tasks.every(isTerminalTask)) return 'COMPLETED';
  if (tasks.some((task) => ACTIVE_EXECUTION_STATUSES.has(task.status))) return 'ACTIVE';
  if (tasks.some((task) => task.status === WORK_ITEM_STATUS.REVIEW)) return 'REVIEW';
  const openTasks = tasks.filter((task) => !isTerminalTask(task));
  if (openTasks.length > 0 && openTasks.every((task) => task.status === WORK_ITEM_STATUS.DEFERRED)) return 'DEFERRED';
  if (openTasks.length > 0 && openTasks.every((task) => (
    [WORK_ITEM_STATUS.BLOCKED, WORK_ITEM_STATUS.DEFERRED].includes(task.status)
  ))) return 'BLOCKED';
  return 'PLANNED';
}

export function isTerminalTask(task) {
  return TERMINAL_STATUSES.has(task.status);
}

export function taskHasCompleteContract(task) {
  return executionContractViolations(task).length === 0;
}

function taskDispatchFacts({ task, taskById, project, run, efficiency, now, nowMs }) {
  const dependencies = (task.dependsOnTaskIds ?? []).map((id) => taskById.get(id)).filter(Boolean);
  const missingDependencyIds = (task.dependsOnTaskIds ?? []).filter((id) => !taskById.has(id));
  const unmetDependencyIds = dependencies.filter((dependency) => (
    !DEPENDENCY_COMPLETE_STATUSES.has(dependency.status)
  )).map((dependency) => dependency.id);
  const leaseExpired = Boolean(
    run?.leaseExpiresAt && Number.isFinite(Date.parse(run.leaseExpiresAt)) && Date.parse(run.leaseExpiresAt) <= nowMs
  );
  const recoverableExpiredClaim = leaseExpired && ACTIVE_EXECUTION_STATUSES.has(task.status);
  const effectiveTask = recoverableExpiredClaim
    ? { ...task, status: WORK_ITEM_STATUS.READY, currentRunId: null }
    : task;
  const active = (ACTIVE_EXECUTION_STATUSES.has(task.status) && run && !leaseExpired)
    || (task.status === WORK_ITEM_STATUS.REVIEW && task.reviewLease?.leaseExpiresAt
      && Date.parse(task.reviewLease.leaseExpiresAt) > nowMs);
  const mode = effectiveTask.status === WORK_ITEM_STATUS.REVIEW ? 'REVIEW' : 'EXECUTION';
  const reasons = [];
  const blocks = [];

  if (effectiveTask.starred) reasons.push('STARRED');
  if (effectiveTask.planning?.priority) reasons.push(`PRIORITY_${effectiveTask.planning.priority}`);
  if (effectiveTask.planning?.commitment === 'COMMITTED') reasons.push('COMMITTED');
  if (['critical', 'high'].includes(effectiveTask.riskTier)) reasons.push(`RISK_${effectiveTask.riskTier.toUpperCase()}`);
  if (effectiveTask.scheduledFor) reasons.push('HARD_DEADLINE');
  if (effectiveTask.status === WORK_ITEM_STATUS.READY) reasons.push('READY');
  if (effectiveTask.status === WORK_ITEM_STATUS.REVIEW) reasons.push('REVIEW_REQUIRED');
  if (project?.strategicValue >= 8) reasons.push('HIGH_STRATEGIC_VALUE');
  if (task.provenance?.origin === 'HUMAN') reasons.push('HUMAN_AUTHORED');

  if (effectiveTask.status === WORK_ITEM_STATUS.DEFERRED) blocks.push('STATUS_DEFERRED');
  if (effectiveTask.status === WORK_ITEM_STATUS.BLOCKED) blocks.push('STATUS_BLOCKED');
  if (effectiveTask.status === WORK_ITEM_STATUS.RECURRING) blocks.push('RECURRING_CYCLE_IDLE');
  if (leaseExpired) reasons.push('LEASE_EXPIRED_RECOVERY_PENDING');
  if (missingDependencyIds.length > 0) blocks.push('DEPENDENCY_MISSING');
  if (unmetDependencyIds.length > 0) blocks.push('DEPENDENCY_BLOCKED');
  if (mode === 'EXECUTION' && !taskHasCompleteContract(effectiveTask)) blocks.push('CONTRACT_INCOMPLETE');
  if (!active && mode === 'EXECUTION' && !EXECUTION_CANDIDATE_STATUSES.has(effectiveTask.status)) {
    blocks.push(`STATUS_${effectiveTask.status}`);
  }

  const eligible = !active && blocks.length === 0 && (
    effectiveTask.status === WORK_ITEM_STATUS.REVIEW || EXECUTION_CANDIDATE_STATUSES.has(effectiveTask.status)
  );
  const routing = calibratedTaskRouting(effectiveTask, efficiency);
  const compute = routing.compute;
  if (routing.modelRef) reasons.push('HISTORY_CALIBRATED_MODEL');
  if (routing.compute !== normalizeCompute(task.recommendation?.compute)) reasons.push('HISTORY_CALIBRATED_COMPUTE');
  if (routing.estimateMinutes !== (Number(task.recommendation?.estimateMinutes) || null)) reasons.push('HISTORY_CALIBRATED_ESTIMATE');
  return {
    task: effectiveTask,
    storedTask: task,
    project,
    run,
    now,
    mode,
    compute,
    routing,
    active,
    eligible,
    leaseExpired,
    unmetDependencyIds,
    missingDependencyIds,
    reasonCodes: [...new Set([...reasons, ...blocks])],
    score: candidateScore(effectiveTask, project, nowMs)
  };
}

function deriveProjectHealth({ project, tasks, factsByTaskId, lastProgressAt, reviewEnteredAtByTaskId, nowMs, policy }) {
  if (tasks.length === 0) return PROJECT_HEALTH.DORMANT;
  if (tasks.length > 0 && tasks.every(isTerminalTask)) return PROJECT_HEALTH.COMPLETE;
  const openTasks = tasks.filter((task) => !isTerminalTask(task));
  if (openTasks.length === 0) return PROJECT_HEALTH.COMPLETE;
  const active = openTasks.some((task) => factsByTaskId.get(task.id)?.active);
  const actionable = openTasks.some((task) => factsByTaskId.get(task.id)?.eligible);
  const reviewAtRisk = openTasks.some((task) => (
    task.status === WORK_ITEM_STATUS.REVIEW
      && nowMs - Date.parse(reviewEnteredAtByTaskId.get(task.id) ?? task.updatedAt ?? task.createdAt ?? '') >= policy.reviewRiskAfterMs
  ));
  const allDormant = openTasks.every((task) => (
    [WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.RECURRING].includes(task.status)
  ));
  const hasHardBlock = openTasks.some((task) => (
    task.status === WORK_ITEM_STATUS.BLOCKED
      || factsByTaskId.get(task.id)?.reasonCodes.includes('DEPENDENCY_BLOCKED')
      || factsByTaskId.get(task.id)?.reasonCodes.includes('DEPENDENCY_MISSING')
  ));
  if (!active && !actionable && hasHardBlock) return PROJECT_HEALTH.BLOCKED;
  if (reviewAtRisk) return PROJECT_HEALTH.AT_RISK;
  if (allDormant) return PROJECT_HEALTH.DORMANT;
  const progressMs = Date.parse(lastProgressAt ?? project.createdAt ?? '');
  if (!active && Number.isFinite(progressMs) && nowMs - progressMs >= policy.stalledAfterMs) {
    return PROJECT_HEALTH.STALLED;
  }
  return PROJECT_HEALTH.ON_TRACK;
}

function derivePhaseTaskTimestamp(task) {
  return Date.parse(task.updatedAt ?? task.createdAt ?? '') || 0;
}

function currentTaskForPhase(tasks, decisionByTaskId) {
  return tasks.filter((task) => (
    !isTerminalTask(task) && decisionByTaskId.get(task.id)?.batch !== DISPATCH_BATCH.BACKLOG
  )).sort((left, right) => (
    batchWeight(decisionByTaskId.get(left.id)?.batch) - batchWeight(decisionByTaskId.get(right.id)?.batch)
      || (decisionByTaskId.get(left.id)?.rank ?? 9999) - (decisionByTaskId.get(right.id)?.rank ?? 9999)
      || derivePhaseTaskTimestamp(right) - derivePhaseTaskTimestamp(left)
  ))[0] ?? null;
}

function currentTaskForProject(tasks, decisionByTaskId) {
  return currentTaskForPhase(tasks, decisionByTaskId);
}

function latestVerifiedTaskForProject(state, tasks) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const runById = new Map((state.runs ?? []).map((run) => [run.id, run]));
  const latestRecord = (state.completionRecords ?? [])
    .filter((record) => {
      const taskId = record.taskId ?? record.workItemId;
      const task = taskById.get(taskId);
      const run = record.runId ? runById.get(record.runId) : null;
      return taskIds.has(taskId)
        && record.verifiedAt
        && [WORK_ITEM_STATUS.RECURRING, WORK_ITEM_STATUS.VERIFIED, WORK_ITEM_STATUS.RELEASED, WORK_ITEM_STATUS.ARCHIVED].includes(task?.status)
        && (!run || run.kind !== 'INTERNAL_MOCK')
        && record.legacyMock !== true;
    })
    .sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt))[0];
  if (latestRecord) return tasks.find((task) => task.id === (latestRecord.taskId ?? latestRecord.workItemId)) ?? null;
  return [...tasks]
    .filter((task) => [WORK_ITEM_STATUS.VERIFIED, WORK_ITEM_STATUS.RELEASED, WORK_ITEM_STATUS.ARCHIVED].includes(task.status))
    .sort((left, right) => (
      Number(right.planning?.phaseOrder ?? 0) - Number(left.planning?.phaseOrder ?? 0)
        || Number(right.planning?.taskOrder ?? 0) - Number(left.planning?.taskOrder ?? 0)
        || String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''))
    ))[0] ?? null;
}

function deriveRecentScheduleChanges(state) {
  const visibleTypes = new Set([
    'dispatch.decision_changed',
    'portfolio.rebalanced',
    'phase.status_reconciled',
    'schedule.reordered',
    'work_item.cancelled',
    'work_item.restored'
  ]);
  const taskById = new Map((state.workItems ?? []).map((task) => [task.id, task]));
  return (state.events ?? [])
    .filter((event) => (
      visibleTypes.has(event.type)
        || (event.type === 'work_item.updated'
          && event.metadata?.statusChange === true
          && event.metadata?.before?.status !== event.metadata?.after?.status)
    ))
    .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
    .slice(0, 20)
    .map((event) => {
      const task = event.workItemId ? taskById.get(event.workItemId) : null;
      const derivedType = event.type === 'work_item.updated' && event.metadata?.statusChange === true
        ? (event.metadata?.after?.status === WORK_ITEM_STATUS.DEFERRED ? 'work_item.deferred' : 'work_item.resumed')
        : event.type;
      const reversalAction = derivedType === 'work_item.cancelled' && task?.status === WORK_ITEM_STATUS.CANCELLED
        ? 'RESTORE'
        : derivedType === 'work_item.deferred' && task?.status === WORK_ITEM_STATUS.DEFERRED
          ? 'RESUME'
          : derivedType === 'schedule.reordered' && canReverseScheduleReorder(state, event)
            ? 'REORDER'
            : null;
      return {
        id: event.id,
        type: derivedType,
        message: event.message,
        createdAt: event.createdAt,
        taskId: event.workItemId ?? null,
        taskTitle: task?.title ?? null,
        projectId: event.metadata?.projectId ?? task?.projectId ?? null,
        phaseId: event.metadata?.phaseId ?? (task ? taskPhaseId(task) : null),
        actor: event.metadata?.actor ?? null,
        reason: event.metadata?.reason ?? event.metadata?.after?.reasonCodes?.join(', ') ?? null,
        before: event.metadata?.before ?? null,
        after: event.metadata?.after ?? null,
        effect: event.metadata?.after ?? null,
        policyVersion: event.metadata?.policyVersion ?? event.metadata?.after?.policyVersion ?? null,
        reversible: Boolean(reversalAction),
        reversalAction,
        reversalOrder: reversalAction === 'REORDER' ? [...event.metadata.beforeOrder] : null
      };
    });
}

function canReverseScheduleReorder(state, event) {
  const beforeOrder = event.metadata?.beforeOrder;
  const afterOrder = event.metadata?.afterOrder;
  const phaseId = event.metadata?.phaseId;
  if (!phaseId || !Array.isArray(beforeOrder) || !Array.isArray(afterOrder) || beforeOrder.length === 0) return false;
  if (beforeOrder.length !== afterOrder.length || new Set(beforeOrder).size !== beforeOrder.length) return false;
  if (beforeOrder.some((taskId) => !afterOrder.includes(taskId))) return false;
  const currentOrder = (state.workItems ?? [])
    .filter((task) => taskPhaseId(task) === phaseId && REORDERABLE_STATUSES.has(task.status))
    .sort((left, right) => (
      Number(left.planning?.taskOrder ?? Number.MAX_SAFE_INTEGER) - Number(right.planning?.taskOrder ?? Number.MAX_SAFE_INTEGER)
        || String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    ))
    .map((task) => task.id);
  return currentOrder.length === afterOrder.length
    && currentOrder.every((taskId, index) => taskId === afterOrder[index]);
}

function batchWeight(batch) {
  return { NOW: 0, NEXT: 1, RESERVE: 2, BACKLOG: 3 }[batch] ?? 4;
}

function dispatchEntry(facts, batch, rank, decidedAt) {
  return {
    taskId: facts.task.id,
    projectId: facts.task.projectId,
    phaseId: taskPhaseId(facts.task),
    title: facts.task.title,
    status: facts.task.status,
    effectiveStatus: facts.task.status,
    mode: facts.mode,
    compute: facts.compute,
    recommendedAgent: facts.task.recommendation?.executor ?? null,
    modelRef: facts.run?.modelRef ?? null,
    recommendedModelRef: facts.routing.modelRef,
    estimateMinutes: facts.routing.estimateMinutes,
    recommendationSource: facts.routing.calibrated ? 'HISTORY_CALIBRATED' : 'RULE_DEFAULT',
    batch,
    rank,
    score: facts.score,
    reasonCodes: facts.reasonCodes,
    policyVersion: DISPATCH_POLICY_VERSION,
    decidedAt,
    leaseExpiresAt: facts.leaseExpired ? null : facts.run?.leaseExpiresAt ?? facts.task.reviewLease?.leaseExpiresAt ?? null
  };
}

function summarizeProjectDispatch(projectId, decisions) {
  const projectDecisions = decisions.filter((entry) => entry.projectId === projectId);
  return Object.fromEntries(Object.values(DISPATCH_BATCH).map((batch) => [
    batch.toLowerCase(),
    projectDecisions.filter((entry) => entry.batch === batch).length
  ]));
}

function withReason(facts, reason) {
  return { ...facts, reasonCodes: [...new Set([...facts.reasonCodes, reason])] };
}

function candidateScore(task, project, nowMs) {
  const priority = { P0: 400, P1: 300, P2: 200, P3: 100 }[task.planning?.priority] ?? 0;
  const state = {
    REVIEW: 500,
    READY: 360,
    PLANNED: 240
  }[task.status] ?? 0;
  const strategic = Math.max(0, Number(project?.strategicValue) || 0) * 24;
  const phase = Math.max(0, 100 - Number(task.planning?.phaseOrder ?? 100));
  const provenance = task.provenance?.origin === 'HUMAN' ? 40 : 0;
  const risk = { critical: 180, high: 120, medium: 40, low: 0 }[task.riskTier] ?? 0;
  return (task.starred ? 1000 : 0)
    + hardDeadlineScore(task.scheduledFor, nowMs)
    + priority
    + state
    + strategic
    + phase
    + risk
    + provenance;
}

function hardDeadlineScore(value, nowMs) {
  if (!value) return 0;
  const target = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(target)) return 0;
  const days = Math.ceil((target - nowMs) / 86_400_000);
  if (days <= 0) return 900;
  return Math.max(0, 700 - days * 20);
}

function lastProjectProgressAt(state, projectId) {
  const taskIds = new Set((state.workItems ?? [])
    .filter((task) => task.projectId === projectId)
    .map((task) => task.id));
  const timestamps = [];
  const runById = new Map((state.runs ?? []).map((run) => [run.id, run]));
  for (const record of state.completionRecords ?? []) {
    if (!taskIds.has(record.taskId ?? record.workItemId)) continue;
    const run = record.runId ? runById.get(record.runId) : null;
    if (run?.kind === 'INTERNAL_MOCK' || record.legacyMock === true) continue;
    const timestamp = record.verifiedAt ?? record.completedAt ?? record.submittedAt;
    if (Number.isFinite(Date.parse(timestamp ?? ''))) timestamps.push(timestamp);
  }
  for (const event of state.events ?? []) {
    if (!taskIds.has(event.workItemId) || !REAL_PROGRESS_EVENT_TYPES.has(event.type)) continue;
    const run = event.runId ? runById.get(event.runId) : null;
    if (run?.kind === 'INTERNAL_MOCK' || event.metadata?.legacyMock === true) continue;
    if (Number.isFinite(Date.parse(event.createdAt ?? ''))) timestamps.push(event.createdAt);
  }
  return timestamps.sort().at(-1) ?? null;
}

function latestCompletionTimeByTask(state) {
  const result = new Map();
  const runById = new Map((state.runs ?? []).map((run) => [run.id, run]));
  for (const record of state.completionRecords ?? []) {
    const taskId = record.taskId ?? record.workItemId;
    const timestamp = record.completedAt ?? record.submittedAt;
    const run = record.runId ? runById.get(record.runId) : null;
    if (run?.kind === 'INTERNAL_MOCK' || run?.legacyMock === true || record.legacyMock === true) continue;
    if (!taskId || !Number.isFinite(Date.parse(timestamp ?? ''))) continue;
    if (!result.has(taskId) || Date.parse(timestamp) > Date.parse(result.get(taskId))) {
      result.set(taskId, timestamp);
    }
  }
  return result;
}

function executionIntervalsForSamples(samples, { startedMs, nowMs }) {
  return samples.flatMap((sample) => {
    const completedMs = Date.parse(sample.completedAt ?? '');
    const explicitStartedMs = Date.parse(sample.startedAt ?? '');
    const inferredStartedMs = Number.isFinite(sample.durationMs) && Number.isFinite(completedMs)
      ? completedMs - sample.durationMs
      : Number.NaN;
    const startMs = Number.isFinite(explicitStartedMs) ? explicitStartedMs : inferredStartedMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(completedMs)) return [];
    const clampedStart = Math.max(startedMs, Math.min(nowMs, startMs));
    const clampedEnd = Math.max(startedMs, Math.min(nowMs, completedMs));
    return clampedEnd > clampedStart ? [{ startMs: clampedStart, endMs: clampedEnd }] : [];
  });
}

function activeExecutionIntervals(state, { startedMs, nowMs }) {
  return (state.runs ?? []).flatMap((run) => {
    if (run.kind !== 'AGENT' || run.legacyMock === true || run.status !== 'RUNNING') return [];
    const startMs = Date.parse(run.claimedAt ?? run.startedAt ?? '');
    const leaseEndMs = Date.parse(run.leaseExpiresAt ?? '');
    const endMs = Number.isFinite(leaseEndMs) ? Math.min(nowMs, leaseEndMs) : nowMs;
    if (!Number.isFinite(startMs) || endMs <= startMs) return [];
    const clampedStart = Math.max(startedMs, Math.min(nowMs, startMs));
    const clampedEnd = Math.max(startedMs, Math.min(nowMs, endMs));
    return clampedEnd > clampedStart ? [{ startMs: clampedStart, endMs: clampedEnd }] : [];
  });
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.startMs > previous.endMs) {
      merged.push({ ...interval });
    } else {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    }
  }
  return merged;
}

function intervalCoverageMs(intervals) {
  return intervals.reduce((sum, interval) => sum + Math.max(0, interval.endMs - interval.startMs), 0);
}

function complementIntervals(intervals, { startedMs, nowMs }) {
  const gaps = [];
  let cursor = startedMs;
  for (const interval of mergeIntervals(intervals)) {
    if (interval.startMs > cursor) gaps.push({ startMs: cursor, endMs: interval.startMs });
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < nowMs) gaps.push({ startMs: cursor, endMs: nowMs });
  return gaps;
}

function aggregateEfficiency(samples, keyFor, labelFor = keyFor, dimension = 'UNKNOWN', metricWindow = null) {
  const groups = new Map();
  for (const sample of samples) {
    const key = String(keyFor(sample));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return [...groups.entries()]
    .map(([key, entries]) => efficiencyAggregate(entries, key, String(labelFor(entries[0])), dimension, metricWindow))
    .sort((left, right) => right.sampleCount - left.sampleCount || left.key.localeCompare(right.key));
}

function efficiencyAggregate(samples, key, label, dimension, metricWindow = null) {
  const durations = samples.map((sample) => sample.durationMs).filter(Number.isFinite);
  const reviewDurations = samples.map((sample) => sample.reviewDurationMs).filter(Number.isFinite);
  const estimateRatios = samples.flatMap((sample) => (
    Number.isFinite(sample.durationMs) && Number.isFinite(sample.estimateMinutes) && sample.estimateMinutes > 0
      ? [sample.durationMs / (sample.estimateMinutes * 60_000)]
      : []
  ));
  const taskIds = new Set(samples.map((sample) => sample.taskId));
  const reopenedTaskIds = new Set(samples.filter((sample) => sample.reopened).map((sample) => sample.taskId));
  const rawIntervals = metricWindow ? executionIntervalsForSamples(samples, metricWindow) : [];
  const intervals = mergeIntervals(rawIntervals);
  const observedBusyMs = intervalCoverageMs(rawIntervals);
  const observedCoveredMs = intervalCoverageMs(intervals);
  const windowMs = metricWindow ? metricWindow.nowMs - metricWindow.startedMs : null;
  const unreported = metricWindow ? complementIntervals(intervals, metricWindow) : [];
  const failureAndBlockedCount = samples.filter((sample) => ['FAILED', 'BLOCKED'].includes(sample.outcome)).length;
  return {
    key,
    label,
    dimension,
    sampleCount: samples.length,
    confidence: samples.length >= CALIBRATION_MIN_SAMPLES ? 'ENOUGH' : 'INSUFFICIENT',
    throughput: samples.filter((sample) => sample.outcome === 'COMPLETED').length,
    failureCount: samples.filter((sample) => sample.outcome === 'FAILED').length,
    blockedCount: samples.filter((sample) => sample.outcome === 'BLOCKED').length,
    failureAndBlockedRate: ratio(failureAndBlockedCount, samples.length),
    reopenCount: reopenedTaskIds.size,
    reopenRate: ratio(reopenedTaskIds.size, taskIds.size),
    medianExecutionMs: median(durations),
    medianReviewMs: median(reviewDurations),
    medianEstimateRatio: median(estimateRatios),
    observedBusyMs: metricWindow ? observedBusyMs : null,
    observedWindowCoverage: metricWindow ? ratio(observedCoveredMs, windowMs) : null,
    unrecordedTimeMs: metricWindow ? Math.max(0, windowMs - observedCoveredMs) : null,
    unreportedIntervalCount: metricWindow ? unreported.length : null,
    longestUnreportedMs: metricWindow ? Math.max(0, ...unreported.map((interval) => interval.endMs - interval.startMs)) : null,
    unrecordedTimeSemantics: 'UNKNOWN_NOT_IDLE'
  };
}

function calibrationForGroup(group) {
  if (!Number.isFinite(group.medianEstimateRatio)) return [];
  if (group.medianEstimateRatio >= 1.35) {
    return [{
      key: group.key,
      label: group.label,
      dimension: group.dimension,
      kind: 'ESTIMATE_INCREASE',
      sampleCount: group.sampleCount,
      confidence: group.confidence,
      reasonCode: 'ACTUAL_DURATION_ABOVE_ESTIMATE',
      suggestedMultiplier: Number(Math.min(2, group.medianEstimateRatio).toFixed(2))
    }];
  }
  if (group.medianEstimateRatio <= 0.6) {
    return [{
      key: group.key,
      label: group.label,
      dimension: group.dimension,
      kind: 'ESTIMATE_DECREASE',
      sampleCount: group.sampleCount,
      confidence: group.confidence,
      reasonCode: 'ACTUAL_DURATION_BELOW_ESTIMATE',
      suggestedMultiplier: Number(Math.max(0.5, group.medianEstimateRatio).toFixed(2))
    }];
  }
  return [];
}

function deriveRoutingCalibrations(samples, metricWindow = null) {
  const kinds = new Map();
  for (const sample of samples) {
    const key = `${sample.kind}|${sample.riskTier}`;
    if (!kinds.has(key)) kinds.set(key, []);
    kinds.get(key).push(sample);
  }
  const result = [];
  for (const [key, kindSamples] of kinds) {
    const [taskKind, riskTier] = key.split('|');
    const kindRiskGroup = efficiencyAggregate(kindSamples, key, key, 'TASK_KIND_RISK', metricWindow);
    const estimateCalibration = kindRiskGroup.sampleCount >= CALIBRATION_MIN_SAMPLES
      ? calibrationForGroup(kindRiskGroup)[0]
      : null;
    if (estimateCalibration) {
      result.push({
        kind: 'ESTIMATE_MULTIPLIER',
        taskKind,
        riskTier,
        suggestedMultiplier: estimateCalibration.suggestedMultiplier,
        sampleCount: estimateCalibration.sampleCount,
        confidence: estimateCalibration.confidence,
        reasonCode: estimateCalibration.reasonCode
      });
    }
    const modelGroups = aggregateEfficiency(kindSamples, (sample) => sample.modelRef, (sample) => sample.modelRef, 'MODEL', metricWindow)
      .filter(isSafeRoutingCalibrationGroup)
      .sort(compareRoutingGroups);
    if (modelGroups[0]) {
      result.push({
        kind: 'MODEL_PREFERENCE',
        taskKind,
        riskTier,
        modelRef: modelGroups[0].key,
        sampleCount: modelGroups[0].sampleCount,
        confidence: 'ENOUGH',
        reasonCode: 'HISTORICAL_MODEL_OUTCOME'
      });
    }
    const computeGroups = aggregateEfficiency(kindSamples, (sample) => sample.compute, (sample) => sample.compute, 'COMPUTE', metricWindow)
      .filter(isSafeRoutingCalibrationGroup)
      .sort(compareRoutingGroups);
    if (computeGroups[0]) {
      result.push({
        kind: 'COMPUTE_PREFERENCE',
        taskKind,
        riskTier,
        compute: computeGroups[0].key,
        sampleCount: computeGroups[0].sampleCount,
        confidence: 'ENOUGH',
        reasonCode: 'HISTORICAL_COMPUTE_OUTCOME'
      });
    }
  }
  return result;
}

function calibratedTaskRouting(task, efficiency) {
  const taskKind = task.planning?.kind ?? 'feature';
  const riskTier = task.riskTier ?? 'medium';
  const baseEstimate = Number(task.recommendation?.estimateMinutes) || null;
  const estimateCalibration = efficiency.routingCalibrations.find((entry) => (
    entry.kind === 'ESTIMATE_MULTIPLIER' && entry.taskKind === taskKind && entry.riskTier === riskTier
  ));
  const modelCalibration = efficiency.routingCalibrations.find((entry) => (
    entry.kind === 'MODEL_PREFERENCE' && entry.taskKind === taskKind && entry.riskTier === riskTier
  ));
  const computeCalibration = efficiency.routingCalibrations.find((entry) => (
    entry.kind === 'COMPUTE_PREFERENCE' && entry.taskKind === taskKind && entry.riskTier === riskTier
  ));
  const estimateMinutes = baseEstimate && estimateCalibration?.suggestedMultiplier
    ? Math.max(1, Math.round(baseEstimate * estimateCalibration.suggestedMultiplier))
    : baseEstimate;
  return {
    modelRef: modelCalibration?.modelRef ?? null,
    compute: normalizeCompute(computeCalibration?.compute ?? task.recommendation?.compute),
    estimateMinutes,
    calibrated: Boolean(estimateCalibration || modelCalibration || computeCalibration)
  };
}

function compareRoutingGroups(left, right) {
  const leftSuccess = ratio(left.throughput, left.sampleCount) ?? 0;
  const rightSuccess = ratio(right.throughput, right.sampleCount) ?? 0;
  return rightSuccess - leftSuccess
    || (left.failureAndBlockedRate ?? 1) - (right.failureAndBlockedRate ?? 1)
    || (left.reopenRate ?? 1) - (right.reopenRate ?? 1)
    || (left.medianExecutionMs ?? Number.POSITIVE_INFINITY) - (right.medianExecutionMs ?? Number.POSITIVE_INFINITY)
    || computeWeight(left.key) - computeWeight(right.key)
    || left.key.localeCompare(right.key);
}

function isSafeRoutingCalibrationGroup(group) {
  const successRate = ratio(group.throughput, group.sampleCount) ?? 0;
  return group.sampleCount >= CALIBRATION_MIN_SAMPLES
    && successRate >= 0.6
    && (group.failureAndBlockedRate ?? 1) <= 0.4
    && (group.reopenRate ?? 1) <= 0.4;
}

function computeWeight(value) {
  return { low: 0, medium: 1, high: 2 }[value] ?? 3;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function compareDispatchFacts(left, right) {
  return right.score - left.score
    || Number(left.task.planning?.phaseOrder ?? 999) - Number(right.task.planning?.phaseOrder ?? 999)
    || Number(left.task.planning?.taskOrder ?? 999) - Number(right.task.planning?.taskOrder ?? 999)
    || String(left.task.title).localeCompare(String(right.task.title), 'zh-CN');
}

function compareProjects(left, right) {
  return Number(right.strategicValue ?? 0) - Number(left.strategicValue ?? 0)
    || String(left.name).localeCompare(String(right.name), 'zh-CN');
}

function comparePhases(left, right) {
  return Number(left.rank ?? 0) - Number(right.rank ?? 0)
    || String(left.title).localeCompare(String(right.title), 'zh-CN');
}

function normalizeCompute(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function taskPhaseId(task) {
  return task.phaseId ?? task.planning?.phaseId ?? null;
}

function normalizeNow(value) {
  const now = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('now must be a valid ISO timestamp');
  return new Date(now).toISOString();
}

function normalizePolicy(input = {}) {
  const executionSlots = {
    high: nonNegativeInteger(input.executionSlots?.high, DEFAULT_DISPATCH_POLICY.executionSlots.high),
    medium: nonNegativeInteger(input.executionSlots?.medium, DEFAULT_DISPATCH_POLICY.executionSlots.medium),
    low: nonNegativeInteger(input.executionSlots?.low, DEFAULT_DISPATCH_POLICY.executionSlots.low)
  };
  return {
    executionSlots,
    reviewSlots: nonNegativeInteger(input.reviewSlots, DEFAULT_DISPATCH_POLICY.reviewSlots),
    maxConcurrentChangesPerProject: positiveInteger(
      input.maxConcurrentChangesPerProject,
      DEFAULT_DISPATCH_POLICY.maxConcurrentChangesPerProject
    ),
    reviewRiskAfterMs: positiveNumber(input.reviewRiskAfterMs, DEFAULT_DISPATCH_POLICY.reviewRiskAfterMs),
    stalledAfterMs: positiveNumber(input.stalledAfterMs, DEFAULT_DISPATCH_POLICY.stalledAfterMs)
  };
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

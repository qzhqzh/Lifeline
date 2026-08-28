const TERMINAL_TASK_STATUSES = new Set(['VERIFIED', 'RELEASED', 'ARCHIVED', 'CANCELLED']);
const ACTIONABLE_TASK_STATUSES = new Set([
  'DISCOVERED',
  'TRIAGED',
  'PLANNED',
  'READY',
  'QUEUED',
  'RUNNING',
  'BLOCKED'
]);

const REVIEW_RISK_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 72 * 60 * 60 * 1000;
const MAX_AGENT_CONTACTS = 500;

export const AGENT_REPORTING_STATUS = Object.freeze({
  HEALTHY: 'HEALTHY',
  NEVER_CONNECTED: 'NEVER_CONNECTED',
  NEEDS_PLAN: 'NEEDS_PLAN',
  STALE: 'STALE',
  REVIEW_BACKLOG: 'REVIEW_BACKLOG',
  COMPLETE: 'COMPLETE'
});

export function deriveAgentReporting(state, options = {}) {
  const generatedAt = normalizeNow(options.now);
  const generatedAtMs = Date.parse(generatedAt);
  const boardProjects = new Map((options.boardProjects ?? []).map((project) => [project.id, project]));
  const decisions = new Map((options.decisions ?? []).map((decision) => [decision.taskId, decision]));
  const projects = (state.projects ?? [])
    .filter((project) => project.status !== 'ARCHIVED')
    .map((project) => deriveProjectReporting(state, project, {
      generatedAt,
      generatedAtMs,
      boardProject: boardProjects.get(project.id),
      decisions
    }))
    .sort((left, right) => Number(right.strategicValue ?? 0) - Number(left.strategicValue ?? 0)
      || String(left.name).localeCompare(String(right.name), 'zh-CN'));

  return {
    generatedAt,
    summary: {
      projectCount: projects.length,
      healthyCount: projects.filter((project) => project.status === AGENT_REPORTING_STATUS.HEALTHY).length,
      completeCount: projects.filter((project) => project.status === AGENT_REPORTING_STATUS.COMPLETE).length,
      neverConnectedCount: projects.filter((project) => project.reasonCodes.includes('NO_AGENT_CONTACT')).length,
      needsPlanCount: projects.filter((project) => project.reasonCodes.includes('NO_ACTIONABLE_PLAN')).length,
      reviewBacklogCount: projects.filter((project) => project.reasonCodes.includes('REVIEW_OVERDUE')).length,
      staleCount: projects.filter((project) => project.reasonCodes.includes('PROGRESS_STALE')).length,
      attentionCount: projects.filter((project) => ![
        AGENT_REPORTING_STATUS.HEALTHY,
        AGENT_REPORTING_STATUS.COMPLETE
      ].includes(project.status)).length
    },
    projects
  };
}

export function upsertAgentContact(state, input) {
  state.agentContacts ??= [];
  const at = normalizeNow(input.at);
  const identityKey = [input.projectId, input.actor, input.client ?? 'unknown'].join('|');
  let contact = state.agentContacts.find((entry) => entry.identityKey === identityKey);
  if (!contact) {
    contact = {
      id: `agent-contact:${stableHash(identityKey)}`,
      identityKey,
      projectId: input.projectId,
      actor: input.actor,
      client: input.client ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
      lastTool: input.tool ?? null,
      contactCount: 0,
      repositoryPath: input.repositoryPath ?? null,
      repositoryUrl: input.repositoryUrl ?? null
    };
    state.agentContacts.push(contact);
  }
  contact.lastSeenAt = at;
  contact.lastTool = input.tool ?? contact.lastTool ?? null;
  contact.contactCount = Number(contact.contactCount ?? 0) + 1;
  contact.repositoryPath = input.repositoryPath ?? contact.repositoryPath ?? null;
  contact.repositoryUrl = input.repositoryUrl ?? contact.repositoryUrl ?? null;

  if (state.agentContacts.length > MAX_AGENT_CONTACTS) {
    state.agentContacts.sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
    state.agentContacts.splice(MAX_AGENT_CONTACTS);
  }
  return contact;
}

function deriveProjectReporting(state, project, context) {
  const tasks = (state.workItems ?? []).filter((task) => task.projectId === project.id && task.status !== 'CANCELLED');
  const effectiveTasks = tasks.map((task) => ({
    ...task,
    status: context.decisions.get(task.id)?.effectiveStatus ?? task.status
  }));
  const taskIds = new Set(tasks.map((task) => task.id));
  const completionRecords = (state.completionRecords ?? [])
    .filter((record) => taskIds.has(record.taskId ?? record.workItemId));
  const realCompletions = completionRecords.filter((record) => (
    !record.completionMethod || record.completionMethod === 'AGENT_RUN'
  ));
  const reviewTasks = effectiveTasks.filter((task) => task.status === 'REVIEW');
  const oldestReviewAt = oldestTimestamp(reviewTasks.map((task) => (
    latestRecordForTask(completionRecords, task.id)?.completedAt ?? task.updatedAt ?? task.createdAt
  )));
  const reviewOverdue = oldestReviewAt
    ? context.generatedAtMs - Date.parse(oldestReviewAt) >= REVIEW_RISK_AFTER_MS
    : false;
  const actionableTaskCount = effectiveTasks.filter((task) => ACTIONABLE_TASK_STATUSES.has(task.status)).length;
  const openTaskCount = effectiveTasks.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status)).length;
  const isComplete = project.status === 'ARCHIVED' || context.boardProject?.health === 'COMPLETE';
  const needsPlan = !isComplete && actionableTaskCount === 0 && reviewTasks.length === 0;
  const lastPlanAt = latestTimestamp([
    ...(state.phases ?? []).filter((phase) => phase.projectId === project.id).map((phase) => phase.createdAt),
    ...tasks.map((task) => task.createdAt)
  ]);
  const explicitContacts = (state.agentContacts ?? []).filter((contact) => contact.projectId === project.id);
  const implicitContactAt = latestTimestamp([
    ...realCompletions.map((record) => record.completedAt ?? record.createdAt),
    ...(state.phases ?? []).filter((phase) => phase.projectId === project.id && isAgentSource(phase)).map((phase) => phase.createdAt),
    ...tasks.filter(isAgentSource).map((task) => task.createdAt)
  ]);
  const lastExplicitContactAt = latestTimestamp(explicitContacts.map((contact) => contact.lastSeenAt));
  const lastAgentContactAt = latestTimestamp([lastExplicitContactAt, implicitContactAt]);
  const lastCompletionAt = latestTimestamp(realCompletions.map((record) => record.completedAt ?? record.createdAt));
  const lastProgressAt = context.boardProject?.lastProgressAt ?? lastCompletionAt ?? null;
  const progressAnchor = lastProgressAt ?? lastPlanAt ?? project.createdAt ?? null;
  const stale = !isComplete && openTaskCount > 0 && progressAnchor
    ? context.generatedAtMs - Date.parse(progressAnchor) >= STALE_AFTER_MS
    : false;
  const reasonCodes = [];
  if (!lastAgentContactAt && !isComplete) reasonCodes.push('NO_AGENT_CONTACT');
  if (needsPlan) reasonCodes.push('NO_ACTIONABLE_PLAN');
  if (reviewOverdue) reasonCodes.push('REVIEW_OVERDUE');
  if (stale) reasonCodes.push('PROGRESS_STALE');

  const status = reportingStatus({ isComplete, reviewOverdue, needsPlan, lastAgentContactAt, stale });
  return {
    projectId: project.id,
    name: project.name,
    strategicValue: project.strategicValue,
    status,
    reasonCodes,
    lastAgentContactAt,
    lastPlanAt,
    lastCompletionAt,
    lastProgressAt,
    openTaskCount,
    actionableTaskCount,
    reviewCount: reviewTasks.length,
    oldestReviewAt,
    contactCount: explicitContacts.reduce((sum, contact) => sum + Number(contact.contactCount ?? 0), 0),
    lastTool: explicitContacts
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))[0]?.lastTool ?? null,
    recommendedAction: recommendedAction(status, reviewTasks[0]?.id ?? null)
  };
}

function reportingStatus({ isComplete, reviewOverdue, needsPlan, lastAgentContactAt, stale }) {
  if (isComplete) return AGENT_REPORTING_STATUS.COMPLETE;
  if (reviewOverdue) return AGENT_REPORTING_STATUS.REVIEW_BACKLOG;
  if (needsPlan) return AGENT_REPORTING_STATUS.NEEDS_PLAN;
  if (!lastAgentContactAt) return AGENT_REPORTING_STATUS.NEVER_CONNECTED;
  if (stale) return AGENT_REPORTING_STATUS.STALE;
  return AGENT_REPORTING_STATUS.HEALTHY;
}

function recommendedAction(status, reviewTaskId) {
  switch (status) {
    case AGENT_REPORTING_STATUS.REVIEW_BACKLOG:
      return { kind: 'REVIEW_TASK', taskId: reviewTaskId, label: '优先完成独立复核' };
    case AGENT_REPORTING_STATUS.NEEDS_PLAN:
      return { kind: 'PLAN_NEXT_ITERATION', taskId: null, label: '制定下一轮可执行排期' };
    case AGENT_REPORTING_STATUS.NEVER_CONNECTED:
      return { kind: 'CONNECT_AGENT', taskId: null, label: '让项目 Agent 读取一次排期' };
    case AGENT_REPORTING_STATUS.STALE:
      return { kind: 'RESUME_PROJECT', taskId: null, label: '领取下一项或重排计划' };
    case AGENT_REPORTING_STATUS.COMPLETE:
      return { kind: 'NONE', taskId: null, label: '项目已完成' };
    default:
      return { kind: 'NONE', taskId: null, label: '汇报链路正常' };
  }
}

function latestRecordForTask(records, taskId) {
  return records
    .filter((record) => (record.taskId ?? record.workItemId) === taskId)
    .sort((left, right) => String(left.completedAt ?? left.createdAt).localeCompare(String(right.completedAt ?? right.createdAt)))
    .at(-1) ?? null;
}

function isAgentSource(entity) {
  if (entity?.provenance?.origin === 'AI') return true;
  const kind = String(entity?.source?.kind ?? entity?.source?.reportedSource?.kind ?? '').toLowerCase();
  return /agent|codex|mcp/.test(kind);
}

function normalizeNow(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new TypeError('reporting timestamp is invalid');
  return date.toISOString();
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function oldestTimestamp(values) {
  return values.filter(Boolean).sort()[0] ?? null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

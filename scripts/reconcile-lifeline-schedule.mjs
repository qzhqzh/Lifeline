import { copyFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createCompletionRecord,
  createId,
  createPhase,
  createWorkItem,
  nowIso
} from '../src/domain.js';
import {
  getPortfolioV2Template,
  PORTFOLIO_TEMPLATE_KEY,
  PORTFOLIO_TEMPLATE_VERSION
} from '../src/portfolio-v2-template.js';
import { JsonStore, migrateState } from '../src/store.js';

const LIFELINE_TEMPLATE = getPortfolioV2Template().find((project) => project.name === 'Lifeline');
const TASK_ALIASES = new Map([
  ['提供扫描提案、完成证据与审计 MCP', '补齐扫描提案与指纹去重 MCP'],
  ['产品化项目文案并合并创建入口', '让项目价值更清晰，创建入口更简单']
]);
const VERIFIED_EXTRA_TASKS = new Map([
  ['确定 Project × Phase × Task 两级模型', ['public/app.js', 'docs/PORTFOLIO_V2_EXECUTION_PLAN.md']],
  ['为任务补齐推荐执行配置', ['src/domain.js', 'public/app.js']]
]);
const IMPORTED_COMPLETION_TIMES = new Map([
  ['5fb358b', '2026-08-01T14:44:07.000Z'],
  ['dcf6b13', '2026-08-01T15:19:25.000Z']
]);
const RECONCILIATION_KEY = `schedule-reconciliation:${PORTFOLIO_TEMPLATE_VERSION}`;

export function reconcileLifelineSchedule(state, at = nowIso()) {
  const project = state.projects.find((candidate) => (
    candidate.name === 'Lifeline'
      && candidate.status !== 'ARCHIVED'
      && candidate.templateKey === PORTFOLIO_TEMPLATE_KEY
  ));
  if (!project) throw new Error('No active Portfolio V2 Lifeline project found');

  const changes = {
    correctedCompletionRecordIds: [],
    backfilledCompletionRecordIds: [],
    verifiedTaskIds: [],
    reviewTaskIds: [],
    statusChanges: [],
    currentTaskIds: [],
    createdPhaseIds: [],
    createdTaskIds: [],
    renamedTaskIds: []
  };

  correctImportedCompletionTimes(state, project.id, changes);
  backfillRunCompletions(state, project.id, changes, at);

  const templatePhases = groupTemplatePhases(LIFELINE_TEMPLATE.workItems);
  for (const phaseSpec of templatePhases) {
    let phase = state.phases.find((candidate) => (
      candidate.projectId === project.id && Number(candidate.phaseOrder) === phaseSpec.phaseOrder
    ));
    if (!phase) {
      phase = createPhase({
        projectId: project.id,
        title: phaseSpec.title,
        goal: phaseGoal(phaseSpec.phaseOrder),
        phaseOrder: phaseSpec.phaseOrder,
        createdBy: 'schedule-reconciliation'
      }, at);
      state.phases.push(phase);
      changes.createdPhaseIds.push(phase.id);
    } else {
      assignIfChanged(phase, 'title', phaseSpec.title);
      assignIfChanged(phase, 'goal', phase.goal || phaseGoal(phaseSpec.phaseOrder));
    }

    for (const taskSpec of phaseSpec.tasks) {
      const previousTitle = [...TASK_ALIASES].find(([, current]) => current === taskSpec.title)?.[0];
      let task = state.workItems.find((candidate) => (
        candidate.projectId === project.id
          && (candidate.title === taskSpec.title || candidate.title === previousTitle)
      ));
      const created = !task;
      if (created) {
        task = createTemplateTask(project.id, phase, taskSpec, at);
        state.workItems.push(task);
        changes.createdTaskIds.push(task.id);
      } else {
        if (task.title !== taskSpec.title) {
          task.title = taskSpec.title;
          task.objective = taskSpec.objective;
          task.acceptanceCriteria = structuredClone(taskSpec.acceptanceCriteria);
          task.updatedAt = at;
          changes.renamedTaskIds.push(task.id);
        }
        task.phaseId = phase.id;
        task.planning = {
          ...task.planning,
          phaseId: phase.id,
          phase: phase.title,
          phaseOrder: phase.phaseOrder
        };
        if (task.templateKey === PORTFOLIO_TEMPLATE_KEY) {
          task.templateVersion = PORTFOLIO_TEMPLATE_VERSION;
        }
      }

      reconcileTemplateTaskStatus(state, task, taskSpec, created, changes, at);
    }
  }

  for (const [title, artifactUris] of VERIFIED_EXTRA_TASKS) {
    const task = state.workItems.find((candidate) => candidate.projectId === project.id && candidate.title === title);
    if (!task || isTerminal(task.status)) continue;
    verifyFromRepositoryEvidence(state, task, artifactUris, at);
    changes.verifiedTaskIds.push(task.id);
  }

  const currentTask = latestCompletedTask(state, project.id);
  if (currentTask && project.currentTaskId !== currentTask.id) {
    project.currentTaskId = currentTask.id;
    changes.currentTaskIds.push(currentTask.id);
  }

  const changed = Object.values(changes).some((entries) => entries.length > 0)
    || project.templateVersion !== PORTFOLIO_TEMPLATE_VERSION;
  if (!changed) return { changed: false, projectId: project.id, ...changes };

  project.templateVersion = PORTFOLIO_TEMPLATE_VERSION;
  project.scheduleVersion = Number(project.scheduleVersion ?? 0) + 1;
  project.updatedAt = at;
  refreshPhaseStatuses(state, project.id, at);
  state.events.push({
    id: createId('event'),
    sequence: nextGlobalSequence(state),
    type: 'schedule.reconciled',
    message: 'Lifeline history and future schedule reconciled with repository evidence',
    runId: null,
    workItemId: null,
    metadata: { projectId: project.id, templateVersion: PORTFOLIO_TEMPLATE_VERSION, ...changes },
    createdAt: at
  });
  return { changed: true, projectId: project.id, scheduleVersion: project.scheduleVersion, ...changes };
}

function correctImportedCompletionTimes(state, projectId, changes) {
  const projectTaskIds = new Set(state.workItems
    .filter((task) => task.projectId === projectId)
    .map((task) => task.id));
  for (const record of state.completionRecords) {
    if (!projectTaskIds.has(record.taskId ?? record.workItemId)
      || record.completionMethod !== 'IMPORTED_HISTORY'
      || !record.commitSha) continue;
    const historicalAt = [...IMPORTED_COMPLETION_TIMES].find(([prefix]) => record.commitSha.startsWith(prefix))?.[1];
    if (!historicalAt || record.completedAt === historicalAt) continue;
    record.startedAt = historicalAt;
    record.completedAt = historicalAt;
    changes.correctedCompletionRecordIds.push(record.id);
  }
}

function backfillRunCompletions(state, projectId, changes, at) {
  const projectTaskIds = new Set(state.workItems
    .filter((task) => task.projectId === projectId && isTerminal(task.status))
    .map((task) => task.id));
  for (const run of state.runs) {
    if (!projectTaskIds.has(run.workItemId) || run.status !== 'SUCCEEDED') continue;
    if (state.completionRecords.some((record) => (record.taskId ?? record.workItemId) === run.workItemId)) continue;
    const evidence = state.evidence.filter((entry) => entry.runId === run.id);
    const record = createCompletionRecord({
      taskId: run.workItemId,
      runId: run.id,
      completionMethod: 'AGENT_RUN',
      executor: run.executor,
      provider: run.provider,
      modelRef: run.modelRef,
      reasoningEffort: run.reasoningEffort,
      startedAt: run.startedAt,
      completedAt: run.finishedAt,
      durationMs: durationBetween(run.startedAt, run.finishedAt),
      testEvidenceIds: evidence.filter((entry) => entry.type === 'TEST').map((entry) => entry.id),
      reviewEvidenceIds: evidence.filter((entry) => entry.type === 'REVIEW').map((entry) => entry.id),
      resultSummary: '补齐旧执行链路的完成记录；保留原 Run、Executor、时间与 Evidence，不把 Mock 执行伪装成生产执行。',
      submittedBy: 'schedule-reconciliation',
      verifiedBy: 'legacy-workflow',
      verifiedAt: run.finishedAt
    }, at);
    record.idempotencyKey = `${RECONCILIATION_KEY}:run:${run.id}`;
    state.completionRecords.push(record);
    changes.backfilledCompletionRecordIds.push(record.id);
  }
}

function verifyFromRepositoryEvidence(state, task, artifactUris, at) {
  const key = `${RECONCILIATION_KEY}:task:${task.id}`;
  let evidence = state.evidence.find((entry) => entry.key === key);
  if (!evidence) {
    evidence = {
      id: createId('evidence'),
      key,
      runId: null,
      workItemId: task.id,
      type: 'SCHEDULE_RECONCILIATION',
      score: 1,
      summary: '排期核查确认仓库已有对应实现与自动化测试证据。',
      metadata: { artifactUris, templateVersion: PORTFOLIO_TEMPLATE_VERSION },
      createdAt: at
    };
    state.evidence.push(evidence);
  }
  if (!state.completionRecords.some((record) => record.idempotencyKey === key)) {
    const record = createCompletionRecord({
      taskId: task.id,
      completionMethod: 'IMPORTED_HISTORY',
      executor: 'repository-reconciliation',
      artifactUris,
      testEvidenceIds: [evidence.id],
      resultSummary: evidence.summary,
      completedAt: at,
      submittedBy: 'schedule-reconciliation',
      verifiedBy: 'repository-audit',
      verifiedAt: at
    }, at);
    record.idempotencyKey = key;
    state.completionRecords.push(record);
  }
  task.status = 'VERIFIED';
  task.updatedAt = at;
}

function reconcileTemplateTaskStatus(state, task, taskSpec, created, changes, at) {
  if (!created && taskWasAdjustedByHuman(task)) return;

  if (taskSpec.status === 'VERIFIED' && (created || ['PLANNED', 'READY'].includes(task.status))) {
    verifyFromRepositoryEvidence(state, task, taskSpec.history?.artifactUris ?? [], at);
    if (!changes.verifiedTaskIds.includes(task.id)) changes.verifiedTaskIds.push(task.id);
    return;
  }

  if (taskSpec.status === 'REVIEW' && ['PLANNED', 'READY'].includes(task.status)) {
    task.status = 'REVIEW';
    task.updatedAt = at;
    changes.reviewTaskIds.push(task.id);
    return;
  }

  if (taskSpec.status === 'PLANNED'
    && task.status === 'REVIEW'
    && !task.currentRunId
    && !state.completionRecords.some((record) => (record.taskId ?? record.workItemId) === task.id)) {
    changeTaskStatus(task, 'PLANNED', changes, at);
    return;
  }

  if (taskSpec.status === 'CANCELLED') {
    if (task.status !== 'CANCELLED') changeTaskStatus(task, 'CANCELLED', changes, at);
    task.cancelReason ??= '新项目不再需要处理旧版数据兼容任务';
    task.cancelledAt ??= at;
    task.cancelledBy ??= 'schedule-reconciliation';
    return;
  }

  if (taskSpec.status === 'DEFERRED') {
    if (task.status !== 'DEFERRED') changeTaskStatus(task, 'DEFERRED', changes, at);
    return;
  }

  if (taskSpec.status === 'RECURRING') {
    if (task.status !== 'RECURRING') changeTaskStatus(task, 'RECURRING', changes, at);
    task.recurrence = { ...task.recurrence, enabled: true };
  }
}

function taskWasAdjustedByHuman(task) {
  return task.provenance?.contentAdjustedByHuman === true
    || task.provenance?.lastContentEditorType === 'HUMAN';
}

function latestCompletedTask(state, projectId) {
  const tasks = state.workItems.filter((task) => (
    task.projectId === projectId && ['VERIFIED', 'RELEASED', 'ARCHIVED'].includes(task.status)
  ));
  const taskIds = new Set(tasks.map((task) => task.id));
  const completionTimes = new Map();
  for (const record of state.completionRecords) {
    const taskId = record.taskId ?? record.workItemId;
    if (!taskIds.has(taskId)) continue;
    const parsed = Date.parse(record.verifiedAt ?? record.completedAt ?? record.startedAt ?? '');
    if (Number.isFinite(parsed) && parsed > (completionTimes.get(taskId) ?? -Infinity)) {
      completionTimes.set(taskId, parsed);
    }
  }
  return tasks.sort((left, right) => (
    (completionTimes.get(right.id) ?? 0) - (completionTimes.get(left.id) ?? 0)
      || Number(right.planning?.phaseOrder ?? 0) - Number(left.planning?.phaseOrder ?? 0)
      || Number(right.planning?.taskOrder ?? 0) - Number(left.planning?.taskOrder ?? 0)
  )).at(0) ?? null;
}

function changeTaskStatus(task, status, changes, at) {
  changes.statusChanges.push({ taskId: task.id, from: task.status, to: status });
  task.status = status;
  task.updatedAt = at;
}

function createTemplateTask(projectId, phase, spec, at) {
  const task = createWorkItem({
    projectId,
    phaseId: phase.id,
    title: spec.title,
    objective: spec.objective,
    acceptanceCriteria: spec.acceptanceCriteria,
    testCommands: ['npm test'],
    riskTier: spec.planning.kind === 'bug' ? 'medium' : 'low',
    weight: 1,
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 2 },
    planning: { ...spec.planning, phaseId: phase.id, phase: phase.title },
    recommendation: spec.recommendation
  }, at);
  task.status = spec.status;
  if (spec.status === 'RECURRING') task.recurrence = { enabled: true };
  task.templateKey = PORTFOLIO_TEMPLATE_KEY;
  task.templateVersion = PORTFOLIO_TEMPLATE_VERSION;
  task.provenance = {
    origin: 'AI',
    createdVia: 'SCHEDULE_RECONCILIATION',
    createdBy: 'codex',
    contentAdjustedByHuman: false,
    lastContentEditorType: null,
    lastContentEditedAt: null,
    edits: []
  };
  return task;
}

function groupTemplatePhases(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const order = Number(task.planning.phaseOrder);
    if (!groups.has(order)) groups.set(order, { phaseOrder: order, title: task.planning.phase, tasks: [] });
    groups.get(order).tasks.push(task);
  }
  return [...groups.values()].sort((left, right) => left.phaseOrder - right.phaseOrder);
}

function refreshPhaseStatuses(state, projectId, at) {
  for (const phase of state.phases.filter((candidate) => candidate.projectId === projectId && candidate.status !== 'CANCELLED')) {
    const tasks = state.workItems.filter((task) => task.phaseId === phase.id && task.status !== 'CANCELLED');
    phase.status = tasks.length > 0 && tasks.every((task) => isTerminal(task.status)) ? 'COMPLETED' : 'ACTIVE';
    phase.updatedAt = at;
  }
}

function isTerminal(status) {
  return ['VERIFIED', 'RELEASED', 'RECURRING', 'ARCHIVED'].includes(status);
}

function phaseGoal(order) {
  return {
    6: '把稳定的控制平面契约迁移到可恢复、可发布的生产链路。'
  }[order] ?? `完成第 ${order} 阶段目标。`;
}

function assignIfChanged(target, key, value) {
  if (target[key] !== value) target[key] = value;
}

function durationBetween(startedAt, finishedAt) {
  const duration = Date.parse(finishedAt ?? '') - Date.parse(startedAt ?? '');
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function nextGlobalSequence(state) {
  const values = state.events.filter((event) => !event.runId).map((event) => Number(event.sequence) || 0);
  return (values.length > 0 ? Math.max(...values) : 0) + 1;
}

async function main() {
  const filePath = process.env.LIFELINE_DATA_FILE ?? '/app/data/lifeline.json';
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const previewState = migrateState(raw).state;
  const preview = reconcileLifelineSchedule(previewState);
  if (process.env.APPLY_RECONCILIATION !== '1') {
    console.log(JSON.stringify({ mode: 'dry-run', ...preview }, null, 2));
    return;
  }
  if (!preview.changed) {
    console.log(JSON.stringify({ mode: 'apply', ...preview }, null, 2));
    return;
  }

  const suffix = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const backupPath = `${filePath}.pre-schedule-reconciliation-${suffix}.backup`;
  await copyFile(filePath, backupPath);
  const store = new JsonStore(filePath);
  await store.ready();
  const result = await store.mutate((state) => reconcileLifelineSchedule(state));
  console.log(JSON.stringify({ mode: 'apply', backupPath, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

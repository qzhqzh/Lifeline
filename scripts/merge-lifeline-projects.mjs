import { copyFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createId, nowIso } from '../src/domain.js';
import { getPortfolioV2Template } from '../src/portfolio-v2-template.js';
import { JsonStore, migrateState } from '../src/store.js';

const TEMPLATE_KEY = 'portfolio-v2-real-projects';
const PROJECT_COPY = new Map(getPortfolioV2Template().map((project) => [project.name, {
  headline: project.headline,
  description: project.description,
  templateVersion: project.templateVersion
}]));

const TARGET_PHASE_BY_TASK = new Map([
  ['理解现有控制平面与首页链路', 1],
  ['确定 Project × Phase × Task 两级模型', 2],
  ['为任务补齐推荐执行配置', 2],
  ['修复扫描发现的首页布局问题', 3],
  ['桌面与移动端真实渲染验收', 3],
  ['周期扫描仓库 Bug 并回填待处理任务', 5]
]);

const DUPLICATE_ALIASES = new Map([
  ['实现纵向项目、横向阶段的推进总览', '实现 Project × Phase × Task 组合大板']
]);

export function mergeLifelineProjects(state) {
  const now = nowIso();
  const copyChanged = applyProductCopy(state, now);
  const archivedDemoProjectIds = archiveObsoleteDemoProjects(state, now);
  const active = state.projects.filter((project) => project.name === 'Lifeline' && project.status !== 'ARCHIVED');
  if (active.length === 0) throw new Error('No active Lifeline project found');

  const target = active
    .slice()
    .sort((left, right) => projectScore(state, right) - projectScore(state, left))[0];
  const sources = active.filter((project) => project.id !== target.id);
  const targetPhases = state.phases
    .filter((phase) => phase.projectId === target.id && phase.status !== 'CANCELLED')
    .sort((left, right) => Number(left.phaseOrder) - Number(right.phaseOrder));
  if (targetPhases.length === 0) throw new Error(`Target Lifeline project has no phases: ${target.id}`);

  const movedTaskIds = [];
  const skippedTaskIds = [];
  const targetTasks = () => state.workItems.filter((task) => task.projectId === target.id);

  for (const source of sources) {
    const sourceTasks = state.workItems.filter((task) => task.projectId === source.id);
    for (const task of sourceTasks) {
      const duplicateTitle = DUPLICATE_ALIASES.get(task.title) ?? task.title;
      if (targetTasks().some((candidate) => candidate.title === duplicateTitle)) {
        skippedTaskIds.push(task.id);
        continue;
      }

      const preferredOrder = TARGET_PHASE_BY_TASK.get(task.title) ?? Number(task.planning?.phaseOrder ?? 1);
      const phase = targetPhases.find((candidate) => Number(candidate.phaseOrder) === preferredOrder)
        ?? targetPhases.at(-1);
      const taskOrder = Math.max(0, ...targetTasks()
        .filter((candidate) => candidate.phaseId === phase.id)
        .map((candidate) => Number(candidate.planning?.taskOrder) || 0)) + 1;
      task.projectId = target.id;
      task.phaseId = phase.id;
      task.planning = {
        ...task.planning,
        phaseId: phase.id,
        phase: phase.title,
        phaseOrder: phase.phaseOrder,
        taskOrder
      };
      task.mergedFromProjectId = source.id;
      task.mergedAt = now;
      task.updatedAt = now;
      movedTaskIds.push(task.id);
    }

    source.status = 'ARCHIVED';
    source.mergedIntoProjectId = target.id;
    source.mergedAt = now;
    source.updatedAt = now;
    for (const conflict of state.migrationConflicts.filter((entry) => (
      entry.sourceProjectId === source.id && !entry.resolvedAt
    ))) {
      conflict.resolvedAt = now;
      conflict.resolution = 'MERGED_INTO_TEMPLATE_PROJECT';
      conflict.targetProjectId = target.id;
    }
  }

  const cleanup = cleanupTargetDuplicates(state, target, now);
  const scheduleChanged = movedTaskIds.length > 0 || cleanup.cleanedTaskIds.length > 0;
  const changed = copyChanged || sources.length > 0 || archivedDemoProjectIds.length > 0 || scheduleChanged;
  if (!changed) {
    return {
      changed: false,
      targetProjectId: target.id,
      movedTaskIds,
      skippedTaskIds,
      cleanedTaskIds: [],
      cancelledPhaseIds: [],
      archivedProjectIds: [],
      archivedDemoProjectIds: []
    };
  }

  target.templateKey = target.templateKey ?? TEMPLATE_KEY;
  if (scheduleChanged) target.scheduleVersion = Number(target.scheduleVersion ?? 0) + 1;
  if (scheduleChanged || sources.length > 0) target.updatedAt = now;
  for (const phase of state.phases.filter((entry) => entry.projectId === target.id && entry.status !== 'CANCELLED')) {
    const phaseTasks = targetTasks().filter((task) => task.phaseId === phase.id && task.status !== 'CANCELLED');
    phase.status = phaseTasks.length > 0 && phaseTasks.every((task) => ['VERIFIED', 'RELEASED', 'RECURRING', 'ARCHIVED'].includes(task.status))
      ? 'COMPLETED'
      : 'ACTIVE';
    phase.updatedAt = now;
  }

  state.events.push({
    id: createId('event'),
    sequence: nextGlobalSequence(state),
    type: sources.length > 0 ? 'project.merged' : 'portfolio.cleaned',
    message: sources.length > 0
      ? 'Duplicate Lifeline projects merged into the complete schedule'
      : 'Obsolete demo data removed from the active portfolio',
    runId: null,
    workItemId: null,
    metadata: {
      targetProjectId: target.id,
      sourceProjectIds: sources.map((project) => project.id),
      movedTaskIds,
      skippedTaskIds,
      cleanedTaskIds: cleanup.cleanedTaskIds,
      cancelledPhaseIds: cleanup.cancelledPhaseIds,
      archivedDemoProjectIds
    },
    createdAt: now
  });

  return {
    changed: true,
    targetProjectId: target.id,
    movedTaskIds,
    skippedTaskIds,
    cleanedTaskIds: cleanup.cleanedTaskIds,
    cancelledPhaseIds: cleanup.cancelledPhaseIds,
    archivedProjectIds: sources.map((project) => project.id),
    archivedDemoProjectIds
  };
}

function projectScore(state, project) {
  const taskCount = state.workItems.filter((task) => task.projectId === project.id).length;
  return (project.templateKey === TEMPLATE_KEY ? 10_000 : 0) + taskCount;
}

function applyProductCopy(state, now) {
  let changed = false;
  for (const project of state.projects) {
    const copy = PROJECT_COPY.get(project.name);
    if (!copy || project.status === 'ARCHIVED') continue;
    if (project.headline === copy.headline
      && project.description === copy.description
      && project.templateVersion === copy.templateVersion) continue;
    project.headline = copy.headline;
    project.description = copy.description;
    project.templateVersion = copy.templateVersion;
    project.updatedAt = now;
    changed = true;
  }
  return changed;
}

function archiveObsoleteDemoProjects(state, now) {
  const aliases = new Map([
    ['Release Radar · 示例', 'EchoMe'],
    ['Release Radar', 'EchoMe'],
    ['Knowledge Lab · 示例', 'Totemora'],
    ['Knowledge Lab', 'Totemora']
  ]);
  const archived = [];
  for (const project of state.projects) {
    const replacementName = aliases.get(project.name);
    if (!replacementName || project.status === 'ARCHIVED') continue;
    const replacement = state.projects.find((candidate) => (
      candidate.name === replacementName && candidate.status !== 'ARCHIVED'
    ));
    if (!replacement) continue;
    project.status = 'ARCHIVED';
    project.mergedIntoProjectId = replacement.id;
    project.mergedAt = now;
    project.updatedAt = now;
    archived.push(project.id);
  }
  return archived;
}

function cleanupTargetDuplicates(state, target, now) {
  const cleanedTaskIds = [];
  const touchedPhaseIds = new Set();
  for (const [duplicateTitle, canonicalTitle] of DUPLICATE_ALIASES) {
    const canonical = state.workItems.find((task) => (
      task.projectId === target.id && task.title === canonicalTitle && task.status !== 'CANCELLED'
    ));
    if (!canonical) continue;
    const duplicates = state.workItems.filter((task) => (
      task.projectId === target.id && task.title === duplicateTitle && task.status !== 'CANCELLED'
    ));
    for (const duplicate of duplicates) {
      const hasHistory = (state.runs ?? []).some((run) => run.workItemId === duplicate.id)
        || (state.completionRecords ?? []).some((record) => (record.taskId ?? record.workItemId) === duplicate.id)
        || (state.evidence ?? []).some((entry) => entry.workItemId === duplicate.id);
      if (hasHistory) continue;
      duplicate.status = 'CANCELLED';
      duplicate.cancelReason = `Merged into canonical task ${canonical.id}`;
      duplicate.cancelledAt = now;
      duplicate.updatedAt = now;
      cleanedTaskIds.push(duplicate.id);
      if (duplicate.phaseId) touchedPhaseIds.add(duplicate.phaseId);
    }
  }

  const cancelledPhaseIds = [];
  for (const phaseId of touchedPhaseIds) {
    const remaining = state.workItems.some((task) => (
      task.projectId === target.id && task.phaseId === phaseId && task.status !== 'CANCELLED'
    ));
    if (remaining) continue;
    const phase = state.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) continue;
    phase.status = 'CANCELLED';
    phase.updatedAt = now;
    cancelledPhaseIds.push(phase.id);
  }
  return { cleanedTaskIds, cancelledPhaseIds };
}

function nextGlobalSequence(state) {
  const values = state.events.filter((event) => !event.runId).map((event) => Number(event.sequence) || 0);
  return (values.length > 0 ? Math.max(...values) : 0) + 1;
}

async function main() {
  const filePath = process.env.LIFELINE_DATA_FILE ?? '/app/data/lifeline.json';
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const previewState = migrateState(raw).state;
  const preview = mergeLifelineProjects(previewState);
  if (process.env.APPLY_MERGE !== '1') {
    console.log(JSON.stringify({ mode: 'dry-run', ...preview }, null, 2));
    return;
  }
  if (!preview.changed) {
    console.log(JSON.stringify({ mode: 'apply', ...preview }, null, 2));
    return;
  }

  const suffix = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const backupPath = `${filePath}.pre-lifeline-merge-${suffix}.backup`;
  await copyFile(filePath, backupPath);
  const store = new JsonStore(filePath);
  await store.ready();
  const result = await store.mutate((state) => mergeLifelineProjects(state));
  console.log(JSON.stringify({ mode: 'apply', backupPath, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

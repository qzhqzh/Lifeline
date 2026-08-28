export const MAX_CELL_PREVIEW = 3;

export const CLIENT_COLUMNS = Object.freeze([
  { id: 'pending', label: '待确认', tone: 'warning' },
  { id: 'scheduled', label: '已排期', tone: 'info' },
  { id: 'running', label: '进行中', tone: 'active' },
  { id: 'review', label: '待验收', tone: 'success' }
]);

const COMPLETED_STATUSES = new Set(['VERIFIED', 'RELEASED', 'ARCHIVED']);
const HIDDEN_STATUSES = new Set(['CANCELLED']);

export function taskClientStatus(task) {
  const status = task?.effectiveStatus ?? task?.status ?? 'PLANNED';
  if (HIDDEN_STATUSES.has(status)) return null;
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  if (status === 'REVIEW') return 'review';
  if (status === 'RUNNING') return 'running';
  if (status === 'DEFERRED' || task?.planning?.commitment !== 'COMMITTED') return 'pending';
  return 'scheduled';
}

export function isCompletedTask(task) {
  return taskClientStatus(task) === 'completed';
}

export function clientMoveTargets(task) {
  const currentStatusId = taskClientStatus(task);
  return CLIENT_COLUMNS.some((column) => column.id === currentStatusId)
    ? CLIENT_COLUMNS.map((column) => column.id)
    : [];
}

export function canClientMoveTask(task, { phaseId, statusId } = {}) {
  const taskPhaseId = task?.phaseId ?? task?.planning?.phaseId;
  return clientMoveTargets(task).includes(statusId)
    && (taskPhaseId !== phaseId || taskClientStatus(task) !== statusId);
}

export function buildClientBoard(schedule) {
  const phases = [...(schedule?.phases ?? [])]
    .filter((phase) => phase?.status !== 'CANCELLED')
    .sort((left, right) => (
      Number(left.phaseOrder ?? 0) - Number(right.phaseOrder ?? 0)
      || String(left.title).localeCompare(String(right.title), 'zh-CN')
    ));

  const rows = phases.map((phase) => {
    const tasks = (phase.tasks ?? []).filter((task) => taskClientStatus(task));
    const cells = Object.fromEntries(CLIENT_COLUMNS.map((column) => {
      const matching = tasks.filter((task) => taskClientStatus(task) === column.id);
      return [column.id, {
        total: matching.length,
        preview: matching.slice(0, MAX_CELL_PREVIEW),
        tasks: matching
      }];
    }));
    return { phase, tasks, cells };
  });

  const allTasks = rows.flatMap((row) => row.tasks);
  const completed = allTasks.filter(isCompletedTask);
  const columnTotals = Object.fromEntries(CLIENT_COLUMNS.map((column) => [
    column.id,
    allTasks.filter((task) => taskClientStatus(task) === column.id).length
  ]));

  return { phases, rows, allTasks, completed, columnTotals };
}

export function projectProgress(tasks) {
  const visible = (tasks ?? []).filter((task) => taskClientStatus(task));
  const completed = visible.filter(isCompletedTask).length;
  return {
    completed,
    total: visible.length,
    percent: visible.length === 0 ? 0 : Math.round((completed / visible.length) * 100)
  };
}

export function currentClientPhase(schedule) {
  const phases = [...(schedule?.phases ?? [])]
    .filter((phase) => phase?.status !== 'CANCELLED')
    .sort((left, right) => Number(left.phaseOrder ?? 0) - Number(right.phaseOrder ?? 0));
  const currentTaskId = schedule?.project?.currentTaskId;
  const taskPhase = currentTaskId
    ? phases.find((phase) => (phase.tasks ?? []).some((task) => task.id === currentTaskId))
    : null;
  if (taskPhase) return taskPhase;
  return phases.find((phase) => ['ACTIVE', 'REVIEW'].includes(phase.computedStatus))
    ?? phases.find((phase) => phase.computedStatus !== 'COMPLETED')
    ?? phases.at(-1)
    ?? null;
}

export function latestCompletedClientTask(tasks) {
  return (tasks ?? [])
    .filter(isCompletedTask)
    .sort((left, right) => (
      (parseDate(taskCompletionDate(right))?.getTime() ?? 0)
      - (parseDate(taskCompletionDate(left))?.getTime() ?? 0)
    ))[0] ?? null;
}

export function taskDueDate(task) {
  return task?.scheduledFor ?? null;
}

export function taskCompletionDate(task) {
  return task?.latestCompletion?.completedAt
    ?? task?.currentRun?.finishedAt
    ?? task?.updatedAt
    ?? task?.createdAt
    ?? null;
}

export function isOverdue(task, now = new Date()) {
  const due = parseDate(taskDueDate(task));
  if (!due || isCompletedTask(task)) return false;
  return due.getTime() < startOfDay(now).getTime();
}

export function isDueWithinDays(task, days, now = new Date()) {
  const due = parseDate(taskDueDate(task));
  if (!due || isCompletedTask(task)) return false;
  const start = startOfDay(now).getTime();
  const end = start + Math.max(0, Number(days)) * 86_400_000;
  return due.getTime() >= start && due.getTime() <= end;
}

export function filterClientTasks(tasks, {
  query = '',
  due = 'all',
  phaseId = 'all',
  range = 'all',
  completionStatus = 'all',
  now = new Date()
} = {}) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase('zh-CN');
  return (tasks ?? []).filter((task) => {
    if (phaseId !== 'all' && task.phaseId !== phaseId) return false;
    if (normalizedQuery && ![
      task.title,
      task.objective,
      task.planning?.phase,
      task.issue
    ].some((value) => String(value ?? '').toLocaleLowerCase('zh-CN').includes(normalizedQuery))) return false;
    if (due === 'overdue' && !isOverdue(task, now)) return false;
    if (due === 'week' && !isDueWithinDays(task, 7, now)) return false;
    if (completionStatus !== 'all' && (task.effectiveStatus ?? task.status) !== completionStatus) return false;
    if (range !== 'all') {
      const completedAt = parseDate(taskCompletionDate(task));
      if (!completedAt) return false;
      const cutoff = range === 'month'
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getTime() - 7 * 86_400_000);
      if (completedAt.getTime() < cutoff.getTime()) return false;
    }
    return true;
  });
}

export function sortByUrgency(tasks, now = new Date()) {
  return [...(tasks ?? [])].sort((left, right) => {
    const leftOverdue = isOverdue(left, now) ? 0 : 1;
    const rightOverdue = isOverdue(right, now) ? 0 : 1;
    if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue;
    const leftDue = parseDate(taskDueDate(left))?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightDue = parseDate(taskDueDate(right))?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return leftDue - rightDue || String(left.title).localeCompare(String(right.title), 'zh-CN');
  });
}

export function groupCompletedTasks(tasks, now = new Date()) {
  const currentWeek = startOfWeek(now).getTime();
  const previousWeek = currentWeek - 7 * 86_400_000;
  const groups = new Map();

  for (const task of [...(tasks ?? [])].sort((left, right) => (
    Date.parse(taskCompletionDate(right) ?? 0) - Date.parse(taskCompletionDate(left) ?? 0)
  ))) {
    const completedAt = parseDate(taskCompletionDate(task));
    let key = 'unknown';
    let label = '时间未记录';
    if (completedAt) {
      const week = startOfWeek(completedAt).getTime();
      if (week === currentWeek) {
        key = 'current-week';
        label = '本周';
      } else if (week === previousWeek) {
        key = 'previous-week';
        label = '上周';
      } else {
        key = `${completedAt.getFullYear()}-${completedAt.getMonth() + 1}`;
        label = `${completedAt.getFullYear()}年${completedAt.getMonth() + 1}月`;
      }
    }
    if (!groups.has(key)) groups.set(key, { key, label, tasks: [] });
    groups.get(key).tasks.push(task);
  }

  return [...groups.values()];
}

function parseDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(value) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(value) {
  const date = startOfDay(value);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return date;
}

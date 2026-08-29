import {
  CLIENT_COLUMNS,
  buildClientBoard,
  canClientMoveTask,
  clientMoveTargets,
  currentClientPhase,
  filterClientTasks,
  groupCompletedTasks,
  isCompletedTask,
  isDueWithinDays,
  isOverdue,
  latestCompletedClientTask,
  projectProgress,
  sortByUrgency,
  taskClientStatus,
  taskCompletionDate,
  taskDueDate
} from './client-data.js';

import { clearProjectAccessToken, projectAccessHeaders } from './project-access.js';

const state = {
  projects: [],
  access: null,
  selectedProjectId: new URLSearchParams(window.location.search).get('project'),
  schedule: null,
  board: null,
  view: readView(),
  requestedSection: readRequestedSection(),
  archive: {
    query: '',
    phaseId: 'all',
    range: 'all',
    completionStatus: 'all',
    page: 1
  },
  drawer: null,
  dragTaskId: null,
  dragTarget: null,
  dragScroll: null,
  pointerDrag: null,
  suppressMoveClickUntil: 0,
  moveTaskId: null,
  moveReturnFocus: null,
  movingTaskId: null,
  locateTimer: null,
  collapsedPhaseIds: new Set(),
  collapsedProjectId: null,
  loading: true
};

const elements = {
  main: document.querySelector('#clientMain'),
  projectSelect: document.querySelector('#projectSelect'),
  projectProgressNavLink: document.querySelector('#projectProgressNavLink'),
  testMapNavLink: document.querySelector('#testMapNavLink'),
  canvasNavLink: document.querySelector('#canvasNavLink'),
  taskDrawer: document.querySelector('#taskDrawer'),
  drawerContent: document.querySelector('#drawerContent'),
  openRequestDialog: document.querySelector('#openRequestDialog'),
  requestDialog: document.querySelector('#requestDialog'),
  requestForm: document.querySelector('#requestForm'),
  requestPhase: document.querySelector('#requestPhase'),
  closeRequestDialog: document.querySelector('#closeRequestDialog'),
  cancelRequest: document.querySelector('#cancelRequest'),
  moveTaskDialog: document.querySelector('#moveTaskDialog'),
  moveTaskForm: document.querySelector('#moveTaskForm'),
  moveTaskName: document.querySelector('#moveTaskName'),
  moveTaskPhase: document.querySelector('#moveTaskPhase'),
  moveTaskStatus: document.querySelector('#moveTaskStatus'),
  moveTaskSubmit: document.querySelector('#moveTaskSubmit'),
  closeMoveTaskDialog: document.querySelector('#closeMoveTaskDialog'),
  cancelMoveTask: document.querySelector('#cancelMoveTask'),
  toast: document.querySelector('#clientToast')
};

let toastTimer = null;

elements.projectSelect.addEventListener('change', async () => {
  state.selectedProjectId = elements.projectSelect.value;
  updateUrl({ projectId: state.selectedProjectId, view: state.view }, { replace: false });
  await loadSelectedProject();
});

elements.main.addEventListener('click', async (event) => {
  const moveHandle = event.target.closest('[data-client-move-task]');
  if (moveHandle) {
    if (event.detail > 0 && Date.now() < state.suppressMoveClickUntil) return;
    openMoveTaskDialog(taskFor(moveHandle.dataset.clientMoveTask), moveHandle);
    return;
  }
  const milestone = event.target.closest('[data-locate-phase]');
  if (milestone) {
    locateBoardPhase(milestone.dataset.locatePhase);
    return;
  }
  const laneToggle = event.target.closest('[data-toggle-lane]');
  if (laneToggle) {
    toggleLane(laneToggle.dataset.phaseId);
    return;
  }
  if (event.target.closest('[data-toggle-all-lanes]')) {
    toggleAllLanes();
    return;
  }
  const openTasks = event.target.closest('[data-open-tasks]');
  if (openTasks) {
    openTaskList(openTasks.dataset.phaseId, openTasks.dataset.statusId);
    return;
  }
  const taskDetail = event.target.closest('[data-task-detail]');
  if (taskDetail) {
    await openTaskDetails(taskDetail.dataset.taskDetail);
    return;
  }
  if (event.target.closest('[data-view-archive]')) {
    navigateToView('archive');
    return;
  }
  if (event.target.closest('[data-back-board]')) {
    navigateToView('board');
    return;
  }
  const archivePreset = event.target.closest('[data-archive-preset]');
  if (archivePreset) {
    applyArchivePreset(archivePreset.dataset.archivePreset);
    return;
  }
  const archivePage = event.target.closest('[data-archive-page]');
  if (archivePage) {
    state.archive.page = Number(archivePage.dataset.archivePage) || 1;
    renderArchiveRows();
    return;
  }
  if (event.target.closest('[data-retry-load]')) {
    await loadProjects();
    return;
  }
  if (event.target.closest('[data-export-archive]')) {
    exportArchive();
  }
});

elements.main.addEventListener('dragstart', (event) => {
  const dragSurface = event.target.closest('[data-client-draggable="true"]');
  const card = dragSurface?.closest('.client-task-card');
  const task = dragSurface ? taskFor(dragSurface.dataset.taskId) : null;
  if (!card || !task || !beginClientDrag(task, card)) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', task.id);
});

elements.main.addEventListener('dragover', (event) => {
  const task = taskFor(state.dragTaskId);
  if (!task) return;
  updateClientDragAutoScroll(event);
  const cell = event.target.closest('[data-client-drop-status]');
  const isValidCell = cell && canClientMoveTask(task, {
    phaseId: cell.dataset.phaseId,
    statusId: cell.dataset.clientDropStatus
  });
  if (!isValidCell) {
    if (cell) setActiveClientDropTarget(null);
    if (!state.dragTarget || !event.target.closest('.board-viewport')) return;
  } else {
    setActiveClientDropTarget(cell);
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});

elements.main.addEventListener('drop', async (event) => {
  const directCell = event.target.closest('[data-client-drop-status]');
  const taskId = event.dataTransfer.getData('text/plain') || state.dragTaskId;
  const task = taskFor(taskId);
  const cell = directCell && task && canClientMoveTask(task, {
    phaseId: directCell.dataset.phaseId,
    statusId: directCell.dataset.clientDropStatus
  }) ? directCell : activeClientDropTarget();
  if (!cell || !task || !canClientMoveTask(task, {
    phaseId: cell.dataset.phaseId,
    statusId: cell.dataset.clientDropStatus
  })) return;
  event.preventDefault();
  const target = clientDropTarget(cell);
  cleanupClientDrag();
  await moveClientTask(task, target);
});

elements.main.addEventListener('dragend', cleanupClientDrag);

elements.main.addEventListener('pointerdown', beginPointerTaskDrag);
elements.main.addEventListener('pointermove', updatePointerTaskDrag);
elements.main.addEventListener('pointerup', finishPointerTaskDrag);
elements.main.addEventListener('pointercancel', cancelPointerTaskDrag);

elements.main.addEventListener('input', (event) => {
  if (event.target.id !== 'archiveSearch') return;
  state.archive.query = event.target.value;
  state.archive.page = 1;
  renderArchiveRows();
});

elements.main.addEventListener('change', (event) => {
  const key = event.target.dataset.archiveFilter;
  if (!key) return;
  state.archive[key] = event.target.value;
  state.archive.page = 1;
  renderArchiveRows();
});

elements.taskDrawer.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeTaskDrawer();
});

elements.taskDrawer.addEventListener('click', async (event) => {
  if (event.target === elements.taskDrawer) {
    closeTaskDrawer();
    return;
  }
  if (event.target.closest('[data-close-drawer]')) {
    closeTaskDrawer();
    return;
  }
  if (event.target.closest('[data-drawer-back]')) {
    state.drawer = state.drawer?.previous ?? null;
    if (state.drawer) renderTaskDrawer();
    else closeTaskDrawer();
    return;
  }
  const dueFilter = event.target.closest('[data-drawer-due]');
  if (dueFilter && state.drawer?.type === 'list') {
    state.drawer.due = dueFilter.dataset.drawerDue;
    renderTaskDrawer();
    return;
  }
  const confirm = event.target.closest('[data-confirm-task]');
  if (confirm) {
    await updateClientDecision(confirm.dataset.confirmTask, 'confirm');
    return;
  }
  const requestChanges = event.target.closest('[data-request-changes]');
  if (requestChanges && state.drawer?.type === 'list') {
    state.drawer.feedbackTaskId = requestChanges.dataset.requestChanges;
    renderTaskDrawer();
    document.querySelector('#drawerFeedback')?.focus();
    return;
  }
  if (event.target.closest('[data-cancel-feedback]') && state.drawer?.type === 'list') {
    state.drawer.feedbackTaskId = null;
    renderTaskDrawer();
    return;
  }
  const taskDetail = event.target.closest('[data-task-detail]');
  if (taskDetail) await openTaskDetails(taskDetail.dataset.taskDetail);
});

elements.taskDrawer.addEventListener('input', (event) => {
  if (event.target.id !== 'drawerSearch' || state.drawer?.type !== 'list') return;
  state.drawer.query = event.target.value;
  const cursor = event.target.selectionStart;
  renderTaskDrawer();
  const input = document.querySelector('#drawerSearch');
  input?.focus();
  input?.setSelectionRange(cursor, cursor);
});

elements.taskDrawer.addEventListener('submit', async (event) => {
  if (!event.target.matches('[data-feedback-form]')) return;
  event.preventDefault();
  const note = new FormData(event.target).get('feedback')?.toString().trim();
  if (!note) {
    notify('请说明需要调整的内容', true);
    return;
  }
  await updateClientDecision(event.target.dataset.feedbackForm, 'changes', note);
});

elements.openRequestDialog.addEventListener('click', openRequestDialog);
elements.closeRequestDialog.addEventListener('click', closeRequestDialog);
elements.cancelRequest.addEventListener('click', closeRequestDialog);
elements.requestDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeRequestDialog();
});
elements.requestDialog.addEventListener('click', (event) => {
  if (event.target === elements.requestDialog) closeRequestDialog();
});
elements.requestForm.addEventListener('submit', submitRequest);

elements.closeMoveTaskDialog.addEventListener('click', closeMoveTaskDialog);
elements.cancelMoveTask.addEventListener('click', closeMoveTaskDialog);
elements.moveTaskDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeMoveTaskDialog();
});
elements.moveTaskDialog.addEventListener('click', (event) => {
  if (event.target === elements.moveTaskDialog) closeMoveTaskDialog();
});
elements.moveTaskForm.addEventListener('change', updateMoveTaskSubmitState);
elements.moveTaskForm.addEventListener('submit', submitMoveTask);

window.addEventListener('popstate', async () => {
  const params = new URLSearchParams(window.location.search);
  const nextProjectId = params.get('project');
  state.view = readView();
  state.requestedSection = readRequestedSection();
  if (nextProjectId !== state.selectedProjectId) {
    state.selectedProjectId = nextProjectId;
    await loadSelectedProject();
  } else {
    render();
  }
});

await loadProjects();

async function loadProjects() {
  state.loading = true;
  try {
    const response = await api('/api/projects');
    state.projects = response.items ?? [];
    state.access = response.access ?? null;
    if (state.projects.length === 0) {
      state.selectedProjectId = null;
      renderEmptyPortfolio();
      return;
    }
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
      state.selectedProjectId = state.projects[0].id;
      updateUrl({ projectId: state.selectedProjectId, view: state.view }, { replace: true });
    }
    renderProjectOptions();
    await loadSelectedProject();
  } catch (error) {
    renderError(error);
  } finally {
    state.loading = false;
  }
}

async function loadSelectedProject({ quiet = false, viewState = null } = {}) {
  if (!state.selectedProjectId) return;
  if (!quiet) renderLoading();
  try {
    const schedule = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/schedule`);
    state.schedule = schedule;
    state.board = buildClientBoard(schedule);
    syncCollapsedLaneState();
    renderProjectOptions();
    renderRequestPhaseOptions();
    render();
    restoreClientViewState(viewState);
  } catch (error) {
    renderError(error);
  }
}

function render() {
  elements.openRequestDialog.hidden = !canProjectWrite();
  if (!state.schedule || !state.board) return;
  document.title = `${state.schedule.project.name} · Lifeline 客户项目`;
  elements.main.innerHTML = state.view === 'archive' ? renderArchivePage() : renderBoardPage();
  requestAnimationFrame(() => {
    alignCurrentMilestone();
    if (!state.requestedSection || state.view !== 'board') return;
    const section = state.requestedSection;
    state.requestedSection = null;
    scrollToSection(section);
  });
}

function renderBoardPage() {
  const { project } = state.schedule;
  const progress = projectProgress(state.board.allTasks);
  const currentPhase = currentClientPhase(state.schedule);
  const currentProgress = projectProgress(currentPhase?.tasks ?? []);
  const currentDate = phaseMilestoneDate(currentPhase);
  const latestDelivery = latestCompletedClientTask(state.board.allTasks);
  const latestDeliveryPhase = phaseForTask(latestDelivery);
  const attention = projectAttentionSummary();
  const monthCompleted = state.board.completed.filter((task) => isInCurrentMonth(taskCompletionDate(task))).length;
  return `
    <div class="project-page">
      <section class="project-summary" id="overview">
        <div class="project-copy">
          <h1>${escapeHtml(project.name)}</h1>
          <p>${escapeHtml(project.headline ?? project.description ?? '客户共享项目进度')}</p>
        </div>
        <div class="project-facts" aria-label="项目概况">
          <span><i class="health-dot${projectNeedsAttention(project) ? ' attention' : ''}"></i>${escapeHtml(projectHealthLabel(project))}</span>
          <span><strong>${progress.percent}%</strong></span>
          ${currentDate ? `<span class="project-date">当前节点计划 ${escapeHtml(formatDate(currentDate))}</span>` : ''}
        </div>
        <dl class="progress-briefing" aria-label="项目进展摘要">
          <div>
            <dt>当前节点</dt>
            <dd><strong>${escapeHtml(currentPhase?.title ?? '尚未排期')}</strong></dd>
            ${currentPhase ? `<dd>${currentProgress.completed}/${currentProgress.total} 项完成</dd>` : ''}
          </div>
          <div${attention.tone === 'warning' ? ' class="attention"' : ''}>
            <dt>需要关注</dt>
            <dd><strong>${escapeHtml(attention.headline)}</strong></dd>
          </div>
          <div>
            <dt>最近交付</dt>
            <dd><strong>${escapeHtml(latestDelivery?.title ?? '暂无交付')}</strong></dd>
            ${latestDelivery ? `<dd>${escapeHtml(formatDate(taskCompletionDate(latestDelivery)))} · ${escapeHtml(latestDeliveryPhase?.title ?? '未分组')}</dd>` : ''}
          </div>
        </dl>
      </section>

      <section class="milestone-section" id="timeline" aria-label="项目时间线">
        ${renderMilestones()}
      </section>

      <section class="board-region" id="tasks" aria-label="客户任务看板">
        <div class="board-viewport" tabindex="0" aria-label="滚动查看全部功能泳道和任务状态">
          ${renderBoardGrid()}
        </div>
        <div class="archive-strip">
          <div class="archive-summary">
            ${svgIcon('archive')}
            <strong>已完成 ${state.board.completed.length} 项</strong>
            <span>· 本月完成 ${monthCompleted} 项</span>
          </div>
          <button class="archive-open" type="button" data-view-archive>
            查看归档 ${svgIcon('arrow-right')}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderMilestones() {
  const phases = state.board.phases;
  if (phases.length === 0) return '<div class="client-empty"><div><p>这个项目还没有可展示的阶段。</p></div></div>';
  const currentPhase = currentClientPhase(state.schedule);
  const completedCount = phases.filter((phase) => phase.computedStatus === 'COMPLETED').length;
  return `
    <header class="milestone-header">
      <h2>项目时间线</h2>
      <span>${completedCount}/${phases.length} 个阶段已完成</span>
    </header>
    <div class="milestone-scroll">
      <div class="milestone-track" style="--milestone-count:${phases.length}">
        ${phases.map((phase, index) => {
          const completed = phase.computedStatus === 'COMPLETED';
          const current = phase.id === currentPhase?.id;
          const plannedDate = phaseMilestoneDate(phase);
          const completionDate = phaseCompletionDate(phase);
          const delayed = !completed && Boolean(plannedDate) && phaseHasOverdueTask(phase);
          const dateLabel = completed && completionDate
            ? `完成 ${formatDate(completionDate)}`
            : plannedDate
              ? `${delayed ? '原定' : '计划'} ${formatDate(plannedDate)}${delayed ? ' · 已延期' : ''}`
              : null;
          return `
            <button class="milestone-step${completed ? ' completed' : ''}${current ? ' current' : ''}${delayed ? ' delayed' : ''}" type="button" data-locate-phase="${escapeHtml(phase.id)}"${current ? ' data-current-milestone aria-current="step"' : ''} aria-label="定位到 ${escapeHtml(phase.title)} 泳道">
              <span class="milestone-node">${completed ? svgIcon('check') : index + 1}</span>
              <strong>${escapeHtml(phase.title)}</strong>
              ${dateLabel ? `<small>${escapeHtml(dateLabel)}</small>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderBoardGrid() {
  const allCollapsed = areAllLanesCollapsed();
  const rows = state.board.rows.length > 0
    ? state.board.rows.map((row, index) => {
        const collapsed = state.collapsedPhaseIds.has(row.phase.id);
        const activeTotal = activeTaskCount(row);
        const action = collapsed ? '展开' : '折叠';
        return `
          <div class="lane-label${collapsed ? ' is-collapsed' : ''}" data-board-phase-id="${escapeHtml(row.phase.id)}" style="--lane-color:${phaseColor(index)}">
            <button class="lane-toggle" type="button" data-toggle-lane data-phase-id="${escapeHtml(row.phase.id)}" aria-expanded="${!collapsed}" aria-label="${action} ${escapeHtml(row.phase.title)} 功能泳道" title="${escapeHtml(row.phase.title)}">
              <span class="lane-index">${String(index + 1).padStart(2, '0')}</span>
              <strong class="lane-title">${escapeHtml(row.phase.title)}</strong>
              <span class="lane-toggle-meta"><span>${activeTotal} 项</span>${svgIcon(collapsed ? 'chevron-down' : 'chevron-up')}</span>
            </button>
          </div>
          ${CLIENT_COLUMNS.map((column) => renderBoardCell(row, column, collapsed)).join('')}
        `;
      }).join('')
    : `<div class="lane-label"><strong>暂无功能</strong></div>${CLIENT_COLUMNS.map(() => '<div class="lane-cell"></div>').join('')}`;
  const allToggleLabel = allCollapsed ? '展开全部' : '折叠全部';
  return `
    <div class="client-board-grid">
      <div class="board-corner">
        <span>功能泳道</span>
        <button class="lane-collapse-all" type="button" data-toggle-all-lanes aria-label="${allToggleLabel}功能泳道" ${state.board.rows.length === 0 ? 'disabled' : ''}>
          ${svgIcon(allCollapsed ? 'chevron-down' : 'chevron-up')}
          <span>${allToggleLabel}</span>
        </button>
      </div>
      ${CLIENT_COLUMNS.map((column) => `
        <div class="board-column-head">
          <span>${column.label}</span>
          <span class="count-badge">${state.board.columnTotals[column.id]}</span>
        </div>
      `).join('')}
      ${rows}
    </div>
  `;
}

function renderBoardCell(row, column, collapsed = false) {
  const cell = row.cells[column.id];
  const hasOverflow = cell.total > cell.preview.length;
  const dropLabel = `移至 ${row.phase.title} · ${column.label}`;
  return `
    <div class="lane-cell${hasOverflow ? ' has-overflow' : ''}${collapsed ? ' is-collapsed' : ''}" data-board-phase-id="${escapeHtml(row.phase.id)}" data-tone="${column.tone}" data-phase-id="${escapeHtml(row.phase.id)}" data-client-drop-status="${column.id}" data-client-drop-label="${escapeHtml(dropLabel)}">
      <div class="cell-task-list">
        ${cell.preview.length > 0
          ? cell.preview.map((task) => renderTaskCard(task)).join('')
          : ''}
      </div>
      ${hasOverflow
        ? `<button class="cell-more" type="button" data-open-tasks data-phase-id="${escapeHtml(row.phase.id)}" data-status-id="${column.id}">查看全部 ${cell.total} 项 ${svgIcon('arrow-right')}</button>`
        : ''}
      <div class="cell-collapsed-summary" aria-hidden="true">${cell.total > 0 ? `<i></i><span>${cell.total} 项</span>` : ''}</div>
    </div>
  `;
}

function renderTaskCard(task) {
  const due = taskDueDate(task);
  const overdue = isOverdue(task);
  const status = taskClientStatus(task);
  const movable = canProjectWrite() && clientMoveTargets(task).length > 0;
  return `
    <article class="client-task-card${movable ? ' is-draggable' : ''}" data-task-id="${escapeHtml(task.id)}">
      <button class="task-card-content" type="button" data-task-detail="${escapeHtml(task.id)}" data-task-id="${escapeHtml(task.id)}" data-client-draggable="${movable}" draggable="${movable}" aria-label="查看 ${escapeHtml(task.title)}">
        <strong>${escapeHtml(task.title)}</strong>
        ${status === 'pending' && task.status === 'DEFERRED' ? '<small class="task-flags">需调整</small>' : ''}
        ${due ? `<small class="${overdue ? 'overdue' : ''}">${svgIcon('calendar')}${escapeHtml(formatDate(due))}</small>` : ''}
      </button>
      ${movable ? `<button class="task-move-handle" type="button" data-client-move-task="${escapeHtml(task.id)}" aria-label="移动 ${escapeHtml(task.title)}" title="移动任务">${svgIcon('move')}</button>` : ''}
    </article>
  `;
}

function openTaskList(phaseId, statusId) {
  state.drawer = {
    type: 'list',
    phaseId,
    statusId,
    query: '',
    due: 'all',
    feedbackTaskId: null
  };
  renderTaskDrawer();
  if (!elements.taskDrawer.open) elements.taskDrawer.showModal();
}

function renderTaskDrawer() {
  if (!state.drawer) return;
  if (state.drawer.type === 'details') {
    renderTaskDetails();
    return;
  }
  const sourceTasks = tasksForDrawerScope(state.drawer);
  const tasks = sortByUrgency(filterClientTasks(sourceTasks, {
    query: state.drawer.query,
    due: state.drawer.due
  }));
  const phase = state.drawer.phaseId === 'all' ? null : state.board.phases.find((entry) => entry.id === state.drawer.phaseId);
  const column = CLIENT_COLUMNS.find((entry) => entry.id === state.drawer.statusId);
  const context = phase?.title ?? '全部功能';
  const overdueCount = sourceTasks.filter((task) => isOverdue(task)).length;
  const weekCount = sourceTasks.filter((task) => isDueWithinDays(task, 7)).length;
  elements.drawerContent.innerHTML = `
    <div class="drawer-layout">
      <header class="drawer-header">
        <div>
          <p class="drawer-context">${escapeHtml(context)}</p>
          <h2 id="drawerTitle">${escapeHtml(column?.label ?? '任务列表')}任务 <span>${sourceTasks.length} 项</span></h2>
        </div>
        <button class="icon-button" type="button" data-close-drawer aria-label="关闭任务列表">${svgIcon('close')}</button>
      </header>
      <div class="drawer-controls">
        <label class="search-field">
          ${svgIcon('search')}
          <span class="visually-hidden">搜索任务</span>
          <input id="drawerSearch" value="${escapeHtml(state.drawer.query)}" placeholder="搜索任务" autocomplete="off" />
        </label>
        <div class="drawer-filter-row" aria-label="任务期限筛选">
          ${drawerFilterButton('all', '全部', sourceTasks.length)}
          ${overdueCount > 0 ? drawerFilterButton('overdue', '逾期', overdueCount, true) : ''}
          ${weekCount > 0 ? drawerFilterButton('week', '本周到期', weekCount) : ''}
        </div>
      </div>
      <div class="drawer-task-list">
        ${tasks.length > 0 ? tasks.map((task) => renderDrawerTask(task)).join('') : '<div class="drawer-list-empty"><p>没有符合当前筛选的任务。</p></div>'}
      </div>
    </div>
  `;
}

function drawerFilterButton(value, label, count, danger = false) {
  return `<button class="filter-chip${state.drawer.due === value ? ' active' : ''}" type="button" data-drawer-due="${value}">${label} <span class="${danger ? 'danger-count' : ''}">${count}</span></button>`;
}

function renderDrawerTask(task) {
  const due = taskDueDate(task);
  const overdue = isOverdue(task);
  const editablePending = state.drawer.statusId === 'pending' && ['PLANNED', 'READY', 'DEFERRED'].includes(task.status);
  const feedbackOpen = state.drawer.feedbackTaskId === task.id;
  const metadata = [
    state.drawer.phaseId === 'all' ? `<span>${escapeHtml(phaseForTask(task)?.title ?? '未分组')}</span>` : '',
    task.status === 'DEFERRED'
      ? `<span class="overdue">需调整${task.deferReason ? `：${escapeHtml(task.deferReason)}` : ''}</span>`
      : ''
  ].filter(Boolean).join('');
  return `
    <article class="drawer-task-row${task.status === 'DEFERRED' ? ' is-deferred' : ''}">
      <div class="drawer-task-head">
        <strong>${escapeHtml(task.title)}</strong>
        ${due ? `<time class="${overdue ? 'overdue' : ''}">${escapeHtml(formatDate(due))}</time>` : ''}
      </div>
      ${metadata ? `<div class="drawer-task-meta">${metadata}</div>` : ''}
      <div class="drawer-task-actions">
        <button class="button secondary compact" type="button" data-task-detail="${escapeHtml(task.id)}">查看详情</button>
        ${editablePending ? `<button class="button primary compact" type="button" data-confirm-task="${escapeHtml(task.id)}">确认</button>` : ''}
        ${editablePending && task.status !== 'DEFERRED' ? `<button class="button secondary compact" type="button" data-request-changes="${escapeHtml(task.id)}">提出修改</button>` : ''}
      </div>
      ${feedbackOpen ? `
        <form class="drawer-feedback" data-feedback-form="${escapeHtml(task.id)}">
          <label>需要调整什么？
            <textarea id="drawerFeedback" name="feedback" required maxlength="1000" placeholder="说明范围、时间或交付物需要修改的部分"></textarea>
          </label>
          <footer>
            <button class="button secondary compact" type="button" data-cancel-feedback>取消</button>
            <button class="button danger compact" type="submit">提交修改意见</button>
          </footer>
        </form>
      ` : ''}
    </article>
  `;
}

async function openTaskDetails(taskId) {
  const previous = state.drawer ? structuredClone(state.drawer) : null;
  try {
    const details = await api(`/api/work-items/${encodeURIComponent(taskId)}/details`);
    state.drawer = { type: 'details', details, previous };
    renderTaskDrawer();
    if (!elements.taskDrawer.open) elements.taskDrawer.showModal();
  } catch (error) {
    notify(error.message, true);
  }
}

function renderTaskDetails() {
  const details = state.drawer.details;
  const { task, phase } = details;
  const completion = details.completionRecords?.at(-1) ?? null;
  const evidence = details.evidence ?? [];
  const status = taskClientStatus(task);
  const acceptanceStatus = isCompletedTask(task) ? '已验收' : status === 'review' ? '待验收' : null;
  elements.drawerContent.innerHTML = `
    <div class="task-detail">
      <header class="drawer-header">
        <div>
          <p class="drawer-context">${escapeHtml(phase?.title ?? '任务详情')}</p>
          <h2 id="drawerTitle">${escapeHtml(task.title)}</h2>
        </div>
        <div>
          ${state.drawer.previous ? `<button class="icon-button" type="button" data-drawer-back aria-label="返回任务列表">${svgIcon('back')}</button>` : ''}
          <button class="icon-button" type="button" data-close-drawer aria-label="关闭任务详情">${svgIcon('close')}</button>
        </div>
      </header>
      <div class="task-detail-body">
        ${task.objective ? `<p class="task-detail-summary">${escapeHtml(task.objective)}</p>` : ''}
        <dl class="detail-facts">
          <div><dt>功能泳道</dt><dd>${escapeHtml(phase?.title ?? '未分组')}</dd></div>
          <div><dt>客户状态</dt><dd>${escapeHtml(clientStatusLabel(status))}</dd></div>
          ${taskDueDate(task) ? `<div><dt>计划日期</dt><dd>${escapeHtml(formatDate(taskDueDate(task)))}</dd></div>` : ''}
          ${acceptanceStatus ? `<div><dt>验收状态</dt><dd>${acceptanceStatus}</dd></div>` : ''}
        </dl>
        ${completion?.resultSummary ? `<section class="detail-section"><h3>交付摘要</h3><p>${escapeHtml(completion.resultSummary)}</p></section>` : ''}
        ${task.acceptanceCriteria?.length > 0 ? `<section class="detail-section"><h3>验收标准</h3><ul>${task.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}
        ${evidence.length > 0 ? `<section class="detail-section"><h3>验收记录</h3><ul>${evidence.map((item) => `<li>${escapeHtml(item.summary ?? item.type)}</li>`).join('')}</ul></section>` : ''}
        ${task.issue ? `<section class="detail-section"><h3>关联事项</h3><a href="${escapeHtml(safeLink(task.issue))}" target="_blank" rel="noreferrer">${escapeHtml(task.issue)}</a></section>` : ''}
      </div>
    </div>
  `;
}

async function updateClientDecision(taskId, decision, note = '') {
  const task = taskFor(taskId);
  if (!task) return;
  const body = {
    expectedScheduleVersion: state.schedule.scheduleVersion,
    planning: { commitment: decision === 'confirm' ? 'COMMITTED' : 'TENTATIVE' },
    source: { kind: 'customer-board', surface: 'client.html' }
  };
  if (decision === 'confirm' && task.status === 'DEFERRED') {
    body.status = 'PLANNED';
    body.reason = '客户确认后重新排入项目计划';
  }
  if (decision === 'changes') {
    body.status = 'DEFERRED';
    body.reason = note;
  }
  try {
    await api(`/api/work-items/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': mutationKey(`customer-${decision}`) },
      body: JSON.stringify(body)
    });
    await loadSelectedProject({ quiet: true });
    if (state.drawer?.type === 'list') {
      state.drawer.feedbackTaskId = null;
      renderTaskDrawer();
    }
    notify(decision === 'confirm' ? '已确认，任务已进入正式排期' : '修改意见已记录，任务暂缓推进');
  } catch (error) {
    if (error.code === 'SCHEDULE_VERSION_CONFLICT') await loadSelectedProject({ quiet: true });
    notify(error.message, true);
  }
}

async function moveClientTask(task, target) {
  const phase = state.board.phases.find((entry) => entry.id === target?.phaseId);
  const column = CLIENT_COLUMNS.find((entry) => entry.id === target?.statusId);
  if (!phase || !column || state.movingTaskId || !canClientMoveTask(task, target)) return false;
  const viewState = captureClientViewState();
  state.movingTaskId = task.id;
  const card = document.querySelector(`.client-task-card[data-task-id="${CSS.escape(task.id)}"]`);
  card?.classList.add('is-moving');
  card?.setAttribute('aria-busy', 'true');
  try {
    await api(`/api/work-items/${encodeURIComponent(task.id)}/client-board`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': mutationKey('client-board-move') },
      body: JSON.stringify({
        expectedScheduleVersion: state.schedule.scheduleVersion,
        phaseId: phase.id,
        statusId: column.id,
        source: { kind: 'customer-board', surface: 'client.html' }
      })
    });
    await loadSelectedProject({ quiet: true, viewState });
    notify(`已移至 ${phase.title} · ${column.label}`);
    return true;
  } catch (error) {
    if (error.code === 'SCHEDULE_VERSION_CONFLICT') await loadSelectedProject({ quiet: true, viewState });
    notify(error.message, true);
    return false;
  } finally {
    state.movingTaskId = null;
    card?.classList.remove('is-moving');
    card?.removeAttribute('aria-busy');
  }
}

function clientDropTarget(cell) {
  return cell ? {
    phaseId: cell.dataset.phaseId,
    statusId: cell.dataset.clientDropStatus
  } : null;
}

function beginClientDrag(task, card) {
  if (!task || !card || state.movingTaskId || clientMoveTargets(task).length === 0) return false;
  state.dragTaskId = task.id;
  state.dragTarget = null;
  card.classList.add('drag-source');
  document.body.classList.add('client-task-dragging');
  markClientDropTargets(task);
  return true;
}

function beginPointerTaskDrag(event) {
  const handle = event.target.closest('[data-client-move-task]');
  if (!handle || event.pointerType === 'mouse' || !event.isPrimary || state.pointerDrag) return;
  const task = taskFor(handle.dataset.clientMoveTask);
  const card = handle.closest('.client-task-card');
  if (!task || !card || state.movingTaskId || clientMoveTargets(task).length === 0) return;
  state.pointerDrag = {
    pointerId: event.pointerId,
    taskId: task.id,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    handle,
    card,
    ghost: null
  };
  handle.setPointerCapture?.(event.pointerId);
}

function updatePointerTaskDrag(event) {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
  const task = taskFor(drag.taskId);
  if (!task) {
    cancelPointerTaskDrag(event);
    return;
  }
  if (!drag.active) {
    if (!beginClientDrag(task, drag.card)) return;
    drag.active = true;
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'client-touch-drag-ghost';
    drag.ghost.setAttribute('aria-hidden', 'true');
    drag.ghost.textContent = task.title;
    document.body.append(drag.ghost);
  }
  event.preventDefault();
  drag.ghost.style.left = `${event.clientX}px`;
  drag.ghost.style.top = `${event.clientY}px`;
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-client-drop-status]');
  setActiveClientDropTarget(cell && canClientMoveTask(task, clientDropTarget(cell)) ? cell : null);
  updateClientDragAutoScroll(event);
}

async function finishPointerTaskDrag(event) {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.active) {
    cleanupPointerTaskDrag();
    return;
  }
  event.preventDefault();
  const task = taskFor(drag.taskId);
  const target = state.dragTarget ? { ...state.dragTarget } : null;
  state.suppressMoveClickUntil = Date.now() + 700;
  cleanupPointerTaskDrag();
  cleanupClientDrag();
  if (task && target && canClientMoveTask(task, target)) await moveClientTask(task, target);
}

function cancelPointerTaskDrag(event) {
  const drag = state.pointerDrag;
  if (!drag || (event?.pointerId != null && drag.pointerId !== event.pointerId)) return;
  if (drag.active) state.suppressMoveClickUntil = Date.now() + 700;
  cleanupPointerTaskDrag();
  cleanupClientDrag();
}

function cleanupPointerTaskDrag() {
  const drag = state.pointerDrag;
  if (!drag) return;
  if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  drag.ghost?.remove();
  state.pointerDrag = null;
}

function markClientDropTargets(task) {
  document.querySelectorAll('[data-client-drop-status]').forEach((cell) => {
    const allowed = canClientMoveTask(task, {
      phaseId: cell.dataset.phaseId,
      statusId: cell.dataset.clientDropStatus
    });
    cell.classList.toggle('is-drop-allowed', allowed);
    cell.classList.toggle('is-drop-blocked', !allowed);
  });
}

function setActiveClientDropTarget(cell) {
  document.querySelectorAll('.lane-cell.is-drop-active').forEach((entry) => entry.classList.remove('is-drop-active'));
  state.dragTarget = cell ? {
    phaseId: cell.dataset.phaseId,
    statusId: cell.dataset.clientDropStatus
  } : null;
  cell?.classList.add('is-drop-active');
}

function activeClientDropTarget() {
  if (!state.dragTarget) return null;
  return [...document.querySelectorAll('[data-client-drop-status]')].find((cell) => (
    cell.dataset.phaseId === state.dragTarget.phaseId
      && cell.dataset.clientDropStatus === state.dragTarget.statusId
  )) ?? null;
}

function updateClientDragAutoScroll(event) {
  const viewport = event.target.closest('.board-viewport');
  if (!viewport) {
    stopClientDragAutoScroll();
    return;
  }
  const rect = viewport.getBoundingClientRect();
  const verticalEdge = Math.min(72, rect.height * .2);
  const horizontalEdge = Math.min(72, rect.width * .18);
  const velocity = (position, start, end, edge) => {
    if (position < start + edge) return -Math.ceil(22 * (1 - Math.max(0, position - start) / edge));
    if (position > end - edge) return Math.ceil(22 * (1 - Math.max(0, end - position) / edge));
    return 0;
  };
  const next = {
    viewport,
    x: velocity(event.clientX, rect.left, rect.right, horizontalEdge),
    y: velocity(event.clientY, rect.top, rect.bottom, verticalEdge),
    frameId: state.dragScroll?.frameId ?? null
  };
  state.dragScroll = next;
  if ((next.x || next.y) && !next.frameId) {
    next.frameId = window.requestAnimationFrame(runClientDragAutoScroll);
  }
}

function runClientDragAutoScroll() {
  const scroll = state.dragScroll;
  if (!state.dragTaskId || !scroll || (!scroll.x && !scroll.y)) {
    stopClientDragAutoScroll();
    return;
  }
  scroll.viewport.scrollBy({ left: scroll.x, top: scroll.y, behavior: 'auto' });
  scroll.frameId = window.requestAnimationFrame(runClientDragAutoScroll);
}

function stopClientDragAutoScroll() {
  if (state.dragScroll?.frameId) window.cancelAnimationFrame(state.dragScroll.frameId);
  state.dragScroll = null;
}

function cleanupClientDrag() {
  state.dragTaskId = null;
  state.dragTarget = null;
  stopClientDragAutoScroll();
  document.body.classList.remove('client-task-dragging');
  document.querySelectorAll('.drag-source, .is-drop-allowed, .is-drop-blocked, .is-drop-active').forEach((entry) => {
    entry.classList.remove('drag-source', 'is-drop-allowed', 'is-drop-blocked', 'is-drop-active');
  });
}

function activeTaskCount(row) {
  return CLIENT_COLUMNS.reduce((total, column) => total + row.cells[column.id].total, 0);
}

function areAllLanesCollapsed() {
  return state.board?.rows.length > 0
    && state.board.rows.every((row) => state.collapsedPhaseIds.has(row.phase.id));
}

function toggleLane(phaseId) {
  if (!state.board?.rows.some((row) => row.phase.id === phaseId)) return;
  if (state.collapsedPhaseIds.has(phaseId)) state.collapsedPhaseIds.delete(phaseId);
  else state.collapsedPhaseIds.add(phaseId);
  persistCollapsedLaneState();
  applyCollapsedLaneState();
}

function toggleAllLanes() {
  if (!state.board?.rows.length) return;
  if (areAllLanesCollapsed()) state.collapsedPhaseIds.clear();
  else state.collapsedPhaseIds = new Set(state.board.rows.map((row) => row.phase.id));
  persistCollapsedLaneState();
  applyCollapsedLaneState();
}

function applyCollapsedLaneState() {
  document.querySelectorAll('[data-board-phase-id]').forEach((entry) => {
    entry.classList.toggle('is-collapsed', state.collapsedPhaseIds.has(entry.dataset.boardPhaseId));
  });
  document.querySelectorAll('[data-toggle-lane]').forEach((button) => {
    const collapsed = state.collapsedPhaseIds.has(button.dataset.phaseId);
    const row = state.board.rows.find((entry) => entry.phase.id === button.dataset.phaseId);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${row?.phase.title ?? '功能'} 功能泳道`);
    const icon = button.querySelector('.lane-toggle-meta svg');
    if (icon) icon.outerHTML = svgIcon(collapsed ? 'chevron-down' : 'chevron-up');
  });
  const allToggle = document.querySelector('[data-toggle-all-lanes]');
  if (allToggle) {
    const allCollapsed = areAllLanesCollapsed();
    const label = allCollapsed ? '展开全部' : '折叠全部';
    allToggle.setAttribute('aria-label', `${label}功能泳道`);
    allToggle.innerHTML = `${svgIcon(allCollapsed ? 'chevron-down' : 'chevron-up')}<span>${label}</span>`;
  }
}

function syncCollapsedLaneState() {
  if (state.collapsedProjectId !== state.selectedProjectId) {
    state.collapsedProjectId = state.selectedProjectId;
    state.collapsedPhaseIds = readCollapsedLaneState();
  }
  const validPhaseIds = new Set(state.board.rows.map((row) => row.phase.id));
  const nextIds = new Set([...state.collapsedPhaseIds].filter((phaseId) => validPhaseIds.has(phaseId)));
  if (nextIds.size !== state.collapsedPhaseIds.size) {
    state.collapsedPhaseIds = nextIds;
    persistCollapsedLaneState();
  }
}

function readCollapsedLaneState() {
  if (!state.selectedProjectId) return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(collapsedLaneStorageKey()) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((phaseId) => typeof phaseId === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistCollapsedLaneState() {
  if (!state.selectedProjectId) return;
  try {
    window.localStorage.setItem(collapsedLaneStorageKey(), JSON.stringify([...state.collapsedPhaseIds]));
  } catch {
    // The board remains usable when storage is disabled or full.
  }
}

function collapsedLaneStorageKey() {
  return `lifeline:client-board:collapsed:${state.selectedProjectId}`;
}

function tasksForDrawerScope(drawer) {
  return state.board.allTasks.filter((task) => (
    (drawer.phaseId === 'all' || task.phaseId === drawer.phaseId)
    && taskClientStatus(task) === drawer.statusId
  ));
}

function closeTaskDrawer() {
  state.drawer = null;
  if (elements.taskDrawer.open) elements.taskDrawer.close();
}

function renderArchivePage() {
  const completed = state.board.completed;
  const monthCount = completed.filter((task) => isInCurrentMonth(taskCompletionDate(task))).length;
  const releasedCount = completed.filter((task) => (task.effectiveStatus ?? task.status) === 'RELEASED').length;
  return `
    <section class="archive-page">
      <div class="archive-layout">
        <aside class="archive-sidebar" aria-label="完成归档筛选">
          <nav class="archive-nav">
            <button class="${archivePresetActive('all') ? 'active' : ''}" type="button" data-archive-preset="all"><span>全部完成</span><span>${completed.length}</span></button>
            <button class="${archivePresetActive('month') ? 'active' : ''}" type="button" data-archive-preset="month"><span>本月完成</span><span>${monthCount}</span></button>
            <button class="${archivePresetActive('released') ? 'active' : ''}" type="button" data-archive-preset="released"><span>正式交付</span><span>${releasedCount}</span></button>
          </nav>
          <button class="button secondary back-board" type="button" data-back-board>${svgIcon('back')} 返回任务看板</button>
        </aside>
        <div class="archive-content">
          <p class="archive-breadcrumb">任务 / 已完成归档</p>
          <div class="archive-title-row"><h1>已完成归档</h1><span>${completed.length} 项</span></div>
          <p class="archive-subtitle">本月完成 ${monthCount} 项 · 最近更新 ${escapeHtml(formatDate(taskCompletionDate(completed[0]) ?? state.schedule.lastModified))}</p>
          <div class="archive-toolbar">
            <label class="search-field">
              ${svgIcon('search')}
              <span class="visually-hidden">搜索已完成任务</span>
              <input id="archiveSearch" value="${escapeHtml(state.archive.query)}" placeholder="搜索已完成任务" autocomplete="off" />
            </label>
            <select data-archive-filter="range" aria-label="完成时间">
              ${selectOption('all', '完成时间', state.archive.range)}
              ${selectOption('week', '最近 7 天', state.archive.range)}
              ${selectOption('month', '本月完成', state.archive.range)}
            </select>
            <select data-archive-filter="phaseId" aria-label="功能泳道">
              ${selectOption('all', '功能泳道', state.archive.phaseId)}
              ${state.board.phases.map((phase) => selectOption(phase.id, phase.title, state.archive.phaseId)).join('')}
            </select>
            <select data-archive-filter="completionStatus" aria-label="验收状态">
              ${selectOption('all', '验收状态', state.archive.completionStatus)}
              ${selectOption('VERIFIED', '已验收', state.archive.completionStatus)}
              ${selectOption('RELEASED', '已交付', state.archive.completionStatus)}
            </select>
            <button class="button secondary" type="button" data-export-archive>${svgIcon('download')} 导出记录</button>
          </div>
          <div id="archiveRows">${renderArchiveRowsMarkup()}</div>
        </div>
      </div>
    </section>
  `;
}

function renderArchiveRows() {
  const container = document.querySelector('#archiveRows');
  if (container) container.innerHTML = renderArchiveRowsMarkup();
}

function renderArchiveRowsMarkup() {
  const filtered = archiveFilteredTasks();
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.archive.page = Math.min(state.archive.page, totalPages);
  const offset = (state.archive.page - 1) * pageSize;
  const page = filtered.slice(offset, offset + pageSize);
  const groups = groupCompletedTasks(page);
  return `
    <div class="archive-table-wrap">
      <div class="archive-table" role="table" aria-label="已完成任务">
        <div class="archive-table-head" role="row">
          <span role="columnheader">任务</span><span role="columnheader">功能泳道</span><span role="columnheader">完成时间</span><span role="columnheader">验收状态</span><span role="columnheader">交付物与记录</span>
        </div>
        ${groups.length > 0 ? groups.map((group) => `
          <section role="rowgroup">
            <div class="archive-group-head"><span>${escapeHtml(group.label)} · ${group.tasks.length} 项</span><span>${svgIcon('chevron-up')}</span></div>
            ${group.tasks.map((task) => renderArchiveTask(task)).join('')}
          </section>
        `).join('') : '<div class="archive-empty">没有符合当前筛选的完成任务。</div>'}
      </div>
    </div>
    <div class="archive-pagination">
      <span>${filtered.length === 0 ? '0' : `${offset + 1}–${Math.min(filtered.length, offset + pageSize)}`} / ${filtered.length}</span>
      <div class="pagination-buttons" aria-label="归档分页">
        ${Array.from({ length: Math.min(totalPages, 5) }, (_, index) => `<button class="${state.archive.page === index + 1 ? 'active' : ''}" type="button" data-archive-page="${index + 1}">${index + 1}</button>`).join('')}
      </div>
    </div>
  `;
}

function renderArchiveTask(task) {
  const phase = phaseForTask(task);
  const completion = task.latestCompletion;
  const artifactCount = completion?.artifactUris?.length ?? 0;
  return `
    <div class="archive-task-row" role="row">
      <div class="archive-task-title" role="cell"><span class="complete-check">${svgIcon('check')}</span><strong>${escapeHtml(task.title)}</strong></div>
      <span role="cell"><i class="phase-dot" style="--phase-color:${phaseColor(state.board.phases.findIndex((entry) => entry.id === phase?.id))}"></i>${escapeHtml(phase?.title ?? '未分组')}</span>
      <time role="cell">${escapeHtml(formatDate(taskCompletionDate(task)))}</time>
      <span class="archive-state" role="cell">${(task.effectiveStatus ?? task.status) === 'RELEASED' ? '已交付' : '已验收'}</span>
      <div class="archive-actions" role="cell"><button type="button" data-task-detail="${escapeHtml(task.id)}">查看验收记录</button>${artifactCount > 0 ? `<span>交付物 ${artifactCount}</span>` : ''}</div>
    </div>
  `;
}

function archiveFilteredTasks() {
  return filterClientTasks(state.board.completed, {
    query: state.archive.query,
    phaseId: state.archive.phaseId,
    range: state.archive.range,
    completionStatus: state.archive.completionStatus
  }).sort((left, right) => Date.parse(taskCompletionDate(right) ?? 0) - Date.parse(taskCompletionDate(left) ?? 0));
}

function applyArchivePreset(preset) {
  state.archive.range = preset === 'month' ? 'month' : 'all';
  state.archive.completionStatus = preset === 'released' ? 'RELEASED' : 'all';
  state.archive.page = 1;
  render();
}

function archivePresetActive(preset) {
  if (preset === 'month') return state.archive.range === 'month' && state.archive.completionStatus === 'all';
  if (preset === 'released') return state.archive.completionStatus === 'RELEASED';
  return state.archive.range === 'all' && state.archive.completionStatus === 'all';
}

function exportArchive() {
  const rows = archiveFilteredTasks();
  const fields = [
    ['任务', (task) => task.title],
    ['功能泳道', (task) => phaseForTask(task)?.title ?? '未分组'],
    ['完成时间', (task) => formatDate(taskCompletionDate(task))],
    ['验收状态', (task) => (task.effectiveStatus ?? task.status) === 'RELEASED' ? '已交付' : '已验收']
  ];
  const csv = [fields.map(([label]) => csvCell(label)).join(','), ...rows.map((task) => fields.map(([, read]) => csvCell(read(task))).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${state.schedule.project.name}-已完成归档.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify(`已导出 ${rows.length} 条完成记录`);
}

function openRequestDialog() {
  if (!state.schedule?.phases?.length) {
    notify('项目还没有可接收需求的功能阶段', true);
    return;
  }
  renderRequestPhaseOptions();
  if (!elements.requestDialog.open) elements.requestDialog.showModal();
  document.querySelector('#requestTitle')?.focus();
}

function closeRequestDialog() {
  if (elements.requestDialog.open) elements.requestDialog.close();
}

function openMoveTaskDialog(task, trigger) {
  if (!task || clientMoveTargets(task).length === 0 || state.movingTaskId) return;
  const phaseId = task.phaseId ?? task.planning?.phaseId;
  state.moveTaskId = task.id;
  state.moveReturnFocus = trigger;
  elements.moveTaskName.textContent = task.title;
  elements.moveTaskPhase.innerHTML = state.board.phases
    .map((phase) => selectOption(phase.id, phase.title, phaseId))
    .join('');
  elements.moveTaskStatus.innerHTML = CLIENT_COLUMNS
    .map((column) => selectOption(column.id, column.label, taskClientStatus(task)))
    .join('');
  updateMoveTaskSubmitState();
  if (!elements.moveTaskDialog.open) elements.moveTaskDialog.showModal();
  elements.moveTaskPhase.focus();
}

function closeMoveTaskDialog({ restoreFocus = true } = {}) {
  const returnFocus = state.moveReturnFocus;
  if (elements.moveTaskDialog.open) elements.moveTaskDialog.close();
  state.moveTaskId = null;
  state.moveReturnFocus = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function updateMoveTaskSubmitState() {
  const task = taskFor(state.moveTaskId);
  const target = {
    phaseId: elements.moveTaskPhase.value,
    statusId: elements.moveTaskStatus.value
  };
  elements.moveTaskSubmit.disabled = !task || Boolean(state.movingTaskId) || !canClientMoveTask(task, target);
}

async function submitMoveTask(event) {
  event.preventDefault();
  const task = taskFor(state.moveTaskId);
  const target = {
    phaseId: elements.moveTaskPhase.value,
    statusId: elements.moveTaskStatus.value
  };
  if (!task || !canClientMoveTask(task, target)) return;
  elements.moveTaskSubmit.disabled = true;
  elements.moveTaskSubmit.textContent = '移动中…';
  const moved = await moveClientTask(task, target);
  elements.moveTaskSubmit.textContent = '移动';
  if (!moved) {
    updateMoveTaskSubmitState();
    return;
  }
  closeMoveTaskDialog({ restoreFocus: false });
  requestAnimationFrame(() => {
    const handle = document.querySelector(`[data-client-move-task="${CSS.escape(task.id)}"]`);
    (handle ?? document.querySelector('.board-viewport'))?.focus({ preventScroll: true });
  });
}

async function submitRequest(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const phase = state.schedule.phases.find((entry) => entry.id === form.get('phaseId'));
  if (!phase) {
    notify('请选择有效的功能阶段', true);
    return;
  }
  const taskOrder = Math.max(0, ...(phase.tasks ?? []).map((task) => Number(task.planning?.taskOrder) || 0)) + 1;
  try {
    await api('/api/work-items', {
      method: 'POST',
      headers: { 'Idempotency-Key': mutationKey('customer-request') },
      body: JSON.stringify({
        projectId: state.selectedProjectId,
        phaseId: phase.id,
        title: form.get('title'),
        objective: form.get('objective'),
        acceptanceCriteria: [],
        testCommands: [],
        scheduledFor: form.get('scheduledFor') || null,
        riskTier: 'low',
        weight: 1,
        resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 5 },
        planning: {
          phaseId: phase.id,
          phase: phase.title,
          phaseOrder: phase.phaseOrder,
          taskOrder,
          kind: 'feature',
          priority: 'P1',
          commitment: 'TENTATIVE'
        },
        source: { kind: 'customer-request', surface: 'client.html' }
      })
    });
    event.currentTarget.reset();
    closeRequestDialog();
    await loadSelectedProject({ quiet: true });
    notify('需求已提交，并进入待确认队列');
  } catch (error) {
    notify(error.message, true);
  }
}

function renderProjectOptions() {
  elements.projectSelect.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === state.selectedProjectId ? ' selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  const progressUrl = new URL('/client.html', window.location.origin);
  if (state.selectedProjectId) progressUrl.searchParams.set('project', state.selectedProjectId);
  elements.projectProgressNavLink.href = `${progressUrl.pathname}${progressUrl.search}`;
  const testMapUrl = new URL('/test-map.html', window.location.origin);
  if (state.selectedProjectId) testMapUrl.searchParams.set('project', state.selectedProjectId);
  elements.testMapNavLink.href = `${testMapUrl.pathname}${testMapUrl.search}`;
  const canvasUrl = new URL('/canvas.html', window.location.origin);
  if (state.selectedProjectId) canvasUrl.searchParams.set('project', state.selectedProjectId);
  elements.canvasNavLink.href = `${canvasUrl.pathname}${canvasUrl.search}`;
}

function canProjectWrite() {
  return state.access?.capabilities?.includes('project:write') !== false;
}

function renderRequestPhaseOptions() {
  if (!state.schedule) return;
  elements.requestPhase.innerHTML = state.schedule.phases
    .filter((phase) => phase.status !== 'CANCELLED')
    .map((phase) => `<option value="${escapeHtml(phase.id)}">${escapeHtml(phase.title)}</option>`)
    .join('');
}

function renderLoading() {
  elements.main.innerHTML = `
    <section class="client-loading" aria-label="正在载入项目">
      <div class="loading-line wide"></div><div class="loading-line"></div><div class="loading-board"></div>
    </section>
  `;
}

function renderError(error) {
  elements.main.innerHTML = `
    <section class="client-error"><div><h1>项目暂时无法载入</h1><p>${escapeHtml(error.message)}</p><button class="button primary" type="button" data-retry-load>重新载入</button></div></section>
  `;
}

function renderEmptyPortfolio() {
  elements.main.innerHTML = '<section class="client-empty"><div><h1>还没有可共享的项目</h1><p>请先在 Lifeline 控制平面中建立项目和阶段。</p><a class="button primary" href="/">返回控制平面</a></div></section>';
}

function navigateToView(view) {
  state.view = view === 'archive' ? 'archive' : 'board';
  closeTaskDrawer();
  updateUrl({ projectId: state.selectedProjectId, view: state.view }, { replace: false });
  render();
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function scrollToSection(section) {
  const id = { overview: 'overview', tasks: 'tasks', timeline: 'timeline' }[section];
  const target = id ? document.querySelector(`#${id}`) : null;
  if (!target) return;
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function alignCurrentMilestone() {
  if (state.view !== 'board') return;
  const scroll = document.querySelector('.milestone-scroll');
  const current = scroll?.querySelector('[data-current-milestone]');
  if (!scroll || !current) return;
  scroll.scrollLeft = Math.max(0, current.offsetLeft - (scroll.clientWidth - current.offsetWidth) / 2);
}

function locateBoardPhase(phaseId) {
  const viewport = document.querySelector('.board-viewport');
  const safePhaseId = window.CSS?.escape ? window.CSS.escape(phaseId) : phaseId.replace(/["\\]/g, '\\$&');
  const lane = viewport?.querySelector(`.lane-label[data-board-phase-id="${safePhaseId}"]`);
  if (!viewport || !lane) return;
  document.querySelector('#tasks')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const headerHeight = viewport.querySelector('.board-corner')?.offsetHeight ?? 0;
  viewport.scrollTo({
    top: Math.max(0, lane.offsetTop - headerHeight),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth'
  });
  const row = viewport.querySelectorAll(`[data-board-phase-id="${safePhaseId}"]`);
  row.forEach((item) => item.classList.add('is-phase-located'));
  window.clearTimeout(state.locateTimer);
  state.locateTimer = window.setTimeout(() => {
    row.forEach((item) => item.classList.remove('is-phase-located'));
    state.locateTimer = null;
  }, 1600);
}

function captureClientViewState() {
  const viewport = document.querySelector('.board-viewport');
  return {
    windowScrollLeft: window.scrollX,
    windowScrollTop: window.scrollY,
    boardScrollLeft: viewport?.scrollLeft ?? 0,
    boardScrollTop: viewport?.scrollTop ?? 0
  };
}

function restoreClientViewState(viewState) {
  if (!viewState || state.view !== 'board') return;
  const viewport = document.querySelector('.board-viewport');
  if (viewport) {
    const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollLeft = Math.min(Math.max(0, viewState.boardScrollLeft), maxLeft);
    viewport.scrollTop = Math.min(Math.max(0, viewState.boardScrollTop), maxTop);
  }
  window.scrollTo({
    left: Math.max(0, viewState.windowScrollLeft),
    top: Math.max(0, viewState.windowScrollTop),
    behavior: 'auto'
  });
}

function updateUrl({ projectId, view }, { replace }) {
  const url = new URL(window.location.href);
  if (projectId) url.searchParams.set('project', projectId);
  else url.searchParams.delete('project');
  if (view === 'archive') url.searchParams.set('view', 'archive');
  else url.searchParams.delete('view');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function readView() {
  return new URLSearchParams(window.location.search).get('view') === 'archive' ? 'archive' : 'board';
}

function readRequestedSection() {
  const section = new URLSearchParams(window.location.search).get('section') ?? window.location.hash.slice(1);
  return ['overview', 'tasks', 'timeline'].includes(section) ? section : null;
}

function phaseForTask(task) {
  return state.board?.phases.find((phase) => phase.id === task.phaseId) ?? null;
}

function taskFor(taskId) {
  return state.board?.allTasks.find((task) => task.id === taskId) ?? null;
}

function phaseMilestoneDate(phase) {
  const dates = (phase?.tasks ?? []).map(taskDueDate).filter(Boolean).sort();
  return dates.at(-1) ?? null;
}

function phaseCompletionDate(phase) {
  const dates = (phase?.tasks ?? [])
    .filter(isCompletedTask)
    .map(taskCompletionDate)
    .filter(Boolean)
    .sort();
  return dates.at(-1) ?? null;
}

function phaseHasOverdueTask(phase) {
  return (phase?.tasks ?? []).some((task) => isOverdue(task));
}

function projectAttentionSummary() {
  const overdue = state.board.allTasks.filter((task) => isOverdue(task)).length;
  const pending = state.board.columnTotals.pending;
  const review = state.board.columnTotals.review;
  if (overdue > 0) return { tone: 'warning', headline: `${overdue} 项任务已延期` };
  if (pending > 0 && review > 0) return { tone: 'warning', headline: `${pending} 项待确认 · ${review} 项待验收` };
  if (pending > 0) return { tone: 'warning', headline: `${pending} 项任务待确认` };
  if (review > 0) return { tone: 'warning', headline: `${review} 项任务待验收` };
  return { tone: 'normal', headline: '暂无阻塞事项' };
}

function projectNeedsAttention(project) {
  return ['STALLED', 'AT_RISK'].includes(project.health);
}

function projectHealthLabel(project) {
  return { STALLED: '需要关注', AT_RISK: '存在风险', ON_TRACK: '按计划推进', ACTIVE: '按计划推进' }[project.health] ?? '持续推进中';
}

function clientStatusLabel(status) {
  return { pending: '待确认', scheduled: '已排期', running: '进行中', review: '待验收', completed: '已完成' }[status] ?? '未分类';
}

function phaseColor(index) {
  return ['#39d39a', '#9c6cff', '#43a9ff', '#f1b73b', '#62d3d8'][Math.max(0, index) % 5];
}

function formatDate(value) {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date);
}

function isInCurrentMonth(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function selectOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function safeLink(value) {
  const text = String(value ?? '');
  return /^https?:\/\//i.test(text) ? text : '#';
}

function mutationKey(scope) {
  return `${scope}:${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function notify(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.add('visible');
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('visible'), 3600);
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: projectAccessHeaders({
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && ['PROJECT_ACCESS_INVALID', 'PROJECT_ACCESS_REQUIRED'].includes(body?.error?.code)) {
      clearProjectAccessToken();
    }
    const error = new Error(body?.error?.message ?? `请求失败（${response.status}）`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function svgIcon(name) {
  const paths = {
    'arrow-right': '<path d="M5 12h13M14 7l5 5-5 5"/>',
    archive: '<path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/>',
    back: '<path d="M19 12H5M10 7l-5 5 5 5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M7 3v4M17 3v4M3.5 10h17"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    'chevron-down': '<path d="m7 10 5 5 5-5"/>',
    'chevron-up': '<path d="m7 14 5-5 5 5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    collapse: '<path d="M9 4v5H4M15 20v-5h5M4 9l6-6M20 15l-6 6"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>',
    expand: '<path d="M9 4H4v5M15 20h5v-5M4 9l6-6M20 15l-6 6"/>',
    move: '<path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>'
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] ?? ''}</svg>`;
}

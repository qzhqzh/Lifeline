const state = {
  projects: [],
  workItems: [],
  dashboard: null,
  eventSource: null,
  devReloadSource: null,
  filter: 'all',
  bootstrap: null,
  selectedProjectId: new URLSearchParams(window.location.search).get('project'),
  detailFocusPending: true,
  detailSchedule: null,
  creationSchedule: null,
  creationMode: 'task',
  creationDraftSnapshot: null,
  editingTaskId: null,
  taskEditorMode: 'edit',
  detailView: readDetailView(),
  draggedTaskId: null,
  dragPlaceholder: null,
  dragTooltipSuppressed: false
};

const elements = {
  health: document.querySelector('#health'),
  metrics: document.querySelector('#metrics'),
  nextAction: document.querySelector('#nextAction'),
  board: document.querySelector('#portfolioBoard'),
  projectId: document.querySelector('#projectId'),
  timeline: document.querySelector('#timeline'),
  runStatus: document.querySelector('#runStatus'),
  bootstrapAction: document.querySelector('#bootstrapAction'),
  seedDemo: document.querySelector('#seedDemo'),
  refresh: document.querySelector('#refresh'),
  openCreationDrawer: document.querySelector('#openCreationDrawer'),
  creationDrawer: document.querySelector('#creationDrawer'),
  closeCreationDrawer: document.querySelector('#closeCreationDrawer'),
  projectForm: document.querySelector('#projectForm'),
  workItemForm: document.querySelector('#workItemForm'),
  createPhaseId: document.querySelector('#createPhaseId'),
  createNewPhaseFields: document.querySelector('#createNewPhaseFields'),
  createNewPhaseTitle: document.querySelector('#createNewPhaseTitle'),
  createNewPhaseOrder: document.querySelector('#createNewPhaseOrder'),
  createPriority: document.querySelector('#createPriority'),
  createDependencies: document.querySelector('#createDependencies'),
  createParallelPolicy: document.querySelector('#createParallelPolicy'),
  strategicValue: document.querySelector('#strategicValue'),
  strategicValueOutput: document.querySelector('#strategicValueOutput'),
  toast: document.querySelector('#toast'),
  boardFilters: document.querySelector('#boardFilters'),
  boardTitle: document.querySelector('#portfolio-title'),
  boardDescription: document.querySelector('#portfolioDescription'),
  backToPortfolio: document.querySelector('#backToPortfolio'),
  detailControls: document.querySelector('#detailControls'),
  addDetailTask: document.querySelector('#addDetailTask'),
  taskEditor: document.querySelector('#taskEditor'),
  taskEditorForm: document.querySelector('#taskEditorForm'),
  taskEditorContext: document.querySelector('#taskEditorContext'),
  taskEditorTitle: document.querySelector('#taskEditorTitle'),
  taskEditorSubmit: document.querySelector('#taskEditorSubmit'),
  taskSourceHint: document.querySelector('#taskSourceHint'),
  closeTaskEditor: document.querySelector('#closeTaskEditor'),
  cancelTaskEdit: document.querySelector('#cancelTaskEdit'),
  editPhaseId: document.querySelector('#editPhaseId'),
  editKind: document.querySelector('#editKind'),
  editPriority: document.querySelector('#editPriority'),
  editCommitment: document.querySelector('#editCommitment'),
  editTitle: document.querySelector('#editTitle'),
  editObjective: document.querySelector('#editObjective'),
  editIssue: document.querySelector('#editIssue'),
  editStarred: document.querySelector('#editStarred'),
  editScheduledFor: document.querySelector('#editScheduledFor'),
  editDependencies: document.querySelector('#editDependencies'),
  editParallelPolicy: document.querySelector('#editParallelPolicy'),
  editCriteria: document.querySelector('#editCriteria'),
  editCommands: document.querySelector('#editCommands'),
  phaseMoveHint: document.querySelector('#phaseMoveHint'),
  newPhaseFields: document.querySelector('#newPhaseFields'),
  editNewPhaseTitle: document.querySelector('#editNewPhaseTitle'),
  editNewPhaseOrder: document.querySelector('#editNewPhaseOrder'),
  taskTooltip: document.querySelector('#taskTooltip')
};

let taskTooltipHideTimer = null;

elements.refresh.addEventListener('click', async () => {
  await Promise.all([checkHealth(), refresh()]);
});
elements.seedDemo?.addEventListener('click', bootstrapPortfolio);
elements.openCreationDrawer.addEventListener('click', openCreationDrawer);
elements.closeCreationDrawer.addEventListener('click', () => closeCreationDrawer());
elements.creationDrawer.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeCreationDrawer();
});
elements.creationDrawer.addEventListener('click', (event) => {
  const button = event.target.closest('[data-create-mode]');
  if (button) setCreationMode(button.dataset.createMode);
});
elements.projectForm.addEventListener('submit', createProject);
elements.workItemForm.addEventListener('submit', createWorkItem);
elements.projectId.addEventListener('change', loadCreationSchedule);
elements.createPhaseId.addEventListener('change', () => {
  syncCreateNewPhaseFields();
  populateCreationDependencyOptions();
});
elements.backToPortfolio.addEventListener('click', () => closeProjectDetail());
elements.addDetailTask.addEventListener('click', openTaskCreator);
elements.detailControls.addEventListener('click', (event) => {
  const button = event.target.closest('[data-detail-view]');
  if (!button) return;
  state.detailView = button.dataset.detailView === 'card' ? 'card' : 'row';
  try { window.localStorage.setItem('lifeline.detailView', state.detailView); } catch {}
  renderBoardToolbar();
  renderBoard();
});
elements.closeTaskEditor.addEventListener('click', closeTaskEditor);
elements.cancelTaskEdit.addEventListener('click', closeTaskEditor);
elements.taskEditorForm.addEventListener('submit', saveTaskEditor);
elements.editPhaseId.addEventListener('change', syncNewPhaseFields);
elements.editDependencies.addEventListener('change', syncNewPhaseFields);
elements.taskEditor.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeTaskEditor();
});
elements.strategicValue.addEventListener('input', () => {
  elements.strategicValueOutput.textContent = `${elements.strategicValue.value} / 10`;
});
elements.boardFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((entry) => {
    const active = entry === button;
    entry.classList.toggle('active', active);
    entry.setAttribute('aria-pressed', String(active));
  });
  renderBoard();
});
window.addEventListener('popstate', async () => {
  state.selectedProjectId = new URLSearchParams(window.location.search).get('project');
  state.detailSchedule = null;
  state.detailFocusPending = Boolean(state.selectedProjectId);
  await refresh();
});
elements.taskTooltip.addEventListener('mouseenter', cancelTaskTooltipHide);
elements.taskTooltip.addEventListener('mouseleave', scheduleTaskTooltipHide);
window.addEventListener('scroll', (event) => {
  if (event.target !== elements.taskTooltip) hideTaskTooltip();
}, true);
window.addEventListener('resize', hideTaskTooltip);
window.addEventListener('pointerup', releaseTaskTooltipSuppression);
window.addEventListener('pointercancel', releaseTaskTooltipSuppression);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.taskEditor.open) hideTaskTooltip();
});

await checkHealth();
await refresh();

async function checkHealth() {
  try {
    const health = await api('/api/health');
    if (health.devReload) enableDevReload();
    elements.health.textContent = `控制平面在线 · ${new Date(health.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    elements.health.classList.add('online');
  } catch (error) {
    elements.health.textContent = '控制平面离线';
    elements.health.classList.remove('online');
    notify(error.message, true);
  }
}

function enableDevReload() {
  if (state.devReloadSource || typeof EventSource === 'undefined') return;
  const source = new EventSource('/api/dev-events');
  let connectedOnce = false;
  source.addEventListener('open', () => {
    if (connectedOnce) window.location.reload();
    connectedOnce = true;
  });
  state.devReloadSource = source;
}

async function refresh() {
  try {
    const [dashboard, projects, workItems] = await Promise.all([
      api('/api/dashboard'),
      api('/api/projects'),
      api('/api/work-items')
    ]);
    state.projects = projects.items;
    state.workItems = workItems.items.map(hydrateWorkItem);
    state.dashboard = hydrateDashboard(dashboard, state.workItems);
    state.bootstrap = dashboard.bootstrap?.portfolioV2 ?? dashboard.bootstrap ?? null;
    if (state.selectedProjectId && state.projects.some((project) => project.id === state.selectedProjectId)) {
      state.detailSchedule = hydrateSchedule(await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/schedule`));
    } else if (state.selectedProjectId) {
      state.selectedProjectId = null;
      state.detailFocusPending = false;
      state.detailSchedule = null;
      replaceProjectQuery(null);
    }
    render();
  } catch (error) {
    notify(error.message, true);
  }
}

async function bootstrapPortfolio() {
  try {
    elements.seedDemo.disabled = true;
    elements.seedDemo.textContent = '正在载入项目排期…';
    await api('/api/bootstrap/portfolio-v2', {
      method: 'POST',
      headers: { 'Idempotency-Key': globalThis.crypto?.randomUUID?.() ?? `portfolio-v2-${Date.now()}` }
    });
    elements.bootstrapAction?.remove();
    state.bootstrap = { ...state.bootstrap, available: false };
    notify('Lifeline、EchoMe 与 Totemora 的项目排期已载入');
    await refresh();
  } catch (error) {
    notify(error.message, true);
    if (elements.seedDemo?.isConnected) {
      elements.seedDemo.disabled = false;
      elements.seedDemo.textContent = '载入本次项目排期';
    }
  }
}

async function openCreationDrawer() {
  await setCreationMode(state.projects.length > 0 ? 'task' : 'project');
  elements.creationDrawer.showModal();
  state.creationDraftSnapshot = creationDraftSnapshot();
  const firstField = state.creationMode === 'task' ? document.querySelector('#title') : document.querySelector('#projectName');
  firstField?.focus();
}

function closeCreationDrawer(force = false) {
  if (!force && creationDraftChanged()) {
    if (!window.confirm('关闭后会丢失尚未提交的内容，仍要关闭吗？')) return;
  }
  elements.createNewPhaseTitle.required = false;
  elements.createNewPhaseOrder.required = false;
  state.creationDraftSnapshot = null;
  if (elements.creationDrawer.open) elements.creationDrawer.close();
}

function creationDraftSnapshot() {
  return JSON.stringify([...elements.creationDrawer.querySelectorAll('input, textarea, select')].map((field) => [
    field.id,
    field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value
  ]));
}

function creationDraftChanged() {
  return state.creationDraftSnapshot !== null && creationDraftSnapshot() !== state.creationDraftSnapshot;
}

async function setCreationMode(mode) {
  state.creationMode = mode === 'project' ? 'project' : 'task';
  elements.creationDrawer.querySelectorAll('[data-create-mode]').forEach((button) => {
    const active = button.dataset.createMode === state.creationMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.creationDrawer.querySelectorAll('[data-create-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.createPane !== state.creationMode;
  });
  if (state.creationMode === 'task') await loadCreationSchedule();
  else syncCreateNewPhaseFields();
}

async function loadCreationSchedule() {
  const projectId = elements.projectId.value;
  if (!projectId) {
    state.creationSchedule = null;
    elements.createPhaseId.innerHTML = '<option value="">请先创建项目</option>';
    elements.createPhaseId.disabled = true;
    populateDependencyOptions(elements.createDependencies, null);
    syncCreateNewPhaseFields();
    return;
  }
  try {
    const schedule = hydrateSchedule(await api(`/api/projects/${encodeURIComponent(projectId)}/schedule`));
    if (elements.projectId.value !== projectId) return;
    state.creationSchedule = schedule;
    elements.createPhaseId.disabled = false;
    elements.createPhaseId.innerHTML = [
      ...schedule.phases.map((phase) => `<option value="${escapeHtml(phase.id)}">S${escapeHtml(phase.phaseOrder)} · ${escapeHtml(phase.title)}</option>`),
      '<option value="__new__">＋ 新建阶段</option>'
    ].join('');
    if (schedule.phases.length === 0) elements.createPhaseId.value = '__new__';
    elements.createNewPhaseOrder.value = String(
      Math.max(0, ...schedule.phases.map((phase) => Number(phase.phaseOrder) || 0)) + 1
    );
    populateCreationDependencyOptions();
    syncCreateNewPhaseFields();
  } catch (error) {
    notify(error.message, true);
  }
}

function syncCreateNewPhaseFields() {
  const creatingPhase = state.creationMode === 'task' && elements.createPhaseId.value === '__new__';
  elements.createNewPhaseFields.hidden = !creatingPhase;
  elements.createNewPhaseTitle.required = creatingPhase;
  elements.createNewPhaseOrder.required = creatingPhase;
}

function populateCreationDependencyOptions() {
  populateDependencyOptions(elements.createDependencies, state.creationSchedule, {
    selectedIds: selectedOptionValues(elements.createDependencies)
  });
}

async function createProject(event) {
  event.preventDefault();
  try {
    const project = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: document.querySelector('#projectName').value,
        description: document.querySelector('#projectDescription').value,
        strategicValue: Number(elements.strategicValue.value)
      })
    });
    notify(`${project.name} 已加入项目大板`);
    elements.projectForm.reset();
    elements.strategicValueOutput.textContent = '8 / 10';
    closeCreationDrawer(true);
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

async function createWorkItem(event) {
  event.preventDefault();
  if (!elements.projectId.value) {
    notify('请先添加项目', true);
    return;
  }
  try {
    const kind = document.querySelector('#kind').value;
    let phase = state.creationSchedule?.phases.find((entry) => entry.id === elements.createPhaseId.value);
    if (elements.createPhaseId.value === '__new__') {
      const phaseOrder = Number(elements.createNewPhaseOrder.value);
      phase = await api('/api/phases', {
        method: 'POST',
        headers: { 'Idempotency-Key': mutationKey('phase-create') },
        body: JSON.stringify({
          projectId: elements.projectId.value,
          title: elements.createNewPhaseTitle.value,
          rank: phaseOrder * 1024
        })
      });
    }
    if (!phase) throw new Error('请选择有效阶段');
    const taskOrder = Math.max(0, ...(phase.tasks ?? []).map((item) => Number(item.planning?.taskOrder) || 0)) + 1;
    await api('/api/work-items', {
      method: 'POST',
      headers: { 'Idempotency-Key': mutationKey('task-create') },
      body: JSON.stringify({
        projectId: elements.projectId.value,
        phaseId: phase.id,
        title: document.querySelector('#title').value,
        objective: document.querySelector('#objective').value,
        issue: document.querySelector('#issue').value.trim() || null,
        starred: document.querySelector('#starred').checked,
        scheduledFor: document.querySelector('#scheduledFor').value || null,
        dependsOnTaskIds: selectedOptionValues(elements.createDependencies),
        parallelPolicy: elements.createParallelPolicy.value,
        acceptanceCriteria: lines(document.querySelector('#criteria').value),
        testCommands: lines(document.querySelector('#commands').value),
        riskTier: kind === 'ops' ? 'medium' : 'low',
        weight: 1,
        resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 2 },
        planning: {
          phaseId: phase.id,
          phase: phase.title,
          phaseOrder: phase.phaseOrder,
          taskOrder,
          kind,
          priority: elements.createPriority.value,
          commitment: 'TENTATIVE'
        }
      })
    });
    elements.workItemForm.reset();
    elements.createParallelPolicy.value = 'AUTO';
    populateDependencyOptions(elements.createDependencies, state.creationSchedule);
    closeCreationDrawer(true);
    notify('人工任务已加入排期，推荐执行配置已生成');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

async function markReady(workItemId) {
  try {
    await api(`/api/work-items/${encodeURIComponent(workItemId)}/ready`, { method: 'POST' });
    notify('执行契约已通过校验');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

async function runWorkItem(workItemId) {
  try {
    const run = await api(`/api/work-items/${encodeURIComponent(workItemId)}/queue`, { method: 'POST' });
    elements.timeline.innerHTML = '';
    setRunStatus(run.status);
    openRunStream(run.id);
    notify('任务已进入执行队列，可在下方工作台回放');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

function openRunStream(runId) {
  state.eventSource?.close();
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  state.eventSource = source;

  const eventNames = ['run.queued', 'run.started', 'step.started', 'step.completed', 'run.succeeded', 'run.failed'];
  for (const eventName of eventNames) {
    source.addEventListener(eventName, (event) => appendTimeline(JSON.parse(event.data)));
  }
  source.addEventListener('terminal', async (event) => {
    const terminal = JSON.parse(event.data);
    setRunStatus(terminal.status);
    source.close();
    await refresh();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) return;
    setRunStatus('RECONNECTING');
  };
}

function appendTimeline(event) {
  elements.timeline.querySelector('.empty')?.remove();
  const item = document.createElement('li');
  item.innerHTML = `
    <span class="timeline-dot"></span>
    <div>
      <div class="timeline-meta"><strong>${escapeHtml(event.type)}</strong><time>${formatTime(event.createdAt)}</time></div>
      <p>${escapeHtml(event.message)}</p>
      ${event.metadata?.evidenceScore !== undefined ? `<small>证据得分 ${Math.round(event.metadata.evidenceScore * 100)}%</small>` : ''}
    </div>
  `;
  elements.timeline.append(item);
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function render() {
  document.body.classList.toggle('project-detail-mode', Boolean(state.selectedProjectId));
  renderBootstrapAction();
  renderMetrics();
  renderNextAction();
  renderBoardToolbar();
  renderBoard();
  renderProjectSelect();
}

function renderBoardToolbar() {
  const project = projectFor(state.selectedProjectId);
  const inDetail = Boolean(project && state.detailSchedule);
  elements.backToPortfolio.hidden = !inDetail;
  elements.boardFilters.hidden = inDetail;
  elements.detailControls.hidden = !inDetail;
  elements.detailControls.querySelectorAll('[data-detail-view]').forEach((button) => {
    const active = button.dataset.detailView === state.detailView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.boardTitle.textContent = inDetail ? project.name : '下一滴算力，投给谁？';
  elements.boardDescription.textContent = inDetail
    ? '当前进度由项目明确指定并保持锁定；待处理任务可继续调整，计划任务暂不占用近期算力。'
    : '越靠上越值得优先投入，越向右越接近交付；切换算力和任务类型，立刻找到此刻最值得推进的工作。';
}

function renderBootstrapAction() {
  if (state.bootstrap?.available === false) elements.bootstrapAction?.remove();
}

function renderMetrics() {
  const projects = state.dashboard?.projects ?? [];
  const unfinished = state.workItems.filter(isUnfinished);
  const deferred = state.workItems.filter((item) => item.status === 'DEFERRED');
  const lowCompute = unfinished.filter((item) => item.recommendation?.compute === 'low').length;
  const blocked = unfinished.filter((item) => item.status === 'BLOCKED').length;
  elements.metrics.innerHTML = [
    ['进行中项目', projects.length],
    ['待推进任务', unfinished.length],
    ['计划任务', deferred.length],
    ['低算力可做', lowCompute],
    ['当前阻塞', blocked]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderNextAction() {
  const candidate = recommendedCandidate();
  if (!candidate) {
    elements.nextAction.innerHTML = `
      <div class="next-action-main">
        <span class="next-label">当前建议</span>
        <div class="next-copy"><strong>先添加项目或载入项目排期</strong><p>系统会结合项目战略价值、任务优先级、依赖顺序与就绪状态给出下一步。</p></div>
      </div>
    `;
    return;
  }
  const project = projectFor(candidate.projectId);
  const recommendation = candidate.recommendation;
  elements.nextAction.innerHTML = `
    <div class="next-action-main">
      <span class="next-label">当前建议</span>
      <div class="next-copy">
        <strong>${escapeHtml(project?.name)} · ${escapeHtml(candidate.planning.phase)} · ${escapeHtml(candidate.title)}</strong>
        <p>${escapeHtml(recommendation.approach)} ${escapeHtml(routeLabel(recommendation))}，预计 ${formatDuration(recommendation.estimateMinutes)}。</p>
      </div>
    </div>
    <button class="button secondary compact" type="button" data-focus-item="${escapeHtml(candidate.id)}">在排期中定位</button>
  `;
  bindActionButtons(elements.nextAction);
}

function renderBoard() {
  if (state.selectedProjectId && state.detailSchedule) {
    renderProjectDetail();
    return;
  }
  const projects = state.dashboard?.projects ?? [];
  const rows = [];
  for (const [projectIndex, project] of projects.entries()) {
    const projectItems = state.workItems.filter((item) => item.projectId === project.id);
    const visibleItems = state.workItems
      .filter((item) => item.projectId === project.id && matchesFilter(item))
      .sort(compareItems);
    const phases = visibleItems.length > 0
      ? groupPhases(visibleItems)
      : [{ order: '—', name: projectItems.length > 0 ? '当前筛选无任务' : '尚未排期', items: [] }];
    const firstUnfinishedPhase = phases.findIndex((phase) => phase.items.some(isUnfinished));
    rows.push(`
      <article class="project-row" aria-labelledby="project-${escapeHtml(project.id)}">
        <button class="project-summary" type="button" data-open-project="${escapeHtml(project.id)}" aria-label="打开 ${escapeHtml(project.name)} 项目详情">
          <div>
            <div class="project-rank">
              <span class="priority">${projectPriority(project.strategicValue)}</span>
              <span class="project-order">${String(projectIndex + 1).padStart(2, '0')} / ${String(projects.length).padStart(2, '0')}</span>
            </div>
            <h3 id="project-${escapeHtml(project.id)}">${escapeHtml(project.name)}</h3>
            ${project.headline ? `<strong class="project-promise">${escapeHtml(project.headline)}</strong>` : ''}
            <p class="project-description">${escapeHtml(project.description || '尚未填写项目说明')}</p>
            <span class="project-open-cue">查看全部任务 →</span>
          </div>
          <div>
            <div class="project-facts"><span>${project.phaseCount} 个阶段</span><span>${project.unfinishedWorkItemCount} 项待推进</span></div>
            <div class="project-progress" aria-label="已验证进度 ${Math.round(project.verifiedProgress * 100)}%"><span style="width:${Math.round(project.verifiedProgress * 100)}%"></span></div>
            <div class="project-facts"><span>已验证进度</span><strong>${Math.round(project.verifiedProgress * 100)}%</strong></div>
          </div>
        </button>
        <div class="phase-track" aria-label="${escapeHtml(project.name)} 的阶段进度">
          ${phases.map((phase, phaseIndex) => renderPhase(phase, phaseIndex, firstUnfinishedPhase)).join('')}
        </div>
      </article>
    `);
  }
  elements.board.innerHTML = rows.length > 0
    ? rows.join('')
    : '<div class="portfolio-empty">这个筛选下暂时没有任务。换个筛选条件，或从右上角添加新的项目与任务。</div>';
  bindActionButtons(elements.board);
}

function renderProjectDetail() {
  const schedule = state.detailSchedule;
  const project = schedule.project;
  const dashboardProject = state.dashboard?.projects?.find((entry) => entry.id === project.id) ?? project;
  const tasks = [...schedule.phases.flatMap((phase) => phase.tasks), ...schedule.unscheduledTasks];
  const completed = tasks.filter(isFinished);
  const inProgress = tasks.filter(isInProgress);
  const unfinished = tasks.filter((task) => isUnfinished(task) && !isInProgress(task));
  const deferred = tasks.filter((task) => task.status === 'DEFERRED');
  const currentTask = tasks.find((task) => task.id === project.currentTaskId && isFinished(task))
    ?? completed.filter((task) => task.status !== 'RECURRING').sort(compareItems).at(-1)
    ?? null;

  elements.board.innerHTML = `
    <div class="project-detail">
      <header class="detail-hero">
        <div class="detail-identity">
          <div class="project-rank">
            <span class="priority">${projectPriority(project.strategicValue)}</span>
            <span class="detail-version">排期版本 ${schedule.scheduleVersion}</span>
          </div>
          <h3>别让你的野心，最后只活在待办事项里。</h3>
          <p>${escapeHtml(project.description || '尚未填写项目说明')}</p>
        </div>
        <div class="detail-progress-block">
          <div class="detail-progress-value">${Math.round(Number(dashboardProject.verifiedProgress ?? 0) * 100)}%</div>
          <span>已验证进度</span>
          <div class="project-progress" aria-label="已验证进度 ${Math.round(Number(dashboardProject.verifiedProgress ?? 0) * 100)}%">
            <span style="width:${Math.round(Number(dashboardProject.verifiedProgress ?? 0) * 100)}%"></span>
          </div>
        </div>
      </header>

      <section class="detail-state-rail" aria-label="项目任务状态概览">
        ${renderStateRailColumn('已完成', completed, '已通过验证并锁定', false)}
        ${renderStateRailColumn('当前进度', currentTask ? [currentTask] : [], '尚无完成记录', true)}
        ${renderStateRailColumn('推进中', inProgress, '执行、排队或复核中的任务', false)}
        ${renderStateRailColumn('待处理', unfinished, '可按算力与优先级调整', false)}
        ${renderStateRailColumn('计划', deferred, '短期不推进，仍可调整或取消', false)}
      </section>

      <section class="detail-state-guide" aria-label="状态说明">
        <div><span class="state-key completed">✓</span><p><strong>已完成</strong>只有通过验证的任务进入这里，内容与顺序均锁定。</p></div>
        <div><span class="state-key current">●</span><p><strong>当前进度</strong>由项目明确指定为最新完成节点；它仍计入已完成，内容与顺序均不可修改。</p></div>
        <div><span class="state-key in-progress">◉</span><p><strong>推进中</strong>已经排队、执行或进入复核，尚未完成，执行契约暂时锁定。</p></div>
        <div><span class="state-key pending">○</span><p><strong>待处理</strong>尚未开始且近期需要推进，可以继续调整或取消。</p></div>
        <div><span class="state-key deferred">◇</span><p><strong>计划</strong>已经进入长期排期，但短期不投入算力，仍可微调或取消；周期任务计入完成并可再次执行。</p></div>
      </section>

      <div class="detail-phase-list">
        ${schedule.phases.map((phase) => renderDetailPhase(phase, currentTask?.id)).join('')}
        ${schedule.unscheduledTasks.length > 0 ? renderDetailPhase({
          id: 'unscheduled', title: '待归档阶段', phaseOrder: '—', goal: '这些任务尚未关联正式阶段。', tasks: schedule.unscheduledTasks
        }, currentTask?.id) : ''}
      </div>
    </div>
  `;
  bindActionButtons(elements.board);
  bindProjectDetailActions();
  bindTaskTooltips();
  if (state.detailFocusPending) {
    state.detailFocusPending = false;
    requestAnimationFrame(() => {
      elements.board.querySelector('[data-current-task="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}

function renderStateRailColumn(label, tasks, hint, current) {
  const preview = tasks.slice(0, 2).map((task) => escapeHtml(task.title)).join(' · ');
  return `
    <div class="state-rail-column${current ? ' current' : ''}">
      <div><span>${label}</span><strong>${tasks.length}</strong></div>
      <p>${preview || hint}</p>
    </div>
  `;
}

function renderDetailPhase(phase, currentTaskId) {
  const reorderable = phase.id === 'unscheduled' ? [] : phase.tasks.filter(isReorderable).map((task) => task.id);
  const completedCount = phase.tasks.filter(isFinished).length;
  const parallelCandidates = parallelCandidatesForPhase(phase);
  const phaseEditable = phase.id !== 'unscheduled';
  return `
    <section class="detail-phase view-${state.detailView}" data-detail-phase="${escapeHtml(phase.id)}">
      <header class="detail-phase-head">
        <div>
          <span class="phase-index">S${escapeHtml(phase.phaseOrder)}</span>
          <h4${phaseEditable ? ` class="phase-inline-field" data-phase-edit-field="title" data-phase-id="${escapeHtml(phase.id)}" tabindex="0" title="双击修改阶段标题"` : ''}>${escapeHtml(phase.title)}</h4>
          <p${phaseEditable ? ` class="phase-inline-field${phase.goal ? '' : ' empty'}" data-phase-edit-field="goal" data-phase-id="${escapeHtml(phase.id)}" tabindex="0" title="双击修改阶段描述"` : ''}>${escapeHtml(phase.goal || '双击补充阶段描述')}</p>
        </div>
        <div class="phase-progress-block">
          <span>${completedCount} / ${phase.tasks.length} 已完成</span>
          ${renderParallelSlot(parallelCandidates)}
        </div>
      </header>
      <div class="detail-task-list view-${state.detailView}">
        ${phase.tasks.length > 0
          ? phase.tasks.map((task, index) => renderDetailTask(task, phase, reorderable, index, currentTaskId)).join('')
          : '<p class="detail-empty">这个阶段还没有任务。</p>'}
      </div>
    </section>
  `;
}

function parallelCandidatesForPhase(phase) {
  if (Array.isArray(phase.parallelTaskIds)) {
    const candidateIds = new Set(phase.parallelTaskIds);
    return phase.tasks.filter((task) => candidateIds.has(task.id));
  }
  return phase.tasks.filter((task) => (
    ['PLANNED', 'READY'].includes(task.status)
      && task.parallelPolicy !== 'SEQUENTIAL'
      && taskDependenciesSatisfied(task)
  ));
}

function renderParallelSlot(tasks) {
  if (tasks.length < 2) return '';
  const visible = tasks.slice(0, 2).map((task) => escapeHtml(task.title)).join(' · ');
  const remaining = tasks.length - 2;
  return `
    <div class="parallel-slot" title="这些任务没有未完成的前置依赖，可以并行投入算力">
      <span>可并行</span>
      <strong>${visible}</strong>
      ${remaining > 0 ? `<em>+${remaining}</em>` : ''}
    </div>
  `;
}

function renderDependencyTags(task) {
  const dependencies = task.dependsOnTaskIds ?? [];
  const dependencyTag = dependencies.length > 0
    ? `<span class="tag dependency-tag">前置 ${dependencies.length}</span>`
    : '';
  const policyTag = task.parallelPolicy === 'PARALLEL_ALLOWED'
    ? '<span class="tag parallel-tag">允许并行</span>'
    : task.parallelPolicy === 'SEQUENTIAL'
      ? '<span class="tag sequential-tag">必须串行</span>'
      : '';
  return `${dependencyTag}${policyTag}`;
}

function renderDetailTask(task, phase, reorderableIds, index, currentTaskId) {
  const movable = reorderableIds.includes(task.id);
  const editable = canEditTask(task);
  const current = task.id === currentTaskId;
  const finished = isFinished(task);
  const recurring = task.status === 'RECURRING';
  const productState = current
    ? { className: 'current', label: '当前进度' }
    : recurring
      ? { className: 'recurring', label: '周期' }
      : task.status === 'DEFERRED'
        ? { className: 'deferred', label: '计划' }
        : finished
          ? { className: 'completed', label: '已完成' }
          : isInProgress(task)
            ? { className: 'in-progress', label: '推进中' }
            : { className: 'pending', label: '待处理' };
  const locked = !movable && !editable;
  const completion = task.latestCompletion;
  const modelRef = completion?.modelRef
    ?? task.currentRun?.modelRef
    ?? completion?.executor
    ?? task.currentRun?.executor
    ?? null;
  const completedAt = completion?.completedAt ?? task.currentRun?.finishedAt ?? null;
  const evidenceCount = (completion?.testEvidenceIds?.length ?? 0) + (completion?.reviewEvidenceIds?.length ?? 0);
  return `
    <article class="detail-task ${state.detailView}${current ? ' current' : ''}${finished ? ' finished' : ''}${task.starred ? ' starred' : ''}${locked ? ' locked' : ''}${recurring ? ' has-actions' : ''}"
      data-detail-task="${escapeHtml(task.id)}"
      data-phase-id="${escapeHtml(phase.id)}"
      data-current-task="${current ? 'true' : 'false'}"
      data-reorderable="${movable ? 'true' : 'false'}"
      data-tooltip-task="${escapeHtml(task.id)}"
      tabindex="0"
      ${movable ? 'aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"' : ''}
      draggable="${movable}">
      <div class="detail-task-order">
        <span class="drag-handle${movable ? '' : ' locked'}" title="${movable ? '拖动调整阶段内顺序' : '执行中或历史任务已锁定'}" aria-hidden="true">${movable ? '⠿' : '·'}</span>
        <span>${String(index + 1).padStart(2, '0')}</span>
      </div>
      <div class="detail-task-content">
        <div class="task-title-row">
          <strong>${task.starred ? '<span class="star-marker" aria-label="星标任务">★</span>' : ''}${escapeHtml(task.title)}</strong>
          <span class="state-badge ${productState.className}">${productState.label}</span>
        </div>
        <p>${escapeHtml(task.objective)}</p>
        <div class="task-meta">
          <span class="status ${task.status.toLowerCase()}" title="${escapeHtml(statusDescription(task.status))}">${statusLabel(task.status)}</span>
          <span class="tag provenance ${provenanceClass(task)}">${provenanceLabel(task)}</span>
          <span class="tag priority-${task.planning.priority.toLowerCase()}">${task.planning.priority}</span>
          <span class="tag kind-${task.planning.kind}">${kindLabel(task.planning.kind)}</span>
          <span class="tag">${computeLabel(task.recommendation.compute)}</span>
          <span class="tag">${task.planning.commitment === 'COMMITTED' ? '已确认' : '可调整'}</span>
          ${renderDependencyTags(task)}
          ${task.scheduledFor ? `<span class="tag scheduled-date">排期 ${escapeHtml(task.scheduledFor)}</span>` : ''}
          ${renderIssueReference(task.issue)}
          ${renderIssueReminder(task)}
        </div>
        <p class="detail-task-route">${escapeHtml(routeLabel(task.recommendation))} · ${formatDuration(task.recommendation.estimateMinutes)} · ${escapeHtml(task.recommendation.approach)}</p>
        ${completion ? `
          <div class="completion-line">
            <span>完成记录</span>
            <strong>${escapeHtml(modelRef || '人工 / 历史导入')}</strong>
            <time>${formatDateTime(completedAt)}</time>
            <span>${evidenceCount} 条证据</span>
          </div>
        ` : ''}
      </div>
      ${locked ? `<span class="task-lock-indicator" title="${recurring ? '周期任务定义和顺序已锁定，但可再次执行' : '已进入执行或完成，内容与顺序已锁定'}" aria-label="已锁定"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"></rect><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"></path></svg></span>` : ''}
      ${(recurring || editable) ? `<div class="detail-task-actions">
        ${recurring ? `<button data-run="${escapeHtml(task.id)}" class="button secondary compact" type="button">再次执行</button>` : ''}
        ${editable ? `<button class="button quiet compact star-toggle${task.starred ? ' active' : ''}" type="button" data-toggle-star="${escapeHtml(task.id)}" aria-pressed="${task.starred ? 'true' : 'false'}">${task.starred ? '取消星标' : '设为星标'}</button>` : ''}
        ${editable ? `<button class="button quiet compact" type="button" data-edit-task="${escapeHtml(task.id)}">编辑</button>` : ''}
        ${editable ? `<button class="button danger compact" type="button" data-cancel-task="${escapeHtml(task.id)}">移出排期</button>` : ''}
      </div>` : ''}
    </article>
  `;
}

function renderPhase(phase, phaseIndex, firstUnfinishedPhase) {
  if (phase.items.length === 0) {
    return `
      <section class="phase planned">
        <div class="phase-head">
          <div><span class="phase-index">S${phase.order}</span><h4>${escapeHtml(phase.name)}</h4></div>
          <span class="phase-state">等待补充</span>
        </div>
        <p class="phase-empty">从下方工作台加入第一个 Phase 与 Task；项目会保留在当前优先级位置。</p>
      </section>
    `;
  }
  const completed = phase.items.every(isFinished);
  const deferred = !completed
    && phase.items.some((item) => item.status === 'DEFERRED')
    && phase.items.every((item) => isFinished(item) || item.status === 'DEFERRED');
  const blocked = phase.items.some((item) => item.status === 'BLOCKED');
  const current = !completed && phaseIndex === firstUnfinishedPhase;
  const className = blocked ? 'blocked' : current ? 'current' : completed ? 'completed' : 'planned';
  const stateLabel = blocked ? '有阻塞' : current ? '正在推进' : completed ? '已验证' : deferred ? '计划' : '待排期';
  return `
    <section class="phase ${className}">
      <div class="phase-head">
        <div><span class="phase-index">S${phase.order}</span><h4>${escapeHtml(phase.name)}</h4></div>
        <span class="phase-state">${stateLabel}</span>
      </div>
      <div class="phase-tasks">
        ${phase.items.map(renderTask).join('')}
      </div>
    </section>
  `;
}

function renderTask(item) {
  const planning = item.planning;
  const recommendation = item.recommendation;
  const action = item.status === 'RECURRING'
    ? `<button data-run="${escapeHtml(item.id)}" class="button secondary compact" type="button">再次执行</button>`
    : item.status === 'PLANNED'
    ? `<button data-ready="${escapeHtml(item.id)}" class="button secondary compact" type="button">校验并就绪</button>`
    : item.status === 'READY'
      ? `<button data-run="${escapeHtml(item.id)}" class="button primary compact" type="button">执行推荐方案</button>`
      : item.currentRunId
        ? `<button data-replay="${escapeHtml(item.currentRunId)}" class="button secondary compact" type="button">查看运行</button>`
        : '';
  return `
    <article class="task-item${item.starred ? ' starred' : ''}" data-item-id="${escapeHtml(item.id)}">
      <div class="task-title-row">
        <strong>${item.starred ? '<span class="star-marker" aria-label="星标任务">★</span>' : ''}${escapeHtml(item.title)}</strong>
        <span class="status ${item.status.toLowerCase()}">${statusLabel(item.status)}</span>
      </div>
      <div class="task-meta">
        <span class="tag priority-${planning.priority.toLowerCase()}">${planning.priority}</span>
        <span class="tag kind-${planning.kind}">${kindLabel(planning.kind)}</span>
        <span class="tag">${computeLabel(recommendation.compute)}</span>
        <span class="tag">${planning.commitment === 'COMMITTED' ? '已确认' : '可调整'}</span>
        ${renderDependencyTags(item)}
        ${item.scheduledFor ? `<span class="tag scheduled-date">排期 ${escapeHtml(item.scheduledFor)}</span>` : ''}
        ${renderIssueReference(item.issue)}
        ${renderIssueReminder(item)}
      </div>
      <p class="task-route">${escapeHtml(routeLabel(recommendation))} · ${formatDuration(recommendation.estimateMinutes)}<br>${escapeHtml(recommendation.approach)}</p>
      ${(action || canEditTask(item)) ? `<div class="task-actions">${canEditTask(item) ? `<button class="button quiet compact star-toggle${item.starred ? ' active' : ''}" type="button" data-toggle-star="${escapeHtml(item.id)}" aria-pressed="${item.starred ? 'true' : 'false'}">${item.starred ? '取消星标' : '设为星标'}</button>` : ''}${action}</div>` : ''}
    </article>
  `;
}

function bindActionButtons(container) {
  container.querySelectorAll('[data-open-project]').forEach((button) => {
    button.addEventListener('click', () => openProjectDetail(button.dataset.openProject));
  });
  container.querySelectorAll('[data-ready]').forEach((button) => {
    button.addEventListener('click', () => markReady(button.dataset.ready));
  });
  container.querySelectorAll('[data-run]').forEach((button) => {
    button.addEventListener('click', () => runWorkItem(button.dataset.run));
  });
  container.querySelectorAll('[data-replay]').forEach((button) => {
    button.addEventListener('click', () => replayRun(button.dataset.replay));
  });
  container.querySelectorAll('[data-focus-item]').forEach((button) => {
    button.addEventListener('click', () => focusItem(button.dataset.focusItem));
  });
  container.querySelectorAll('[data-toggle-star]').forEach((button) => {
    button.addEventListener('click', () => toggleTaskStar(button.dataset.toggleStar));
  });
}

async function toggleTaskStar(taskId) {
  const task = detailTaskFor(taskId) ?? state.workItems.find((entry) => entry.id === taskId);
  if (!task || !canEditTask(task)) {
    notify('执行中或历史任务不能调整星标', true);
    return;
  }
  try {
    const schedule = state.detailSchedule?.project?.id === task.projectId
      ? state.detailSchedule
      : hydrateSchedule(await api(`/api/projects/${encodeURIComponent(task.projectId)}/schedule`));
    await api(`/api/work-items/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': mutationKey('star') },
      body: JSON.stringify({
        expectedScheduleVersion: schedule.scheduleVersion,
        starred: task.starred !== true
      })
    });
    notify(task.starred ? '已取消星标' : '已设为星标，下一步建议会优先考虑');
    await refresh();
  } catch (error) {
    await recoverScheduleMutation(error);
  }
}

async function openProjectDetail(projectId) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('project', projectId);
    window.history.pushState({ projectId }, '', url);
    state.selectedProjectId = projectId;
    state.detailFocusPending = true;
    state.detailSchedule = hydrateSchedule(await api(`/api/projects/${encodeURIComponent(projectId)}/schedule`));
    render();
    document.querySelector('.board-shell')?.scrollIntoView({ block: 'start' });
  } catch (error) {
    notify(error.message, true);
  }
}

function closeProjectDetail({ replace = false } = {}) {
  state.selectedProjectId = null;
  state.detailFocusPending = false;
  state.detailSchedule = null;
  closeTaskEditor();
  const url = new URL(window.location.href);
  url.searchParams.delete('project');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  render();
}

function replaceProjectQuery(projectId) {
  const url = new URL(window.location.href);
  if (projectId) url.searchParams.set('project', projectId);
  else url.searchParams.delete('project');
  window.history.replaceState(projectId ? { projectId } : {}, '', url);
}

function bindProjectDetailActions() {
  elements.board.querySelectorAll('[data-phase-edit-field]').forEach((node) => {
    node.addEventListener('dblclick', () => startPhaseInlineEdit(node));
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || node.dataset.editing === 'true') return;
      event.preventDefault();
      startPhaseInlineEdit(node);
    });
  });
  elements.board.querySelectorAll('[data-edit-task]').forEach((button) => {
    button.addEventListener('click', () => openTaskEditor(button.dataset.editTask));
  });
  elements.board.querySelectorAll('[data-cancel-task]').forEach((button) => {
    button.addEventListener('click', () => cancelTask(button.dataset.cancelTask));
  });
  elements.board.querySelectorAll('[draggable="true"]').forEach((task) => {
    task.addEventListener('keydown', (event) => {
      if (event.target !== task || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      moveTaskByKeyboard(task.dataset.detailTask, event.key === 'ArrowUp' ? -1 : 1);
    });
    task.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      state.dragTooltipSuppressed = true;
      hideTaskTooltip();
    });
    task.addEventListener('dragstart', (event) => {
      state.draggedTaskId = task.dataset.detailTask;
      state.dragTooltipSuppressed = true;
      document.body.classList.add('task-dragging');
      hideTaskTooltip();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', state.draggedTaskId);
      state.dragPlaceholder = createDragPlaceholder(task);
      task.after(state.dragPlaceholder);
      requestAnimationFrame(() => task.classList.add('drag-source-hidden'));
    });
    task.addEventListener('dragover', (event) => {
      const dragged = detailTaskFor(state.draggedTaskId);
      const target = detailTaskFor(task.dataset.detailTask);
      if (!dragged || !target || dragged.id === target.id || dragged.phaseId !== target.phaseId || !isReorderable(target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const placeholder = state.dragPlaceholder;
      if (!placeholder) return;
      const before = shouldInsertBefore(event, task);
      animateTaskLayout(task.parentElement, () => {
        task.parentElement.insertBefore(placeholder, before ? task : task.nextSibling);
      });
    });
    task.addEventListener('drop', async (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData('text/plain') || state.draggedTaskId;
      const placeholder = state.dragPlaceholder;
      if (!draggedId || !placeholder) return;
      const phaseId = task.dataset.phaseId;
      const orderedTaskIds = [...task.parentElement.children]
        .map((entry) => entry === placeholder
          ? draggedId
          : entry.dataset.reorderable === 'true' && entry.dataset.detailTask !== draggedId
            ? entry.dataset.detailTask
            : null)
        .filter(Boolean);
      cleanupDragState();
      await persistPhaseOrder(phaseId, orderedTaskIds);
    });
    task.addEventListener('dragend', () => {
      cleanupDragState();
    });
  });
}

function startPhaseInlineEdit(node) {
  if (!state.detailSchedule || node.dataset.editing === 'true') return;
  const phase = state.detailSchedule.phases.find((entry) => entry.id === node.dataset.phaseId);
  const field = node.dataset.phaseEditField;
  if (!phase || !['title', 'goal'].includes(field)) return;
  const original = field === 'title' ? phase.title : (phase.goal ?? '');
  let settled = false;
  const controller = new AbortController();
  node.dataset.editing = 'true';
  node.classList.remove('empty');
  node.contentEditable = 'true';
  node.spellcheck = false;
  node.textContent = original;
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const finish = async (save) => {
    if (settled) return;
    settled = true;
    controller.abort();
    const value = node.textContent.trim();
    node.contentEditable = 'false';
    delete node.dataset.editing;
    if (!save || value === original) {
      node.textContent = original || '双击补充阶段描述';
      node.classList.toggle('empty', field === 'goal' && !original);
      return;
    }
    if (field === 'title' && !value) {
      node.textContent = original;
      notify('阶段标题不能为空', true);
      return;
    }
    node.classList.add('saving');
    try {
      await api(`/api/phases/${encodeURIComponent(phase.id)}`, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': mutationKey('phase-inline-edit') },
        body: JSON.stringify({
          expectedScheduleVersion: state.detailSchedule.scheduleVersion,
          [field]: value
        })
      });
      notify(field === 'title' ? '阶段标题已保存' : '阶段描述已保存');
      await refresh();
    } catch (error) {
      node.classList.remove('saving');
      node.textContent = original || '双击补充阶段描述';
      node.classList.toggle('empty', field === 'goal' && !original);
      await recoverScheduleMutation(error);
    }
  };

  node.addEventListener('blur', () => finish(true), { once: true, signal: controller.signal });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
      node.blur();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      finish(true);
      node.blur();
    }
  }, { signal: controller.signal });
}

async function moveTaskByKeyboard(taskId, direction) {
  const task = detailTaskFor(taskId);
  const phase = state.detailSchedule?.phases.find((entry) => entry.id === task?.phaseId);
  if (!task || !phase || !isReorderable(task)) return;
  const orderedTaskIds = phase.tasks.filter(isReorderable).map((entry) => entry.id);
  const index = orderedTaskIds.indexOf(task.id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= orderedTaskIds.length) {
    notify(direction < 0 ? '已经是本阶段第一项可调整任务' : '已经是本阶段最后一项可调整任务');
    return;
  }
  [orderedTaskIds[index], orderedTaskIds[targetIndex]] = [orderedTaskIds[targetIndex], orderedTaskIds[index]];
  await persistPhaseOrder(phase.id, orderedTaskIds);
  requestAnimationFrame(() => elements.board.querySelector(`[data-detail-task="${CSS.escape(task.id)}"]`)?.focus());
}

function createDragPlaceholder(task) {
  const placeholder = document.createElement('div');
  placeholder.className = `task-drop-placeholder ${state.detailView}`;
  placeholder.dataset.dragPlaceholder = 'true';
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.style.height = `${Math.max(76, task.getBoundingClientRect().height)}px`;
  placeholder.innerHTML = '<span>放到这里</span>';
  return placeholder;
}

function shouldInsertBefore(event, target) {
  const rect = target.getBoundingClientRect();
  if (state.detailView === 'card' && Math.abs(event.clientY - (rect.top + rect.height / 2)) < rect.height * 0.35) {
    return event.clientX < rect.left + rect.width / 2;
  }
  return event.clientY < rect.top + rect.height / 2;
}

function animateTaskLayout(container, mutate) {
  if (!container) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nodes = [...container.children];
  const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
  mutate();
  if (reducedMotion) return;
  for (const node of [...container.children]) {
    const previous = before.get(node);
    if (!previous || typeof node.animate !== 'function') continue;
    const next = node.getBoundingClientRect();
    const dx = previous.left - next.left;
    const dy = previous.top - next.top;
    if (dx === 0 && dy === 0) continue;
    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  }
}

function cleanupDragState() {
  state.dragPlaceholder?.remove();
  state.dragPlaceholder = null;
  state.draggedTaskId = null;
  state.dragTooltipSuppressed = false;
  document.body.classList.remove('task-dragging');
  hideTaskTooltip();
  elements.board.querySelectorAll('.drag-source-hidden').forEach((entry) => entry.classList.remove('drag-source-hidden'));
}

function releaseTaskTooltipSuppression() {
  if (!state.draggedTaskId) state.dragTooltipSuppressed = false;
}

async function persistPhaseOrder(phaseId, orderedTaskIds, { recordUndo = true } = {}) {
  try {
    const previousOrder = state.detailSchedule?.phases
      .find((phase) => phase.id === phaseId)?.tasks
      .filter(isReorderable)
      .map((task) => task.id) ?? [];
    state.detailSchedule = hydrateSchedule(await api(
      `/api/projects/${encodeURIComponent(state.selectedProjectId)}/schedule`,
      {
        method: 'PATCH',
        headers: { 'Idempotency-Key': mutationKey('reorder') },
        body: JSON.stringify({
          phaseId,
          orderedTaskIds,
          expectedScheduleVersion: state.detailSchedule.scheduleVersion
        })
      }
    ));
    syncScheduleIntoWorkItems();
    if (recordUndo && previousOrder.length > 0) {
      notify('任务顺序已更新', false, {
        label: '撤销',
        handler: () => persistPhaseOrder(phaseId, previousOrder, { recordUndo: false })
      });
    } else {
      notify('任务顺序已恢复');
    }
    render();
  } catch (error) {
    await recoverScheduleMutation(error);
  }
}

function openTaskEditor(taskId) {
  const task = detailTaskFor(taskId);
  if (!task || !canEditTask(task)) return;
  const phases = state.detailSchedule.phases;
  if (phases.length === 0) {
    notify('请先为项目创建一个有效阶段，再编辑这项任务', true);
    return;
  }
  state.taskEditorMode = 'edit';
  state.editingTaskId = taskId;
  setTaskEditorCopy({
    context: '调整执行契约',
    title: '编辑排期任务',
    submit: '保存调整',
    hint: `创建来源：${provenanceLabel(task)}。内容调整会进入审计；只调整顺序不会改变来源标签。`
  });
  populatePhaseOptions(false);
  elements.editPhaseId.value = phases.some((phase) => phase.id === task.phaseId) ? task.phaseId : phases[0].id;
  elements.editKind.value = task.planning.kind;
  elements.editPriority.value = task.planning.priority;
  elements.editCommitment.value = task.planning.commitment;
  elements.editTitle.value = task.title;
  elements.editObjective.value = task.objective;
  elements.editIssue.value = task.issue ?? '';
  elements.editStarred.checked = task.starred === true;
  elements.editScheduledFor.value = task.scheduledFor ?? '';
  elements.editParallelPolicy.value = task.parallelPolicy;
  populateDependencyOptions(elements.editDependencies, state.detailSchedule, {
    excludeTaskId: task.id,
    selectedIds: task.dependsOnTaskIds
  });
  elements.editCriteria.value = task.acceptanceCriteria.join('\n');
  elements.editCommands.value = task.testCommands.join('\n');
  syncNewPhaseFields();
  elements.taskEditor.showModal();
  elements.editTitle.focus();
}

function openTaskCreator() {
  if (!state.detailSchedule || !state.selectedProjectId) return;
  state.taskEditorMode = 'create';
  state.editingTaskId = null;
  setTaskEditorCopy({
    context: '人工录入排期',
    title: '新增项目任务',
    submit: '加入当前排期',
    hint: '页面新增会标记为“人工新增”；Agent 通过 MCP 新增会标记为“AI 提交”。AI 任务后续改内容时会保留“人工调整”记录。'
  });
  populatePhaseOptions(true);
  elements.editKind.value = 'feature';
  elements.editPriority.value = 'P1';
  elements.editCommitment.value = 'TENTATIVE';
  elements.editTitle.value = '';
  elements.editObjective.value = '';
  elements.editIssue.value = '';
  elements.editStarred.checked = false;
  elements.editScheduledFor.value = '';
  elements.editParallelPolicy.value = 'AUTO';
  populateDependencyOptions(elements.editDependencies, state.detailSchedule);
  elements.editCriteria.value = '';
  elements.editCommands.value = '';
  const nextPhaseOrder = Math.max(0, ...state.detailSchedule.phases.map((phase) => Number(phase.phaseOrder) || 0)) + 1;
  elements.editNewPhaseOrder.value = String(nextPhaseOrder);
  elements.editNewPhaseTitle.value = '';
  syncNewPhaseFields();
  elements.taskEditor.showModal();
  elements.editTitle.focus();
}

function populatePhaseOptions(includeNewPhase) {
  const phaseOptions = state.detailSchedule.phases
    .map((phase) => `<option value="${escapeHtml(phase.id)}">S${escapeHtml(phase.phaseOrder)} · ${escapeHtml(phase.title)}</option>`)
    .join('');
  elements.editPhaseId.innerHTML = `${phaseOptions}${includeNewPhase ? '<option value="__new__">＋ 新建阶段</option>' : ''}`;
  if (includeNewPhase && state.detailSchedule.phases.length === 0) elements.editPhaseId.value = '__new__';
}

function populateDependencyOptions(select, schedule, { excludeTaskId = null, selectedIds = [] } = {}) {
  const selected = new Set(selectedIds ?? []);
  const tasks = schedule
    ? [...schedule.phases.flatMap((phase) => phase.tasks), ...(schedule.unscheduledTasks ?? [])]
      .filter((task) => task.id !== excludeTaskId && task.status !== 'CANCELLED')
      .sort(compareItems)
    : [];
  if (tasks.length === 0) {
    select.innerHTML = '<option disabled>当前没有可选的前置任务</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = tasks.map((task) => `
    <option value="${escapeHtml(task.id)}"${selected.has(task.id) ? ' selected' : ''}>
      S${escapeHtml(task.planning.phaseOrder)} · ${escapeHtml(task.title)} · ${escapeHtml(statusLabel(task.status))}
    </option>
  `).join('');
}

function selectedOptionValues(select) {
  if (!select || select.disabled) return [];
  return [...select.selectedOptions].map((option) => option.value);
}

function setTaskEditorCopy({ context, title, submit, hint }) {
  elements.taskEditorContext.textContent = context;
  elements.taskEditorTitle.textContent = title;
  elements.taskEditorSubmit.textContent = submit;
  elements.taskSourceHint.textContent = hint;
}

function syncNewPhaseFields() {
  const creatingPhase = state.taskEditorMode === 'create' && elements.editPhaseId.value === '__new__';
  elements.newPhaseFields.hidden = !creatingPhase;
  elements.editNewPhaseTitle.required = creatingPhase;
  elements.editNewPhaseOrder.required = creatingPhase;
  if (creatingPhase) {
    elements.phaseMoveHint.textContent = '保存后会创建新阶段，并把新任务放到该阶段末尾。';
    return;
  }
  const targetPhase = state.detailSchedule?.phases.find((phase) => phase.id === elements.editPhaseId.value);
  const currentTask = detailTaskFor(state.editingTaskId);
  const dependencyIds = selectedOptionValues(elements.editDependencies);
  const dependencies = dependencyIds.map(detailTaskFor).filter(Boolean);
  const latestDependencyPhase = Math.max(0, ...dependencies.map((task) => Number(task.planning.phaseOrder) || 0));
  if (state.taskEditorMode === 'edit' && targetPhase && currentTask && targetPhase.id !== currentTask.phaseId) {
    elements.phaseMoveHint.textContent = Number(targetPhase.phaseOrder) < latestDependencyPhase
      ? `目标阶段早于已选前置任务，保存会被依赖校验拒绝；请先调整依赖或阶段。`
      : `将从 ${currentTask.planning.phase} 移到 S${targetPhase.phaseOrder} · ${targetPhase.title}；保存后可立即撤销。`;
  } else if (state.taskEditorMode === 'edit') {
    elements.phaseMoveHint.textContent = '任务仍在当前阶段；Alt + ↑ / ↓ 可调整阶段内顺序。';
  } else {
    elements.phaseMoveHint.textContent = targetPhase
      ? `新任务将加入 S${targetPhase.phaseOrder} · ${targetPhase.title} 的末尾。`
      : '请选择有效阶段。';
  }
}

function closeTaskEditor() {
  state.editingTaskId = null;
  elements.editNewPhaseTitle.required = false;
  elements.editNewPhaseOrder.required = false;
  if (elements.taskEditor.open) elements.taskEditor.close();
}

async function saveTaskEditor(event) {
  event.preventDefault();
  if (state.taskEditorMode === 'create') {
    await createDetailTask();
    return;
  }
  const task = detailTaskFor(state.editingTaskId);
  if (!task) return;
  const phaseId = elements.editPhaseId.value;
  const targetPhase = state.detailSchedule.phases.find((phase) => phase.id === phaseId);
  if (!targetPhase) {
    notify('所选阶段已失效，排期已刷新，请重试', true);
    await refresh();
    return;
  }
  try {
    const previousPhaseId = task.phaseId;
    const movedAcrossPhases = previousPhaseId !== phaseId;
    await api(`/api/work-items/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': mutationKey('edit') },
      body: JSON.stringify({
        expectedScheduleVersion: state.detailSchedule.scheduleVersion,
        phaseId,
        title: elements.editTitle.value,
        objective: elements.editObjective.value,
        issue: elements.editIssue.value.trim() || null,
        starred: elements.editStarred.checked,
        scheduledFor: elements.editScheduledFor.value || null,
        dependsOnTaskIds: selectedOptionValues(elements.editDependencies),
        parallelPolicy: elements.editParallelPolicy.value,
        acceptanceCriteria: lines(elements.editCriteria.value),
        testCommands: lines(elements.editCommands.value),
        planning: {
          kind: elements.editKind.value,
          priority: elements.editPriority.value,
          commitment: elements.editCommitment.value
        }
      })
    });
    closeTaskEditor();
    await refresh();
    if (movedAcrossPhases) {
      notify('任务已移动到新阶段', false, {
        label: '撤销移动',
        handler: () => restoreTaskPhase(task.id, previousPhaseId)
      });
    } else {
      notify('任务执行契约已更新');
    }
  } catch (error) {
    await recoverScheduleMutation(error);
  }
}

async function restoreTaskPhase(taskId, phaseId) {
  if (!state.detailSchedule) return;
  try {
    await api(`/api/work-items/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': mutationKey('undo-phase-move') },
      body: JSON.stringify({
        expectedScheduleVersion: state.detailSchedule.scheduleVersion,
        phaseId
      })
    });
    await refresh();
    notify('任务已移回原阶段');
  } catch (error) {
    await recoverScheduleMutation(error);
  }
}

async function createDetailTask() {
  if (!state.detailSchedule || !state.selectedProjectId) return;
  try {
    let phase = state.detailSchedule.phases.find((entry) => entry.id === elements.editPhaseId.value);
    if (elements.editPhaseId.value === '__new__') {
      const phaseOrder = Number(elements.editNewPhaseOrder.value);
      phase = await api('/api/phases', {
        method: 'POST',
        headers: { 'Idempotency-Key': mutationKey('phase-create') },
        body: JSON.stringify({
          projectId: state.selectedProjectId,
          title: elements.editNewPhaseTitle.value,
          rank: phaseOrder * 1024
        })
      });
    }
    if (!phase) throw new Error('请选择有效阶段');
    const kind = elements.editKind.value;
    const taskOrder = Math.max(0, ...(phase.tasks ?? []).map((task) => Number(task.planning?.taskOrder) || 0)) + 1;
    await api('/api/work-items', {
      method: 'POST',
      headers: { 'Idempotency-Key': mutationKey('task-create') },
      body: JSON.stringify({
        projectId: state.selectedProjectId,
        phaseId: phase.id,
        title: elements.editTitle.value,
        objective: elements.editObjective.value,
        issue: elements.editIssue.value.trim() || null,
        starred: elements.editStarred.checked,
        scheduledFor: elements.editScheduledFor.value || null,
        dependsOnTaskIds: selectedOptionValues(elements.editDependencies),
        parallelPolicy: elements.editParallelPolicy.value,
        acceptanceCriteria: lines(elements.editCriteria.value),
        testCommands: lines(elements.editCommands.value),
        riskTier: kind === 'ops' ? 'medium' : 'low',
        weight: 1,
        resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 2 },
        planning: {
          phaseId: phase.id,
          phase: phase.title,
          phaseOrder: phase.phaseOrder,
          taskOrder,
          kind,
          priority: elements.editPriority.value,
          commitment: elements.editCommitment.value
        }
      })
    });
    closeTaskEditor();
    notify('人工任务已加入排期，来源记录已写入');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

async function cancelTask(taskId) {
  const task = detailTaskFor(taskId);
  if (!task || !canEditTask(task)) return;
  if (!window.confirm(`确定将“${task.title}”移出当前排期？\n\n任务会从有效排期中消失，历史审计记录仍会保留。`)) return;
  try {
    await api(`/api/work-items/${encodeURIComponent(task.id)}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': mutationKey('cancel') },
      body: JSON.stringify({
        expectedScheduleVersion: state.detailSchedule.scheduleVersion,
        reason: '用户从项目详情移出当前排期'
      })
    });
    notify('任务已移出当前排期，审计记录已保留');
    await refresh();
  } catch (error) {
    await recoverScheduleMutation(error);
  }
}

async function recoverScheduleMutation(error) {
  if (error.code === 'SCHEDULE_VERSION_CONFLICT') {
    closeTaskEditor();
    notify('排期刚被其他操作更新，已刷新到最新版本，请重试', true);
    await refresh();
    return;
  }
  notify(error.message, true);
}

function focusItem(itemId) {
  if (state.filter !== 'all') {
    state.filter = 'all';
    document.querySelectorAll('[data-filter]').forEach((entry) => {
      const active = entry.dataset.filter === 'all';
      entry.classList.toggle('active', active);
      entry.setAttribute('aria-pressed', String(active));
    });
    renderBoard();
  }
  const item = elements.board.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
  item?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  item?.classList.add('focus-pulse');
  window.setTimeout(() => item?.classList.remove('focus-pulse'), 1000);
}

function renderProjectSelect() {
  const previous = elements.projectId.value;
  elements.projectId.innerHTML = state.projects.length
    ? state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')
    : '<option value="">请先添加项目</option>';
  if (state.projects.some((project) => project.id === previous)) elements.projectId.value = previous;
}

function hydrateDashboard(dashboard, workItems) {
  return {
    ...dashboard,
    projects: (dashboard.projects ?? []).map((project) => {
      const projectItems = workItems.filter((item) => item.projectId === project.id);
      const unfinished = projectItems.filter(isUnfinished);
      return {
        ...project,
        phaseCount: project.phaseCount ?? new Set(projectItems.map((item) => item.planning.phaseOrder)).size,
        unfinishedWorkItemCount: project.unfinishedWorkItemCount ?? unfinished.length,
        nextWorkItemId: project.nextWorkItemId ?? unfinished.sort(compareItems)[0]?.id ?? null
      };
    })
  };
}

function hydrateSchedule(schedule) {
  return {
    ...schedule,
    phases: (schedule.phases ?? []).map((phase) => ({
      ...phase,
      tasks: (phase.tasks ?? []).map((task) => hydrateScheduleTask(task, phase))
    })),
    unscheduledTasks: (schedule.unscheduledTasks ?? []).map((task) => hydrateWorkItem(task))
  };
}

function hydrateScheduleTask(task, phase) {
  const hydrated = hydrateWorkItem(task);
  return {
    ...hydrated,
    phaseId: phase.id,
    planning: {
      ...hydrated.planning,
      phaseId: phase.id,
      phase: phase.title,
      phaseOrder: phase.phaseOrder
    }
  };
}

function syncScheduleIntoWorkItems() {
  if (!state.detailSchedule) return;
  const scheduled = state.detailSchedule.phases.flatMap((phase) => phase.tasks);
  const byId = new Map(scheduled.map((task) => [task.id, task]));
  state.workItems = state.workItems.map((task) => byId.get(task.id) ?? task);
}

function hydrateWorkItem(item) {
  const kind = item.planning?.kind ?? inferKind(item);
  const defaults = recommendationDefaults(kind);
  return {
    ...item,
    starred: item.starred === true,
    scheduledFor: item.scheduledFor ?? null,
    dependsOnTaskIds: Array.isArray(item.dependsOnTaskIds) ? item.dependsOnTaskIds : [],
    parallelPolicy: ['AUTO', 'SEQUENTIAL', 'PARALLEL_ALLOWED'].includes(item.parallelPolicy)
      ? item.parallelPolicy
      : 'AUTO',
    planning: {
      phase: item.planning?.phase ?? '待排期',
      phaseOrder: positiveNumber(item.planning?.phaseOrder, 99),
      taskOrder: positiveNumber(item.planning?.taskOrder, 99),
      kind,
      priority: item.planning?.priority ?? (kind === 'bug' ? 'P0' : kind === 'scan' ? 'P2' : 'P1'),
      commitment: item.planning?.commitment ?? 'TENTATIVE'
    },
    recommendation: {
      ...defaults,
      ...(item.recommendation ?? {}),
      estimateMinutes: positiveNumber(item.recommendation?.estimateMinutes, defaults.estimateMinutes)
    }
  };
}

function recommendationDefaults(kind) {
  return {
    feature: { capability: 'agentic-coding', executor: 'codex', reasoningEffort: 'high', compute: 'high', estimateMinutes: 90, approach: '先确认执行契约与验收证据，再实现并独立审查。' },
    bug: { capability: 'code-repair', executor: 'codex', reasoningEffort: 'high', compute: 'medium', estimateMinutes: 45, approach: '先复现并补回归测试，再做最小修复。' },
    scan: { capability: 'repository-scan', executor: 'codex', reasoningEffort: 'low', compute: 'low', estimateMinutes: 20, approach: '先跑确定性检查，只把异常和高价值区域交给模型分析。' },
    research: { capability: 'research-synthesis', executor: 'codex', reasoningEffort: 'medium', compute: 'medium', estimateMinutes: 40, approach: '先快速铺开证据，再用强推理收敛分歧和方案。' },
    ops: { capability: 'safe-automation', executor: 'shell', reasoningEffort: 'medium', compute: 'low', estimateMinutes: 30, approach: '优先使用确定性脚本，高风险动作保留人工审批。' },
    review: { capability: 'independent-review', executor: 'codex', reasoningEffort: 'high', compute: 'medium', estimateMinutes: 35, approach: '与实现上下文隔离审查，先报告可验证问题再决定修改。' }
  }[kind] ?? recommendationDefaults('feature');
}

function inferKind(item) {
  const text = `${item.title ?? ''} ${item.objective ?? ''}`.toLowerCase();
  if (text.includes('bug') || text.includes('修复')) return 'bug';
  if (text.includes('scan') || text.includes('扫描')) return 'scan';
  if (text.includes('review') || text.includes('审查')) return 'review';
  return 'feature';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function replayRun(runId) {
  try {
    const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
    elements.timeline.innerHTML = '';
    for (const event of run.events) appendTimeline(event);
    setRunStatus(run.status);
    document.querySelector('#workbench').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) openRunStream(runId);
  } catch (error) {
    notify(error.message, true);
  }
}

function setRunStatus(status) {
  elements.runStatus.textContent = statusLabel(status);
  elements.runStatus.className = `status ${String(status).toLowerCase()}`;
}

function groupPhases(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.planning.phaseOrder}:${item.planning.phase}`;
    if (!groups.has(key)) groups.set(key, { order: item.planning.phaseOrder, name: item.planning.phase, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((left, right) => left.order - right.order);
}

function recommendedCandidate() {
  return state.workItems.filter(isUnfinished).sort((left, right) => candidateScore(right) - candidateScore(left))[0] ?? null;
}

function candidateScore(item) {
  const project = projectFor(item.projectId);
  const priority = { P0: 40, P1: 30, P2: 20, P3: 10 }[item.planning.priority] ?? 0;
  const readiness = {
    REVIEW: 48,
    RUNNING: 46,
    QUEUED: 44,
    READY: 36,
    PLANNED: 24,
    TRIAGED: 16,
    DISCOVERED: 10,
    BLOCKED: -40
  }[item.status] ?? 0;
  const foundation = Math.max(0, 100 - Number(item.planning.phaseOrder ?? 100));
  const humanPriority = item.provenance?.origin === 'HUMAN' ? 8 : 0;
  return (item.starred === true ? 1000 : 0)
    + scheduledDatePriority(item.scheduledFor)
    + Number(project?.strategicValue ?? 0) * 6
    + priority
    + readiness
    + foundation
    + humanPriority;
}

function scheduledDatePriority(value) {
  if (!value) return 0;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const target = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(target)) return 0;
  const days = Math.ceil((target - todayUtc) / 86_400_000);
  if (days <= 0) return 120;
  return Math.max(0, 100 - days * 5);
}

function matchesFilter(item) {
  if (state.filter === 'low') return item.recommendation.compute === 'low';
  if (state.filter === 'high') return item.recommendation.compute === 'high';
  if (state.filter === 'bug') return ['bug', 'scan'].includes(item.planning.kind);
  if (state.filter === 'starred') return item.starred === true;
  return true;
}

function compareItems(left, right) {
  return left.planning.phaseOrder - right.planning.phaseOrder
    || left.planning.taskOrder - right.planning.taskOrder
    || left.title.localeCompare(right.title, 'zh-CN');
}

function projectFor(projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function detailTaskFor(taskId) {
  if (!state.detailSchedule || !taskId) return null;
  return [
    ...state.detailSchedule.phases.flatMap((phase) => phase.tasks),
    ...state.detailSchedule.unscheduledTasks
  ].find((task) => task.id === taskId) ?? null;
}

function taskDependenciesSatisfied(task) {
  return (task.dependsOnTaskIds ?? []).every((dependencyId) => {
    const dependency = detailTaskFor(dependencyId) ?? state.workItems.find((entry) => entry.id === dependencyId);
    return dependency && isFinished(dependency);
  });
}

function canEditTask(task) {
  return ['PLANNED', 'DEFERRED', 'READY', 'BLOCKED'].includes(task.status);
}

function isReorderable(task) {
  return ['DISCOVERED', 'TRIAGED', 'PLANNED', 'DEFERRED', 'READY', 'BLOCKED'].includes(task.status);
}

function projectPriority(strategicValue) {
  if (strategicValue >= 9) return 'P1';
  if (strategicValue >= 7) return 'P2';
  if (strategicValue >= 5) return 'P3';
  return 'P4';
}

function kindLabel(kind) {
  return {
    feature: '功能', bug: 'Bug', scan: '扫描', research: '调研', ops: '运维', review: '审查'
  }[kind] ?? kind;
}

function computeLabel(compute) {
  return { low: '低算力', medium: '中算力', high: '高算力' }[compute] ?? compute;
}

function statusLabel(status) {
  return {
    DISCOVERED: '新发现', TRIAGED: '已分诊', PLANNED: '待排期', DEFERRED: '计划', READY: '已就绪', QUEUED: '排队中', RUNNING: '执行中', REVIEW: '审查中',
    BLOCKED: '已阻塞', RECURRING: '周期', VERIFIED: '已验证', RELEASED: '已发布', ARCHIVED: '已归档', SUCCEEDED: '运行成功',
    FAILED: '运行失败', CANCELLED: '已取消', RECONNECTING: '重连中'
  }[status] ?? status;
}

function statusDescription(status) {
  return {
    DISCOVERED: '扫描或 Agent 新发现，尚未确认是否进入排期。',
    TRIAGED: '已判断价值与影响，等待形成执行契约。',
    PLANNED: '已进入排期，内容和顺序仍可调整。',
    DEFERRED: '已列入长期计划，短期不推进；内容、顺序和是否保留仍可调整。',
    READY: '目标、验收与测试契约完整，可以立即进入执行队列。',
    QUEUED: '已进入执行队列，任务已锁定。',
    RUNNING: 'Agent 或执行器正在处理，任务已锁定。',
    REVIEW: '执行已提交，正在核验结果与证据，尚未算完成。',
    BLOCKED: '当前存在阻塞，解除后可以重新排期或就绪。',
    RECURRING: '周期任务已经建立并计入完成；定义和顺序锁定，但可以反复执行并保留每次记录。',
    VERIFIED: '结果与证据已通过验证，计入完成并锁定。',
    RELEASED: '已验证结果已经发布，保持锁定。',
    ARCHIVED: '历史完成项已归档，保持只读。',
    CANCELLED: '已从有效排期移除，不计入完成。'
  }[status] ?? '技术执行状态。';
}

function provenanceLabel(task) {
  const provenance = task?.provenance ?? {};
  if (provenance.origin === 'AI' && provenance.contentAdjustedByHuman) return 'AI 提交 · 人工调整';
  return {
    AI: 'AI 提交',
    HUMAN: '人工新增',
    IMPORTED: '历史导入',
    UNKNOWN: '来源未记录'
  }[provenance.origin] ?? '来源未记录';
}

function provenanceClass(task) {
  const provenance = task?.provenance ?? {};
  if (provenance.origin === 'AI' && provenance.contentAdjustedByHuman) return 'ai-adjusted';
  return String(provenance.origin ?? 'UNKNOWN').toLowerCase();
}

function bindTaskTooltips() {
  elements.board.querySelectorAll('[data-tooltip-task]').forEach((node) => {
    const show = () => showTaskTooltip(node, detailTaskFor(node.dataset.tooltipTask));
    node.addEventListener('mouseenter', show);
    node.addEventListener('focusin', show);
    node.addEventListener('mouseleave', scheduleTaskTooltipHide);
    node.addEventListener('focusout', (event) => {
      if (!node.contains(event.relatedTarget)) scheduleTaskTooltipHide();
    });
  });
}

function showTaskTooltip(anchor, task) {
  if (!task || state.dragTooltipSuppressed || state.draggedTaskId) {
    hideTaskTooltip();
    return;
  }
  cancelTaskTooltipHide();
  const completion = task.latestCompletion;
  const completionModel = completion?.modelRef
    ?? task.currentRun?.modelRef
    ?? completion?.executor
    ?? task.currentRun?.executor
    ?? null;
  const completionAt = completion?.completedAt ?? task.currentRun?.finishedAt ?? null;
  const evidenceCount = (completion?.testEvidenceIds?.length ?? 0) + (completion?.reviewEvidenceIds?.length ?? 0);
  const criteria = task.acceptanceCriteria?.length
    ? `<ul>${task.acceptanceCriteria.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`
    : '<p>尚未填写验收标准</p>';
  const commands = task.testCommands?.length
    ? `<pre>${escapeHtml(task.testCommands.join('\n'))}</pre>`
    : '<p>尚未填写测试命令</p>';
  const dependencies = (task.dependsOnTaskIds ?? []).map((dependencyId) => (
    detailTaskFor(dependencyId) ?? state.workItems.find((entry) => entry.id === dependencyId)
  )).filter(Boolean);
  const dependencyList = dependencies.length > 0
    ? `<ul>${dependencies.map((dependency) => `<li>${escapeHtml(dependency.title)} · ${escapeHtml(statusLabel(dependency.status))}</li>`).join('')}</ul>`
    : '<p>无前置依赖</p>';
  elements.taskTooltip.innerHTML = `
    <div class="tooltip-heading"><strong>${escapeHtml(task.title)}</strong><span>${provenanceLabel(task)}</span></div>
    <div class="tooltip-meta">
      ${task.starred ? '<span>★ 星标优先</span>' : ''}<span>${statusLabel(task.status)}</span><span>${task.planning.priority}</span><span>${kindLabel(task.planning.kind)}</span><span>${computeLabel(task.recommendation.compute)}</span>${task.scheduledFor ? `<span>排期 ${escapeHtml(task.scheduledFor)}</span>` : ''}
    </div>
    <p>${escapeHtml(task.objective)}</p>
    <p class="tooltip-status">${escapeHtml(statusDescription(task.status))}</p>
    ${task.issue ? `<p class="tooltip-issue">${renderIssueReference(task.issue)}</p>` : ''}
    <h5>前置依赖</h5>${dependencyList}
    <h5>验收标准</h5>${criteria}
    <h5>测试命令</h5>${commands}
    ${completion ? `<p class="tooltip-completion">完成记录：${escapeHtml(completionModel || '人工 / 历史导入')} · ${formatDateTime(completionAt)} · ${evidenceCount} 条证据</p>` : ''}
    <p class="tooltip-route">${escapeHtml(routeLabel(task.recommendation))} · ${formatDuration(task.recommendation.estimateMinutes)}<br>${escapeHtml(task.recommendation.approach)}</p>
  `;
  elements.taskTooltip.hidden = false;
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = elements.taskTooltip.getBoundingClientRect();
  const gap = 12;
  const left = Math.min(window.innerWidth - tooltipRect.width - gap, Math.max(gap, anchorRect.left));
  const below = anchorRect.bottom + gap;
  const top = below + tooltipRect.height <= window.innerHeight - gap
    ? below
    : Math.max(gap, anchorRect.top - tooltipRect.height - gap);
  elements.taskTooltip.style.left = `${left}px`;
  elements.taskTooltip.style.top = `${top}px`;
}

function hideTaskTooltip() {
  cancelTaskTooltipHide();
  elements.taskTooltip.hidden = true;
}

function scheduleTaskTooltipHide() {
  cancelTaskTooltipHide();
  taskTooltipHideTimer = window.setTimeout(hideTaskTooltip, 160);
}

function cancelTaskTooltipHide() {
  if (taskTooltipHideTimer === null) return;
  window.clearTimeout(taskTooltipHideTimer);
  taskTooltipHideTimer = null;
}

function routeLabel(recommendation) {
  const executor = recommendation.executor === 'codex' ? 'Codex' : recommendation.executor === 'shell' ? 'Shell' : recommendation.executor;
  const effort = { low: '低推理', medium: '中推理', high: '高推理' }[recommendation.reasoningEffort] ?? recommendation.reasoningEffort;
  return `${executor} · ${effort} · ${recommendation.capability}`;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function isFinished(item) {
  return ['RECURRING', 'VERIFIED', 'RELEASED', 'ARCHIVED'].includes(item.status);
}

function isUnfinished(item) {
  return !isFinished(item) && !['CANCELLED', 'DEFERRED'].includes(item.status);
}

function isInProgress(item) {
  return ['QUEUED', 'RUNNING', 'REVIEW'].includes(item.status);
}

function renderIssueReference(issue) {
  const value = typeof issue === 'string' ? issue.trim() : '';
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `<a class="tag issue-ref" href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">关联 Issue ↗</a>`;
    }
  } catch {}
  return `<span class="tag issue-ref" title="${escapeHtml(value)}">Issue · ${escapeHtml(value)}</span>`;
}

function renderIssueReminder(task) {
  if (task.issue || task.provenance?.origin !== 'HUMAN') return '';
  return '<span class="tag issue-missing" title="可从任务编辑器补充仓库 Issue">待关联 Issue</span>';
}

function readDetailView() {
  try {
    return window.localStorage.getItem('lifeline.detailView') === 'card' ? 'card' : 'row';
  } catch {
    return 'row';
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    error.status = response.status;
    throw error;
  }
  return body;
}

function lines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function mutationKey(action) {
  return globalThis.crypto?.randomUUID?.() ?? `${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function notify(message, isError = false, action = null) {
  elements.toast.replaceChildren();
  const copy = document.createElement('span');
  copy.textContent = message;
  elements.toast.append(copy);
  if (action?.label && typeof action.handler === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      window.clearTimeout(notify.timer);
      elements.toast.classList.remove('visible');
      await action.handler();
    });
    elements.toast.append(button);
  }
  elements.toast.className = `toast visible${isError ? ' error' : ''}${action ? ' actionable' : ''}`;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => elements.toast.classList.remove('visible'), action ? 6000 : 2800);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  })[character]);
}

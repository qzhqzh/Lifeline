const state = {
  projects: [],
  workItems: [],
  dashboard: null,
  dispatch: null,
  devReloadSource: null,
  trajectory: null,
  trajectoryWindow: readTrajectoryWindow(),
  filter: 'all',
  bootstrap: null,
  bootstrapConflictKey: null,
  selectedProjectId: new URLSearchParams(window.location.search).get('project'),
  detailFocusPending: true,
  detailSchedule: null,
  creationMode: 'task',
  creationDraftSnapshot: null,
  editingTaskId: null,
  taskEditorMode: 'edit',
  taskEditorProjectId: null,
  taskEditorSchedule: null,
  detailView: readDetailView(),
  draggedTaskId: null,
  dragPlaceholder: null,
  dragTooltipSuppressed: false,
  boardScrollPositions: new Map(),
  boardRowSignatures: new Map(),
  detailRenderSignature: null,
  refreshRemainingSeconds: 10,
  refreshInFlight: false
};

const elements = {
  health: document.querySelector('#health'),
  subscriptionSummaryLink: document.querySelector('#subscriptionSummaryLink'),
  metrics: document.querySelector('#metrics'),
  nextAction: document.querySelector('#nextAction'),
  dispatchAudit: document.querySelector('#dispatchAudit'),
  board: document.querySelector('#portfolioBoard'),
  projectId: document.querySelector('#projectId'),
  trajectory: document.querySelector('#trajectory'),
  trajectorySummary: document.querySelector('#trajectorySummary'),
  trajectoryCoverage: document.querySelector('#trajectoryCoverage'),
  trajectoryBoard: document.querySelector('#trajectoryBoard'),
  trajectoryWindowSwitch: document.querySelector('#trajectoryWindowSwitch'),
  trajectoryDrawer: document.querySelector('#trajectoryDrawer'),
  trajectoryDrawerContext: document.querySelector('#trajectoryDrawerContext'),
  trajectoryDrawerTitle: document.querySelector('#trajectoryDrawerTitle'),
  trajectoryDrawerBody: document.querySelector('#trajectoryDrawerBody'),
  closeTrajectoryDrawer: document.querySelector('#closeTrajectoryDrawer'),
  bootstrapAction: document.querySelector('#bootstrapAction'),
  seedDemo: document.querySelector('#seedDemo'),
  bootstrapConflictDialog: document.querySelector('#bootstrapConflictDialog'),
  bootstrapConflictSummary: document.querySelector('#bootstrapConflictSummary'),
  keepBootstrapExisting: document.querySelector('#keepBootstrapExisting'),
  mergeBootstrapExisting: document.querySelector('#mergeBootstrapExisting'),
  refresh: document.querySelector('#refresh'),
  openCreationDrawer: document.querySelector('#openCreationDrawer'),
  creationDrawer: document.querySelector('#creationDrawer'),
  closeCreationDrawer: document.querySelector('#closeCreationDrawer'),
  projectForm: document.querySelector('#projectForm'),
  taskLauncherForm: document.querySelector('#taskLauncherForm'),
  strategicValue: document.querySelector('#strategicValue'),
  strategicValueOutput: document.querySelector('#strategicValueOutput'),
  toast: document.querySelector('#toast'),
  boardFilters: document.querySelector('#boardFilters'),
  boardTitle: document.querySelector('#portfolio-title'),
  boardDescription: document.querySelector('#portfolioDescription'),
  backToPortfolio: document.querySelector('#backToPortfolio'),
  detailControls: document.querySelector('#detailControls'),
  clientViewLink: document.querySelector('#clientViewLink'),
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
  taskTooltip: document.querySelector('#taskTooltip'),
  taskInspector: document.querySelector('#taskInspector'),
  taskInspectorContext: document.querySelector('#taskInspectorContext'),
  taskInspectorTitle: document.querySelector('#taskInspectorTitle'),
  taskInspectorBody: document.querySelector('#taskInspectorBody'),
  closeTaskInspector: document.querySelector('#closeTaskInspector')
};

let taskTooltipHideTimer = null;

elements.refresh.addEventListener('click', async () => {
  resetRefreshCountdown();
  await Promise.all([checkHealth(), refresh()]);
});
elements.seedDemo?.addEventListener('click', bootstrapPortfolio);
elements.keepBootstrapExisting?.addEventListener('click', () => resolveBootstrapConflict('KEEP_EXISTING'));
elements.mergeBootstrapExisting?.addEventListener('click', () => resolveBootstrapConflict('MERGE_EXISTING'));
elements.bootstrapConflictDialog?.addEventListener('close', resetBootstrapConflictControls);
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
elements.taskLauncherForm.addEventListener('submit', openGlobalTaskCreator);
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
  applyBoardFilter();
});
elements.trajectoryWindowSwitch.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-trajectory-window]');
  if (!button || button.dataset.trajectoryWindow === state.trajectoryWindow) return;
  state.trajectoryWindow = button.dataset.trajectoryWindow;
  try { window.localStorage.setItem('lifeline.trajectoryWindow', state.trajectoryWindow); } catch {}
  syncTrajectoryWindowSwitch();
  await loadTrajectory();
});
elements.closeTrajectoryDrawer.addEventListener('click', () => elements.trajectoryDrawer.close());
elements.trajectoryDrawer.addEventListener('cancel', (event) => {
  event.preventDefault();
  elements.trajectoryDrawer.close();
});
elements.closeTaskInspector.addEventListener('click', () => elements.taskInspector.close());
elements.taskInspector.addEventListener('cancel', (event) => {
  event.preventDefault();
  elements.taskInspector.close();
});
window.addEventListener('popstate', async () => {
  state.selectedProjectId = new URLSearchParams(window.location.search).get('project');
  state.detailSchedule = null;
  state.detailRenderSignature = null;
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
await loadSubscriptionSummary();
window.setInterval(loadSubscriptionSummary, 10_000);
updateRefreshButton();
window.setInterval(tickAutoRefresh, 1_000);

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

async function loadSubscriptionSummary() {
  if (!elements.subscriptionSummaryLink) return;
  try {
    const summary = await api('/api/subscriptions/summary');
    elements.subscriptionSummaryLink.textContent = `算力余量 ${summary.usable}/${summary.total} 可用 · ${summary.attention} 异常`;
    elements.subscriptionSummaryLink.classList.toggle('has-attention', summary.attention > 0);
  } catch {
    elements.subscriptionSummaryLink.textContent = '算力余量 · 暂不可用';
    elements.subscriptionSummaryLink.classList.add('has-attention');
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
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  elements.refresh.disabled = true;
  try {
    const [dashboard, workItems, trajectory] = await Promise.all([
      api('/api/dashboard'),
      api('/api/work-items'),
      api(`/api/trajectory?window=${encodeURIComponent(state.trajectoryWindow)}`)
    ]);
    state.workItems = workItems.items.map(hydrateWorkItem);
    state.dashboard = hydrateDashboard(dashboard, state.workItems);
    state.projects = state.dashboard.projects;
    state.dispatch = dashboard.dispatch ?? null;
    state.trajectory = trajectory;
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
  } finally {
    state.refreshInFlight = false;
    elements.refresh.disabled = false;
    resetRefreshCountdown();
  }
}

async function tickAutoRefresh() {
  if (document.hidden || state.refreshInFlight) return;
  state.refreshRemainingSeconds = Math.max(0, state.refreshRemainingSeconds - 1);
  updateRefreshButton();
  if (state.refreshRemainingSeconds > 0) return;
  if (state.draggedTaskId || document.querySelector('dialog[open]')) {
    resetRefreshCountdown();
    return;
  }
  await Promise.all([checkHealth(), refresh()]);
}

function resetRefreshCountdown() {
  state.refreshRemainingSeconds = 10;
  updateRefreshButton();
}

function updateRefreshButton() {
  if (!elements.refresh) return;
  elements.refresh.textContent = state.refreshInFlight
    ? '正在刷新…'
    : `刷新状态 · ${state.refreshRemainingSeconds}s`;
}

async function bootstrapPortfolio() {
  const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `portfolio-v2-${Date.now()}`;
  try {
    elements.seedDemo.disabled = true;
    elements.seedDemo.textContent = '正在载入项目排期…';
    const result = await api('/api/bootstrap/portfolio-v2', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey }
    });
    if (result.requiresResolution) {
      showBootstrapConflict(result, idempotencyKey);
      return;
    }
    await finishBootstrap(result);
  } catch (error) {
    notify(error.message, true);
    resetBootstrapAction();
  }
}

function showBootstrapConflict(result, idempotencyKey) {
  state.bootstrap = result;
  state.bootstrapConflictKey = idempotencyKey;
  const names = [...new Set((result.conflicts ?? []).map((entry) => entry.sourceName).filter(Boolean))];
  const projectText = names.length > 0 ? names.slice(0, 3).join('、') : '现有项目';
  elements.bootstrapConflictSummary.textContent = `检测到 ${projectText} 已被修改。合并会沿用现有项目和任务，再补齐正式排期；保留现状不会写入 receipt。`;
  elements.bootstrapConflictDialog.showModal();
  elements.keepBootstrapExisting.focus();
}

async function resolveBootstrapConflict(conflictResolution) {
  const idempotencyKey = state.bootstrapConflictKey;
  if (!idempotencyKey) return;
  setBootstrapConflictBusy(true);
  try {
    const result = await api('/api/bootstrap/portfolio-v2', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ conflictResolution })
    });
    if (conflictResolution === 'KEEP_EXISTING') {
      state.bootstrap = result;
      elements.bootstrapConflictDialog.close();
      resetBootstrapAction();
      notify('已保留现有项目，本次没有载入新排期');
      return;
    }
    elements.bootstrapConflictDialog.close();
    await finishBootstrap(result);
  } catch (error) {
    notify(error.message, true);
    setBootstrapConflictBusy(false);
  }
}

async function finishBootstrap(result) {
  elements.bootstrapAction?.remove();
  state.bootstrap = { ...result, available: false };
  state.bootstrapConflictKey = null;
  notify('Lifeline、EchoMe 与 Totemora 的项目排期已载入');
  await refresh();
}

function setBootstrapConflictBusy(busy) {
  elements.keepBootstrapExisting.disabled = busy;
  elements.mergeBootstrapExisting.disabled = busy;
  elements.mergeBootstrapExisting.textContent = busy ? '正在处理…' : '合并并载入';
}

function resetBootstrapConflictControls() {
  state.bootstrapConflictKey = null;
  setBootstrapConflictBusy(false);
  resetBootstrapAction();
}

function resetBootstrapAction() {
  if (!elements.seedDemo?.isConnected) return;
  elements.seedDemo.disabled = false;
  elements.seedDemo.innerHTML = '<span class="button-label-wide">载入本次项目排期</span><span class="button-label-compact">载入排期</span>';
}

async function openCreationDrawer() {
  await setCreationMode(state.projects.length > 0 ? 'task' : 'project');
  elements.creationDrawer.showModal();
  state.creationDraftSnapshot = creationDraftSnapshot();
  const firstField = state.creationMode === 'task' ? elements.projectId : document.querySelector('#projectName');
  firstField?.focus();
}

function closeCreationDrawer(force = false) {
  if (!force && creationDraftChanged()) {
    if (!window.confirm('关闭后会丢失尚未提交的内容，仍要关闭吗？')) return;
  }
  state.creationDraftSnapshot = null;
  if (elements.creationDrawer.open) elements.creationDrawer.close();
}

function creationDraftSnapshot() {
  return JSON.stringify([...elements.projectForm.querySelectorAll('input, textarea, select')].map((field) => [
    field.id,
    field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value
  ]));
}

function creationDraftChanged() {
  return state.creationDraftSnapshot !== null && creationDraftSnapshot() !== state.creationDraftSnapshot;
}

function setCreationMode(mode) {
  state.creationMode = mode === 'project' ? 'project' : 'task';
  elements.creationDrawer.querySelectorAll('[data-create-mode]').forEach((button) => {
    const active = button.dataset.createMode === state.creationMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.creationDrawer.querySelectorAll('[data-create-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.createPane !== state.creationMode;
  });
}

async function openGlobalTaskCreator(event) {
  event.preventDefault();
  const projectId = elements.projectId.value;
  if (!projectId) {
    notify('请先添加项目', true);
    return;
  }
  try {
    const schedule = hydrateSchedule(await api(`/api/projects/${encodeURIComponent(projectId)}/schedule`));
    closeCreationDrawer(true);
    openTaskCreatorFor(projectId, schedule);
  } catch (error) {
    notify(error.message, true);
  }
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


async function markReady(workItemId) {
  try {
    await api(`/api/work-items/${encodeURIComponent(workItemId)}/ready`, { method: 'POST' });
    notify('执行契约已通过校验');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

function render() {
  document.body.classList.toggle('project-detail-mode', Boolean(state.selectedProjectId));
  renderBootstrapAction();
  renderMetrics();
  renderNextAction();
  renderDispatchAudit();
  renderBoardToolbar();
  renderBoard();
  renderProjectSelect();
  renderTrajectory();
}

async function loadTrajectory() {
  elements.trajectoryBoard.setAttribute('aria-busy', 'true');
  try {
    state.trajectory = await api(`/api/trajectory?window=${encodeURIComponent(state.trajectoryWindow)}`);
    renderTrajectory();
  } catch (error) {
    elements.trajectoryBoard.innerHTML = `<div class="trajectory-empty error"><strong>轨迹暂时没有载入</strong><p>${escapeHtml(error.message)}</p></div>`;
    notify(error.message, true);
  } finally {
    elements.trajectoryBoard.removeAttribute('aria-busy');
  }
}

function renderTrajectory() {
  if (!elements.trajectory) return;
  elements.trajectory.hidden = Boolean(state.selectedProjectId);
  syncTrajectoryWindowSwitch();
  const trajectory = state.trajectory;
  if (!trajectory) return;
  const summary = trajectory.summary;
  elements.trajectorySummary.innerHTML = [
    trajectoryMetric('推进覆盖', formatTrajectoryPercent(summary.coverageRatio), '真实 Agent 任务区间的并集占当前窗口的比例'),
    trajectoryMetric('完成上报', `${summary.completedTaskCount} 次`, 'Agent 在当前窗口内上报完成的任务结果'),
    trajectoryMetric('并发峰值', `${summary.peakConcurrency} 路`, '真实任务区间发生重叠时的最高并行数'),
    trajectoryMetric('未记录推进', formatElapsedMs(summary.unrecordedDurationMs), '没有收到任务完成上报的时间，不等同于用户空闲')
  ].join('');
  renderTrajectoryCoverage(trajectory);

  if (trajectory.projects.length === 0) {
    elements.trajectoryBoard.innerHTML = `
      <div class="trajectory-empty">
        <strong>还没有真实推进记录</strong>
        <p>任务完成时让 Agent 只调用一次 <code>lifeline_submit_completion</code>，第一条轨迹就会出现在这里。</p>
      </div>
    `;
    return;
  }

  const axis = trajectoryAxisLabels(trajectory);
  elements.trajectoryBoard.innerHTML = `
    <div class="trajectory-axis" aria-hidden="true">
      <span></span>
      <div><time>${axis[0]}</time><time>${axis[1]}</time><time>${axis[2]}</time></div>
    </div>
    <div class="trajectory-projects">
      ${trajectory.projects.map((project) => renderTrajectoryProject(project, trajectory)).join('')}
    </div>
    <div class="trajectory-legend">
      <span><i class="verified"></i>已验证</span>
      <span><i class="review"></i>待复核</span>
      <span><i class="failed"></i>失败 / 阻塞</span>
      <span class="trajectory-legend-note">轨迹只来自 Agent 的真实结果上报</span>
    </div>
  `;
  elements.trajectoryBoard.querySelectorAll('[data-trajectory-record]').forEach((button) => {
    button.addEventListener('click', () => openTrajectoryRecord(button.dataset.trajectoryRecord));
  });
}

function trajectoryMetric(label, value, title) {
  return `<div class="trajectory-metric" title="${escapeHtml(title)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderTrajectoryCoverage(trajectory) {
  const startMs = Date.parse(trajectory.startedAt);
  const windowMs = Date.parse(trajectory.completedAt) - startMs;
  const gapSegments = trajectory.gaps.map((gap) => {
    const left = ((Date.parse(gap.startedAt) - startMs) / windowMs) * 100;
    const width = (gap.durationMs / windowMs) * 100;
    return `<span class="trajectory-gap" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%" title="未记录推进 · ${escapeHtml(formatElapsedMs(gap.durationMs))}"></span>`;
  }).join('');
  elements.trajectoryCoverage.innerHTML = `
    <div class="coverage-copy"><strong>推进脉冲</strong><span>亮色是已上报区间，灰色是未记录推进</span></div>
    <div class="coverage-track" aria-label="真实推进覆盖 ${escapeHtml(formatTrajectoryPercent(trajectory.summary.coverageRatio))}">${gapSegments}</div>
  `;
}

function renderTrajectoryProject(project, trajectory) {
  const startMs = Date.parse(trajectory.startedAt);
  const windowMs = Date.parse(trajectory.completedAt) - startMs;
  const lanes = assignTrajectoryLanes(project.intervals);
  const laneCount = Math.max(1, ...lanes.map((entry) => entry.lane + 1));
  return `
    <article class="trajectory-project" style="--trajectory-lanes:${laneCount}">
      <header>
        <strong>${escapeHtml(project.name)}</strong>
        <span>${project.intervals.length} 次真实上报</span>
      </header>
      <div class="trajectory-track" aria-label="${escapeHtml(project.name)} 推进时间轴">
        ${lanes.map(({ interval, lane }) => {
          const displayStart = Date.parse(interval.displayStartedAt);
          const displayEnd = Date.parse(interval.displayCompletedAt);
          const left = Math.max(0, Math.min(100, ((displayStart - startMs) / windowMs) * 100));
          const width = Math.max(0, ((displayEnd - displayStart) / windowMs) * 100);
          const edge = left > 98 ? ' edge' : '';
          const status = interval.outcome === 'COMPLETED'
            ? interval.verificationStatus.toLowerCase()
            : interval.outcome.toLowerCase();
          const label = `${interval.taskTitle} · ${formatDateTime(interval.startedAt)} 至 ${formatDateTime(interval.completedAt)}`;
          return `<button
            class="trajectory-interval ${status}${edge}"
            type="button"
            data-trajectory-record="${escapeHtml(interval.id)}"
            data-label="${escapeHtml(interval.taskTitle)}"
            style="--interval-left:${left.toFixed(4)}%;--interval-width:${width.toFixed(4)}%;--interval-lane:${lane}"
            aria-label="${escapeHtml(label)}"
            title="${escapeHtml(label)}"
          ><span aria-hidden="true"></span></button>`;
        }).join('')}
      </div>
    </article>
  `;
}

function assignTrajectoryLanes(intervals) {
  const laneEnds = [];
  return [...intervals]
    .sort((left, right) => Date.parse(left.displayStartedAt) - Date.parse(right.displayStartedAt))
    .map((interval) => {
      const startedAt = Date.parse(interval.displayStartedAt);
      const completedAt = Date.parse(interval.displayCompletedAt);
      let lane = laneEnds.findIndex((endAt) => endAt <= startedAt);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = completedAt;
      return { interval, lane };
    });
}

function openTrajectoryRecord(recordId) {
  const interval = state.trajectory?.projects.flatMap((project) => project.intervals).find((entry) => entry.id === recordId);
  if (!interval) return;
  elements.trajectoryDrawerContext.textContent = `${interval.projectName}${interval.phaseTitle ? ` · ${interval.phaseTitle}` : ''}`;
  elements.trajectoryDrawerTitle.textContent = interval.taskTitle;
  const evidence = interval.evidence.length > 0
    ? `<ul>${interval.evidence.map((entry) => `<li><strong>${escapeHtml(evidenceLabel(entry.type))}</strong><span>${escapeHtml(entry.summary)}</span>${Object.keys(entry.metadata ?? {}).length > 0 ? `<pre>${escapeHtml(JSON.stringify(entry.metadata, null, 2))}</pre>` : ''}</li>`).join('')}</ul>`
    : '<p class="trajectory-detail-empty">本次上报没有附加证据。</p>';
  const artifacts = interval.artifactUris.length > 0
    ? `<ul>${interval.artifactUris.map((uri) => `<li><code>${escapeHtml(uri)}</code></li>`).join('')}</ul>`
    : '<p class="trajectory-detail-empty">本次上报没有附加产物路径。</p>';
  elements.trajectoryDrawerBody.innerHTML = `
    <section class="trajectory-result ${interval.outcome.toLowerCase()}">
      <div><span>本次结果</span><strong>${escapeHtml(outcomeLabel(interval.outcome))}</strong></div>
      <p>${escapeHtml(interval.resultSummary || 'Agent 未填写结果摘要。')}</p>
    </section>
    <dl class="trajectory-facts">
      <div><dt>开始</dt><dd>${escapeHtml(formatDateTime(interval.startedAt))}</dd></div>
      <div><dt>完成</dt><dd>${escapeHtml(formatDateTime(interval.completedAt))}</dd></div>
      <div><dt>持续</dt><dd>${escapeHtml(formatElapsedMs(interval.durationMs))}</dd></div>
      <div><dt>模型</dt><dd>${escapeHtml(interval.modelRef || '未记录')}</dd></div>
      <div><dt>推理强度</dt><dd>${escapeHtml(effortLabel(interval.reasoningEffort))}</dd></div>
      <div><dt>复核状态</dt><dd>${escapeHtml(trajectoryVerificationLabel(interval.verificationStatus))}</dd></div>
    </dl>
    <details class="trajectory-details">
      <summary>证据明细 <span>${interval.evidence.length}</span></summary>
      ${evidence}
    </details>
    <details class="trajectory-details">
      <summary>代码与文档产物 <span>${interval.artifactUris.length}</span></summary>
      ${artifacts}
    </details>
  `;
  elements.trajectoryDrawer.showModal();
}

function syncTrajectoryWindowSwitch() {
  elements.trajectoryWindowSwitch.querySelectorAll('[data-trajectory-window]').forEach((button) => {
    const active = button.dataset.trajectoryWindow === state.trajectoryWindow;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function trajectoryAxisLabels(trajectory) {
  const startMs = Date.parse(trajectory.startedAt);
  const endMs = Date.parse(trajectory.completedAt);
  return [startMs, startMs + (endMs - startMs) / 2, endMs].map((time) => new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: trajectory.window === '24h' ? '2-digit' : undefined,
    minute: trajectory.window === '24h' ? '2-digit' : undefined
  }).format(new Date(time)));
}

function formatTrajectoryPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '暂无';
  const percent = Math.max(0, Number(ratio)) * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatElapsedMs(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '暂无';
  const milliseconds = Math.max(0, Number(value));
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1) return '少于 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

function outcomeLabel(outcome) {
  return { COMPLETED: '已完成', FAILED: '执行失败', BLOCKED: '遇到阻塞' }[outcome] ?? outcome;
}

function effortLabel(effort) {
  return { low: '低', medium: '中', high: '高', max: 'Max' }[effort] ?? effort ?? '未记录';
}

function evidenceLabel(type) {
  return { TEST_COMMAND: '测试', TEST: '测试', VERIFICATION: '验证', REVIEW: '复核' }[type] ?? type;
}

function trajectoryVerificationLabel(status) {
  return { VERIFIED: '已验证', REVIEW: '待复核', NOT_APPLICABLE: '不适用，需重新推进' }[status] ?? status;
}

function renderBoardToolbar() {
  const project = projectFor(state.selectedProjectId);
  const inDetail = Boolean(project && state.detailSchedule);
  elements.backToPortfolio.hidden = !inDetail;
  elements.boardFilters.hidden = inDetail;
  elements.detailControls.hidden = !inDetail;
  elements.clientViewLink.href = inDetail
    ? `/client.html?project=${encodeURIComponent(project.id)}`
    : '/client.html';
  elements.detailControls.querySelectorAll('[data-detail-view]').forEach((button) => {
    const active = button.dataset.detailView === state.detailView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.boardTitle.textContent = inDetail ? project.name : '下一滴算力，投给谁？';
  elements.boardDescription.textContent = inDetail
    ? '当前进度由最后一个已验证任务派生并保持锁定；待处理任务可继续调整，已推迟任务暂不占用近期算力。'
    : '越靠上越值得优先投入，越向右越接近交付；切换算力和任务类型，立刻找到此刻最值得推进的工作。';
}

function renderBootstrapAction() {
  if (state.bootstrap?.available === false) elements.bootstrapAction?.remove();
}

function renderMetrics() {
  const summary = state.dispatch?.summary ?? {};
  const free = summary.freeSlots ?? { execution: { high: 0, medium: 0, low: 0 }, review: 0 };
  const freeExecution = Object.values(free.execution ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
  elements.metrics.innerHTML = [
    ['正在执行', summary.runningCount ?? 0, '路'],
    ['下一批', summary.nextCount ?? 0, '项'],
    ['待复核', summary.reviewCount ?? 0, '项'],
    ['停滞项目', summary.stalledProjectCount ?? 0, '个'],
    ['剩余执行槽', freeExecution + Number(free.review ?? 0), '槽']
  ].map(([label, value, unit]) => `<div class="metric"><span>${label}</span><strong>${value}<small>${unit}</small></strong></div>`).join('');
}

function renderNextAction() {
  const recommendations = state.dispatch?.recommendations ?? {};
  elements.nextAction.innerHTML = [
    renderDispatchRecommendation('执行中', recommendations.running, '当前没有 Agent 占用执行槽'),
    renderDispatchRecommendation('下一批 · 高算力', recommendations.highCompute, '高算力槽暂时没有合格任务'),
    renderDispatchRecommendation('下一批 · 低算力', recommendations.lowCompute, '低算力槽暂时没有合格任务')
  ].join('');
  bindActionButtons(elements.nextAction);
}

function renderDispatchAudit() {
  if (!elements.dispatchAudit) return;
  const changes = state.dispatch?.recentChanges ?? [];
  const efficiency = state.dispatch?.efficiency;
  const confidence = efficiency?.confidence === 'ENOUGH'
    ? `${efficiency.summary.sampleCount} 个真实样本，已允许校准`
    : `${efficiency?.summary?.sampleCount ?? 0} 个真实样本，继续使用保守规则`;
  const efficiencySummary = efficiency?.summary ?? {};
  const effect = Number(efficiencySummary.sampleCount) > 0
    ? `近 30 天完成 ${efficiencySummary.throughput ?? 0} 项 · 执行中位 ${formatElapsedMs(efficiencySummary.medianExecutionMs)} · 失败/阻塞 ${formatTrajectoryPercent(efficiencySummary.failureAndBlockedRate)} · 槽位饱和 ${formatTrajectoryPercent(efficiencySummary.observedSlotSaturation)} · 最长未上报 ${formatElapsedMs(efficiencySummary.longestUnreportedMs)}`
    : '尚无真实 Agent 完成样本；暂不根据历史调整模型、算力或估时。';
  const changeMarkup = changes.slice(0, 8).map((change) => `
    <article class="dispatch-audit-item">
      <div>
        <strong>${escapeHtml(dispatchChangeTitle(change))}</strong>
        <span>${formatDateTime(change.createdAt)}${change.actor ? ` · ${escapeHtml(change.actor)}` : ''}${change.policyVersion ? ` · ${escapeHtml(change.policyVersion)}` : ''}</span>
      </div>
      <p>${escapeHtml(dispatchChangeSummary(change))}</p>
      ${change.reversible ? `<button class="button compact" type="button" data-reverse-change="${escapeHtml(change.id)}">${change.reversalAction === 'RESUME' ? '重新排入近期' : change.reversalAction === 'REORDER' ? '撤销重排' : '恢复任务'}</button>` : ''}
    </article>
  `).join('');
  elements.dispatchAudit.innerHTML = `
    <div class="dispatch-confidence">
      <strong>推荐置信度</strong>
      <span>${escapeHtml(confidence)}</span>
      <p>${escapeHtml(effect)}</p>
      <small>未上报时段只表示“未知”，不当作 Agent 空闲。</small>
    </div>
    <div class="dispatch-audit-list">${changeMarkup || '<p class="dispatch-audit-empty">还没有写入调度变化；首次重排后会在这里留下前后值和规则版本。</p>'}</div>
  `;
  elements.dispatchAudit.querySelectorAll('[data-reverse-change]').forEach((button) => {
    button.addEventListener('click', () => reverseDispatchChange(button.dataset.reverseChange));
  });
}

function dispatchChangeTitle(change) {
  const labels = {
    'dispatch.decision_changed': '动态批次已调整',
    'portfolio.rebalanced': '组合排期已重算',
    'phase.status_reconciled': '阶段状态已校正',
    'schedule.reordered': '任务顺序已调整',
    'work_item.deferred': '任务已推迟',
    'work_item.resumed': '任务已恢复近期推进',
    'work_item.cancelled': '任务已移出排期',
    'work_item.restored': '任务已恢复'
  };
  return `${labels[change.type] ?? '排期发生变化'}${change.taskTitle ? ` · ${change.taskTitle}` : ''}`;
}

function dispatchChangeSummary(change) {
  if (change.type === 'dispatch.decision_changed') {
    const before = change.before?.batch ? `${change.before.batch} #${change.before.rank}` : '未分批';
    const after = change.after?.batch ? `${change.after.batch} #${change.after.rank}` : '未分批';
    return `${before} → ${after}；${decisionReasonSummary(change.after?.reasonCodes)}`;
  }
  return change.reason || change.message || '已记录结构化审计信息';
}

async function reverseDispatchChange(changeId) {
  const change = state.dispatch?.recentChanges?.find((entry) => entry.id === changeId);
  const project = state.projects.find((entry) => entry.id === change?.projectId);
  if (!project) return notify('无法确定任务所属项目，请刷新后重试', true);
  try {
    if (change.reversalAction === 'REORDER') {
      await api(`/api/projects/${encodeURIComponent(project.id)}/schedule`, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': mutationKey('undo-reorder') },
        body: JSON.stringify({
          expectedScheduleVersion: Number(project.scheduleVersion ?? 0),
          phaseId: change.phaseId,
          orderedTaskIds: change.reversalOrder,
          reason: '用户从调度解释视图撤销任务重排'
        })
      });
      notify('任务顺序已恢复');
    } else if (change.reversalAction === 'RESUME') {
      await api(`/api/work-items/${encodeURIComponent(change.taskId)}`, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': mutationKey('resume') },
        body: JSON.stringify({
          expectedScheduleVersion: Number(project.scheduleVersion ?? 0),
          status: 'PLANNED',
          reason: '用户从调度解释视图重新排入近期推进'
        })
      });
      notify('任务已重新进入近期排期');
    } else {
      await api(`/api/work-items/${encodeURIComponent(change.taskId)}/restore`, {
        method: 'POST',
        headers: { 'Idempotency-Key': mutationKey('restore') },
        body: JSON.stringify({
          expectedScheduleVersion: Number(project.scheduleVersion ?? 0),
          reason: '用户从调度解释视图恢复任务'
        })
      });
      notify('任务已恢复到动态排期');
    }
    await refresh();
  } catch (error) {
    await recoverScheduleMutation(error);
  }
}

function renderDispatchRecommendation(label, decision, emptyText) {
  const task = decision ? state.workItems.find((entry) => entry.id === decision.taskId) : null;
  if (!decision || !task) {
    return `<div class="dispatch-choice empty"><span>${escapeHtml(label)}</span><strong>${escapeHtml(emptyText)}</strong><p>状态或容量变化后自动补位</p></div>`;
  }
  const project = projectFor(task.projectId);
  const reason = decisionReasonSummary(decision.reasonCodes);
  const route = decision.recommendedModelRef ?? decision.recommendedAgent ?? task.recommendation?.executor ?? '待分配';
  const source = decision.recommendationSource === 'HISTORY_CALIBRATED' ? '历史结果校准' : '规则推荐';
  return `
    <button class="dispatch-choice" type="button" data-focus-item="${escapeHtml(task.id)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(project?.name ?? '未知项目')} · ${escapeHtml(task.title)}</strong>
      <p>${escapeHtml(reason)} · ${escapeHtml(route)} · ${formatDuration(decision.estimateMinutes ?? task.recommendation?.estimateMinutes)} · ${source}</p>
    </button>
  `;
}

function renderBoard() {
  if (state.selectedProjectId && state.detailSchedule) {
    renderProjectDetail();
    return;
  }
  if (state.draggedTaskId && elements.board.children.length > 0) return;
  captureBoardScrollPositions();
  const projects = state.dashboard?.projects ?? [];
  const desiredIds = new Set();
  const changedRows = [];
  const focusSnapshot = captureBoardFocus();
  for (const [projectIndex, project] of projects.entries()) {
    const projectItems = state.workItems.filter((item) => item.projectId === project.id).sort(compareItems);
    const phases = projectItems.length > 0
      ? groupPhases(projectItems, project.phases)
      : [{ order: '—', name: projectItems.length > 0 ? '当前筛选无任务' : '尚未排期', items: [] }];
    const firstUnfinishedPhase = phases.findIndex((phase) => phase.items.some(isUnfinished));
    const markup = renderProjectRow(project, projectIndex, projects.length, phases, firstUnfinishedPhase);
    desiredIds.add(project.id);
    let row = elements.board.querySelector(`[data-project-row="${cssEscape(project.id)}"]`);
    if (!row) {
      row = htmlElement(markup);
      changedRows.push(row);
    } else if (state.boardRowSignatures.get(project.id) !== markup) {
      const replacement = htmlElement(markup);
      row.className = replacement.className;
      row.replaceChildren(...replacement.childNodes);
      changedRows.push(row);
    }
    state.boardRowSignatures.set(project.id, markup);
    elements.board.appendChild(row);
  }
  elements.board.querySelectorAll('[data-project-row]').forEach((row) => {
    if (desiredIds.has(row.dataset.projectRow)) return;
    state.boardRowSignatures.delete(row.dataset.projectRow);
    state.boardScrollPositions.delete(row.dataset.projectRow);
    row.remove();
  });
  if (projects.length === 0) {
    elements.board.innerHTML = '<div class="portfolio-empty">这个筛选下暂时没有任务。换个筛选条件，或从右上角添加新的项目与任务。</div>';
  } else {
    elements.board.querySelector('.portfolio-empty')?.remove();
  }
  changedRows.forEach((row) => {
    bindActionButtons(row);
    bindTaskInspectors(row);
  });
  applyBoardFilter();
  restoreBoardScrollPositions();
  restoreBoardFocus(focusSnapshot);
}

function renderProjectRow(project, projectIndex, projectCount, phases, firstUnfinishedPhase) {
  const health = projectHealthView(project.health);
  return `
      <article class="project-row health-${escapeHtml(String(project.health ?? 'ON_TRACK').toLowerCase())}" data-project-row="${escapeHtml(project.id)}" aria-labelledby="project-${escapeHtml(project.id)}">
        <button class="project-summary" type="button" data-open-project="${escapeHtml(project.id)}" aria-label="打开 ${escapeHtml(project.name)} 项目详情">
          <div>
            <div class="project-rank">
              <span class="priority">${projectPriority(project.strategicValue)}</span>
              <span class="project-health ${escapeHtml(health.className)}">${escapeHtml(health.label)}</span>
              <span class="project-order">${String(projectIndex + 1).padStart(2, '0')} / ${String(projectCount).padStart(2, '0')}</span>
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
        <div class="phase-track" data-project-track="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} 的阶段进度">
          ${phases.map((phase, phaseIndex) => renderPhase(phase, phaseIndex, firstUnfinishedPhase)).join('')}
        </div>
      </article>
    `;
}

function renderProjectDetail() {
  const schedule = state.detailSchedule;
  const project = schedule.project;
  const dashboardProject = state.dashboard?.projects?.find((entry) => entry.id === project.id) ?? project;
  const projectHealth = projectHealthView(dashboardProject.health ?? project.health);
  const tasks = [...schedule.phases.flatMap((phase) => phase.tasks), ...schedule.unscheduledTasks];
  const completed = tasks.filter(isFinished);
  const inProgress = tasks.filter(isInProgress);
  const unfinished = tasks.filter((task) => isUnfinished(task) && !isInProgress(task));
  const deferred = tasks.filter((task) => task.status === 'DEFERRED');
  const currentTask = tasks.find((task) => task.id === project.latestVerifiedTaskId && isFinished(task))
    ?? completed.filter((task) => task.status !== 'RECURRING').sort(compareItems).at(-1)
    ?? null;

  const signature = JSON.stringify({
    projectId: project.id,
    scheduleVersion: schedule.scheduleVersion,
    detailView: state.detailView,
    latestVerifiedTaskId: project.latestVerifiedTaskId,
    tasks: tasks.map((task) => [
      task.id,
      task.status,
      task.updatedAt,
      task.currentRunId,
      task.latestCompletion?.id,
      task.starred,
      task.decision?.batch,
      task.decision?.compute,
      task.decision?.recommendedModelRef,
      task.decision?.estimateMinutes
    ])
  });
  if (state.detailRenderSignature === signature && elements.board.querySelector('.project-detail')) return;
  const previousScrollTop = document.querySelector('.board-scroll')?.scrollTop ?? 0;
  const focusSnapshot = captureBoardFocus();

  elements.board.innerHTML = `
    <div class="project-detail">
      <header class="detail-hero">
        <div class="detail-identity">
          <div class="project-rank">
            <span class="priority">${projectPriority(project.strategicValue)}</span>
            <span class="project-health ${escapeHtml(projectHealth.className)}">${escapeHtml(projectHealth.label)}</span>
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
        ${renderStateRailColumn('已推迟', deferred, '短期不推进，仍可调整或取消', false)}
      </section>

      <section class="detail-state-guide" aria-label="状态说明">
        <div><span class="state-key completed">✓</span><p><strong>已完成</strong>只有通过验证的任务进入这里，内容与顺序均锁定。</p></div>
        <div><span class="state-key current">●</span><p><strong>当前进度</strong>由最后一次验证时间自动派生；它仍计入已完成，内容与顺序均不可修改。</p></div>
        <div><span class="state-key in-progress">◉</span><p><strong>推进中</strong>已经排队、执行或进入复核，尚未完成，执行契约暂时锁定。</p></div>
        <div><span class="state-key pending">○</span><p><strong>待处理</strong>尚未开始且近期需要推进，可以继续调整或取消。</p></div>
        <div><span class="state-key deferred">◇</span><p><strong>已推迟</strong>仍在长期排期里，但短期不投入算力，可以微调、恢复或取消。</p></div>
      </section>

      <div class="detail-phase-list">
        ${schedule.phases.map((phase) => renderDetailPhase(phase, currentTask?.id)).join('')}
        ${schedule.unscheduledTasks.length > 0 ? renderDetailPhase({
          id: 'unscheduled', title: '待归档阶段', phaseOrder: '—', goal: '这些任务尚未关联正式阶段。', tasks: schedule.unscheduledTasks
        }, currentTask?.id) : ''}
      </div>
    </div>
  `;
  state.detailRenderSignature = signature;
  bindActionButtons(elements.board);
  bindProjectDetailActions();
  bindTaskInspectors(elements.board);
  bindTaskTooltips();
  const detailScroll = document.querySelector('.board-scroll');
  if (detailScroll && !state.detailFocusPending) detailScroll.scrollTop = previousScrollTop;
  restoreBoardFocus(focusSnapshot);
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
  const phaseState = phaseStatusView(phase.computedStatus);
  return `
    <section class="detail-phase view-${state.detailView}" data-detail-phase="${escapeHtml(phase.id)}">
      <header class="detail-phase-head">
        <div>
          <span class="phase-index">S${escapeHtml(phase.phaseOrder)}</span>
          <h4${phaseEditable ? ` class="phase-inline-field" data-phase-edit-field="title" data-phase-id="${escapeHtml(phase.id)}" tabindex="0" title="双击修改阶段标题"` : ''}>${escapeHtml(phase.title)}</h4>
          <p${phaseEditable ? ` class="phase-inline-field${phase.goal ? '' : ' empty'}" data-phase-edit-field="goal" data-phase-id="${escapeHtml(phase.id)}" tabindex="0" title="双击修改阶段描述"` : ''}>${escapeHtml(phase.goal || '双击补充阶段描述')}</p>
        </div>
        <div class="phase-progress-block">
          <span class="phase-computed-status ${escapeHtml(phaseState.className)}">${escapeHtml(phaseState.label)}</span>
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
        ? { className: 'deferred', label: '已推迟' }
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
  const routing = effectiveTaskRouting(task);
  return `
    <article class="detail-task ${state.detailView}${current ? ' current' : ''}${finished ? ' finished' : ''}${task.starred ? ' starred' : ''}${locked ? ' locked' : ''}${recurring ? ' has-actions' : ''}"
      data-detail-task="${escapeHtml(task.id)}"
      data-inspect-task="${escapeHtml(task.id)}"
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
          <strong class="task-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</strong>
          <div class="task-title-controls">
            ${renderStarControl(task, editable)}
            <span class="state-badge ${productState.className}">${productState.label}</span>
          </div>
        </div>
        <p>${escapeHtml(task.objective)}</p>
        <div class="task-meta">
          <span class="status ${task.status.toLowerCase()}" title="${escapeHtml(statusDescription(task.status))}">${statusLabel(task.status)}</span>
          <span class="tag provenance ${provenanceClass(task)}">${provenanceLabel(task)}</span>
          <span class="tag priority-${task.planning.priority.toLowerCase()}">${task.planning.priority}</span>
          <span class="tag kind-${task.planning.kind}">${kindLabel(task.planning.kind)}</span>
          <span class="tag">${computeLabel(routing.compute)}</span>
          <span class="tag">${task.planning.commitment === 'COMMITTED' ? '已确认' : '可调整'}</span>
          ${renderDependencyTags(task)}
          ${task.scheduledFor ? `<span class="tag scheduled-date">排期 ${escapeHtml(task.scheduledFor)}</span>` : ''}
          ${renderIssueReference(task.issue)}
          ${renderIssueReminder(task)}
        </div>
        <p class="detail-task-route">${escapeHtml(routeLabel(task.recommendation, routing.label))} · ${formatDuration(routing.estimateMinutes)} · ${escapeHtml(task.recommendation.approach)}</p>
        ${completion ? `
          <div class="completion-line">
            <span>完成记录</span>
            <strong>${escapeHtml(modelRef || '人工 / 历史导入')}</strong>
            <time>${formatDateTime(completedAt)}</time>
            <span>${evidenceCount} 条证据</span>
          </div>
        ` : ''}
      </div>
      ${locked ? `<span class="task-lock-indicator" title="${recurring ? '周期任务已锁定，由 Agent 完成后上报新一轮结果' : '已进入执行或完成，内容与顺序已锁定'}" aria-label="已锁定"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"></rect><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"></path></svg></span>` : ''}
      ${editable ? `<div class="detail-task-actions">
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
        <p class="phase-empty">从右上角添加第一个阶段或任务；项目会保留在当前优先级位置。</p>
      </section>
    `;
  }
  const completed = phase.computedStatus
    ? phase.computedStatus === 'COMPLETED'
    : phase.items.every(isFinished);
  const deferred = !completed
    && phase.items.some((item) => item.status === 'DEFERRED')
    && phase.items.every((item) => isFinished(item) || item.status === 'DEFERRED');
  const blocked = phase.computedStatus
    ? phase.computedStatus === 'BLOCKED'
    : phase.items.some((item) => item.status === 'BLOCKED');
  const current = !completed && (phase.computedStatus
    ? ['ACTIVE', 'REVIEW'].includes(phase.computedStatus)
    : phaseIndex === firstUnfinishedPhase);
  const className = blocked ? 'blocked' : current ? 'current' : completed ? 'completed' : 'planned';
  const stateLabel = phase.computedStatus === 'REVIEW'
    ? '等待复核'
    : blocked ? '有阻塞' : current ? '正在推进' : completed ? '已验证' : deferred ? '已推迟' : '待排期';
  return `
    <section class="phase ${className}" data-filter-phase${current ? ' data-current-phase="true"' : ''}>
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
  const recommendation = item.recommendation;
  const routing = effectiveTaskRouting(item);
  const stateClass = isFinished(item)
    ? ' finished'
    : isInProgress(item)
      ? ' in-progress'
      : isUnfinished(item)
        ? ' pending'
        : '';
  const activeAgent = item.currentRun?.modelRef ?? item.currentRun?.agentId ?? null;
  const agentLabel = activeAgent ? `执行 · ${activeAgent}` : `推荐 · ${routing.label}`;
  return `
    <article class="task-item${stateClass}${item.starred ? ' starred' : ''}" data-item-id="${escapeHtml(item.id)}" data-filter-task="${escapeHtml(item.id)}" data-inspect-task="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="查看任务：${escapeHtml(item.title)}">
      <div class="task-title-row">
        <strong class="task-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
        <div class="task-title-controls">
          ${item.starred ? '<span class="task-star-indicator" aria-label="星标任务">★</span>' : ''}
          <span class="status ${item.status.toLowerCase()}">${statusLabel(item.status)}</span>
        </div>
      </div>
      <div class="task-dispatch-line">
        <span>${escapeHtml(agentLabel)}</span>
        <span>${computeLabel(routing.compute)}</span>
        <span>${formatDuration(routing.estimateMinutes)}</span>
      </div>
    </article>
  `;
}

function renderStarControl(task, editable) {
  if (!editable && !task.starred) return '';
  const active = task.starred === true;
  const label = active ? '取消星标' : '设为星标';
  if (!editable) {
    return `<span class="star-toggle static active" title="星标任务" aria-label="星标任务"><span aria-hidden="true">★</span></span>`;
  }
  return `<button class="star-toggle${active ? ' active' : ''}" type="button" data-toggle-star="${escapeHtml(task.id)}" aria-pressed="${active ? 'true' : 'false'}" aria-label="${label}" title="${label}"><span aria-hidden="true">${active ? '★' : '☆'}</span></button>`;
}

function bindActionButtons(container) {
  container.querySelectorAll('[data-open-project]').forEach((button) => {
    button.addEventListener('click', () => openProjectDetail(button.dataset.openProject));
  });
  container.querySelectorAll('[data-ready]').forEach((button) => {
    button.addEventListener('click', () => markReady(button.dataset.ready));
  });
  container.querySelectorAll('[data-focus-item]').forEach((button) => {
    button.addEventListener('click', () => focusItem(button.dataset.focusItem));
  });
  container.querySelectorAll('[data-toggle-star]').forEach((button) => {
    button.addEventListener('click', () => toggleTaskStar(button.dataset.toggleStar));
  });
}

function bindTaskInspectors(container) {
  container.querySelectorAll('[data-inspect-task]').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select, textarea, summary') || state.draggedTaskId) return;
      openTaskInspector(node.dataset.inspectTask);
    });
    node.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key) || event.target !== node || state.draggedTaskId) return;
      event.preventDefault();
      openTaskInspector(node.dataset.inspectTask);
    });
  });
}

async function openTaskInspector(taskId) {
  const fallback = detailTaskFor(taskId) ?? state.workItems.find((entry) => entry.id === taskId);
  if (!fallback) return;
  elements.taskInspectorContext.textContent = `${projectFor(fallback.projectId)?.name ?? '项目'} · ${fallback.planning?.phase ?? '待排期'}`;
  elements.taskInspectorTitle.textContent = fallback.title;
  elements.taskInspectorBody.innerHTML = '<p class="inspector-loading">正在读取真实任务记录…</p>';
  if (!elements.taskInspector.open) elements.taskInspector.showModal();
  try {
    const details = await api(`/api/work-items/${encodeURIComponent(taskId)}/details`);
    if (!elements.taskInspector.open) return;
    renderTaskInspector(details);
  } catch (error) {
    elements.taskInspectorBody.innerHTML = `<div class="inspector-error"><strong>任务记录暂时无法读取</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderTaskInspector(details) {
  const task = hydrateWorkItem(details.task);
  const decision = details.task?.decision ?? task.decision ?? null;
  const routing = effectiveTaskRouting({ ...task, decision });
  const dependencies = (task.dependsOnTaskIds ?? []).map((dependencyId) => (
    detailTaskFor(dependencyId) ?? state.workItems.find((entry) => entry.id === dependencyId)
  )).filter(Boolean);
  const completion = details.completionRecords?.at(-1) ?? null;
  const decisionReasons = decision?.reasonCodes?.length
    ? decision.reasonCodes.map((reason) => `<li>${escapeHtml(decisionReasonLabel(reason))}</li>`).join('')
    : '<li>当前没有持久化调度决策；刷新或重平衡后会补齐。</li>';
  const criteria = task.acceptanceCriteria?.length
    ? task.acceptanceCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join('')
    : '<li>尚未填写；进入 NEXT 前会被契约门禁拦截。</li>';
  const commands = task.testCommands?.length
    ? `<pre>${escapeHtml(task.testCommands.join('\n'))}</pre>`
    : '<p>未指定测试命令；可以使用其他可验证证据完成复核。</p>';
  elements.taskInspectorContext.textContent = `${details.project?.name ?? '项目'} · ${details.phase?.title ?? task.planning.phase}`;
  elements.taskInspectorTitle.textContent = task.title;
  elements.taskInspectorBody.innerHTML = `
    <section class="inspector-decision">
      <div><span>动态批次</span><strong>${escapeHtml(dispatchBatchLabel(decision?.batch))}</strong></div>
      <p>${escapeHtml(decisionReasonSummary(decision?.reasonCodes))}</p>
      <ul>${decisionReasons}</ul>
      <small>策略 ${escapeHtml(decision?.policyVersion ?? '尚未生成')} · ${decision?.decidedAt ? formatDateTime(decision.decidedAt) : '等待重平衡'}</small>
    </section>
    <dl class="inspector-facts">
      <div><dt>状态</dt><dd>${escapeHtml(statusLabel(task.status))}</dd></div>
      <div><dt>优先级</dt><dd>${escapeHtml(task.planning.priority)}</dd></div>
      <div><dt>推荐执行</dt><dd>${escapeHtml(routing.label)} · ${routing.source === 'HISTORY_CALIBRATED' ? '历史结果校准' : '规则默认'}</dd></div>
      <div><dt>算力 / 估时</dt><dd>${escapeHtml(computeLabel(routing.compute))} · ${formatDuration(routing.estimateMinutes)}</dd></div>
      <div><dt>依赖</dt><dd>${dependencies.length ? dependencies.map((entry) => escapeHtml(entry.title)).join(' · ') : '无'}</dd></div>
      <div><dt>并行策略</dt><dd>${escapeHtml(parallelPolicyLabel(task.parallelPolicy))}</dd></div>
    </dl>
    <section class="inspector-section"><h3>目标</h3><p>${escapeHtml(task.objective)}</p></section>
    <details class="inspector-section" open><summary>验收标准 <span>${task.acceptanceCriteria?.length ?? 0}</span></summary><ul>${criteria}</ul></details>
    <details class="inspector-section"><summary>验证方式 <span>${task.testCommands?.length ?? 0}</span></summary>${commands}</details>
    <details class="inspector-section"><summary>完成与证据 <span>${details.evidence?.length ?? 0}</span></summary>
      ${completion ? `<p>${escapeHtml(completion.resultSummary || '已收到完成上报')}</p><small>${escapeHtml(completion.modelRef ?? completion.executor ?? '未记录模型')} · ${formatDateTime(completion.completedAt)}</small>` : '<p>尚未收到真实完成上报。</p>'}
    </details>
  `;
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
  captureBoardScrollPositions();
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('project', projectId);
    window.history.pushState({ projectId }, '', url);
    state.selectedProjectId = projectId;
    state.detailRenderSignature = null;
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
  state.detailRenderSignature = null;
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
  state.taskEditorProjectId = state.selectedProjectId;
  state.taskEditorSchedule = state.detailSchedule;
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
  openTaskCreatorFor(state.selectedProjectId, state.detailSchedule);
}

function openTaskCreatorFor(projectId, schedule) {
  state.taskEditorMode = 'create';
  state.editingTaskId = null;
  state.taskEditorProjectId = projectId;
  state.taskEditorSchedule = schedule;
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
  populateDependencyOptions(elements.editDependencies, schedule);
  elements.editCriteria.value = '';
  elements.editCommands.value = '';
  const nextPhaseOrder = Math.max(0, ...schedule.phases.map((phase) => Number(phase.phaseOrder) || 0)) + 1;
  elements.editNewPhaseOrder.value = String(nextPhaseOrder);
  elements.editNewPhaseTitle.value = '';
  syncNewPhaseFields();
  elements.taskEditor.showModal();
  elements.editTitle.focus();
}

function populatePhaseOptions(includeNewPhase) {
  const phaseOptions = (state.taskEditorSchedule?.phases ?? [])
    .map((phase) => `<option value="${escapeHtml(phase.id)}">S${escapeHtml(phase.phaseOrder)} · ${escapeHtml(phase.title)}</option>`)
    .join('');
  elements.editPhaseId.innerHTML = `${phaseOptions}${includeNewPhase ? '<option value="__new__">＋ 新建阶段</option>' : ''}`;
  if (includeNewPhase && state.taskEditorSchedule?.phases.length === 0) elements.editPhaseId.value = '__new__';
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
  const targetPhase = state.taskEditorSchedule?.phases.find((phase) => phase.id === elements.editPhaseId.value);
  const currentTask = taskEditorTaskFor(state.editingTaskId);
  const dependencyIds = selectedOptionValues(elements.editDependencies);
  const dependencies = dependencyIds.map(taskEditorTaskFor).filter(Boolean);
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

function taskEditorTaskFor(taskId) {
  if (!state.taskEditorSchedule || !taskId) return null;
  return [
    ...state.taskEditorSchedule.phases.flatMap((phase) => phase.tasks),
    ...(state.taskEditorSchedule.unscheduledTasks ?? [])
  ].find((task) => task.id === taskId) ?? null;
}

function closeTaskEditor() {
  state.editingTaskId = null;
  state.taskEditorProjectId = null;
  state.taskEditorSchedule = null;
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
  if (!state.taskEditorSchedule || !state.taskEditorProjectId) return;
  try {
    let phase = state.taskEditorSchedule.phases.find((entry) => entry.id === elements.editPhaseId.value);
    if (elements.editPhaseId.value === '__new__') {
      const phaseOrder = Number(elements.editNewPhaseOrder.value);
      phase = await api('/api/phases', {
        method: 'POST',
        headers: { 'Idempotency-Key': mutationKey('phase-create') },
        body: JSON.stringify({
          projectId: state.taskEditorProjectId,
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
        projectId: state.taskEditorProjectId,
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
  return {
    ...item,
    storedStatus: item.storedStatus ?? item.status,
    status: item.effectiveStatus ?? item.status
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function groupPhases(items, derivedPhases = []) {
  const groups = new Map();
  for (const item of items) {
    const phaseId = item.phaseId ?? item.planning?.phaseId ?? null;
    const key = phaseId ?? `${item.planning.phaseOrder}:${item.planning.phase}`;
    if (!groups.has(key)) {
      const derived = derivedPhases.find((phase) => (
        phaseId ? phase.id === phaseId : (
          Number(phase.phaseOrder) === Number(item.planning.phaseOrder)
            && phase.title === item.planning.phase
        )
      ));
      groups.set(key, {
        id: phaseId,
        order: item.planning.phaseOrder,
        name: item.planning.phase,
        computedStatus: derived?.computedStatus ?? null,
        items: []
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((left, right) => left.order - right.order);
}

function decisionReasonSummary(reasonCodes = []) {
  const labels = {
    STARRED: '星标优先',
    PRIORITY_P0: 'P0 优先',
    PRIORITY_P1: 'P1 优先',
    PRIORITY_P2: 'P2 候选',
    PRIORITY_P3: 'P3 储备',
    COMMITTED: '已确认投入',
    HARD_DEADLINE: '临近硬期限',
    READY: '契约已就绪',
    REVIEW_REQUIRED: '等待独立复核',
    HIGH_STRATEGIC_VALUE: '高战略价值',
    HUMAN_AUTHORED: '人工明确排入',
    RISK_CRITICAL: '关键风险优先处置',
    RISK_HIGH: '高风险优先处置',
    PROJECT_CAPACITY_FULL: '同项目执行槽已满',
    HIGH_COMPUTE_CAPACITY_FULL: '高算力槽已满',
    MEDIUM_COMPUTE_CAPACITY_FULL: '中算力槽已满',
    LOW_COMPUTE_CAPACITY_FULL: '低算力槽已满',
    REVIEW_CAPACITY_FULL: '复核槽已满',
    DEPENDENCY_BLOCKED: '前置任务未完成',
    CONTRACT_INCOMPLETE: '执行契约待补齐',
    HISTORY_CALIBRATED_MODEL: '历史表现推荐模型',
    HISTORY_CALIBRATED_COMPUTE: '历史表现校准算力',
    HISTORY_CALIBRATED_ESTIMATE: '历史耗时校准估时'
  };
  const visible = reasonCodes.map((code) => labels[code]).filter(Boolean).slice(0, 2);
  return visible.join(' · ') || '按项目价值、顺序与可用容量进入当前批次';
}

function matchesFilter(item) {
  const compute = effectiveTaskRouting(item).compute;
  if (state.filter === 'low') return compute === 'low';
  if (state.filter === 'high') return compute === 'high';
  if (state.filter === 'bug') return ['bug', 'scan'].includes(item.planning.kind);
  if (state.filter === 'starred') return item.starred === true;
  return true;
}

function applyBoardFilter() {
  if (state.selectedProjectId) return;
  const byId = new Map(state.workItems.map((item) => [item.id, item]));
  elements.board.querySelectorAll('[data-filter-task]').forEach((node) => {
    const item = byId.get(node.dataset.filterTask);
    const matches = item ? matchesFilter(item) : false;
    node.classList.toggle('filter-muted', !matches);
    node.classList.toggle('filter-match', matches && state.filter !== 'all');
  });
  elements.board.querySelectorAll('[data-filter-phase]').forEach((phase) => {
    const tasks = [...phase.querySelectorAll('[data-filter-task]')];
    phase.classList.toggle('filter-empty', tasks.length > 0 && tasks.every((task) => task.classList.contains('filter-muted')));
  });
  elements.board.querySelectorAll('[data-project-row]').forEach((row) => {
    const tasks = [...row.querySelectorAll('[data-filter-task]')];
    row.classList.toggle('filter-empty', tasks.length > 0 && tasks.every((task) => task.classList.contains('filter-muted')));
  });
}

function captureBoardScrollPositions() {
  if (state.selectedProjectId) return;
  elements.board.querySelectorAll('[data-project-track]').forEach((track) => {
    state.boardScrollPositions.set(track.dataset.projectTrack, track.scrollLeft);
  });
}

function restoreBoardScrollPositions() {
  elements.board.querySelectorAll('[data-project-track]').forEach((track) => {
    const saved = state.boardScrollPositions.get(track.dataset.projectTrack);
    if (Number.isFinite(saved)) {
      track.scrollLeft = saved;
      return;
    }
    const currentPhase = track.querySelector('[data-current-phase="true"]');
    if (!currentPhase) {
      track.scrollLeft = 0;
      return;
    }
    track.scrollLeft = Math.max(0, currentPhase.offsetLeft - Math.max(0, (track.clientWidth - currentPhase.offsetWidth) / 2));
  });
}

function captureBoardFocus() {
  const active = document.activeElement;
  if (!active || !elements.board.contains(active)) return null;
  for (const attribute of ['data-open-project', 'data-focus-item', 'data-inspect-task', 'data-toggle-star']) {
    const value = active.getAttribute?.(attribute);
    if (value) return { attribute, value };
  }
  return null;
}

function restoreBoardFocus(snapshot) {
  if (!snapshot) return;
  elements.board.querySelector(`[${snapshot.attribute}="${cssEscape(snapshot.value)}"]`)?.focus({ preventScroll: true });
}

function htmlElement(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');
}

function projectHealthView(health) {
  return {
    ON_TRACK: { label: '推进正常', className: 'on-track' },
    AT_RISK: { label: '存在风险', className: 'at-risk' },
    BLOCKED: { label: '项目阻塞', className: 'blocked' },
    STALLED: { label: '已经停滞', className: 'stalled' },
    DORMANT: { label: '暂时休眠', className: 'dormant' },
    COMPLETE: { label: '全部完成', className: 'complete' }
  }[health] ?? { label: '状态计算中', className: 'unknown' };
}

function phaseStatusView(status) {
  return {
    COMPLETED: { label: '阶段完成', className: 'completed' },
    ACTIVE: { label: '正在推进', className: 'active' },
    REVIEW: { label: '等待复核', className: 'review' },
    BLOCKED: { label: '阶段阻塞', className: 'blocked' },
    DEFERRED: { label: '阶段已推迟', className: 'deferred' },
    PLANNED: { label: '待推进', className: 'planned' },
    NOT_STARTED: { label: '尚未开始', className: 'not-started' }
  }[status] ?? { label: '状态计算中', className: 'unknown' };
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
    DISCOVERED: '新发现', TRIAGED: '已分诊', PLANNED: '待排期', DEFERRED: '已推迟', READY: '已就绪', QUEUED: '排队中', RUNNING: '执行中', REVIEW: '审查中',
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

function dispatchBatchLabel(batch) {
  return {
    NOW: '正在推进',
    NEXT: '下一批',
    RESERVE: '候选池',
    BACKLOG: '待处理池'
  }[batch] ?? '等待调度';
}

function decisionReasonLabel(reason) {
  const known = decisionReasonSummary([reason]);
  if (known !== '按项目价值、顺序与可用容量进入当前批次') return known;
  return {
    STATUS_DEFERRED: '任务已推迟，不占用近期容量',
    STATUS_BLOCKED: '任务处于阻塞状态',
    STATUS_RECURRING: '周期任务等待下一次触发',
    RECURRING_CYCLE_IDLE: '周期任务等待下一次触发',
    DEPENDENCY_MISSING: '依赖任务不存在，需要人工修复',
    LEASE_EXPIRED: '领取租约已经过期，等待安全恢复',
    LEASE_EXPIRED_RECOVERY_PENDING: '领取租约已经过期，等待安全恢复'
  }[reason] ?? reason;
}

function parallelPolicyLabel(policy) {
  return {
    AUTO: '自动判断',
    PARALLEL_ALLOWED: '允许并行',
    SEQUENTIAL: '必须串行'
  }[policy] ?? policy ?? '自动判断';
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
    const show = (event) => showTaskTooltip(node, detailTaskFor(node.dataset.tooltipTask), pointerFromEvent(event));
    node.addEventListener('pointerdown', () => {
      state.dragTooltipSuppressed = true;
      hideTaskTooltip();
    });
    node.addEventListener('mouseenter', show);
    node.addEventListener('focusin', show);
    node.addEventListener('mouseleave', scheduleTaskTooltipHide);
    node.addEventListener('focusout', (event) => {
      if (!node.contains(event.relatedTarget)) scheduleTaskTooltipHide();
    });
  });
}

function pointerFromEvent(event) {
  return Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
    ? { x: event.clientX, y: event.clientY }
    : null;
}

function showTaskTooltip(anchor, task, pointer = null) {
  if (!task || state.dragTooltipSuppressed || state.draggedTaskId) {
    hideTaskTooltip();
    return;
  }
  cancelTaskTooltipHide();
  const routing = effectiveTaskRouting(task);
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
      ${task.starred ? '<span>★ 星标优先</span>' : ''}<span>${statusLabel(task.status)}</span><span>${task.planning.priority}</span><span>${kindLabel(task.planning.kind)}</span><span>${computeLabel(routing.compute)}</span>${task.scheduledFor ? `<span>排期 ${escapeHtml(task.scheduledFor)}</span>` : ''}
    </div>
    <p>${escapeHtml(task.objective)}</p>
    <p class="tooltip-status">${escapeHtml(statusDescription(task.status))}</p>
    ${task.issue ? `<p class="tooltip-issue">${renderIssueReference(task.issue)}</p>` : ''}
    <h5>前置依赖</h5>${dependencyList}
    <h5>验收标准</h5>${criteria}
    <h5>测试命令</h5>${commands}
    ${completion ? `<p class="tooltip-completion">完成记录：${escapeHtml(completionModel || '人工 / 历史导入')} · ${formatDateTime(completionAt)} · ${evidenceCount} 条证据</p>` : ''}
    <p class="tooltip-route">${escapeHtml(routeLabel(task.recommendation, routing.label))} · ${formatDuration(routing.estimateMinutes)}<br>${escapeHtml(task.recommendation.approach)}</p>
  `;
  elements.taskTooltip.hidden = false;
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = elements.taskTooltip.getBoundingClientRect();
  const gap = 12;
  const preferredDirection = pointer
    ? nearestTooltipEdge(anchorRect, pointer)
    : anchorRect.left + anchorRect.width / 2 <= window.innerWidth / 2 ? 'right' : 'left';
  const placement = resolveTooltipPlacement(anchorRect, tooltipRect, preferredDirection, gap);
  const { left, top } = placement;
  elements.taskTooltip.dataset.placement = placement.direction;
  elements.taskTooltip.style.left = `${left}px`;
  elements.taskTooltip.style.top = `${top}px`;
}

function nearestTooltipEdge(rect, pointer) {
  const distances = {
    left: Math.abs(pointer.x - rect.left),
    right: Math.abs(rect.right - pointer.x),
    top: Math.abs(pointer.y - rect.top),
    bottom: Math.abs(rect.bottom - pointer.y)
  };
  return Object.entries(distances).sort((first, second) => first[1] - second[1])[0][0];
}

function resolveTooltipPlacement(anchorRect, tooltipRect, preferredDirection, gap) {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const room = {
    left: anchorRect.left - gap,
    right: viewport.width - anchorRect.right - gap,
    top: anchorRect.top - gap,
    bottom: viewport.height - anchorRect.bottom - gap
  };
  const required = {
    left: tooltipRect.width,
    right: tooltipRect.width,
    top: tooltipRect.height,
    bottom: tooltipRect.height
  };
  const alternatives = Object.keys(room)
    .filter((direction) => direction !== preferredDirection)
    .sort((first, second) => (room[second] - required[second]) - (room[first] - required[first]));
  const directions = [preferredDirection, ...alternatives];
  const direction = directions.find((candidate) => room[candidate] >= required[candidate])
    ?? directions[0];
  return tooltipCoordinates(anchorRect, tooltipRect, direction, gap, viewport);
}

function tooltipCoordinates(anchorRect, tooltipRect, direction, gap, viewport) {
  const centeredLeft = anchorRect.left + (anchorRect.width - tooltipRect.width) / 2;
  const centeredTop = anchorRect.top + (anchorRect.height - tooltipRect.height) / 2;
  const positions = {
    left: { left: anchorRect.left - tooltipRect.width - gap, top: centeredTop },
    right: { left: anchorRect.right + gap, top: centeredTop },
    top: { left: centeredLeft, top: anchorRect.top - tooltipRect.height - gap },
    bottom: { left: centeredLeft, top: anchorRect.bottom + gap }
  };
  return {
    direction,
    left: Math.min(viewport.width - tooltipRect.width - gap, Math.max(gap, positions[direction].left)),
    top: Math.min(viewport.height - tooltipRect.height - gap, Math.max(gap, positions[direction].top))
  };
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

function routeLabel(recommendation, actor = recommendation.executor) {
  const executor = actor === 'codex'
    ? 'Codex'
    : actor === 'luna_worker'
      ? 'Luna Worker'
      : actor === 'shell' ? 'Shell' : actor;
  const effort = { low: '低推理', medium: '中推理', high: '高推理' }[recommendation.reasoningEffort] ?? recommendation.reasoningEffort;
  return `${executor} · ${effort} · ${recommendation.validationProfile ?? 'V2'} · ${recommendation.capability}`;
}

function effectiveTaskRouting(task) {
  const recommendation = task.recommendation ?? {};
  const decision = task.decision ?? {};
  const label = decision.recommendedModelRef
    ?? decision.recommendedAgent
    ?? recommendation.executor
    ?? '待分配';
  return {
    label,
    compute: decision.compute ?? recommendation.compute ?? 'medium',
    estimateMinutes: positiveNumber(decision.estimateMinutes, recommendation.estimateMinutes ?? 30),
    source: decision.recommendationSource ?? 'RULE_DEFAULT'
  };
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

function readTrajectoryWindow() {
  try {
    const value = window.localStorage.getItem('lifeline.trajectoryWindow');
    return ['24h', '7d', '30d'].includes(value) ? value : '7d';
  } catch {
    return '7d';
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

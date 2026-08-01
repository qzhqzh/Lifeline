const state = {
  projects: [],
  workItems: [],
  dashboard: null,
  eventSource: null,
  activeRunId: null
};

const elements = {
  health: document.querySelector('#health'),
  metrics: document.querySelector('#metrics'),
  projects: document.querySelector('#projects'),
  projectId: document.querySelector('#projectId'),
  workItems: document.querySelector('#workItems'),
  timeline: document.querySelector('#timeline'),
  runStatus: document.querySelector('#runStatus'),
  seedDemo: document.querySelector('#seedDemo'),
  refresh: document.querySelector('#refresh'),
  form: document.querySelector('#workItemForm'),
  toast: document.querySelector('#toast')
};

elements.refresh.addEventListener('click', refresh);
elements.seedDemo.addEventListener('click', seedDemo);
elements.form.addEventListener('submit', createWorkItem);

await checkHealth();
await refresh();

async function checkHealth() {
  try {
    const health = await api('/api/health');
    elements.health.textContent = `控制平面在线 · ${new Date(health.time).toLocaleTimeString()}`;
    elements.health.classList.add('online');
  } catch (error) {
    elements.health.textContent = '控制平面离线';
    notify(error.message, true);
  }
}

async function refresh() {
  try {
    const [dashboard, projects, workItems] = await Promise.all([
      api('/api/dashboard'),
      api('/api/projects'),
      api('/api/work-items')
    ]);
    state.dashboard = dashboard;
    state.projects = projects.items;
    state.workItems = workItems.items;
    render();
  } catch (error) {
    notify(error.message, true);
  }
}

async function seedDemo() {
  try {
    const result = await api('/api/demo', { method: 'POST' });
    notify(result.seeded ? '演示项目已创建' : '演示项目已经存在');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

async function createWorkItem(event) {
  event.preventDefault();
  if (!elements.projectId.value) {
    notify('请先创建演示项目', true);
    return;
  }
  try {
    await api('/api/work-items', {
      method: 'POST',
      body: JSON.stringify({
        projectId: elements.projectId.value,
        title: document.querySelector('#title').value,
        objective: document.querySelector('#objective').value,
        acceptanceCriteria: lines(document.querySelector('#criteria').value),
        testCommands: lines(document.querySelector('#commands').value),
        riskTier: 'low',
        weight: 1,
        resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
      })
    });
    notify('工作包已创建');
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
    state.activeRunId = run.id;
    elements.timeline.innerHTML = '';
    setRunStatus(run.status);
    openRunStream(run.id);
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
      ${event.metadata?.evidenceScore ? `<small>证据得分 ${Math.round(event.metadata.evidenceScore * 100)}%</small>` : ''}
    </div>
  `;
  elements.timeline.append(item);
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function render() {
  renderMetrics();
  renderProjects();
  renderProjectSelect();
  renderWorkItems();
}

function renderMetrics() {
  const dashboard = state.dashboard ?? { projects: [], activeRuns: 0, evidenceCount: 0, totalRuns: 0 };
  const average = dashboard.projects.length
    ? dashboard.projects.reduce((sum, project) => sum + project.verifiedProgress, 0) / dashboard.projects.length
    : 0;
  elements.metrics.innerHTML = [
    ['项目', dashboard.projects.length],
    ['活动运行', dashboard.activeRuns],
    ['验收证据', dashboard.evidenceCount],
    ['组合已验证进度', `${Math.round(average * 100)}%`]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderProjects() {
  if (state.dashboard?.projects.length === 0) {
    elements.projects.innerHTML = '<div class="empty-card">尚无项目。创建演示项目即可开始。</div>';
    return;
  }
  elements.projects.innerHTML = state.dashboard.projects.map((project) => {
    const progress = Math.round(project.verifiedProgress * 100);
    return `
      <div class="project-card">
        <div class="project-title-row">
          <div><h4>${escapeHtml(project.name)}</h4><p>${escapeHtml(project.description || '未填写项目描述')}</p></div>
          <span class="priority">P${11 - project.strategicValue}</span>
        </div>
        <div class="progress-label"><span>已验证进度</span><strong>${progress}%</strong></div>
        <div class="progress"><span style="width:${progress}%"></span></div>
        <div class="project-foot"><span>${project.workItemCount} 个工作包</span><span>最近证据 ${project.lastEvidenceAt ? formatTime(project.lastEvidenceAt) : '无'}</span></div>
      </div>
    `;
  }).join('');
}

function renderProjectSelect() {
  const previous = elements.projectId.value;
  elements.projectId.innerHTML = state.projects.length
    ? state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('')
    : '<option value="">请先创建项目</option>';
  if (state.projects.some((project) => project.id === previous)) elements.projectId.value = previous;
}

function renderWorkItems() {
  if (state.workItems.length === 0) {
    elements.workItems.innerHTML = '<div class="empty-card">尚无工作包。</div>';
    return;
  }
  elements.workItems.innerHTML = state.workItems.map((item) => {
    const action = item.status === 'PLANNED'
      ? `<button data-ready="${item.id}" class="secondary compact">校验并就绪</button>`
      : item.status === 'READY'
        ? `<button data-run="${item.id}" class="primary compact">运行 Mock Executor</button>`
        : item.currentRunId
          ? `<button data-replay="${item.currentRunId}" class="secondary compact">查看运行</button>`
          : '';
    return `
      <div class="work-item">
        <div class="work-item-main">
          <div class="work-item-head"><h4>${escapeHtml(item.title)}</h4><span class="status ${item.status.toLowerCase()}">${item.status}</span></div>
          <p>${escapeHtml(item.objective)}</p>
          <div class="chips"><span>${item.acceptanceCriteria.length} 条验收标准</span><span>${item.testCommands.length} 条测试命令</span><span>${item.riskTier} risk</span></div>
        </div>
        <div class="work-item-action">${action}</div>
      </div>
    `;
  }).join('');

  elements.workItems.querySelectorAll('[data-ready]').forEach((button) => {
    button.addEventListener('click', () => markReady(button.dataset.ready));
  });
  elements.workItems.querySelectorAll('[data-run]').forEach((button) => {
    button.addEventListener('click', () => runWorkItem(button.dataset.run));
  });
  elements.workItems.querySelectorAll('[data-replay]').forEach((button) => {
    button.addEventListener('click', () => replayRun(button.dataset.replay));
  });
}

async function replayRun(runId) {
  try {
    const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
    elements.timeline.innerHTML = '';
    for (const event of run.events) appendTimeline(event);
    setRunStatus(run.status);
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) openRunStream(runId);
  } catch (error) {
    notify(error.message, true);
  }
}

function setRunStatus(status) {
  elements.runStatus.textContent = status;
  elements.runStatus.className = `status ${String(status).toLowerCase()}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
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

function notify(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${isError ? ' error' : ''}`;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => elements.toast.classList.remove('visible'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  })[character]);
}

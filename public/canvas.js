import {
  clearProjectAccessToken,
  projectAccessHeaders,
  projectShareUrl
} from './project-access.js';

const state = {
  projects: [],
  selectedProjectId: new URLSearchParams(window.location.search).get('project'),
  session: null,
  context: null,
  requestController: null,
  framePending: false,
  contextTimer: null,
  toastTimer: null
};

const elements = {
  projectSelect: document.querySelector('#projectSelect'),
  projectProgressNavLink: document.querySelector('#projectProgressNavLink'),
  testMapNavLink: document.querySelector('#testMapNavLink'),
  canvasNavLink: document.querySelector('#canvasNavLink'),
  frame: document.querySelector('#canvasFrame'),
  surface: document.querySelector('.canvas-surface'),
  status: document.querySelector('#canvasStatus'),
  statusTitle: document.querySelector('#canvasStatusTitle'),
  statusDetail: document.querySelector('#canvasStatusDetail'),
  retry: document.querySelector('#retryCanvas'),
  contextToggle: document.querySelector('#canvasContextToggle'),
  contextClose: document.querySelector('#canvasContextClose'),
  contextPanel: document.querySelector('#canvasContextPanel'),
  contextCount: document.querySelector('#canvasContextCount'),
  accessRole: document.querySelector('#canvasAccessRole'),
  bindingCount: document.querySelector('#canvasBindingCount'),
  objectList: document.querySelector('#canvasObjectList'),
  changeSection: document.querySelector('#canvasChangeSection'),
  changeForm: document.querySelector('#canvasChangeForm'),
  changeTask: document.querySelector('#canvasChangeTask'),
  changePhase: document.querySelector('#canvasChangePhase'),
  changeStatus: document.querySelector('#canvasChangeStatus'),
  changeReason: document.querySelector('#canvasChangeReason'),
  proposalCount: document.querySelector('#canvasProposalCount'),
  proposalList: document.querySelector('#canvasProposalList'),
  shareSection: document.querySelector('#canvasShareSection'),
  shareForm: document.querySelector('#canvasShareForm'),
  shareName: document.querySelector('#canvasShareName'),
  shareRole: document.querySelector('#canvasShareRole'),
  shareResult: document.querySelector('#canvasShareResult'),
  shareUrl: document.querySelector('#canvasShareUrl'),
  copyShareUrl: document.querySelector('#copyCanvasShareUrl'),
  toast: document.querySelector('#canvasToast')
};

elements.projectSelect.addEventListener('change', async () => {
  state.selectedProjectId = elements.projectSelect.value;
  updateUrl({ replace: false });
  updateProjectLinks();
  await loadCanvas();
});

elements.retry.addEventListener('click', loadCanvas);
elements.contextToggle.addEventListener('click', () => setContextPanelOpen(elements.contextPanel.getAttribute('aria-hidden') === 'true'));
elements.contextClose.addEventListener('click', () => setContextPanelOpen(false));
elements.objectList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-bind-entity]');
  if (!button) return;
  await bindProjectObject(button);
});
elements.proposalList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-review-proposal]');
  if (!button) return;
  await reviewProposal(button.dataset.proposalId, button.dataset.reviewProposal);
});
elements.changeForm.addEventListener('submit', createChangeProposal);
elements.shareForm.addEventListener('submit', createShareLink);
elements.copyShareUrl.addEventListener('click', () => copyText(elements.shareUrl.value, '共享链接已复制'));

elements.frame.addEventListener('load', () => {
  if (!state.framePending || !state.session) return;
  try {
    const frameUrl = new URL(elements.frame.contentWindow.location.href);
    const expectedPath = `/boards/${encodeURIComponent(state.session.boardId)}`;
    if (!frameUrl.pathname.endsWith(expectedPath)) return;
    if (!elements.frame.contentDocument?.querySelector('#canvas')) {
      throw new Error('Whiteboard document did not expose its canvas surface');
    }
    state.framePending = false;
    elements.surface.classList.add('is-ready');
    elements.status.hidden = true;
  } catch {
    state.framePending = false;
    showCanvasError(Object.assign(new Error('画布服务返回了无效页面。'), { code: 'CANVAS_UNAVAILABLE' }));
  }
});

window.addEventListener('popstate', async () => {
  const projectId = new URLSearchParams(window.location.search).get('project');
  if (!projectId || projectId === state.selectedProjectId) return;
  state.selectedProjectId = projectId;
  renderProjectOptions();
  updateProjectLinks();
  await loadCanvas();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setContextPanelOpen(false);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.selectedProjectId) loadCanvasContext({ silent: true });
});

await loadProjects();

async function loadProjects() {
  setStatus('loading', '正在连接协作画布', '');
  try {
    const response = await api('/api/projects');
    state.projects = response.items ?? [];
    if (state.projects.length === 0) {
      setStatus('error', '还没有可共享的项目', '请先在 Lifeline 中建立项目。');
      return;
    }
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
      state.selectedProjectId = state.projects[0].id;
      updateUrl({ replace: true });
    }
    renderProjectOptions();
    updateProjectLinks();
    await loadCanvas();
  } catch (error) {
    showCanvasError(error);
  }
}

async function loadCanvas() {
  if (!state.selectedProjectId) return;
  state.requestController?.abort();
  state.requestController = new AbortController();
  state.session = null;
  state.framePending = false;
  elements.surface.classList.remove('is-ready');
  elements.frame.removeAttribute('src');
  setStatus('loading', '正在连接协作画布', '');

  try {
    await loadCanvasContext();
    const session = await api(
      `/api/projects/${encodeURIComponent(state.selectedProjectId)}/canvas-session`,
      { signal: state.requestController.signal }
    );
    state.session = session;
    state.framePending = true;
    const project = state.projects.find((item) => item.id === state.selectedProjectId);
    document.title = `${project?.name ?? '项目'}协作画布 · Lifeline`;
    elements.frame.title = `${project?.name ?? '项目'}协作画布`;
    elements.frame.src = session.iframeUrl;
    scheduleContextRefresh();
  } catch (error) {
    if (error.name === 'AbortError') return;
    showCanvasError(error);
  }
}

async function loadCanvasContext({ silent = false } = {}) {
  if (!state.selectedProjectId) return;
  try {
    state.context = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/canvas-context`);
    renderCanvasContext();
  } catch (error) {
    if (!silent) throw error;
  }
}

function scheduleContextRefresh() {
  window.clearInterval(state.contextTimer);
  state.contextTimer = window.setInterval(() => {
    if (!document.hidden) loadCanvasContext({ silent: true });
  }, 5_000);
}

function renderCanvasContext() {
  const context = state.context;
  if (!context) return;
  const bindings = new Set((context.bindings ?? []).map((entry) => `${entry.entityType}:${entry.entityId}`));
  const capabilities = new Set(context.access?.capabilities ?? []);
  elements.contextCount.textContent = String((context.bindings ?? []).length);
  elements.accessRole.textContent = roleLabel(context.access?.role);
  elements.bindingCount.textContent = `${context.bindings?.length ?? 0} 个已关联`;
  elements.proposalCount.textContent = `${context.changeProposals?.filter((entry) => entry.status === 'PENDING').length ?? 0} 个待处理`;

  const tasksByPhase = new Map((context.phases ?? []).map((phase) => [phase.id, []]));
  for (const task of context.tasks ?? []) {
    if (!tasksByPhase.has(task.phaseId)) tasksByPhase.set(task.phaseId, []);
    tasksByPhase.get(task.phaseId).push(task);
  }
  elements.objectList.innerHTML = (context.phases ?? []).map((phase) => {
    const tasks = tasksByPhase.get(phase.id) ?? [];
    return `
      <div class="canvas-object-group">
        <strong>${escapeHtml(phase.title)} · ${tasks.length}</strong>
        ${objectRow(phase, bindings, capabilities)}
        ${tasks.slice(0, 8).map((task) => objectRow(task, bindings, capabilities)).join('')}
      </div>`;
  }).join('') || '<p class="canvas-empty">暂无可关联对象</p>';

  elements.changeSection.hidden = !capabilities.has('canvas-change:create');
  elements.changeTask.innerHTML = (context.tasks ?? []).map((task) => (
    `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)}</option>`
  )).join('');
  elements.changePhase.innerHTML = (context.phases ?? []).map((phase) => (
    `<option value="${escapeHtml(phase.id)}">${escapeHtml(phase.title)}</option>`
  )).join('');
  elements.changeForm.hidden = !(context.tasks?.length && context.phases?.length);
  renderProposals(capabilities);
  elements.shareSection.hidden = !capabilities.has('access:manage');
}

function objectRow(entity, bindings, capabilities) {
  const key = `${entity.type}:${entity.id}`;
  const bound = bindings.has(key);
  return `
    <div class="canvas-object-row">
      <a class="canvas-object-copy" href="${escapeHtml(entity.href)}">
        ${escapeHtml(entity.title)}
        <span>${escapeHtml(entity.type === 'PHASE' ? '阶段' : statusLabel(entity.status))}</span>
      </a>
      ${capabilities.has('canvas:bind') ? `<button type="button" data-bind-entity data-entity-id="${escapeHtml(entity.id)}" data-entity-type="${escapeHtml(entity.type)}" data-bound="${bound}">${bound ? '再复制' : '复制'}</button>` : ''}
    </div>`;
}

function renderProposals(capabilities) {
  const proposals = state.context?.changeProposals ?? [];
  elements.proposalList.innerHTML = proposals.length ? proposals.slice(0, 20).map((proposal) => `
    <div class="canvas-proposal-row">
      <div class="canvas-proposal-copy">
        <strong>${escapeHtml(proposal.title)}</strong>
        <span>${escapeHtml(proposal.reason)}</span>
        <i class="canvas-proposal-state">${escapeHtml(proposalStateLabel(proposal.status))}</i>
      </div>
      ${proposal.status === 'PENDING' && capabilities.has('canvas-change:review') ? `
        <div class="canvas-proposal-actions">
          <button type="button" data-review-proposal="ACCEPT" data-proposal-id="${escapeHtml(proposal.id)}">接受</button>
          <button class="dismiss" type="button" data-review-proposal="DISMISS" data-proposal-id="${escapeHtml(proposal.id)}">驳回</button>
        </div>` : ''}
    </div>`).join('') : '<p class="canvas-empty">暂无排期提议</p>';
}

async function bindProjectObject(button) {
  button.disabled = true;
  try {
    const entity = [...(state.context?.phases ?? []), ...(state.context?.tasks ?? [])]
      .find((entry) => entry.id === button.dataset.entityId);
    const binding = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/canvas-bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: button.dataset.entityType, entityId: button.dataset.entityId, boardId: state.session?.boardId })
    });
    const reference = `[Lifeline · ${entity?.type === 'PHASE' ? '阶段' : '任务'}] ${binding.label}\n${new URL(binding.href, window.location.origin).href}`;
    await copyText(reference, '项目对象已复制，可粘贴到画布');
    await loadCanvasContext({ silent: true });
  } catch (error) {
    showToast(error.message || '关联失败', true);
  } finally {
    button.disabled = false;
  }
}

async function createChangeProposal(event) {
  event.preventDefault();
  const submit = elements.changeForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/canvas-change-proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemId: elements.changeTask.value,
        targetPhaseId: elements.changePhase.value,
        statusId: elements.changeStatus.value,
        reason: elements.changeReason.value
      })
    });
    elements.changeReason.value = '';
    showToast('排期提议已提交');
    await loadCanvasContext({ silent: true });
  } catch (error) {
    showToast(error.message || '提议提交失败', true);
  } finally {
    submit.disabled = false;
  }
}

async function reviewProposal(proposalId, decision) {
  try {
    await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/canvas-change-proposals/${encodeURIComponent(proposalId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision,
        reason: decision === 'ACCEPT' ? '负责人在协作画布确认' : '负责人在协作画布驳回'
      })
    });
    showToast(decision === 'ACCEPT' ? '排期已更新' : '提议已驳回');
    await loadCanvasContext({ silent: true });
  } catch (error) {
    showToast(error.code === 'SCHEDULE_VERSION_CONFLICT' ? '排期已变化，请重新提交提议' : error.message || '处理失败', true);
    await loadCanvasContext({ silent: true });
  }
}

async function createShareLink(event) {
  event.preventDefault();
  const submit = elements.shareForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const grant = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/access-grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: elements.shareName.value, role: elements.shareRole.value })
    });
    elements.shareUrl.value = projectShareUrl({
      projectId: state.selectedProjectId,
      token: grant.token,
      path: grant.role === 'VIEWER' ? '/client.html' : '/canvas.html'
    });
    elements.shareResult.hidden = false;
    await copyText(elements.shareUrl.value, '共享链接已生成并复制');
  } catch (error) {
    showToast(error.message || '共享链接生成失败', true);
  } finally {
    submit.disabled = false;
  }
}

function setContextPanelOpen(open) {
  elements.contextPanel.setAttribute('aria-hidden', String(!open));
  elements.contextToggle.setAttribute('aria-expanded', String(open));
  if (open) loadCanvasContext({ silent: true });
}

function renderProjectOptions() {
  elements.projectSelect.innerHTML = state.projects
    .map((project) => `<option value="${escapeHtml(project.id)}"${project.id === state.selectedProjectId ? ' selected' : ''}>${escapeHtml(project.name)}</option>`)
    .join('');
}

function updateProjectLinks() {
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

function updateUrl({ replace }) {
  const url = new URL(window.location.href);
  if (state.selectedProjectId) url.searchParams.set('project', state.selectedProjectId);
  else url.searchParams.delete('project');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function setStatus(status, title, detail) {
  elements.status.hidden = false;
  elements.status.dataset.state = status;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.retry.hidden = status !== 'error';
}

function showCanvasError(error) {
  const copy = {
    CANVAS_NOT_CONFIGURED: ['协作画布尚未启用', '请完成画布服务配置后重试。'],
    CANVAS_UNAVAILABLE: ['协作画布暂时无法连接', '服务恢复后可从这里重新连接。'],
    NOT_FOUND: ['找不到这个项目', '请切换到其他项目后重试。'],
    PROJECT_CAPABILITY_DENIED: ['当前链接不能编辑画布', '可从项目对象查看正式进度。'],
    PROJECT_ACCESS_REQUIRED: ['需要项目访问链接', '请让项目负责人重新发送链接。'],
    PROJECT_ACCESS_INVALID: ['项目访问链接已失效', '请让项目负责人重新生成。']
  }[error.code] ?? ['协作画布载入失败', error.message || '请稍后重新连接。'];
  setStatus('error', copy[0], copy[1]);
}

async function copyText(value, message) {
  await navigator.clipboard.writeText(value);
  showToast(message);
}

function showToast(message, error = false) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.add('visible');
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('visible'), 2800);
}

function roleLabel(role) {
  return ({ OWNER: '所有者', MANAGER: '负责人', EDITOR: '协作编辑', VIEWER: '仅查看' })[role] ?? '';
}

function statusLabel(status) {
  return ({ PLANNED: '已排期', DEFERRED: '待确认', READY: '已排期', QUEUED: '已排期', RUNNING: '进行中', REVIEW: '待验收', VERIFIED: '已完成', RELEASED: '已完成' })[status] ?? status;
}

function proposalStateLabel(status) {
  return ({ PENDING: '待负责人处理', ACCEPTED: '已接受', DISMISSED: '已驳回' })[status] ?? status;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: projectAccessHeaders({ Accept: 'application/json', ...(options.headers ?? {}) }),
    cache: 'no-store'
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && ['PROJECT_ACCESS_INVALID', 'PROJECT_ACCESS_REQUIRED'].includes(body?.error?.code)) {
      clearProjectAccessToken();
    }
    const error = new Error(body?.error?.message ?? `请求失败（${response.status}）`);
    error.code = body?.error?.code;
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

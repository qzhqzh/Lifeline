const state = {
  projects: [],
  selectedProjectId: new URLSearchParams(window.location.search).get('project'),
  session: null,
  requestController: null,
  framePending: false
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
  retry: document.querySelector('#retryCanvas')
};

elements.projectSelect.addEventListener('change', async () => {
  state.selectedProjectId = elements.projectSelect.value;
  updateUrl({ replace: false });
  updateProjectLinks();
  await loadCanvas();
});

elements.retry.addEventListener('click', loadCanvas);

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
  } catch (error) {
    if (error.name === 'AbortError') return;
    showCanvasError(error);
  }
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
    NOT_FOUND: ['找不到这个项目', '请切换到其他项目后重试。']
  }[error.code] ?? ['协作画布载入失败', error.message || '请稍后重新连接。'];
  setStatus('error', copy[0], copy[1]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
    cache: 'no-store'
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
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

const state = {
  summary: null,
  accounts: [],
  histories: new Map(),
  filter: 'ALL',
  window: '7d',
  pairingCodes: new Map(),
  ownerToken: window.sessionStorage.getItem('lifelineOwnerToken') ?? '',
  countdown: 10
};

const elements = {
  summary: document.querySelector('#subscriptionSummary'),
  grid: document.querySelector('#subscriptionGrid'),
  filters: document.querySelector('#subscriptionFilters'),
  historySwitch: document.querySelector('#historySwitch'),
  refresh: document.querySelector('#refreshSubscriptions'),
  lastUpdated: document.querySelector('#lastUpdated'),
  health: document.querySelector('#subscriptionHealth'),
  toast: document.querySelector('#subscriptionToast')
};

elements.filters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-status]');
  if (!button) return;
  state.filter = button.dataset.status;
  elements.filters.querySelectorAll('button').forEach((entry) => {
    const active = entry === button;
    entry.classList.toggle('active', active);
    entry.setAttribute('aria-pressed', String(active));
  });
  renderAccounts();
});

elements.historySwitch.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-window]');
  if (!button || button.dataset.window === state.window) return;
  state.window = button.dataset.window;
  elements.historySwitch.querySelectorAll('button').forEach((entry) => entry.setAttribute('aria-pressed', String(entry === button)));
  await loadHistories();
  renderAccounts();
});

elements.refresh.addEventListener('click', () => load({ includeHistory: true }));

elements.grid.addEventListener('click', async (event) => {
  const aliasButton = event.target.closest('[data-edit-alias]');
  const pairButton = event.target.closest('[data-pair-account]');
  const revokeButton = event.target.closest('[data-revoke-collector]');
  try {
    if (aliasButton) await editAlias(aliasButton.dataset.editAlias);
    if (pairButton) await createPairingCode(pairButton.dataset.pairAccount);
    if (revokeButton) await revokeCollector(revokeButton.dataset.revokeCollector);
  } catch (error) {
    notify(error.message, true);
  }
});

await load({ includeHistory: true });
window.setInterval(tick, 1000);

async function tick() {
  state.countdown -= 1;
  if (state.countdown <= 0) await load();
  elements.refresh.textContent = `刷新 · ${state.countdown}s`;
  renderFreshnessOnly();
}

async function load({ includeHistory = false } = {}) {
  state.countdown = 10;
  try {
    const [summary, accounts] = await Promise.all([
      api('/api/subscriptions/summary'),
      api('/api/subscriptions/accounts')
    ]);
    state.summary = summary;
    state.accounts = accounts.items;
    if (includeHistory) await loadHistories();
    elements.health.textContent = '本地余额服务在线';
    elements.health.classList.add('online');
    render();
  } catch (error) {
    elements.health.textContent = '本地余额服务离线';
    elements.health.classList.remove('online');
    notify(error.message, true);
  }
}

async function loadHistories() {
  const results = await Promise.all(state.accounts.map(async (account) => [
    account.id,
    await api(`/api/subscriptions/accounts/${encodeURIComponent(account.id)}/history?window=${state.window}`)
  ]));
  state.histories = new Map(results);
}

function render() {
  renderSummary();
  renderAccounts();
  renderFreshnessOnly();
}

function renderSummary() {
  const summary = state.summary;
  elements.summary.innerHTML = [
    ['账户总数', summary.total, ''],
    ['当前可用', summary.usable, ''],
    ['需要关注', summary.attention, 'attention'],
    ['已触顶', summary.statusCounts.LIMITED, summary.statusCounts.LIMITED ? 'attention' : ''],
    ['数据过期', summary.statusCounts.STALE, summary.statusCounts.STALE ? 'attention' : '']
  ].map(([label, value, className]) => `<article class="${className}"><span>${label}</span><strong>${value}</strong></article>`).join('');
}

function renderAccounts() {
  const accounts = state.accounts.filter((entry) => state.filter === 'ALL' || entry.status === state.filter);
  if (accounts.length === 0) {
    elements.grid.innerHTML = '<div class="subscription-empty"><strong>这个状态下没有账号</strong><span>切换筛选查看其他订阅。</span></div>';
    return;
  }
  elements.grid.innerHTML = accounts.map(renderAccount).join('');
}

function renderAccount(account) {
  const measurements = account.latest?.measurements ?? [];
  const pairing = state.pairingCodes.get(account.id);
  const history = state.histories.get(account.id)?.items ?? [];
  return `<article class="subscription-card" data-status="${account.status}">
    <header class="subscription-card-head">
      <div class="subscription-identity"><small>${escapeHtml(providerLabel(account.provider))}</small><h3>${escapeHtml(account.alias)}</h3><span>${escapeHtml(account.plan)}</span></div>
      <span class="subscription-status">${displayStatusLabel(account)}</span>
    </header>
    <div class="subscription-measurements">${measurements.length ? measurements.map(renderMeasurement).join('') : renderNoMeasurement(account)}</div>
    <div class="subscription-trend">${renderTrend(history)}</div>
    <div class="subscription-freshness">
      <span>最后采集<strong>${relativeTime(account.lastUpdatedAt)}</strong></span>
      <span>采集 Profile<strong>${escapeHtml(account.collector?.profileName ?? '尚未配对')}</strong></span>
      <span>连接状态<strong>${escapeHtml(collectorStateLabel(account))}</strong></span>
    </div>
    <div class="subscription-actions">
      <a class="button primary" href="${escapeHtml(account.sourceUrl)}" target="_blank" rel="noreferrer">打开额度页并同步</a>
      <button class="button quiet" type="button" data-edit-alias="${account.id}">修改别名</button>
      <button class="button quiet" type="button" data-pair-account="${account.id}">${account.collector ? '重新配对' : '生成配对码'}</button>
      ${account.collector ? `<button class="button danger" type="button" data-revoke-collector="${account.collector.id}">撤销采集器</button>` : ''}
      ${pairing ? `<div class="pairing-code"><span>在扩展中输入，10 分钟内有效</span><strong>${escapeHtml(pairing.pairingToken)}</strong><span>账号：${escapeHtml(account.alias)}</span></div>` : ''}
    </div>
  </article>`;
}

function renderMeasurement(entry) {
  const value = measurementValue(entry);
  const detail = [
    `来源 ${measurementSourceLabel(entry.sourceKind)}`,
    `可信度 ${confidenceLabel(entry.confidence)}`,
    entry.window ? `窗口 ${entry.window}` : null,
    entry.resetsAt ? `重置 ${formatDate(entry.resetsAt)}` : null
  ].filter(Boolean).join(' · ');
  return `<div class="subscription-measurement${entry.displayable === false ? ' unverified' : ''}"><span>${escapeHtml(entry.label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function renderNoMeasurement(account) {
  const error = account.collector?.lastError?.message;
  const guidance = error
    ?? (account.collector
      ? '已配对，但尚未收到额度页上报。请在对应浏览器 Profile 中打开并刷新额度页，再查看扩展里的真实上报状态。'
      : '尚未建立采集连接。请先生成配对码，并在对应浏览器 Profile 的扩展中完成配对。');
  return `<div class="subscription-measurement"><span>当前状态</span><strong>${displayStatusLabel(account)}</strong><small>${escapeHtml(guidance)}</small></div>`;
}

function displayStatusLabel(account) {
  if (account.status === 'UNKNOWN') {
    if (account.latest?.measurements?.some((entry) => entry.displayable === false && hasNumericValue(entry))) return '数值待校准';
    return account.collector ? '等待额度页' : '未配对';
  }
  return statusLabel(account.status);
}

function collectorStateLabel(account) {
  if (!account.collector) return '未建立连接';
  if (account.collector.lastError) return '最近上报失败';
  if (account.collector.lastSeenAt) return '已收到上报';
  return '已配对，尚未上报';
}

function measurementValue(entry) {
  if (entry.displayable === false && hasNumericValue(entry)) return '数值待校准';
  if (Number.isFinite(entry.remaining) && Number.isFinite(entry.limit)) return `${formatNumber(entry.remaining)} / ${formatNumber(entry.limit)} ${entry.unit ?? ''}`.trim();
  if (Number.isFinite(entry.remainingRatio)) return `${Math.round(entry.remainingRatio * 100)}% 剩余`;
  if (Number.isFinite(entry.remaining)) return `${formatNumber(entry.remaining)} ${entry.unit ?? ''}`.trim();
  return '状态可用';
}

function renderTrend(items) {
  const values = items.map(trendValue).filter((entry) => entry !== null);
  if (values.length < 2) return '<p>积累两次以上可量化快照后显示趋势</p>';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${64 - ((value - min) / range) * 54}`).join(' ');
  return `<svg viewBox="0 0 100 68" preserveAspectRatio="none" aria-label="${state.window} 额度趋势"><path class="area" d="M ${points.replaceAll(' ', ' L ')} L 100 68 L 0 68 Z"></path><polyline points="${points}"></polyline></svg>`;
}

function trendValue(snapshot) {
  const measurement = snapshot.measurements?.find((entry) => entry.displayable !== false && Number.isFinite(entry.remainingRatio))
    ?? snapshot.measurements?.find((entry) => entry.displayable !== false && Number.isFinite(entry.remaining));
  return measurement ? (measurement.remainingRatio ?? measurement.remaining) : null;
}

function hasNumericValue(entry) {
  return Number.isFinite(entry?.remaining) || Number.isFinite(entry?.remainingRatio) || Number.isFinite(entry?.used) || Number.isFinite(entry?.limit);
}

function measurementSourceLabel(sourceKind) {
  return {
    OFFICIAL_API: '官方接口',
    PROVIDER_STRUCTURED: '官方结构化页面',
    SCOPED_DOM: '精确页面组件',
    STATUS_INFERENCE: '页面状态',
    UNVERIFIED: '待校准'
  }[sourceKind] ?? '待校准';
}

function confidenceLabel(confidence) {
  return { HIGH: '高', MEDIUM: '中', LOW: '低', UNVERIFIED: '未验证' }[confidence] ?? '未验证';
}

function renderFreshnessOnly() {
  elements.lastUpdated.textContent = state.summary?.lastUpdatedAt
    ? `最近更新 ${relativeTime(state.summary.lastUpdatedAt)}`
    : '尚无采集记录';
  document.querySelectorAll('.subscription-card').forEach((card) => {
    const account = state.accounts.find((entry) => entry.status === card.dataset.status && card.querySelector('h3')?.textContent === entryAlias(entry));
    const node = card.querySelector('.subscription-freshness strong');
    if (account && node) node.textContent = relativeTime(account.lastUpdatedAt);
  });
}

function entryAlias(entry) { return entry.alias; }

async function editAlias(accountId) {
  const account = state.accounts.find((entry) => entry.id === accountId);
  const alias = window.prompt('输入新的账号别名', account?.alias ?? '');
  if (!alias || alias.trim() === account?.alias) return;
  await ownerApi(`/api/subscriptions/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify({ alias: alias.trim() }) });
  await load();
}

async function createPairingCode(accountId) {
  const result = await ownerApi('/api/subscriptions/pairing-token', { method: 'POST', body: JSON.stringify({ accountId }) });
  state.pairingCodes.set(accountId, result);
  renderAccounts();
  notify('配对码已生成，请在浏览器扩展中输入');
}

async function revokeCollector(collectorId) {
  if (!window.confirm('撤销后该浏览器 Profile 将无法继续上报，确定撤销？')) return;
  await ownerApi(`/api/subscriptions/collectors/${encodeURIComponent(collectorId)}`, { method: 'DELETE' });
  await load();
}

async function api(path, options = {}) {
  const { headers = {}, ...fetchOptions } = options;
  const response = await fetch(path, {
    ...fetchOptions,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
  return body;
}

async function ownerApi(path, options = {}) {
  if (!state.ownerToken) {
    const token = window.prompt('输入具有 schedule:write 权限的 Lifeline 管理令牌');
    if (!token?.trim()) throw new Error('未提供管理令牌，操作已取消');
    state.ownerToken = token.trim();
    window.sessionStorage.setItem('lifelineOwnerToken', state.ownerToken);
  }
  try {
    return await api(path, {
      ...options,
      headers: { Authorization: `Bearer ${state.ownerToken}`, ...(options.headers ?? {}) }
    });
  } catch (error) {
    if (/token|401|403|503|权限/i.test(error.message)) {
      state.ownerToken = '';
      window.sessionStorage.removeItem('lifelineOwnerToken');
    }
    throw error;
  }
}

function statusLabel(status) {
  return { AVAILABLE: '可用', LOW: '低余额', LIMITED: '已触顶', STALE: '数据过期', ERROR: '采集异常', UNKNOWN: '等待数据' }[status] ?? status;
}

function providerLabel(provider) {
  return {
    CODEX: 'Codex',
    GEMINI: 'Gemini',
    CURSOR: 'Cursor',
    GROK: 'Grok',
    XIAOYUNQUE: '小云雀'
  }[provider] ?? provider;
}

function relativeTime(value) {
  if (!value) return '尚未采集';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function notify(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => elements.toast.classList.remove('visible'), 2800);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

const STORAGE_KEY = 'lifelineSubscriptionConnections';
const form = document.querySelector('#pairForm');
const message = document.querySelector('#message');
const connectionsNode = document.querySelector('#connections');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '正在配对…';
  try {
    const baseUrl = normalizeLocalUrl(document.querySelector('#baseUrl').value);
    document.querySelector('#baseUrl').value = baseUrl;
    await requireHealthyService(baseUrl);
    const response = await fetch(`${baseUrl}/api/subscriptions/collectors/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingToken: document.querySelector('#pairingToken').value.trim(),
        profileName: document.querySelector('#profileName').value.trim()
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message ?? '配对失败');
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const connections = (stored[STORAGE_KEY] ?? []).filter((entry) => entry.account.id !== body.account.id);
    connections.push({
      ...body,
      baseUrl,
      telemetry: { state: 'WAITING', lastCheckedAt: new Date().toISOString(), message: '服务在线，等待打开额度页' }
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: connections });
    document.querySelector('#pairingToken').value = '';
    message.textContent = `${body.account.alias} 已连接；打开对应额度页即可同步。`;
    await refreshConnections(connections);
  } catch (error) {
    message.textContent = error.message;
  }
});

connectionsNode.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button || button.disabled) return;
  button.disabled = true;
  message.dataset.state = '';
  message.textContent = '正在撤销同步…';
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const currentConnections = stored[STORAGE_KEY] ?? [];
  const connection = currentConnections.find((entry) => entry.collectorId === button.dataset.remove);
  if (!connection) {
    message.textContent = '这条本地连接已经不存在。';
    renderConnections(currentConnections);
    return;
  }

  try {
    const response = await fetch(`${connection.baseUrl}/api/subscriptions/collectors/${encodeURIComponent(connection.collectorId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${connection.collectorToken}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 404) {
      throw new Error(body?.error?.message ?? `撤销接口返回 ${response.status}`);
    }
    const connections = currentConnections.filter((entry) => entry.collectorId !== connection.collectorId);
    await chrome.storage.local.set({ [STORAGE_KEY]: connections });
    message.textContent = `${connection.account.alias} 已断开同步。`;
    await refreshConnections(connections);
  } catch (error) {
    message.dataset.state = 'error';
    message.textContent = `撤销失败，连接已保留：${error.message}`;
    renderConnections(currentConnections);
  } finally {
    button.disabled = false;
  }
});

function normalizeLocalUrl(value) {
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : `http://${input}`);
  if (url.protocol !== 'http:' || !isPrivateHost(url.hostname)) throw new Error('Lifeline 地址必须是 localhost 或局域网 IPv4 地址');
  if (!url.port) url.port = '8019';
  return url.origin;
}

function renderConnections(connections) {
  connectionsNode.innerHTML = connections.length === 0 ? '<span>尚未配对任何账号</span>' : connections.map((entry) => `
    <div class="connection">
      <div>
        <strong>${escapeHtml(entry.account.alias)}</strong>
        <span class="connection-state" data-state="${escapeHtml(entry.telemetry?.state ?? 'CHECKING')}">${escapeHtml(entry.telemetry?.message ?? '正在检查真实连接…')}</span>
        <span class="connection-url">${escapeHtml(entry.baseUrl)}</span>
      </div>
      <button type="button" data-remove="${escapeHtml(entry.collectorId)}">断开</button>
    </div>`).join('');
}

async function refreshConnections(connections) {
  renderConnections(connections.map((entry) => ({ ...entry, telemetry: { ...entry.telemetry, state: 'CHECKING', message: '正在检查真实连接…' } })));
  const checked = await Promise.all(connections.map(probeConnection));
  await chrome.storage.local.set({ [STORAGE_KEY]: checked });
  renderConnections(checked);
}

async function probeConnection(connection) {
  try {
    await requireHealthyService(connection.baseUrl);
    const response = await fetch(`${connection.baseUrl}/api/subscriptions/accounts`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`账号状态接口返回 ${response.status}`);
    const body = await response.json();
    const account = body.items?.find((entry) => entry.id === connection.account.id);
    if (!account?.collector || account.collector.id !== connection.collectorId) {
      return withTelemetry(connection, 'REVOKED', '服务在线，但这条配对已失效');
    }
    if (account.collector.lastError) return withTelemetry(connection, 'ERROR', `上报失败：${account.collector.lastError.message ?? '页面解析失败'}`);
    if (account.latest) return withTelemetry(connection, 'SYNCED', `最近同步 ${relativeTime(account.latest.capturedAt)}`);
    return withTelemetry(connection, 'WAITING', '服务在线，等待打开额度页');
  } catch (error) {
    return withTelemetry(connection, 'OFFLINE', `服务不可达：${error.message}`);
  }
}

async function requireHealthyService(baseUrl) {
  const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`健康检查返回 ${response.status}`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error('目标不是可用的 Lifeline 服务');
}

function withTelemetry(connection, state, message) {
  return { ...connection, telemetry: { ...connection.telemetry, state, message, lastCheckedAt: new Date().toISOString() } };
}

function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 127;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

const stored = await chrome.storage.local.get(STORAGE_KEY);
const connections = stored[STORAGE_KEY] ?? [];
renderConnections(connections);
await refreshConnections(connections);

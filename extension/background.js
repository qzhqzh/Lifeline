const STORAGE_KEY = 'lifelineSubscriptionConnections';

chrome.runtime.onMessage.addListener((message) => {
  if (!['SUBSCRIPTION_SNAPSHOT', 'SUBSCRIPTION_SNAPSHOT_ERROR'].includes(message?.type)) return;
  void forwardSnapshot(message);
});

async function forwardSnapshot(message) {
  const { [STORAGE_KEY]: connections = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const provider = message.result?.provider ?? message.provider;
  const connection = connections.find((entry) => entry.account?.provider === provider);
  if (!connection) return;
  const capturedAt = new Date().toISOString();
  const measurements = message.type === 'SUBSCRIPTION_SNAPSHOT_ERROR'
    ? [availabilityMeasurement(`${provider} 页面解析失败`)]
    : message.result.measurements;
  const payload = {
    accountId: connection.account.id,
    capturedAt,
    reportedStatus: message.type === 'SUBSCRIPTION_SNAPSHOT_ERROR' ? 'ERROR' : message.result.reportedStatus,
    measurements,
    adapterVersion: message.adapterVersion ?? message.result.adapterVersion,
    sourceUrl: sanitizeSourceUrl(message.sourceUrl),
    snapshotHash: await digest(JSON.stringify({ accountId: connection.account.id, capturedAt, measurements })),
    error: message.type === 'SUBSCRIPTION_SNAPSHOT_ERROR' ? message.error : null
  };
  try {
    const response = await fetch(`${connection.baseUrl}/api/subscriptions/snapshots`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.collectorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? `上报接口返回 ${response.status}`);
    if (message.type === 'SUBSCRIPTION_SNAPSHOT_ERROR' || body.accepted === false) {
      await updateTelemetry(connection.collectorId, 'ERROR', message.error?.message ?? '页面解析失败');
      return;
    }
    await updateTelemetry(connection.collectorId, 'SYNCED', '最近一次额度上报成功', capturedAt);
  } catch (error) {
    await updateTelemetry(connection.collectorId, 'ERROR', String(error?.message ?? error).slice(0, 300));
  }
}

async function updateTelemetry(collectorId, state, message, lastSuccessAt = null) {
  const { [STORAGE_KEY]: connections = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const updated = connections.map((entry) => entry.collectorId === collectorId ? {
    ...entry,
    telemetry: {
      ...entry.telemetry,
      state,
      message,
      lastAttemptAt: new Date().toISOString(),
      ...(lastSuccessAt ? { lastSuccessAt } : {})
    }
  } : entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
}

function availabilityMeasurement(label) {
  return {
    key: 'availability',
    label,
    kind: 'availability',
    unit: null,
    used: null,
    limit: null,
    remaining: null,
    remainingRatio: null,
    window: null,
    resetsAt: null,
    reliableLimit: false
  };
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((entry) => entry.toString(16).padStart(2, '0')).join('');
}

function sanitizeSourceUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError, createId, nowIso } from './domain.js';

export const SUBSCRIPTION_STATUS = Object.freeze([
  'AVAILABLE',
  'LOW',
  'LIMITED',
  'STALE',
  'ERROR',
  'UNKNOWN'
]);

export const MEASUREMENT_KINDS = Object.freeze([
  'quota_window',
  'usage_pool',
  'credit_balance',
  'availability'
]);

export const MEASUREMENT_SOURCE_KINDS = Object.freeze([
  'OFFICIAL_API',
  'PROVIDER_STRUCTURED',
  'SCOPED_DOM',
  'STATUS_INFERENCE',
  'UNVERIFIED'
]);

export const MEASUREMENT_CONFIDENCE = Object.freeze([
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNVERIFIED'
]);

const REPORTED_STATUSES = new Set(['AVAILABLE', 'LIMITED', 'ERROR', 'UNKNOWN']);
const HISTORY_WINDOWS = Object.freeze({
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000
});
const MAX_CAPTURE_SKEW_MS = 10 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const RETENTION_MS = HISTORY_WINDOWS['90d'];

export const DEFAULT_SUBSCRIPTION_ACCOUNTS = Object.freeze([
  account('subscription_codex_a', 'CODEX', 'Codex 账号 A', 'ChatGPT 个人订阅', 'https://chatgpt.com/codex/settings/usage', 30),
  account('subscription_codex_b', 'CODEX', 'Codex 账号 B', 'ChatGPT 个人订阅', 'https://chatgpt.com/codex/settings/usage', 30),
  account('subscription_gemini_pro', 'GEMINI', 'Google AI Pro', 'Google AI Pro 个人会员', 'https://gemini.google.com/app', 45),
  account('subscription_cursor', 'CURSOR', 'Cursor', 'Cursor 个人订阅', 'https://cursor.com/dashboard?tab=usage', 45),
  account('subscription_grok', 'GROK', 'Grok', 'Grok 个人订阅', 'https://grok.com/settings', 45),
  account('subscription_xiaoyunque', 'XIAOYUNQUE', '小云雀', '小云雀个人账号', 'https://xyq.jianying.com/home?tab_name=home', 45)
]);

const PROVIDER_HOSTS = Object.freeze({
  CODEX: new Set(['chatgpt.com']),
  GEMINI: new Set(['gemini.google.com']),
  CURSOR: new Set(['cursor.com', 'www.cursor.com']),
  GROK: new Set(['grok.com', 'www.grok.com', 'x.com', 'www.x.com']),
  XIAOYUNQUE: new Set(['xyq.jianying.com'])
});

export class SubscriptionService {
  #store;
  #clock;

  constructor({ store, clock = Date }) {
    this.#store = store;
    this.#clock = clock;
  }

  async start() {
    await this.#store.ready();
    await this.#store.mutate((state) => {
      ensureCollections(state);
      const existingIds = new Set(state.subscriptionAccounts.map((entry) => entry.id));
      for (const template of DEFAULT_SUBSCRIPTION_ACCOUNTS) {
        if (!existingIds.has(template.id)) {
          state.subscriptionAccounts.push({ ...template, createdAt: nowIso(this.#clock), updatedAt: nowIso(this.#clock) });
        } else if (template.id === 'subscription_grok') {
          const existing = state.subscriptionAccounts.find((entry) => entry.id === template.id);
          if (['https://grok.com/', 'https://www.grok.com/'].includes(existing.sourceUrl)) existing.sourceUrl = template.sourceUrl;
        }
      }
      pruneHistory(state, this.#nowMs());
    });
  }

  async getSummary() {
    const state = await this.#store.read();
    const accounts = activeAccounts(state).map((entry) => presentAccount(state, entry, this.#nowMs()));
    const statusCounts = Object.fromEntries(SUBSCRIPTION_STATUS.map((status) => [status, 0]));
    for (const entry of accounts) statusCounts[entry.status] += 1;
    const usable = accounts.filter((entry) => ['AVAILABLE', 'LOW'].includes(entry.status)).length;
    const attention = accounts.filter((entry) => entry.status !== 'AVAILABLE').length;
    const timestamps = accounts.map((entry) => Date.parse(entry.lastUpdatedAt)).filter(Number.isFinite);
    return {
      total: accounts.length,
      usable,
      attention,
      statusCounts,
      lastUpdatedAt: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null
    };
  }

  async listAccounts() {
    const state = await this.#store.read();
    return { items: activeAccounts(state).map((entry) => presentAccount(state, entry, this.#nowMs())) };
  }

  async getHistory(accountId, window = '7d') {
    const duration = HISTORY_WINDOWS[window];
    if (!duration) throw new SubscriptionError('Unsupported history window', 'INVALID_HISTORY_WINDOW');
    const state = await this.#store.read();
    requireAccount(state, accountId);
    const since = this.#nowMs() - duration;
    const items = state.subscriptionHourlySnapshots
      .filter((entry) => entry.accountId === accountId && Date.parse(entry.capturedAt) >= since)
      .sort((first, second) => first.capturedAt.localeCompare(second.capturedAt))
      .map(presentSnapshot);
    return { accountId, window, items };
  }

  async updateAccount(accountId, input) {
    assertAllowedKeys(input, ['alias', 'staleAfterMinutes', 'enabled']);
    return this.#store.mutate((state) => {
      const entry = requireAccount(state, accountId);
      if ('alias' in input) entry.alias = requireText(input.alias, 'alias', 1, 80);
      if ('staleAfterMinutes' in input) entry.staleAfterMinutes = requireInteger(input.staleAfterMinutes, 'staleAfterMinutes', 5, 1440);
      if ('enabled' in input) entry.enabled = requireBoolean(input.enabled, 'enabled');
      entry.updatedAt = nowIso(this.#clock);
      return presentAccount(state, entry, this.#nowMs());
    });
  }

  async createPairingToken(input) {
    assertAllowedKeys(input, ['accountId']);
    const accountId = requireText(input?.accountId, 'accountId', 3, 160);
    const pairingToken = randomToken(8).toUpperCase();
    const now = nowIso(this.#clock);
    const expiresAt = new Date(this.#nowMs() + PAIRING_TTL_MS).toISOString();
    return this.#store.mutate((state) => {
      requireAccount(state, accountId);
      state.subscriptionCollectors = state.subscriptionCollectors.filter((entry) => entry.status !== 'PENDING' || Date.parse(entry.pairingExpiresAt) > this.#nowMs());
      const collector = {
        id: createId('collector'),
        accountId,
        status: 'PENDING',
        pairingTokenHash: hashSecret(pairingToken),
        pairingExpiresAt: expiresAt,
        tokenHash: null,
        profileName: null,
        extensionOrigin: null,
        lastSeenAt: null,
        lastAttemptAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      };
      state.subscriptionCollectors.push(collector);
      return { collectorId: collector.id, accountId, pairingToken, expiresAt };
    });
  }

  async pairCollector(input, origin) {
    requireExtensionOrigin(origin);
    assertAllowedKeys(input, ['pairingToken', 'profileName']);
    const pairingToken = requireText(input?.pairingToken, 'pairingToken', 6, 40).toUpperCase();
    const profileName = requireText(input?.profileName, 'profileName', 1, 80);
    const collectorToken = randomToken(32);
    return this.#store.mutate((state) => {
      const collector = state.subscriptionCollectors.find((entry) => entry.status === 'PENDING' && timingSafeHashEqual(entry.pairingTokenHash, pairingToken));
      if (!collector || Date.parse(collector.pairingExpiresAt) <= this.#nowMs()) {
        throw new SubscriptionError('Pairing token is invalid or expired', 'INVALID_PAIRING_TOKEN');
      }
      const linked = state.subscriptionCollectors.find((entry) => entry.status === 'ACTIVE' && entry.accountId === collector.accountId);
      if (linked) linked.status = 'REVOKED';
      collector.status = 'ACTIVE';
      collector.profileName = profileName;
      collector.extensionOrigin = origin;
      collector.tokenHash = hashSecret(collectorToken);
      collector.pairingTokenHash = null;
      collector.updatedAt = nowIso(this.#clock);
      const linkedAccount = requireAccount(state, collector.accountId);
      return {
        collectorId: collector.id,
        collectorToken,
        account: publicAccountIdentity(linkedAccount)
      };
    });
  }

  async submitSnapshot(input, { authorization, origin } = {}) {
    requireExtensionOrigin(origin);
    const token = bearerToken(authorization);
    const sanitized = sanitizeSnapshot(input);
    const capturedMs = Date.parse(sanitized.capturedAt);
    if (Math.abs(this.#nowMs() - capturedMs) > MAX_CAPTURE_SKEW_MS) {
      throw new SubscriptionError('capturedAt is outside the allowed clock window', 'CAPTURE_TIME_SKEW');
    }
    return this.#store.mutate((state) => {
      const collector = state.subscriptionCollectors.find((entry) => entry.status === 'ACTIVE' && timingSafeHashEqual(entry.tokenHash, token));
      if (!collector) throw new SubscriptionError('Collector token is invalid or revoked', 'INVALID_COLLECTOR_TOKEN');
      if (collector.extensionOrigin !== origin) throw new SubscriptionError('Collector origin does not match the paired extension', 'COLLECTOR_ORIGIN_MISMATCH');
      if (collector.accountId !== sanitized.accountId) throw new SubscriptionError('Collector is not paired to this account', 'COLLECTOR_ACCOUNT_MISMATCH');
      const linkedAccount = requireAccount(state, collector.accountId);
      requireProviderUrl(linkedAccount.provider, sanitized.sourceUrl);
      collector.lastAttemptAt = nowIso(this.#clock);
      collector.lastSeenAt = collector.lastAttemptAt;
      collector.updatedAt = collector.lastAttemptAt;

      if (sanitized.reportedStatus === 'ERROR') {
        collector.lastError = sanitized.error;
        return { accepted: false, preservedPreviousSnapshot: true, status: 'ERROR' };
      }

      collector.lastError = null;
      const duplicate = state.subscriptionHourlySnapshots.some((entry) => entry.accountId === sanitized.accountId && entry.collectorId === collector.id && entry.snapshotHash === sanitized.snapshotHash);
      if (duplicate) return { accepted: true, duplicate: true, snapshotHash: sanitized.snapshotHash };

      const snapshot = {
        ...sanitized,
        id: createId('subscription_snapshot'),
        collectorId: collector.id,
        receivedAt: nowIso(this.#clock),
        contentHash: hashSecret(JSON.stringify(sanitized))
      };
      const latestIndex = state.subscriptionLatestSnapshots.findIndex((entry) => entry.accountId === snapshot.accountId);
      if (latestIndex === -1) state.subscriptionLatestSnapshots.push(snapshot);
      else if (state.subscriptionLatestSnapshots[latestIndex].capturedAt <= snapshot.capturedAt) state.subscriptionLatestSnapshots[latestIndex] = snapshot;

      const bucket = hourBucket(snapshot.capturedAt);
      const hourlyIndex = state.subscriptionHourlySnapshots.findIndex((entry) => entry.accountId === snapshot.accountId && entry.hourBucket === bucket);
      const hourly = { ...snapshot, hourBucket: bucket };
      if (hourlyIndex === -1) state.subscriptionHourlySnapshots.push(hourly);
      else if (state.subscriptionHourlySnapshots[hourlyIndex].capturedAt <= snapshot.capturedAt) state.subscriptionHourlySnapshots[hourlyIndex] = hourly;
      pruneHistory(state, this.#nowMs());
      return { accepted: true, duplicate: false, snapshotHash: snapshot.snapshotHash, status: deriveSnapshotStatus(linkedAccount, snapshot) };
    });
  }

  async revokeCollector(collectorId, { authorization, origin, ownerApproved = false } = {}) {
    const collectorToken = authorization ? bearerToken(authorization) : null;
    if (!ownerApproved) requireExtensionOrigin(origin);
    return this.#store.mutate((state) => {
      const collector = state.subscriptionCollectors.find((entry) => entry.id === collectorId);
      if (!collector) throw new SubscriptionError('Collector not found', 'NOT_FOUND');
      if (!ownerApproved && (
        collector.status !== 'ACTIVE'
          || collector.extensionOrigin !== origin
          || !timingSafeHashEqual(collector.tokenHash, collectorToken)
      )) {
        throw new SubscriptionError('Collector token is invalid or revoked', 'INVALID_COLLECTOR_TOKEN');
      }
      collector.status = 'REVOKED';
      collector.tokenHash = null;
      collector.updatedAt = nowIso(this.#clock);
      return { id: collector.id, accountId: collector.accountId, status: collector.status };
    });
  }

  #nowMs() {
    return new this.#clock().getTime();
  }
}

function account(id, provider, alias, plan, sourceUrl, staleAfterMinutes) {
  return { id, provider, alias, plan, sourceUrl, staleAfterMinutes, collectionMode: 'BROWSER_EXTENSION', enabled: true };
}

function ensureCollections(state) {
  for (const key of ['subscriptionAccounts', 'subscriptionLatestSnapshots', 'subscriptionHourlySnapshots', 'subscriptionCollectors']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
}

function activeAccounts(state) {
  return state.subscriptionAccounts.filter((entry) => entry.enabled !== false);
}

function requireAccount(state, accountId) {
  const entry = state.subscriptionAccounts.find((account) => account.id === accountId);
  if (!entry) throw new SubscriptionError('Subscription account not found', 'NOT_FOUND');
  return entry;
}

function publicAccountIdentity(entry) {
  return {
    id: entry.id,
    provider: entry.provider,
    alias: entry.alias,
    plan: entry.plan,
    sourceUrl: entry.sourceUrl,
    staleAfterMinutes: entry.staleAfterMinutes,
    collectionMode: entry.collectionMode,
    enabled: entry.enabled
  };
}

function presentAccount(state, entry, nowMs) {
  const latest = state.subscriptionLatestSnapshots.find((snapshot) => snapshot.accountId === entry.id) ?? null;
  const collector = [...state.subscriptionCollectors]
    .filter((item) => item.accountId === entry.id && item.status === 'ACTIVE')
    .sort((first, second) => String(second.updatedAt).localeCompare(String(first.updatedAt)))[0] ?? null;
  const status = effectiveStatus(entry, latest, collector, nowMs);
  return {
    ...publicAccountIdentity(entry),
    status,
    latest: latest ? presentSnapshot(latest) : null,
    lastUpdatedAt: latest?.capturedAt ?? collector?.lastAttemptAt ?? null,
    collector: collector ? {
      id: collector.id,
      status: collector.status,
      profileName: collector.profileName,
      lastSeenAt: collector.lastSeenAt,
      lastAttemptAt: collector.lastAttemptAt,
      lastError: collector.lastError
    } : null
  };
}

function effectiveStatus(accountEntry, latest, collector, nowMs) {
  if (collector?.lastError && (!latest || Date.parse(collector.lastAttemptAt) >= Date.parse(latest.capturedAt))) return 'ERROR';
  if (!latest) return 'UNKNOWN';
  if (nowMs - Date.parse(latest.capturedAt) > accountEntry.staleAfterMinutes * 60 * 1000) return 'STALE';
  return deriveSnapshotStatus(accountEntry, latest);
}

function deriveSnapshotStatus(_accountEntry, snapshot) {
  if (snapshot.reportedStatus === 'LIMITED') return 'LIMITED';
  const measurements = snapshot.measurements.map(presentMeasurement);
  const reliable = measurements.find((entry) => entry.displayable && entry.reliableLimit && Number.isFinite(entry.limit) && entry.limit > 0 && Number.isFinite(entry.remaining));
  if (reliable && reliable.remaining / reliable.limit <= 0.2) return 'LOW';
  const hasUsableSignal = measurements.some((entry) => entry.kind === 'availability' || entry.displayable);
  return snapshot.reportedStatus === 'AVAILABLE' && hasUsableSignal ? 'AVAILABLE' : 'UNKNOWN';
}

function sanitizeSnapshot(input) {
  assertAllowedKeys(input, ['accountId', 'capturedAt', 'reportedStatus', 'measurements', 'adapterVersion', 'sourceUrl', 'snapshotHash', 'error']);
  const reportedStatus = requireEnum(input?.reportedStatus, 'reportedStatus', REPORTED_STATUSES);
  const error = input?.error === undefined || input?.error === null ? null : sanitizeError(input.error);
  if (reportedStatus === 'ERROR' && !error) throw new SubscriptionError('ERROR snapshots require error details', 'INVALID_SNAPSHOT');
  const measurements = Array.isArray(input?.measurements) ? input.measurements.map(sanitizeMeasurement) : null;
  if (!measurements || measurements.length === 0 || measurements.length > 24) throw new SubscriptionError('measurements must contain 1 to 24 items', 'INVALID_SNAPSHOT');
  return {
    accountId: requireText(input.accountId, 'accountId', 3, 160),
    capturedAt: requireDateTime(input.capturedAt, 'capturedAt'),
    reportedStatus,
    measurements,
    adapterVersion: requireText(input.adapterVersion, 'adapterVersion', 1, 80),
    sourceUrl: requireUrl(input.sourceUrl, 'sourceUrl'),
    snapshotHash: requireText(input.snapshotHash, 'snapshotHash', 16, 128),
    error
  };
}

function sanitizeMeasurement(input) {
  assertAllowedKeys(input, ['key', 'label', 'kind', 'unit', 'used', 'limit', 'remaining', 'remainingRatio', 'window', 'resetsAt', 'reliableLimit', 'sourceKind', 'confidence']);
  const kind = requireEnum(input?.kind, 'measurement.kind', new Set(MEASUREMENT_KINDS));
  const entry = {
    key: requireText(input?.key, 'measurement.key', 1, 80),
    label: requireText(input?.label, 'measurement.label', 1, 120),
    kind,
    unit: optionalText(input?.unit, 'measurement.unit', 32),
    used: optionalNumber(input?.used, 'measurement.used'),
    limit: optionalNumber(input?.limit, 'measurement.limit'),
    remaining: optionalNumber(input?.remaining, 'measurement.remaining'),
    remainingRatio: optionalRatio(input?.remainingRatio, 'measurement.remainingRatio'),
    window: optionalText(input?.window, 'measurement.window', 80),
    resetsAt: input?.resetsAt === undefined || input?.resetsAt === null ? null : requireDateTime(input.resetsAt, 'measurement.resetsAt'),
    reliableLimit: input?.reliableLimit === true,
    sourceKind: input?.sourceKind === undefined
      ? (kind === 'availability' ? 'STATUS_INFERENCE' : 'UNVERIFIED')
      : requireEnum(input.sourceKind, 'measurement.sourceKind', new Set(MEASUREMENT_SOURCE_KINDS)),
    confidence: input?.confidence === undefined
      ? (kind === 'availability' ? 'LOW' : 'UNVERIFIED')
      : requireEnum(input.confidence, 'measurement.confidence', new Set(MEASUREMENT_CONFIDENCE))
  };
  if (entry.kind === 'availability') {
    entry.used = null;
    entry.limit = null;
    entry.remaining = null;
    entry.remainingRatio = null;
    entry.reliableLimit = false;
  }
  return entry;
}

function presentSnapshot(snapshot) {
  return {
    ...snapshot,
    measurements: (snapshot.measurements ?? []).map(presentMeasurement)
  };
}

function presentMeasurement(input) {
  const kind = input?.kind;
  const sourceKind = MEASUREMENT_SOURCE_KINDS.includes(input?.sourceKind)
    ? input.sourceKind
    : (kind === 'availability' ? 'STATUS_INFERENCE' : 'UNVERIFIED');
  const confidence = MEASUREMENT_CONFIDENCE.includes(input?.confidence)
    ? input.confidence
    : (kind === 'availability' ? 'LOW' : 'UNVERIFIED');
  const displayable = kind === 'availability' || (
    ['OFFICIAL_API', 'PROVIDER_STRUCTURED', 'SCOPED_DOM'].includes(sourceKind)
      && ['HIGH', 'MEDIUM'].includes(confidence)
  );
  return { ...input, sourceKind, confidence, displayable };
}

function sanitizeError(input) {
  assertAllowedKeys(input, ['code', 'message']);
  return {
    code: requireText(input?.code, 'error.code', 1, 80),
    message: requireText(input?.message, 'error.message', 1, 300)
  };
}

function requireProviderUrl(provider, value) {
  const url = new URL(value);
  if (!PROVIDER_HOSTS[provider]?.has(url.hostname)) throw new SubscriptionError('sourceUrl does not match the paired provider', 'PROVIDER_URL_MISMATCH');
}

function requireExtensionOrigin(origin) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(String(origin ?? ''))) {
    throw new SubscriptionError('Only a paired Chrome extension origin may use this endpoint', 'INVALID_EXTENSION_ORIGIN');
  }
}

function bearerToken(value) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,128})$/.exec(String(value ?? ''));
  if (!match) throw new SubscriptionError('A valid collector bearer token is required', 'INVALID_COLLECTOR_TOKEN');
  return match[1];
}

function pruneHistory(state, nowMs) {
  const cutoff = nowMs - RETENTION_MS;
  state.subscriptionHourlySnapshots = state.subscriptionHourlySnapshots.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
}

function hourBucket(value) {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeHashEqual(expectedHash, value) {
  if (!expectedHash || !value) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashSecret(value), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function randomToken(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function assertAllowedKeys(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SubscriptionError('Request body must be an object', 'INVALID_INPUT');
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new SubscriptionError(`Unknown fields: ${extra.join(', ')}`, 'UNKNOWN_FIELDS');
}

function requireText(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new SubscriptionError(`${name} must be ${min}-${max} characters`, 'INVALID_INPUT');
  return value.trim();
}

function optionalText(value, name, max) {
  return value === undefined || value === null || value === '' ? null : requireText(value, name, 1, max);
}

function requireInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new SubscriptionError(`${name} must be an integer from ${min} to ${max}`, 'INVALID_INPUT');
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new SubscriptionError(`${name} must be a boolean`, 'INVALID_INPUT');
  return value;
}

function optionalNumber(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new SubscriptionError(`${name} must be a non-negative number`, 'INVALID_INPUT');
  return value;
}

function optionalRatio(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new SubscriptionError(`${name} must be between 0 and 1`, 'INVALID_INPUT');
  return value;
}

function requireEnum(value, name, allowed) {
  if (!allowed.has(value)) throw new SubscriptionError(`${name} is invalid`, 'INVALID_INPUT');
  return value;
}

function requireDateTime(value, name) {
  const text = requireText(value, name, 10, 64);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new SubscriptionError(`${name} must be an ISO datetime`, 'INVALID_INPUT');
  return new Date(time).toISOString();
}

function requireUrl(value, name) {
  const text = requireText(value, name, 8, 500);
  let url;
  try { url = new URL(text); } catch { throw new SubscriptionError(`${name} must be a valid URL`, 'INVALID_INPUT'); }
  if (url.protocol !== 'https:') throw new SubscriptionError(`${name} must use HTTPS`, 'INVALID_INPUT');
  return url.toString();
}

export class SubscriptionError extends DomainError {
  constructor(message, code = 'SUBSCRIPTION_ERROR', details) {
    super(message, code, details);
    this.name = 'SubscriptionError';
  }
}

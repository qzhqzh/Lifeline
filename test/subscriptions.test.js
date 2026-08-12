import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';
import { SubscriptionService } from '../src/subscriptions.js';

const NOW = '2026-08-09T05:00:00.000Z';
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

test('subscription store seeds six personal accounts without disturbing existing state', async () => {
  const { file, store } = await fixtureStore({ projects: [{ id: 'project_existing', name: 'Existing' }] });
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();

  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.projects[0].id, 'project_existing');
  assert.equal(state.subscriptionAccounts.length, 6);
  assert.equal(state.subscriptionAccounts.filter((entry) => entry.provider === 'CODEX').length, 2);
  assert.deepEqual(state.subscriptionLatestSnapshots, []);
  assert.equal((await service.getSummary()).lastUpdatedAt, null);
  assert.equal((await service.listAccounts()).items[0].lastUpdatedAt, null);
});

test('latest snapshots are deduplicated and rolled into one hourly point', async () => {
  const { store } = await fixtureStore();
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();
  const connection = await pair(service, 'subscription_cursor');
  const input = snapshot({
    accountId: 'subscription_cursor',
    sourceUrl: 'https://cursor.com/dashboard?tab=usage',
    snapshotHash: 'cursor-snapshot-0001',
    measurements: [usagePool('other_models', 18, 20)]
  });

  const first = await service.submitSnapshot(input, connection.request);
  const duplicate = await service.submitSnapshot(input, connection.request);
  const state = await store.read();

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.subscriptionLatestSnapshots.length, 1);
  assert.equal(state.subscriptionHourlySnapshots.length, 1);
  assert.equal((await service.listAccounts()).items.find((entry) => entry.id === 'subscription_cursor').status, 'LOW');
});

test('history keeps only the last successful point in an hour and prunes older than 90 days', async () => {
  const old = '2026-04-01T00:00:00.000Z';
  const { store } = await fixtureStore({
    subscriptionHourlySnapshots: [{ id: 'old', accountId: 'subscription_cursor', capturedAt: old, hourBucket: old }]
  });
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();
  const state = await store.read();
  assert.equal(state.subscriptionHourlySnapshots.length, 0);
  assert.equal((await service.getHistory('subscription_cursor', '90d')).items.length, 0);
});

test('a stale snapshot preserves its value while deriving STALE', async () => {
  const initialClock = fixedClock(NOW);
  const { store } = await fixtureStore();
  const service = new SubscriptionService({ store, clock: initialClock });
  await service.start();
  const connection = await pair(service, 'subscription_codex_a');
  await service.submitSnapshot(snapshot({
    accountId: 'subscription_codex_a',
    sourceUrl: 'https://chatgpt.com/codex/settings/usage',
    snapshotHash: 'codex-snapshot-0001'
  }), connection.request);

  const later = new SubscriptionService({ store, clock: fixedClock('2026-08-09T05:31:00.000Z') });
  const account = (await later.listAccounts()).items.find((entry) => entry.id === 'subscription_codex_a');
  assert.equal(account.status, 'STALE');
  assert.equal(account.latest.snapshotHash, 'codex-snapshot-0001');
});

test('legacy numeric snapshots remain auditable but are not treated as trusted balance', async () => {
  const { store } = await fixtureStore();
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();
  const connection = await pair(service, 'subscription_codex_a');
  await service.submitSnapshot(snapshot({
    measurements: [{
      key: 'codex_credits', label: '可用 Credits', kind: 'credit_balance', unit: 'credits',
      used: null, limit: null, remaining: 0, remainingRatio: null,
      window: null, resetsAt: null, reliableLimit: false
    }]
  }), connection.request);

  const account = (await service.listAccounts()).items.find((entry) => entry.id === 'subscription_codex_a');
  assert.equal(account.status, 'UNKNOWN');
  assert.equal(account.latest.measurements[0].sourceKind, 'UNVERIFIED');
  assert.equal(account.latest.measurements[0].confidence, 'UNVERIFIED');
  assert.equal(account.latest.measurements[0].displayable, false);
});

export async function fixtureStore(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-subscriptions-'));
  const file = join(directory, 'lifeline.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, ...overrides }), 'utf8');
  const store = new JsonStore(file);
  await store.ready();
  return { directory, file, store };
}

export async function pair(service, accountId) {
  const pairing = await service.createPairingToken({ accountId });
  const paired = await service.pairCollector({ pairingToken: pairing.pairingToken, profileName: `Profile ${accountId}` }, EXTENSION_ORIGIN);
  return {
    ...paired,
    request: { origin: EXTENSION_ORIGIN, authorization: `Bearer ${paired.collectorToken}` }
  };
}

export function snapshot(overrides = {}) {
  return {
    accountId: 'subscription_codex_a',
    capturedAt: NOW,
    reportedStatus: 'AVAILABLE',
    measurements: [{
      key: 'availability', label: '当前页面可访问', kind: 'availability', unit: null,
      used: null, limit: null, remaining: null, remainingRatio: null,
      window: null, resetsAt: null, reliableLimit: false
    }],
    adapterVersion: 'fixture-v1',
    sourceUrl: 'https://chatgpt.com/codex/settings/usage',
    snapshotHash: 'snapshot-hash-0001',
    error: null,
    ...overrides
  };
}

function usagePool(key, used, limit) {
  return {
    key, label: key, kind: 'usage_pool', unit: '$', used, limit,
    remaining: limit - used, remainingRatio: (limit - used) / limit,
    window: 'billing_cycle', resetsAt: null, reliableLimit: true,
    sourceKind: 'SCOPED_DOM', confidence: 'MEDIUM'
  };
}

function fixedClock(value) {
  return class FixedClock extends Date {
    constructor(input) { super(input ?? value); }
  };
}

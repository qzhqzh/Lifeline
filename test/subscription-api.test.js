import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';
import { SubscriptionService } from '../src/subscriptions.js';

const NOW = '2026-08-09T05:00:00.000Z';

test('subscription API contract is exposed by server and OpenAPI', async () => {
  const [server, openapi] = await Promise.all([
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../openapi.json', import.meta.url), 'utf8')
  ]);
  for (const path of [
    '/api/subscriptions/summary', '/api/subscriptions/accounts',
    '/api/subscriptions/pairing-token', '/api/subscriptions/collectors/pair',
    '/api/subscriptions/snapshots'
  ]) {
    assert.match(server, new RegExp(path.replaceAll('/', '\\/')));
    assert.ok(JSON.parse(openapi).paths[path]);
  }
  assert.match(server, /Authorization, Content-Type, Idempotency-Key/);
  assert.doesNotMatch(server, /Access-Control-Allow-Origin', '\*'/);
  assert.match(server, /requireOwnerBrowserMutation\(request\)/);
});

test('collector revocation requires either the paired collector token or an owner-approved call', async () => {
  const { store } = await fixtureStore();
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();
  const connection = await pair(service, 'subscription_codex_a');
  await assert.rejects(
    service.revokeCollector(connection.collectorId, {
      origin: connection.request.origin,
      authorization: `Bearer ${'f'.repeat(64)}`
    }),
    (error) => error.code === 'INVALID_COLLECTOR_TOKEN'
  );
  const revoked = await service.revokeCollector(connection.collectorId, connection.request);
  assert.equal(revoked.status, 'REVOKED');
});

test('collector rejects wrong origins, account mismatch, unknown fields, and stale capture time', async () => {
  const { store } = await fixtureStore();
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();
  const connection = await pair(service, 'subscription_codex_a');

  await assert.rejects(
    service.submitSnapshot(snapshot(), { ...connection.request, origin: 'https://example.com' }),
    (error) => error.code === 'INVALID_EXTENSION_ORIGIN'
  );
  await assert.rejects(
    service.submitSnapshot(snapshot({ accountId: 'subscription_codex_b' }), connection.request),
    (error) => error.code === 'COLLECTOR_ACCOUNT_MISMATCH'
  );
  await assert.rejects(
    service.submitSnapshot({ ...snapshot(), rawHtml: '<body>secret</body>' }, connection.request),
    (error) => error.code === 'UNKNOWN_FIELDS'
  );
  await assert.rejects(
    service.submitSnapshot(snapshot({ measurements: [{
      ...snapshot().measurements[0], sourceKind: 'BROAD_DOM', confidence: 'HIGH'
    }] }), connection.request),
    (error) => error.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    service.submitSnapshot(snapshot({ capturedAt: '2026-08-09T04:00:00.000Z' }), connection.request),
    (error) => error.code === 'CAPTURE_TIME_SKEW'
  );
});

test('adapter errors preserve the previous successful balance', async () => {
  const { store } = await fixtureStore();
  const service = new SubscriptionService({ store, clock: fixedClock(NOW) });
  await service.start();
  const connection = await pair(service, 'subscription_codex_a');
  await service.submitSnapshot(snapshot(), connection.request);
  const result = await service.submitSnapshot(snapshot({
    reportedStatus: 'ERROR',
    snapshotHash: 'snapshot-error-0001',
    error: { code: 'ADAPTER_PARSE_FAILED', message: 'Expected usage markers were not found' }
  }), connection.request);
  const state = await store.read();
  assert.equal(result.preservedPreviousSnapshot, true);
  assert.equal(state.subscriptionLatestSnapshots.length, 1);
  assert.equal(state.subscriptionLatestSnapshots[0].snapshotHash, 'snapshot-hash-0001');
  assert.equal((await service.listAccounts()).items[0].status, 'ERROR');
});

function fixedClock(value) {
  return class FixedClock extends Date { constructor(input) { super(input ?? value); } };
}

async function fixtureStore() {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-subscription-api-'));
  const file = join(directory, 'lifeline.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1 }), 'utf8');
  const store = new JsonStore(file);
  await store.ready();
  return { store };
}

async function pair(service, accountId) {
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const pairing = await service.createPairingToken({ accountId });
  const paired = await service.pairCollector({ pairingToken: pairing.pairingToken, profileName: 'API test' }, origin);
  return {
    collectorId: paired.collectorId,
    request: { origin, authorization: `Bearer ${paired.collectorToken}` }
  };
}

function snapshot(overrides = {}) {
  return {
    accountId: 'subscription_codex_a', capturedAt: NOW, reportedStatus: 'AVAILABLE',
    measurements: [{ key: 'availability', label: 'Available', kind: 'availability', unit: null, used: null, limit: null, remaining: null, remainingRatio: null, window: null, resetsAt: null, reliableLimit: false }],
    adapterVersion: 'fixture-v1', sourceUrl: 'https://chatgpt.com/codex/settings/usage',
    snapshotHash: 'snapshot-hash-0001', error: null, ...overrides
  };
}

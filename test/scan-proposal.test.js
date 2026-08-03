import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockExecutor } from '../src/executor.js';
import { LifelineService } from '../src/service.js';
import { JsonStore, migrateState } from '../src/store.js';

const silentLogger = { error() {} };

test('schema migration adds the durable scan proposal collection without discarding unknown data', () => {
  const migrated = migrateState({ schemaVersion: 3, projects: [], custom: { keep: true } }).state;
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.scanProposals, []);
  assert.deepEqual(migrated.custom, { keep: true });
});

test('scan findings deduplicate before review and only accepted proposals become planned tasks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-scan-proposal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Scanner review gate' });
  const phase = await service.createPhase({ projectId: project.id, title: 'Bug queue', phaseOrder: 1 });
  const finding = {
    projectId: project.id,
    phaseId: phase.id,
    fingerprint: 'eslint:no-floating-promises:src/worker.js:42',
    scanner: 'eslint',
    severity: 'high',
    title: 'Await the worker persistence write',
    objective: 'Prevent the worker from reporting success before the durable write has completed.',
    acceptanceCriteria: ['The worker awaits the persistence promise'],
    testCommands: ['node --test test/scan-proposal.test.js'],
    issue: 'https://github.com/example/lifeline/issues/33'
  };
  const source = { actor: 'scanner-agent', client: 'mcp', source: { kind: 'codex-mcp' } };

  const first = await service.proposeScanFinding(finding, { ...source, idempotencyKey: 'scan:1' });
  const repeated = await service.proposeScanFinding(
    { ...finding, fingerprint: '  ESLINT:NO-FLOATING-PROMISES:SRC/WORKER.JS:42  ' },
    { ...source, idempotencyKey: 'scan:2' }
  );
  assert.equal(first.deduplicated, false);
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.proposal.id, first.proposal.id);
  assert.equal(repeated.proposal.occurrences, 2);
  assert.equal((await service.listScanProposals(project.id, 'PENDING')).length, 1);
  assert.equal((await service.getSchedule(project.id)).taskCount, 0, 'an unreviewed finding must not enter the schedule');

  const scheduleBeforeReview = await service.getSchedule(project.id);
  const accepted = await service.reviewScanProposal(first.proposal.id, {
    decision: 'ACCEPT',
    summary: 'Reproduced and accepted into the next bug-fix window.',
    expectedScheduleVersion: scheduleBeforeReview.scheduleVersion
  }, { actor: 'reviewer', client: 'mcp', idempotencyKey: 'scan-review:1', source: { kind: 'codex-mcp' } });
  assert.equal(accepted.proposal.status, 'ACCEPTED');
  assert.equal(accepted.task.status, 'PLANNED');
  assert.equal(accepted.task.planning.kind, 'bug');
  assert.equal(accepted.task.planning.priority, 'P0');
  assert.equal(accepted.task.issue, finding.issue);
  assert.equal(accepted.task.provenance.origin, 'AI');
  assert.equal((await service.getSchedule(project.id)).taskCount, 1);

  const replay = await service.reviewScanProposal(first.proposal.id, {
    decision: 'ACCEPT',
    summary: 'Idempotent replay.',
    expectedScheduleVersion: 0
  }, { actor: 'reviewer', client: 'mcp', idempotencyKey: 'scan-review:1', source: { kind: 'codex-mcp' } });
  assert.equal(replay.task.id, accepted.task.id);
  assert.equal((await service.getSchedule(project.id)).taskCount, 1);

  const dismissedProposal = await service.proposeScanFinding({
    ...finding,
    fingerprint: 'style:non-actionable:src/worker.js:1',
    title: 'Ignore an informational style note'
  }, { ...source, idempotencyKey: 'scan:3' });
  const dismissed = await service.reviewScanProposal(dismissedProposal.proposal.id, {
    decision: 'DISMISS',
    summary: 'No user or runtime impact.',
    expectedScheduleVersion: (await service.getSchedule(project.id)).scheduleVersion
  }, { actor: 'reviewer', client: 'mcp', idempotencyKey: 'scan-review:2', source: { kind: 'codex-mcp' } });
  assert.equal(dismissed.proposal.status, 'DISMISSED');
  assert.equal(dismissed.task, null);
  assert.equal((await service.getSchedule(project.id)).taskCount, 1);
});

async function createService(file) {
  const service = new LifelineService({
    store: new JsonStore(file),
    executor: new MockExecutor({ delayMs: 0 }),
    localUserId: 'local-owner',
    logger: silentLogger
  });
  await service.start();
  return service;
}

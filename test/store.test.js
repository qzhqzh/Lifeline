import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CURRENT_SCHEMA_VERSION } from '../src/domain.js';
import { JsonStore, migrateState, normalizeLoadedState } from '../src/store.js';

test('current complete state bypasses historical migration on steady reload', () => {
  const current = migrateState({ schemaVersion: 1, custom: { keep: true } }).state;
  const normalized = normalizeLoadedState(current);

  assert.equal(normalized.changed, false);
  assert.strictEqual(normalized.state, current);
  assert.deepEqual(normalized.state.custom, { keep: true });
});

test('old or incomplete state still runs the idempotent migration chain', () => {
  const old = normalizeLoadedState({ schemaVersion: 1, projects: [], custom: { keep: true } });
  assert.equal(old.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(old.state.custom, { keep: true });
  assert.ok(Array.isArray(old.state.agentContacts));
  assert.ok(Array.isArray(old.state.projectAccessGrants));
  assert.ok(Array.isArray(old.state.canvasBindings));
  assert.ok(Array.isArray(old.state.canvasChangeProposals));
  assert.ok(Array.isArray(old.state.testScenarioProposals));
  assert.ok(Array.isArray(old.state.testEvidenceHistory));

  const incompleteCurrent = normalizeLoadedState({
    ...old.state,
    agentContacts: undefined
  });
  assert.ok(Array.isArray(incompleteCurrent.state.agentContacts));
  assert.equal(migrateState(incompleteCurrent.state).changed, false);
});

test('persistence keeps canonical phase and audit history while runtime restores compatibility projections', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-store-projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  await store.ready();
  await store.mutate((state) => {
    state.projects.push({ id: 'project-a', name: 'Project A' });
    state.phases.push({
      id: 'phase-a', projectId: 'project-a', title: 'Delivery', rank: 2048, phaseOrder: 2,
      status: 'ACTIVE', computedStatus: 'PLANNED'
    });
    state.workItems.push({
      id: 'task-a', projectId: 'project-a', phaseId: 'phase-a', status: 'PLANNED',
      planning: { phaseId: 'phase-a', phase: 'Delivery', phaseOrder: 2, taskOrder: 1, kind: 'feature' },
      dispatch: { batch: 'NEXT', rank: 1 },
      decision: { batch: 'NEXT', rank: 1, policyVersion: 'autonomous-board-v1' }
    });
  });

  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.workItems[0].phaseId, 'phase-a');
  assert.equal('phaseId' in persisted.workItems[0].planning, false);
  assert.equal('phase' in persisted.workItems[0].planning, false);
  assert.equal('phaseOrder' in persisted.workItems[0].planning, false);
  assert.equal('dispatch' in persisted.workItems[0], false);
  assert.equal('decision' in persisted.workItems[0], false);
  assert.equal('computedStatus' in persisted.phases[0], false);

  const reloaded = new JsonStore(file);
  const state = await reloaded.read();
  assert.equal(state.workItems[0].planning.phaseId, 'phase-a');
  assert.equal(state.workItems[0].planning.phase, 'Delivery');
  assert.equal(state.workItems[0].planning.phaseOrder, 2);
});

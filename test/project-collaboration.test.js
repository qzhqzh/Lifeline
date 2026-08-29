import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ProjectCollaborationService,
  hasProjectCapability
} from '../src/project-collaboration.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

test('project access grants are scoped, hashed at rest, expirable, and revocable', async (t) => {
  const fixture = await createFixture(t);
  const grant = await fixture.collaboration.createAccessGrant(fixture.project.id, {
    displayName: '客户负责人',
    organizationId: 'org-client',
    role: 'EDITOR',
    expiresAt: '2099-01-01T00:00:00.000Z'
  }, { actor: 'owner' });
  const stored = JSON.parse(await readFile(fixture.file, 'utf8'));

  assert.match(grant.token, /^lfp_/);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(grant.token));
  const identity = await fixture.collaboration.authenticateProjectToken(grant.token, fixture.project.id);
  assert.equal(identity.projectId, fixture.project.id);
  assert.equal(identity.role, 'EDITOR');
  assert.equal(hasProjectCapability(identity, 'canvas:edit'), true);
  assert.equal(hasProjectCapability(identity, 'access:manage'), false);
  assert.equal(hasProjectCapability(identity, 'test-governance:review'), false);
  assert.equal(await fixture.collaboration.authenticateProjectToken(grant.token, 'project_other'), null);

  const manager = await fixture.collaboration.createAccessGrant(fixture.project.id, {
    displayName: '项目负责人', role: 'MANAGER'
  }, { actor: 'owner' });
  const managerIdentity = await fixture.collaboration.authenticateProjectToken(manager.token, fixture.project.id);
  assert.equal(hasProjectCapability(managerIdentity, 'test-governance:review'), true);
  assert.equal(hasProjectCapability(managerIdentity, 'test-governance:verify'), true);

  await fixture.collaboration.revokeAccessGrant(fixture.project.id, grant.id, { reason: '项目交付结束' }, { actor: 'owner' });
  assert.equal(await fixture.collaboration.authenticateProjectToken(grant.token, fixture.project.id), null);
  assert.equal(
    (await fixture.collaboration.listAccessGrants(fixture.project.id)).find((entry) => entry.id === grant.id)?.status,
    'REVOKED'
  );
});

test('canvas bindings remain project-scoped and formal task changes require a reviewed proposal', async (t) => {
  const fixture = await createFixture(t);
  const task = await fixture.lifeline.createWorkItem({
    projectId: fixture.project.id,
    phaseId: fixture.phase.id,
    title: '客户验收流程',
    objective: '让客户能够追踪并验收这一项正式功能。',
    acceptanceCriteria: ['客户面板状态可追踪'],
    testCommands: ['npm test']
  });
  const binding = await fixture.collaboration.createCanvasBinding(fixture.project.id, {
    entityType: 'TASK',
    entityId: task.id,
    boardId: 'lf-board'
  }, { actor: 'editor' });
  const replay = await fixture.collaboration.createCanvasBinding(fixture.project.id, {
    entityType: 'TASK',
    entityId: task.id,
    boardId: 'lf-board'
  }, { actor: 'editor' });
  assert.equal(replay.id, binding.id);

  const proposal = await fixture.collaboration.createCanvasChangeProposal(fixture.project.id, {
    workItemId: task.id,
    targetPhaseId: fixture.phase.id,
    statusId: 'running',
    reason: '客户确认进入排期'
  }, { actor: 'editor' });
  assert.equal((await fixture.lifeline.getWorkItem(task.id)).status, 'PLANNED');
  assert.equal(proposal.status, 'PENDING');

  const moved = await fixture.lifeline.moveWorkItemOnClientBoard(task.id, {
    phaseId: fixture.phase.id,
    statusId: 'running',
    expectedScheduleVersion: proposal.expectedScheduleVersion
  }, {
    actor: 'manager',
    client: 'canvas',
    tool: 'canvas.change.accept',
    idempotencyKey: `canvas-proposal:${proposal.id}`,
    source: { kind: 'canvas-change-proposal', proposalId: proposal.id }
  });
  const reviewed = await fixture.collaboration.reviewCanvasChangeProposal(fixture.project.id, proposal.id, {
    decision: 'ACCEPT',
    reason: '排期已确认',
    result: { workItemId: moved.id, status: moved.status }
  }, { actor: 'manager' });

  assert.equal(moved.status, 'RUNNING');
  assert.equal(reviewed.status, 'ACCEPTED');
  const context = await fixture.collaboration.getCanvasContext(fixture.project.id);
  assert.equal(context.bindings.length, 1);
  assert.equal(context.changeProposals[0].result.workItemId, task.id);
  assert.equal(context.tasks[0].title, task.title);
  assert.equal('objective' in context.tasks[0], false);
});

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-collaboration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = new JsonStore(file);
  const lifeline = new LifelineService({ store });
  const collaboration = new ProjectCollaborationService({ store });
  await lifeline.start();
  await collaboration.start();
  const project = await lifeline.createProject({ name: 'Shared project' });
  const phase = await lifeline.createPhase({ projectId: project.id, title: '交付', phaseOrder: 1 });
  return { directory, file, store, lifeline, collaboration, project, phase };
}

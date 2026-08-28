import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AGENT_REPORTING_STATUS,
  deriveAgentReporting,
  upsertAgentContact
} from '../src/agent-reporting.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

test('reporting health distinguishes missing plans, stale work, overdue review, and completed projects', () => {
  const now = '2026-08-12T12:00:00.000Z';
  const state = reportingFixture();
  upsertAgentContact(state, {
    projectId: 'project-healthy',
    actor: 'agent-a',
    client: 'codex',
    tool: 'lifeline_get_schedule',
    at: '2026-08-12T11:50:00.000Z'
  });
  const result = deriveAgentReporting(state, {
    now,
    boardProjects: [
      { id: 'project-needs-plan', health: 'DORMANT', lastProgressAt: null },
      { id: 'project-healthy', health: 'ON_TRACK', lastProgressAt: '2026-08-12T11:00:00.000Z' },
      { id: 'project-review', health: 'AT_RISK', lastProgressAt: '2026-08-10T08:00:00.000Z' },
      { id: 'project-stale', health: 'STALLED', lastProgressAt: '2026-08-08T08:00:00.000Z' },
      { id: 'project-complete', health: 'COMPLETE', lastProgressAt: '2026-08-11T08:00:00.000Z' }
    ]
  });
  const byId = new Map(result.projects.map((project) => [project.projectId, project]));

  assert.equal(byId.get('project-needs-plan').status, AGENT_REPORTING_STATUS.NEEDS_PLAN);
  assert.ok(byId.get('project-needs-plan').reasonCodes.includes('NO_AGENT_CONTACT'));
  assert.ok(byId.get('project-needs-plan').reasonCodes.includes('NO_ACTIONABLE_PLAN'));
  assert.equal(byId.get('project-healthy').status, AGENT_REPORTING_STATUS.HEALTHY);
  assert.equal(byId.get('project-review').status, AGENT_REPORTING_STATUS.REVIEW_BACKLOG);
  assert.equal(byId.get('project-review').reviewCount, 1);
  assert.equal(byId.get('project-stale').status, AGENT_REPORTING_STATUS.STALE);
  assert.equal(byId.get('project-complete').status, AGENT_REPORTING_STATUS.COMPLETE);
  assert.equal(result.summary.needsPlanCount, 1);
  assert.equal(result.summary.reviewBacklogCount, 1);
  assert.equal(result.summary.staleCount, 1);
});

test('agent contacts coalesce by project and client without creating event noise', () => {
  const state = { agentContacts: [], events: [] };
  upsertAgentContact(state, {
    projectId: 'project-a', actor: 'agent-a', client: 'codex', tool: 'lifeline_get_schedule', at: '2026-08-12T10:00:00.000Z'
  });
  const updated = upsertAgentContact(state, {
    projectId: 'project-a', actor: 'agent-a', client: 'codex', tool: 'lifeline_submit_completion', at: '2026-08-12T11:00:00.000Z'
  });
  assert.equal(state.agentContacts.length, 1);
  assert.equal(updated.contactCount, 2);
  assert.equal(updated.lastTool, 'lifeline_submit_completion');
  assert.equal(updated.lastSeenAt, '2026-08-12T11:00:00.000Z');
  assert.deepEqual(state.events, []);
});

test('one completion atomically creates an idempotent next iteration plan', async (t) => {
  const { service, store } = await createService(t);
  const project = await service.createProject({ name: 'Reporting Project', strategicValue: 8 });
  const initial = await service.syncPlan({
    projectId: project.id,
    planId: 'reporting-initial-v1',
    phase: { title: 'S1 Initial', phaseOrder: 1, goal: 'Ship the first result.' },
    tasks: [taskDraft('Implement first result', 1)]
  }, mutationOptions('plan-initial', 'lifeline_sync_plan'));
  const task = initial.tasks[0];
  const completionInput = {
    outcome: 'COMPLETED',
    resultSummary: 'First result implemented and focused test passed.',
    modelRef: 'gpt-5.6-sol',
    agentId: 'agent-a',
    startedAt: '2026-08-12T10:00:00.000Z',
    completedAt: '2026-08-12T10:05:00.000Z',
    evidence: [{ type: 'TEST', summary: 'Focused test passed', metadata: { passed: true } }],
    nextPlan: {
      planId: 'reporting-next-v1',
      phase: { title: 'S2 Next iteration', phaseOrder: 2, goal: 'Keep useful work ready.' },
      tasks: [taskDraft('Implement evidence-backed follow-up', 1)]
    }
  };
  const options = mutationOptions('complete-once', 'lifeline_submit_completion');
  const first = await service.submitCompletion(task.id, completionInput, options);
  const replay = await service.submitCompletion(task.id, completionInput, options);
  const schedule = await service.getSchedule(project.id);
  const persisted = await store.read();

  assert.equal(first.task.status, 'REVIEW');
  assert.deepEqual(replay.completionRecord.nextPlan, first.completionRecord.nextPlan);
  assert.equal(schedule.phases.length, 2);
  assert.equal(schedule.taskCount, 2);
  assert.equal(persisted.completionRecords.length, 1);
  assert.equal(persisted.workItems.filter((entry) => entry.title === 'Implement evidence-backed follow-up').length, 1);
  assert.equal(first.completionRecord.nextPlan.planId, 'reporting-next-v1');
});

test('invalid or non-completed nextPlan leaves completion and schedule untouched', async (t) => {
  const { service, store } = await createService(t);
  const project = await service.createProject({ name: 'Atomic Reporting Project', strategicValue: 8 });
  const initial = await service.syncPlan({
    projectId: project.id,
    planId: 'atomic-initial-v1',
    phase: { title: 'S1 Initial', phaseOrder: 1 },
    tasks: [taskDraft('Keep original task untouched', 1)]
  }, mutationOptions('atomic-plan', 'lifeline_sync_plan'));
  const task = initial.tasks[0];
  const base = {
    resultSummary: 'This write must roll back.',
    modelRef: 'gpt-5.6-sol',
    startedAt: '2026-08-12T10:00:00.000Z',
    completedAt: '2026-08-12T10:01:00.000Z'
  };

  await assert.rejects(() => service.submitCompletion(task.id, {
    ...base,
    outcome: 'COMPLETED',
    nextPlan: {
      planId: 'invalid-next-v1',
      phase: { title: 'S2 Invalid', phaseOrder: 2 },
      tasks: []
    }
  }, mutationOptions('invalid-next', 'lifeline_submit_completion')), /at least one task/);
  await assert.rejects(() => service.submitCompletion(task.id, {
    ...base,
    outcome: 'FAILED',
    nextPlan: {
      planId: 'failed-next-v1',
      phase: { title: 'S2 Must not exist', phaseOrder: 2 },
      tasks: [taskDraft('Must not be scheduled', 1)]
    }
  }, mutationOptions('failed-next', 'lifeline_submit_completion')), /only allowed for a completed/);

  const persisted = await store.read();
  assert.equal(persisted.workItems.find((entry) => entry.id === task.id).status, 'PLANNED');
  assert.equal(persisted.completionRecords.length, 0);
  assert.equal(persisted.phases.length, 1);
  assert.equal(persisted.workItems.length, 1);
});

function reportingFixture() {
  const projects = [
    ['project-needs-plan', 'Needs Plan'],
    ['project-healthy', 'Healthy'],
    ['project-review', 'Review'],
    ['project-stale', 'Stale'],
    ['project-complete', 'Complete']
  ].map(([id, name], index) => ({
    id, name, status: 'ACTIVE', strategicValue: 10 - index, createdAt: '2026-08-01T00:00:00.000Z'
  }));
  return {
    projects,
    phases: [],
    workItems: [
      taskState('task-healthy', 'project-healthy', 'PLANNED', '2026-08-12T10:00:00.000Z'),
      taskState('task-review', 'project-review', 'REVIEW', '2026-08-10T08:00:00.000Z'),
      taskState('task-stale', 'project-stale', 'PLANNED', '2026-08-08T08:00:00.000Z'),
      taskState('task-complete', 'project-complete', 'VERIFIED', '2026-08-11T08:00:00.000Z')
    ],
    completionRecords: [{
      id: 'completion-review', taskId: 'task-review', completionMethod: 'AGENT_RUN', completedAt: '2026-08-10T08:00:00.000Z'
    }],
    agentContacts: [],
    events: []
  };
}

function taskState(id, projectId, status, at) {
  return {
    id,
    projectId,
    title: id,
    status,
    createdAt: at,
    updatedAt: at,
    source: { kind: 'codex-mcp' }
  };
}

function taskDraft(title, taskOrder) {
  return {
    title,
    objective: `${title} with a verifiable result.`,
    acceptanceCriteria: ['The focused behavior is verified'],
    testCommands: ['node --test test/agent-reporting.test.js'],
    taskOrder,
    kind: 'feature',
    priority: 'P0',
    commitment: 'COMMITTED',
    riskTier: 'medium'
  };
}

function mutationOptions(idempotencyKey, tool) {
  return {
    actor: 'agent-a',
    client: 'codex-test',
    tool,
    idempotencyKey,
    source: {
      reportedSource: { repositoryPath: '/workspace/reporting-project' },
      kind: 'codex-mcp',
      tool
    }
  };
}

async function createService(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-agent-reporting-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'state.json'));
  await store.ready();
  const service = new LifelineService({ store, localUserId: 'local-owner', logger: { error() {} } });
  return { service, store };
}

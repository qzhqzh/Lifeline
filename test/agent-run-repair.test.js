import assert from 'node:assert/strict';
import test from 'node:test';
import { repairAgentRunAutocomplete } from '../scripts/repair-agent-run-autocomplete.mjs';

test('repair removes only synthesized mock output and restores the Agent run', () => {
  const state = {
    workItems: [{ id: 'task', status: 'VERIFIED', currentRunId: 'run', updatedAt: 'before' }],
    runs: [{ id: 'run', workItemId: 'task', kind: 'AGENT', status: 'SUCCEEDED', stage: 4, finishedAt: 'done' }],
    evidence: [
      { id: 'mock', runId: 'run', metadata: { executor: 'mock' } },
      { id: 'other', runId: 'other-run', metadata: { executor: 'mock' } }
    ],
    completionRecords: [],
    events: [
      { id: 'agent-start', sequence: 1, runId: 'run', type: 'run.started', message: 'Agent run started', metadata: { tool: 'lifeline_start_task' } },
      { id: 'mock-step', sequence: 2, runId: 'run', type: 'step.completed', message: 'Mock step', metadata: {} },
      { id: 'global', sequence: 1, runId: null, type: 'project.created', metadata: {} }
    ]
  };

  const first = repairAgentRunAutocomplete(state, 'run', '2026-08-02T19:00:00.000Z');
  assert.equal(first.changed, true);
  assert.equal(state.runs[0].status, 'RUNNING');
  assert.equal(state.runs[0].stage, 0);
  assert.equal(state.workItems[0].status, 'RUNNING');
  assert.deepEqual(state.evidence.map((entry) => entry.id), ['other']);
  assert.equal(state.events.some((entry) => entry.id === 'agent-start'), true);
  assert.equal(state.events.some((entry) => entry.id === 'mock-step'), false);
  assert.equal(state.events.at(-1).type, 'run.autocomplete_repaired');

  const second = repairAgentRunAutocomplete(state, 'run', '2026-08-02T19:01:00.000Z');
  assert.equal(second.changed, false);
});

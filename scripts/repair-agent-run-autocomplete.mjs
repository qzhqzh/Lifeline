import { copyFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createId, nowIso } from '../src/domain.js';
import { JsonStore, migrateState } from '../src/store.js';

export function repairAgentRunAutocomplete(state, runId, at = nowIso()) {
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const task = state.workItems.find((entry) => entry.id === run.workItemId);
  if (!task) throw new Error(`Task not found for Run: ${runId}`);
  const completion = state.completionRecords.find((entry) => entry.runId === runId);
  const mockEvidence = state.evidence.filter((entry) => (
    entry.runId === runId && entry.metadata?.executor === 'mock'
  ));
  const mockEvidenceIds = new Set(mockEvidence.map((entry) => entry.id));
  const mockEvents = state.events.filter((entry) => (
    entry.runId === runId
      && entry.metadata?.tool !== 'lifeline_start_task'
      && (entry.type !== 'run.started' || entry.message !== 'Agent run started')
  ));

  const alreadyRepaired = run.kind === 'AGENT'
    && run.status === 'RUNNING'
    && run.stage === 0
    && !completion
    && mockEvidence.length === 0;
  if (alreadyRepaired) return { changed: false, runId, taskId: task.id };
  if (run.kind !== 'AGENT' || completion || mockEvidence.length === 0) {
    throw new Error('Run is not an unreported Agent run completed by mock evidence; refusing repair');
  }

  const mockEventIds = new Set(mockEvents.map((entry) => entry.id));
  state.evidence = state.evidence.filter((entry) => !mockEvidenceIds.has(entry.id));
  state.events = state.events.filter((entry) => !mockEventIds.has(entry.id));
  Object.assign(run, {
    status: 'RUNNING',
    stage: 0,
    error: null,
    finishedAt: null,
    updatedAt: at
  });
  task.status = 'RUNNING';
  task.currentRunId = run.id;
  task.updatedAt = at;
  state.events.push({
    id: createId('event'),
    sequence: nextGlobalSequence(state),
    type: 'run.autocomplete_repaired',
    message: 'Removed mock executor output incorrectly attached to an Agent run after restart',
    runId: null,
    workItemId: task.id,
    metadata: {
      runId,
      removedEvidenceIds: [...mockEvidenceIds],
      removedEventIds: [...mockEventIds]
    },
    createdAt: at
  });
  return {
    changed: true,
    runId,
    taskId: task.id,
    removedEvidenceIds: [...mockEvidenceIds],
    removedEventIds: [...mockEventIds]
  };
}

function nextGlobalSequence(state) {
  return Math.max(0, ...state.events.filter((event) => !event.runId).map((event) => Number(event.sequence) || 0)) + 1;
}

async function main() {
  const runId = process.env.RUN_ID;
  if (!runId) throw new Error('RUN_ID is required');
  const filePath = process.env.LIFELINE_DATA_FILE ?? '/app/data/lifeline.json';
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const previewState = migrateState(raw).state;
  const preview = repairAgentRunAutocomplete(previewState, runId);
  if (process.env.APPLY_REPAIR !== '1') {
    console.log(JSON.stringify({ mode: 'dry-run', ...preview }, null, 2));
    return;
  }
  if (!preview.changed) {
    console.log(JSON.stringify({ mode: 'apply', ...preview }, null, 2));
    return;
  }

  const suffix = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const backupPath = `${filePath}.pre-agent-run-repair-${suffix}.backup`;
  await copyFile(filePath, backupPath);
  const store = new JsonStore(filePath);
  await store.ready();
  const result = await store.mutate((state) => repairAgentRunAutocomplete(state, runId));
  console.log(JSON.stringify({ mode: 'apply', backupPath, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  RUN_STATUS,
  WORK_ITEM_STATUS,
  hydrateWorkItemMetadata
} from './domain.js';

const EMPTY_STATE = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  projects: [],
  phases: [],
  workItems: [],
  runs: [],
  evidence: [],
  completionRecords: [],
  bootstrapReceipts: [],
  migrationConflicts: [],
  migrationSnapshots: [],
  scanProposals: [],
  events: []
});

const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_RETRY_MS = 20;

export class JsonStore {
  #filePath;
  #state;
  #initialized;
  #lockPath;
  #writeChain = Promise.resolve();

  constructor(filePath) {
    this.#filePath = filePath;
    this.#lockPath = `${filePath}.lock`;
    this.#initialized = this.#load();
  }

  async #load() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await this.#withFileLock(async () => {
      try {
        const migrated = await this.#reloadFromDisk();
        if (migrated.changed) await this.#persist();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        this.#state = structuredClone(EMPTY_STATE);
        await this.#persist();
      }
    });
  }

  async ready() {
    await this.#initialized;
  }

  async read() {
    await this.#initialized;
    await this.#writeChain;
    await this.#reloadFromDisk();
    return structuredClone(this.#state);
  }

  /**
   * Mutations are serialized per store and persisted with an atomic rename.
   * Bootstrap uses this boundary as its JSON-MVP transaction/unique-key
   * primitive; callers must perform uniqueness checks inside the callback.
   */
  async mutate(mutator) {
    await this.#initialized;
    const operation = this.#writeChain.then(() => this.#withFileLock(async () => {
      await this.#reloadFromDisk();
      const result = await mutator(this.#state);
      await this.#persist();
      return structuredClone(result);
    }));
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  async #reloadFromDisk() {
    const text = await readFile(this.#filePath, 'utf8');
    const migrated = migrateState(JSON.parse(text));
    this.#state = migrated.state;
    return migrated;
  }

  async #persist() {
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;
    const body = `${JSON.stringify(this.#state, null, 2)}\n`;
    await writeFile(tempPath, body, 'utf8');
    await rename(tempPath, this.#filePath);
  }

  async #withFileLock(operation) {
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(this.#lockPath);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const lockStat = await stat(this.#lockPath).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > STORE_LOCK_STALE_MS) {
          await rm(this.#lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for JSON store lock: ${this.#lockPath}`);
        }
        await delay(STORE_LOCK_RETRY_MS);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(this.#lockPath, { recursive: true, force: true });
    }
  }
}

/**
 * Idempotent schema/migration harness. It deliberately keeps unknown fields
 * so older or user-owned data is never discarded during a compatibility read.
 */
export function migrateState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const before = JSON.stringify(source);
  const state = {
    ...structuredClone(source),
    schemaVersion: Math.max(Number(source.schemaVersion) || 1, CURRENT_SCHEMA_VERSION),
    projects: Array.isArray(source.projects) ? structuredClone(source.projects) : [],
    phases: Array.isArray(source.phases) ? structuredClone(source.phases) : [],
    workItems: Array.isArray(source.workItems) ? source.workItems.map(hydrateWorkItemMetadata) : [],
    runs: Array.isArray(source.runs) ? structuredClone(source.runs) : [],
    evidence: Array.isArray(source.evidence) ? structuredClone(source.evidence) : [],
    completionRecords: Array.isArray(source.completionRecords) ? structuredClone(source.completionRecords) : [],
    bootstrapReceipts: Array.isArray(source.bootstrapReceipts) ? structuredClone(source.bootstrapReceipts) : [],
    migrationConflicts: Array.isArray(source.migrationConflicts) ? structuredClone(source.migrationConflicts) : [],
    migrationSnapshots: Array.isArray(source.migrationSnapshots) ? structuredClone(source.migrationSnapshots) : [],
    scanProposals: Array.isArray(source.scanProposals) ? structuredClone(source.scanProposals) : [],
    events: Array.isArray(source.events) ? structuredClone(source.events) : []
  };

  normalizePhases(state);
  normalizeRunKinds(state);
  isolateLegacyMockRuns(state);
  repairDetachedActiveTasks(state);
  const after = JSON.stringify(state);
  return { state, changed: before !== after };
}

// Kept as a named export for tests and future repository adapters.
export const normalizeState = (state) => migrateState(state).state;
export const migrateLegacyState = migrateState;

function normalizeRunKinds(state) {
  for (const run of state.runs) {
    if (!run || typeof run !== 'object' || run.kind) continue;
    run.kind = run.executor === 'mock' ? 'INTERNAL_MOCK' : 'AGENT';
  }
}

function isolateLegacyMockRuns(state) {
  const mockRunIds = new Set();
  const changedProjectIds = new Set();
  for (const run of state.runs) {
    if (run?.kind !== 'INTERNAL_MOCK') continue;
    mockRunIds.add(run.id);
    run.legacyMock = true;
    if ([RUN_STATUS.QUEUED, RUN_STATUS.RUNNING].includes(run.status)) {
      run.status = RUN_STATUS.CANCELLED;
      run.error = { code: 'MOCK_EXECUTOR_DISABLED', message: 'Historical Mock Run stopped by schema v5.' };
      run.finishedAt ??= run.updatedAt ?? run.createdAt ?? null;
    }
  }
  if (mockRunIds.size === 0) return;

  for (const evidence of state.evidence) {
    if (!mockRunIds.has(evidence?.runId)) continue;
    evidence.metadata = { ...(evidence.metadata ?? {}), legacyMock: true };
  }

  const runsById = new Map(state.runs.map((run) => [run.id, run]));
  const realVerifiedTaskIds = new Set(state.completionRecords
    .filter((record) => {
      if (!record?.verifiedAt) return false;
      const run = record.runId ? runsById.get(record.runId) : null;
      return !run || run.kind === 'AGENT';
    })
    .map((record) => record.taskId ?? record.workItemId));

  for (const task of state.workItems) {
    const mockRun = mockRunIds.has(task.currentRunId) ? runsById.get(task.currentRunId) : null;
    if (!mockRun) continue;
    const beforeStatus = task.status;
    const beforeRunId = task.currentRunId;
    task.legacyMockRunIds = [...new Set([...(task.legacyMockRunIds ?? []), mockRun.id])];
    task.currentRunId = null;
    if ([WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.RUNNING].includes(task.status)) {
      task.status = WORK_ITEM_STATUS.PLANNED;
    } else if (task.status === WORK_ITEM_STATUS.VERIFIED && !realVerifiedTaskIds.has(task.id)) {
      task.status = WORK_ITEM_STATUS.PLANNED;
    }
    changedProjectIds.add(task.projectId);
    appendMockIsolationEvent(state, task, { beforeStatus, beforeRunId, afterStatus: task.status });
  }

  for (const project of state.projects) {
    const verifiedRecords = state.completionRecords
      .filter((record) => {
        const task = state.workItems.find((entry) => entry.id === (record.taskId ?? record.workItemId));
        if (!task || task.projectId !== project.id || !record.verifiedAt) return false;
        const run = record.runId ? runsById.get(record.runId) : null;
        return !run || run.kind === 'AGENT';
      })
      .sort((left, right) => String(left.verifiedAt).localeCompare(String(right.verifiedAt)));
    const currentTaskId = verifiedRecords.at(-1)?.taskId ?? verifiedRecords.at(-1)?.workItemId ?? null;
    if (project.currentTaskId === currentTaskId) continue;
    project.currentTaskId = currentTaskId;
    changedProjectIds.add(project.id);
  }

  for (const projectId of changedProjectIds) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (project) project.scheduleVersion = Number(project.scheduleVersion ?? 0) + 1;
  }
}

function appendMockIsolationEvent(state, task, metadata) {
  const key = `${task.id}|${metadata.beforeRunId}|${metadata.beforeStatus}|${metadata.afterStatus}`;
  const id = `event_mock_isolation_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  if (state.events.some((event) => event.id === id)) return;
  const sequence = Math.max(0, ...state.events.map((event) => Number(event.sequence) || 0)) + 1;
  state.events.push({
    id,
    sequence,
    type: 'work_item.mock_history_isolated',
    message: 'Historical Mock Run isolated from formal progress',
    runId: metadata.beforeRunId,
    workItemId: task.id,
    metadata: { projectId: task.projectId, ...metadata },
    createdAt: task.updatedAt ?? task.createdAt ?? null
  });
}

function repairDetachedActiveTasks(state) {
  const repairedProjectIds = new Set();
  for (const task of state.workItems) {
    if (![WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.RUNNING].includes(task.status)) continue;
    const activeRuns = state.runs
      .filter((run) => (
        run.workItemId === task.id
          && [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING].includes(run.status)
      ))
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
    if (activeRuns.some((run) => run.id === task.currentRunId)) continue;

    const replacement = activeRuns.at(-1);
    const durableCurrent = state.runs.find((run) => run.id === task.currentRunId && run.workItemId === task.id);
    const completion = state.completionRecords
      .filter((record) => (record.taskId ?? record.workItemId) === task.id)
      .at(-1);
    const beforeStatus = task.status;
    const beforeRunId = task.currentRunId ?? null;
    let reason = 'MISSING_ACTIVE_RUN';
    if (replacement) {
      task.currentRunId = replacement.id;
      reason = 'ATTACHED_ACTIVE_RUN';
    } else if (durableCurrent?.status === RUN_STATUS.SUCCEEDED && completion) {
      task.status = completion.verifiedAt ? WORK_ITEM_STATUS.VERIFIED : WORK_ITEM_STATUS.REVIEW;
      reason = completion.verifiedAt ? 'RESTORED_VERIFIED_COMPLETION' : 'RESTORED_REVIEW_COMPLETION';
    } else if (durableCurrent?.status === RUN_STATUS.FAILED) {
      task.status = WORK_ITEM_STATUS.BLOCKED;
      reason = 'RESTORED_FAILED_RUN';
    } else {
      task.status = WORK_ITEM_STATUS.PLANNED;
      task.currentRunId = null;
    }
    repairedProjectIds.add(task.projectId);
    appendMigrationEvent(state, task, {
      beforeStatus,
      beforeRunId,
      afterStatus: task.status,
      afterRunId: task.currentRunId,
      reason
    });
  }

  for (const projectId of repairedProjectIds) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (project) project.scheduleVersion = Number(project.scheduleVersion ?? 0) + 1;
  }
}

function appendMigrationEvent(state, task, metadata) {
  const key = `${task.id}|${metadata.beforeStatus}|${metadata.beforeRunId ?? ''}|${metadata.afterStatus}|${metadata.afterRunId ?? ''}`;
  const id = `event_migration_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  if (state.events.some((event) => event.id === id)) return;
  const sequence = Math.max(0, ...state.events.map((event) => Number(event.sequence) || 0)) + 1;
  state.events.push({
    id,
    sequence,
    type: 'work_item.active_run_repaired',
    message: 'Active task state reconciled with durable runs',
    runId: task.currentRunId,
    workItemId: task.id,
    metadata: { projectId: task.projectId, ...metadata },
    createdAt: task.updatedAt ?? task.createdAt ?? null
  });
}

function normalizePhases(state) {
  const phasesByKey = new Map();
  for (const phase of state.phases) {
    if (!phase || typeof phase !== 'object') continue;
    const key = phaseKey(phase.projectId, phase.rank ?? phase.phaseOrder, phase.title ?? phase.name);
    if (!key || phasesByKey.has(key)) continue;
    const rawRank = Number(phase.rank ?? phase.phaseOrder ?? 1) || 1;
    const rank = rawRank >= 1024 && rawRank % 1024 === 0 ? rawRank : rawRank * 1024;
    const normalized = {
      id: phase.id || stablePhaseId(key),
      projectId: phase.projectId ?? null,
      title: phase.title ?? phase.name ?? '待排期',
      goal: phase.goal ?? '',
      rank,
      status: phase.status ?? 'ACTIVE',
      createdBy: phase.createdBy ?? null,
      createdAt: phase.createdAt ?? null,
      updatedAt: phase.updatedAt ?? phase.createdAt ?? null
    };
    normalized.phaseOrder = normalized.rank >= 1024 && normalized.rank % 1024 === 0
      ? normalized.rank / 1024
      : normalized.rank;
    Object.assign(phase, normalized);
    phasesByKey.set(key, phase);
  }

  for (const item of state.workItems) {
    if (!item || typeof item !== 'object') continue;
    const planning = item.planning ?? {};
    const existingPhase = item.phaseId || planning.phaseId;
    if (existingPhase) {
      item.phaseId = existingPhase;
      if (!planning.phaseId) planning.phaseId = existingPhase;
      continue;
    }
    const projectId = item.projectId ?? null;
    const phaseOrder = planning.phaseOrder ?? 99;
    const title = planning.phase ?? '待排期';
    const key = phaseKey(projectId, phaseOrder, title);
    if (!key) continue;
    let phase = phasesByKey.get(key);
    if (!phase) {
      phase = {
        id: stablePhaseId(key),
        projectId,
        title,
        goal: '',
        rank: (Number(phaseOrder) || 1) * 1024,
        phaseOrder: Number(phaseOrder) || 1,
        status: 'ACTIVE',
        createdBy: null,
        createdAt: item.createdAt ?? null,
        updatedAt: item.updatedAt ?? item.createdAt ?? null
      };
      state.phases.push(phase);
      phasesByKey.set(key, phase);
    }
    item.phaseId = phase.id;
    planning.phaseId = phase.id;
  }
}

function phaseKey(projectId, rank, title) {
  if (!projectId || title === undefined || title === null) return null;
  const numericRank = Number(rank) || 99;
  const logicalOrder = numericRank >= 1024 && numericRank % 1024 === 0
    ? numericRank / 1024
    : numericRank;
  return `${projectId}|${logicalOrder}|${String(title).trim() || '待排期'}`;
}

function stablePhaseId(key) {
  return `phase_legacy_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import {
  DomainError,
  RUN_STATUS,
  WORK_ITEM_STATUS,
  calculateProjectProgress,
  createId,
  createProject,
  createWorkItem,
  nowIso,
  transitionWorkItem,
  validateReadyContract
} from './domain.js';

export class LifelineService {
  #store;
  #executor;
  #logger;
  #activeRuns = new Set();

  constructor({ store, executor, logger = console }) {
    this.#store = store;
    this.#executor = executor;
    this.#logger = logger;
  }

  async start() {
    await this.#store.ready();
    const state = await this.#store.read();
    const resumable = state.runs.filter((run) => [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING].includes(run.status));
    for (const run of resumable) this.#schedule(run.id);
  }

  async listProjects() {
    const state = await this.#store.read();
    return state.projects;
  }

  async getProject(projectId) {
    const state = await this.#store.read();
    return requireEntity(state.projects, projectId, 'project');
  }

  async createProject(input) {
    const project = createProject(input);
    return this.#store.mutate((state) => {
      state.projects.push(project);
      return project;
    });
  }

  async listWorkItems(projectId = null) {
    const state = await this.#store.read();
    return projectId ? state.workItems.filter((item) => item.projectId === projectId) : state.workItems;
  }

  async getWorkItem(workItemId) {
    const state = await this.#store.read();
    return requireEntity(state.workItems, workItemId, 'work item');
  }

  async createWorkItem(input) {
    const workItem = createWorkItem(input);
    return this.#store.mutate((state) => {
      requireEntity(state.projects, workItem.projectId, 'project');
      state.workItems.push(workItem);
      state.events.push(createAuditEvent({
        type: 'work_item.created',
        message: `Work item created in ${workItem.status}`,
        workItemId: workItem.id,
        metadata: { projectId: workItem.projectId }
      }, nextGlobalSequence(state)));
      return workItem;
    });
  }

  async markReady(workItemId) {
    return this.#store.mutate((state) => {
      const index = findIndexOrThrow(state.workItems, workItemId, 'work item');
      const workItem = state.workItems[index];
      validateReadyContract(workItem);
      state.workItems[index] = transitionWorkItem(workItem, WORK_ITEM_STATUS.READY);
      state.events.push(createAuditEvent({
        type: 'work_item.ready',
        message: 'Execution contract validated; work item is ready',
        workItemId
      }, nextGlobalSequence(state)));
      return state.workItems[index];
    });
  }

  async queueWorkItem(workItemId) {
    const result = await this.#store.mutate((state) => {
      const index = findIndexOrThrow(state.workItems, workItemId, 'work item');
      const workItem = state.workItems[index];

      if ([WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.REVIEW].includes(workItem.status)) {
        return requireEntity(state.runs, workItem.currentRunId, 'run');
      }

      validateReadyContract(workItem);
      const queued = transitionWorkItem(workItem, WORK_ITEM_STATUS.QUEUED);
      const run = {
        id: createId('run'),
        workItemId,
        executor: 'mock',
        status: RUN_STATUS.QUEUED,
        stage: 0,
        attempt: 1,
        error: null,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        updatedAt: nowIso()
      };
      queued.currentRunId = run.id;
      state.workItems[index] = queued;
      state.runs.push(run);
      state.events.push(createRunEvent(state, run, 'run.queued', 'Run queued for the mock executor'));
      return run;
    });

    this.#schedule(result.id);
    return result;
  }

  async getRun(runId) {
    const state = await this.#store.read();
    const run = requireEntity(state.runs, runId, 'run');
    return {
      ...run,
      events: state.events.filter((event) => event.runId === runId),
      evidence: state.evidence.filter((entry) => entry.runId === runId)
    };
  }

  async getRunEvents(runId, afterSequence = 0) {
    const state = await this.#store.read();
    requireEntity(state.runs, runId, 'run');
    return state.events
      .filter((event) => event.runId === runId && event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async dashboard() {
    const state = await this.#store.read();
    const projects = state.projects.map((project) => {
      const workItems = state.workItems.filter((item) => item.projectId === project.id);
      const workItemIds = new Set(workItems.map((item) => item.id));
      const evidence = state.evidence.filter((entry) => workItemIds.has(entry.workItemId));
      const counts = Object.fromEntries(Object.values(WORK_ITEM_STATUS).map((status) => [status, 0]));
      for (const item of workItems) counts[item.status] = (counts[item.status] ?? 0) + 1;
      return {
        ...project,
        verifiedProgress: calculateProjectProgress(workItems, evidence),
        workItemCount: workItems.length,
        statusCounts: counts,
        lastEvidenceAt: latestTimestamp(evidence.map((entry) => entry.createdAt))
      };
    });

    return {
      generatedAt: nowIso(),
      projects,
      activeRuns: state.runs.filter((run) => [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING].includes(run.status)).length,
      totalRuns: state.runs.length,
      evidenceCount: state.evidence.length
    };
  }

  async seedDemo() {
    const existing = await this.listProjects();
    if (existing.length > 0) return { seeded: false, project: existing[0] };
    const project = await this.createProject({
      name: 'Lifeline Demo',
      description: 'First evidence-driven control-plane vertical slice',
      repositoryUrl: 'https://github.com/qzhqzh/Lifeline',
      strategicValue: 10
    });
    const workItem = await this.createWorkItem({
      projectId: project.id,
      title: 'Run the first durable mock workflow',
      objective: 'Validate a work item, persist every workflow checkpoint, produce evidence, and replay the run in the UI.',
      acceptanceCriteria: [
        'The work item reaches VERIFIED through valid state transitions',
        'The run can be replayed from persisted events',
        'Evidence raises project verified progress'
      ],
      testCommands: ['npm test'],
      riskTier: 'low',
      weight: 1,
      resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 }
    });
    return { seeded: true, project, workItem };
  }

  #schedule(runId) {
    if (this.#activeRuns.has(runId)) return;
    queueMicrotask(() => this.#executeRun(runId));
  }

  async #executeRun(runId) {
    if (this.#activeRuns.has(runId)) return;
    this.#activeRuns.add(runId);
    try {
      await this.#markRunning(runId);
      let run = await this.getRun(runId);
      while (run.stage < this.#executor.stepCount) {
        const workItem = await this.getWorkItem(run.workItemId);
        await this.#appendRunEvent(runId, 'step.started', `Starting executor step ${run.stage + 1}`, {
          stage: run.stage
        });
        const result = await this.#executor.executeStep(run.stage, workItem);
        await this.#checkpointStep(runId, result);
        run = await this.getRun(runId);
      }
      await this.#completeRun(runId);
    } catch (error) {
      await this.#failRun(runId, error);
      this.#logger.error?.('Lifeline run failed', { runId, error: error?.message });
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  async #markRunning(runId) {
    await this.#store.mutate((state) => {
      const runIndex = findIndexOrThrow(state.runs, runId, 'run');
      const run = state.runs[runIndex];
      if (run.status === RUN_STATUS.SUCCEEDED || run.status === RUN_STATUS.FAILED) return run;
      run.status = RUN_STATUS.RUNNING;
      run.startedAt ??= nowIso();
      run.updatedAt = nowIso();

      const itemIndex = findIndexOrThrow(state.workItems, run.workItemId, 'work item');
      const workItem = state.workItems[itemIndex];
      if (workItem.status === WORK_ITEM_STATUS.QUEUED) {
        state.workItems[itemIndex] = transitionWorkItem(workItem, WORK_ITEM_STATUS.RUNNING);
      }
      state.events.push(createRunEvent(state, run, 'run.started', 'Run started'));
      return run;
    });
  }

  async #checkpointStep(runId, result) {
    await this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      const evidenceKey = `${runId}:${result.evidence.type}`;
      if (!state.evidence.some((entry) => entry.key === evidenceKey)) {
        state.evidence.push({
          id: createId('evidence'),
          key: evidenceKey,
          runId,
          workItemId: run.workItemId,
          type: result.evidence.type,
          score: result.evidence.score,
          summary: result.evidence.summary,
          metadata: result.evidence.metadata ?? {},
          createdAt: nowIso()
        });
      }
      run.stage += 1;
      run.updatedAt = nowIso();
      state.events.push(createRunEvent(state, run, 'step.completed', result.message, {
        step: result.step,
        stage: run.stage,
        evidenceType: result.evidence.type,
        evidenceScore: result.evidence.score
      }));
      return run;
    });
  }

  async #completeRun(runId) {
    await this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      const itemIndex = findIndexOrThrow(state.workItems, run.workItemId, 'work item');
      let workItem = state.workItems[itemIndex];
      if (workItem.status === WORK_ITEM_STATUS.RUNNING) {
        workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.REVIEW);
      }
      if (workItem.status === WORK_ITEM_STATUS.REVIEW) {
        workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.VERIFIED);
      }
      state.workItems[itemIndex] = workItem;
      run.status = RUN_STATUS.SUCCEEDED;
      run.finishedAt = nowIso();
      run.updatedAt = run.finishedAt;
      state.events.push(createRunEvent(state, run, 'run.succeeded', 'Run completed and work item verified'));
      return run;
    });
  }

  async #failRun(runId, error) {
    await this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      run.status = RUN_STATUS.FAILED;
      run.error = {
        code: error?.code ?? 'EXECUTOR_FAILURE',
        message: error?.message ?? String(error)
      };
      run.finishedAt = nowIso();
      run.updatedAt = run.finishedAt;
      const itemIndex = findIndexOrThrow(state.workItems, run.workItemId, 'work item');
      const workItem = state.workItems[itemIndex];
      if ([WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.REVIEW].includes(workItem.status)) {
        state.workItems[itemIndex] = transitionWorkItem(workItem, WORK_ITEM_STATUS.BLOCKED);
      }
      state.events.push(createRunEvent(state, run, 'run.failed', run.error.message, { error: run.error }));
      return run;
    });
  }

  async #appendRunEvent(runId, type, message, metadata = {}) {
    return this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      const event = createRunEvent(state, run, type, message, metadata);
      state.events.push(event);
      return event;
    });
  }
}

export function isTerminalRunStatus(status) {
  return [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED].includes(status);
}

function requireEntity(collection, id, entityName) {
  const entity = collection.find((entry) => entry.id === id);
  if (!entity) throw new DomainError(`${entityName} not found: ${id}`, 'NOT_FOUND');
  return entity;
}

function findIndexOrThrow(collection, id, entityName) {
  const index = collection.findIndex((entry) => entry.id === id);
  if (index === -1) throw new DomainError(`${entityName} not found: ${id}`, 'NOT_FOUND');
  return index;
}

function createRunEvent(state, run, type, message, metadata = {}) {
  return createAuditEvent({
    type,
    message,
    runId: run.id,
    workItemId: run.workItemId,
    metadata
  }, nextRunSequence(state, run.id));
}

function createAuditEvent(input, sequence) {
  return {
    id: createId('event'),
    sequence,
    type: input.type,
    message: input.message,
    runId: input.runId ?? null,
    workItemId: input.workItemId ?? null,
    metadata: input.metadata ?? {},
    createdAt: nowIso()
  };
}

function nextRunSequence(state, runId) {
  const sequences = state.events.filter((event) => event.runId === runId).map((event) => Number(event.sequence) || 0);
  return (sequences.length === 0 ? 0 : Math.max(...sequences)) + 1;
}

function nextGlobalSequence(state) {
  const sequences = state.events.filter((event) => !event.runId).map((event) => Number(event.sequence) || 0);
  return (sequences.length === 0 ? 0 : Math.max(...sequences)) + 1;
}

function latestTimestamp(values) {
  if (values.length === 0) return null;
  return values.sort().at(-1) ?? null;
}

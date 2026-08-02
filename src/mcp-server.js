import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { MockExecutor } from './executor.js';
import { LifelineService } from './service.js';
import { JsonStore } from './store.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_NAME = 'lifeline';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const LIFELINE_MCP_INSTRUCTIONS = [
  'Before planning work, call lifeline_list_projects and lifeline_get_schedule.',
  'Use each Phase parallelTaskIds as candidate hints; the primary Agent must still check scope and shared files before optionally delegating independent work.',
  'Decompose requested functionality into Project → Phase → Task only; use lifeline_sync_plan with a stable planId and complete objectives, acceptance criteria, and test commands.',
  'Reuse existing phases and tasks when they already cover the work; never create duplicates to make progress look larger.',
  'Repository scanners must call lifeline_propose_scan_finding with a stable fingerprint, then use lifeline_review_scan_proposal before a finding becomes a scheduled Task.',
  'Before editing, reordering, or cancelling tasks, read the current scheduleVersion and pass it as expectedScheduleVersion.',
  'Use dependsOnTaskIds only for hard same-project predecessors and parallelPolicy for execution intent; dependencies must stay acyclic and before the dependent task.',
  'Before executing a tracked task call lifeline_start_task.',
  'After implementation call lifeline_submit_completion with the actual model, timestamps, result, and evidence. This moves the task only to REVIEW.',
  'Call lifeline_verify_task only after deterministic tests, independent review, or explicit human approval. Never claim VERIFIED from an Agent statement alone; a recurring task returns to RECURRING after each verified cycle.'
].join(' ');

const idempotencyKeySchema = z.string().trim().min(1).max(256);
const sourceSchema = z.record(z.string(), z.unknown()).optional();
const outputSchema = z.object({ result: z.record(z.string(), z.unknown()) });
const paginationSchema = {
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional()
};
const taskDraftSchema = z.object({
  title: z.string().trim().min(3).max(180),
  objective: z.string().trim().min(8).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30),
  testCommands: z.array(z.string().trim().min(1).max(500)).max(20),
  issue: z.string().trim().max(1000).nullable().optional(),
  starred: z.boolean().default(false),
  scheduledFor: z.string().date().nullable().optional(),
  dependsOnTaskIds: z.array(z.string().trim().min(3).max(160)).max(100).default([]),
  parallelPolicy: z.enum(['AUTO', 'SEQUENTIAL', 'PARALLEL_ALLOWED']).default('AUTO'),
  nonGoals: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  kind: z.enum(['feature', 'bug', 'scan', 'research', 'ops', 'review']).default('feature'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  commitment: z.enum(['COMMITTED', 'TENTATIVE']).default('TENTATIVE'),
  taskOrder: z.number().int().min(1).max(999),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  weight: z.number().positive().max(100).default(1)
});
const taskUpdateSchema = z.object({
  title: z.string().trim().min(3).max(180).optional(),
  objective: z.string().trim().min(8).max(4000).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30).optional(),
  testCommands: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  issue: z.string().trim().max(1000).nullable().optional(),
  starred: z.boolean().optional(),
  scheduledFor: z.string().date().nullable().optional(),
  dependsOnTaskIds: z.array(z.string().trim().min(3).max(160)).max(100).optional(),
  parallelPolicy: z.enum(['AUTO', 'SEQUENTIAL', 'PARALLEL_ALLOWED']).optional(),
  nonGoals: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  kind: z.enum(['feature', 'bug', 'scan', 'research', 'ops', 'review']).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  commitment: z.enum(['COMMITTED', 'TENTATIVE']).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  weight: z.number().positive().max(100).optional()
});
const scanProposalDraftSchema = z.object({
  title: z.string().trim().min(3).max(180),
  objective: z.string().trim().min(8).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  testCommands: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  nonGoals: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  issue: z.string().trim().max(1000).nullable().optional(),
  starred: z.boolean().default(false),
  scheduledFor: z.string().date().nullable().optional(),
  dependsOnTaskIds: z.array(z.string().trim().min(3).max(160)).max(100).default([]),
  parallelPolicy: z.enum(['AUTO', 'SEQUENTIAL', 'PARALLEL_ALLOWED']).default('AUTO'),
  fingerprint: z.string().trim().min(1).max(512),
  scanner: z.string().trim().min(1).max(160).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  weight: z.number().positive().max(100).default(1)
});

export function createLifelineMcpServer({ service, actor = 'local-owner', clientName = 'codex' }) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: LIFELINE_MCP_INSTRUCTIONS,
      cacheHints: {
        'tools/list': { ttlMs: 5_000, cacheScope: 'private' },
        'resources/list': { ttlMs: 5_000, cacheScope: 'private' },
        'resources/templates/list': { ttlMs: 5_000, cacheScope: 'private' },
        'resources/read': { ttlMs: 1_000, cacheScope: 'private' },
        'server/discover': { ttlMs: 5_000, cacheScope: 'private' }
      }
    }
  );

  registerResources(server, service);
  registerReadTools(server, service);
  registerWriteTools(server, service, { actor, clientName });
  return server;
}

function registerResources(server, service) {
  server.registerResource(
    'portfolio',
    'lifeline://portfolio',
    {
      title: 'Lifeline Portfolio',
      description: 'Active projects, verified progress, and bootstrap capability.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 1_000, cacheScope: 'private' }
    },
    async (uri) => resourceResult(uri, await service.dashboard())
  );

  server.registerResource(
    'project',
    new ResourceTemplate('lifeline://projects/{projectId}', {
      list: async () => ({
        resources: (await service.listProjects()).map((project) => ({
          uri: `lifeline://projects/${encodeURIComponent(project.id)}`,
          name: project.name,
          title: project.headline ?? project.name,
          description: project.description,
          mimeType: 'application/json'
        }))
      })
    }),
    {
      title: 'Lifeline Project',
      description: 'One project and its product metadata.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 1_000, cacheScope: 'private' }
    },
    async (uri, variables) => resourceResult(uri, await service.getProject(singleVariable(variables.projectId)))
  );

  server.registerResource(
    'schedule',
    new ResourceTemplate('lifeline://projects/{projectId}/schedule', { list: undefined }),
    {
      title: 'Project Schedule',
      description: 'Phase → Task schedule, recommendations, runs, and latest completion state.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 1_000, cacheScope: 'private' }
    },
    async (uri, variables) => resourceResult(uri, await service.getSchedule(singleVariable(variables.projectId)))
  );

  server.registerResource(
    'task',
    new ResourceTemplate('lifeline://tasks/{taskId}', { list: undefined }),
    {
      title: 'Lifeline Task',
      description: 'Task execution contract, Run, Evidence, CompletionRecord, and audit events.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 1_000, cacheScope: 'private' }
    },
    async (uri, variables) => resourceResult(uri, await service.getTaskDetails(singleVariable(variables.taskId)))
  );

  server.registerResource(
    'run',
    new ResourceTemplate('lifeline://runs/{runId}', { list: undefined }),
    {
      title: 'Lifeline Run',
      description: 'One execution run with events and evidence.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 500, cacheScope: 'private' }
    },
    async (uri, variables) => resourceResult(uri, await service.getRun(singleVariable(variables.runId)))
  );
}

function registerReadTools(server, service) {
  server.registerTool(
    'lifeline_list_projects',
    {
      title: 'List Lifeline projects',
      description: 'Read active project summaries before choosing where a plan belongs.',
      inputSchema: z.object(paginationSchema),
      outputSchema,
      annotations: readOnlyAnnotations()
    },
    async (input) => {
      const projects = (await service.listProjects()).map((project) => ({
        id: project.id,
        name: project.name,
        headline: project.headline ?? null,
        description: project.description,
        repositoryUrl: project.repositoryUrl,
        strategicValue: project.strategicValue,
        scheduleVersion: Number(project.scheduleVersion ?? 0),
        updatedAt: project.updatedAt
      }));
      return toolResult(paginate(projects, input));
    }
  );

  server.registerTool(
    'lifeline_get_schedule',
    {
      title: 'Get a project schedule',
      description: 'Read ordered Phase → Task data before decomposing or updating work.',
      inputSchema: z.object({
        projectId: z.string().trim().min(3).max(160),
        status: z.string().trim().min(1).max(80).optional(),
        kind: z.enum(['feature', 'bug', 'scan', 'research', 'ops', 'review']).optional(),
        ...paginationSchema
      }),
      outputSchema,
      annotations: readOnlyAnnotations()
    },
    async (input) => toolResult(filterSchedule(await service.getSchedule(input.projectId), input))
  );

  server.registerTool(
    'lifeline_get_task',
    {
      title: 'Get a Lifeline task',
      description: 'Read a task contract, current Run, completion records, evidence, and audit history.',
      inputSchema: z.object({ taskId: z.string().trim().min(3).max(160) }),
      outputSchema,
      annotations: readOnlyAnnotations()
    },
    async ({ taskId }) => toolResult(await service.getTaskDetails(taskId))
  );
}

function registerWriteTools(server, service, identity) {
  server.registerTool(
    'lifeline_create_project',
    {
      title: 'Create a Lifeline project',
      description: 'Create one product project through the same Application Service used by the Web UI.',
      inputSchema: z.object({
        name: z.string().trim().min(2).max(120),
        headline: z.string().trim().min(2).max(300).optional(),
        description: z.string().trim().max(2000).default(''),
        repositoryUrl: z.string().trim().url().max(500).optional(),
        strategicValue: z.number().int().min(1).max(10).default(5),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.createProject(input, mutationOptions(identity, 'lifeline_create_project', input)))
  );

  server.registerTool(
    'lifeline_create_phase',
    {
      title: 'Create a project phase',
      description: 'Create an ordered Phase in one project. Phase is the only grouping level above Task.',
      inputSchema: z.object({
        projectId: z.string().trim().min(3).max(160),
        title: z.string().trim().min(1).max(180),
        goal: z.string().trim().max(2000).default(''),
        phaseOrder: z.number().int().min(1).max(999).optional(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.createPhase(input, mutationOptions(identity, 'lifeline_create_phase', input)))
  );

  server.registerTool(
    'lifeline_update_phase',
    {
      title: 'Update a project phase',
      description: 'Update one Phase title or goal using the current schedule version; Task grouping remains two levels.',
      inputSchema: z.object({
        phaseId: z.string().trim().min(3).max(160),
        title: z.string().trim().min(1).max(180).optional(),
        goal: z.string().trim().max(2000).optional(),
        expectedScheduleVersion: z.number().int().min(0),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.updatePhase(
      input.phaseId,
      input,
      mutationOptions(identity, 'lifeline_update_phase', input)
    ))
  );

  server.registerTool(
    'lifeline_create_task',
    {
      title: 'Create a planned task',
      description: 'Add one executable Task to an existing Phase with acceptance criteria and verification commands.',
      inputSchema: taskDraftSchema.extend({
        projectId: z.string().trim().min(3).max(160),
        phaseId: z.string().trim().min(3).max(160),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await createTaskFromMcp(service, input, mutationOptions(identity, 'lifeline_create_task', input)))
  );

  server.registerTool(
    'lifeline_list_scan_proposals',
    {
      title: 'List scan proposals',
      description: 'Query fingerprinted repository findings before they become scheduled Tasks.',
      inputSchema: z.object({
        projectId: z.string().trim().min(3).max(160),
        status: z.enum(['PENDING', 'ACCEPTED', 'DISMISSED']).optional(),
        ...paginationSchema
      }),
      outputSchema,
      annotations: readOnlyAnnotations()
    },
    async (input) => toolResult(paginate(await service.listScanProposals(input.projectId, input.status), input))
  );

  server.registerTool(
    'lifeline_propose_scan_finding',
    {
      title: 'Propose a repository scan finding',
      description: 'Store a stable-fingerprint scan proposal without adding it to the active schedule. Repeated fingerprints are deduplicated and counted.',
      inputSchema: scanProposalDraftSchema.extend({
        projectId: z.string().trim().min(3).max(160),
        phaseId: z.string().trim().min(3).max(160),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.proposeScanFinding(
      input,
      mutationOptions(identity, 'lifeline_propose_scan_finding', input)
    ))
  );

  server.registerTool(
    'lifeline_review_scan_proposal',
    {
      title: 'Review a repository scan proposal',
      description: 'Accept one PENDING proposal into the selected Phase as a PLANNED bug Task, or dismiss it with an audit reason.',
      inputSchema: z.object({
        proposalId: z.string().trim().min(3).max(160),
        decision: z.enum(['ACCEPT', 'DISMISS']),
        summary: z.string().trim().min(1).max(2000),
        expectedScheduleVersion: z.number().int().nonnegative(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.reviewScanProposal(
      input.proposalId,
      input,
      mutationOptions(identity, 'lifeline_review_scan_proposal', input)
    ))
  );

  server.registerTool(
    'lifeline_update_task',
    {
      title: 'Update a planned task',
      description: 'Edit an unfinished task contract or move it to another Phase using optimistic schedule version checks.',
      inputSchema: taskUpdateSchema.extend({
        taskId: z.string().trim().min(3).max(160),
        phaseId: z.string().trim().min(3).max(160).optional(),
        expectedScheduleVersion: z.number().int().nonnegative(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.updateWorkItem(
      input.taskId,
      mcpTaskUpdateInput(input),
      mutationOptions(identity, 'lifeline_update_task', input)
    ))
  );

  server.registerTool(
    'lifeline_reorder_tasks',
    {
      title: 'Reorder tasks in one phase',
      description: 'Replace the order of all movable tasks in one Phase. Running and historical tasks remain locked.',
      inputSchema: z.object({
        projectId: z.string().trim().min(3).max(160),
        phaseId: z.string().trim().min(3).max(160),
        orderedTaskIds: z.array(z.string().trim().min(3).max(160)).max(1000),
        expectedScheduleVersion: z.number().int().nonnegative(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.reorderPhaseTasks(
      input.projectId,
      input,
      mutationOptions(identity, 'lifeline_reorder_tasks', input)
    ))
  );

  server.registerTool(
    'lifeline_cancel_task',
    {
      title: 'Remove a task from the active schedule',
      description: 'Cancel an unstarted task with a reason while preserving its audit history. Running and terminal tasks are protected.',
      inputSchema: z.object({
        taskId: z.string().trim().min(3).max(160),
        reason: z.string().trim().min(1).max(1000),
        expectedScheduleVersion: z.number().int().nonnegative(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true, true)
    },
    async (input) => toolResult(await service.cancelWorkItem(
      input.taskId,
      input,
      mutationOptions(identity, 'lifeline_cancel_task', input)
    ))
  );

  server.registerTool(
    'lifeline_sync_plan',
    {
      title: 'Sync a decomposed plan',
      description: 'After decomposition, idempotently write one Phase and its ordered Tasks. Repeating the same planId resumes without duplicates.',
      inputSchema: z.object({
        projectId: z.string().trim().min(3).max(160),
        planId: idempotencyKeySchema,
        phase: z.union([
          z.object({ phaseId: z.string().trim().min(3).max(160) }),
          z.object({
            title: z.string().trim().min(1).max(180),
            goal: z.string().trim().max(2000).default(''),
            phaseOrder: z.number().int().min(1).max(999).optional()
          })
        ]),
        tasks: z.array(taskDraftSchema).min(1).max(50),
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => {
      const source = { ...(input.source ?? {}), kind: 'codex-plan', planId: input.planId };
      const phase = 'phaseId' in input.phase
        ? (await service.listPhases(input.projectId)).find((entry) => entry.id === input.phase.phaseId)
        : await service.createPhase(
          { projectId: input.projectId, ...input.phase, source },
          mutationOptions(identity, 'lifeline_sync_plan', {
            idempotencyKey: `${input.planId}:phase`,
            source
          })
        );
      if (!phase) throw new Error(`Phase not found in project: ${input.phase.phaseId}`);

      const tasks = [];
      for (const task of input.tasks) {
        const taskKey = `${input.planId}:task:${shortHash(`${task.taskOrder}:${task.title}`)}`;
        tasks.push(await createTaskFromMcp(
          service,
          { ...task, projectId: input.projectId, phaseId: phase.id, idempotencyKey: taskKey, source },
          mutationOptions(identity, 'lifeline_sync_plan', { idempotencyKey: taskKey, source })
        ));
      }
      return toolResult({ projectId: input.projectId, phase, tasks, createdOrReused: tasks.length });
    }
  );

  server.registerTool(
    'lifeline_start_task',
    {
      title: 'Start an Agent task',
      description: 'Create a durable Agent Run and move a ready or recurring execution contract into RUNNING.',
      inputSchema: z.object({
        taskId: z.string().trim().min(3).max(160),
        agentId: z.string().trim().min(1).max(160).optional(),
        executor: z.string().trim().min(1).max(160).default('codex'),
        provider: z.string().trim().min(1).max(160).optional(),
        modelRef: z.string().trim().min(1).max(240),
        modelSnapshot: z.record(z.string(), z.unknown()).optional(),
        reasoningEffort: z.string().trim().min(1).max(80).optional(),
        startedAt: z.string().datetime().optional(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.startTask(
      input.taskId,
      input,
      mutationOptions(identity, 'lifeline_start_task', input)
    ))
  );

  server.registerTool(
    'lifeline_submit_completion',
    {
      title: 'Submit Agent completion',
      description: 'Attach actual model/time/artifact/test evidence and move RUNNING → REVIEW. This never verifies the task.',
      inputSchema: z.object({
        taskId: z.string().trim().min(3).max(160),
        runId: z.string().trim().min(3).max(160).optional(),
        resultSummary: z.string().trim().min(1).max(4000),
        evidence: z.array(z.object({
          type: z.string().trim().min(1).max(80),
          summary: z.string().trim().min(1).max(2000),
          metadata: z.record(z.string(), z.unknown()).optional()
        })).min(1).max(50),
        agentId: z.string().trim().min(1).max(160).optional(),
        executor: z.string().trim().min(1).max(160).optional(),
        provider: z.string().trim().min(1).max(160).optional(),
        modelRef: z.string().trim().min(1).max(240).optional(),
        modelSnapshot: z.record(z.string(), z.unknown()).optional(),
        reasoningEffort: z.string().trim().min(1).max(80).optional(),
        promptVersion: z.string().trim().min(1).max(160).optional(),
        policyVersion: z.string().trim().min(1).max(160).optional(),
        startedAt: z.string().datetime().optional(),
        completedAt: z.string().datetime().optional(),
        durationMs: z.number().nonnegative().optional(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        cost: z.number().nonnegative().optional(),
        commitSha: z.string().trim().min(1).max(200).optional(),
        prUrl: z.string().trim().url().max(1000).optional(),
        artifactUris: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.submitCompletion(
      input.taskId,
      input,
      mutationOptions(identity, 'lifeline_submit_completion', input)
    ))
  );

  server.registerTool(
    'lifeline_verify_task',
    {
      title: 'Verify a reviewed task',
      description: 'Verify REVIEW with deterministic tests, independent review, or explicit human approval; recurring tasks return to RECURRING, others move to VERIFIED.',
      inputSchema: z.object({
        taskId: z.string().trim().min(3).max(160),
        completionRecordId: z.string().trim().min(3).max(160).optional(),
        verificationMethod: z.enum(['DETERMINISTIC_TEST', 'INDEPENDENT_REVIEW', 'HUMAN_APPROVAL']),
        summary: z.string().trim().min(1).max(2000),
        evidenceIds: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
        idempotencyKey: idempotencyKeySchema,
        source: sourceSchema
      }),
      outputSchema,
      annotations: writeAnnotations(true)
    },
    async (input) => toolResult(await service.verifyTask(
      input.taskId,
      input,
      mutationOptions(identity, 'lifeline_verify_task', input)
    ))
  );
}

async function createTaskFromMcp(service, input, options) {
  return service.createWorkItem({
    projectId: input.projectId,
    title: input.title,
    objective: input.objective,
    nonGoals: input.nonGoals ?? [],
    acceptanceCriteria: input.acceptanceCriteria,
    testCommands: input.testCommands,
    issue: input.issue,
    starred: input.starred,
    scheduledFor: input.scheduledFor,
    dependsOnTaskIds: input.dependsOnTaskIds,
    parallelPolicy: input.parallelPolicy,
    riskTier: input.riskTier,
    weight: input.weight,
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 5 },
    planning: {
      phaseId: input.phaseId,
      taskOrder: input.taskOrder,
      kind: input.kind,
      priority: input.priority,
      commitment: input.commitment
    },
    source: input.source
  }, options);
}

function mcpTaskUpdateInput(input) {
  const planningFields = ['kind', 'priority', 'commitment'];
  const planning = Object.fromEntries(planningFields
    .filter((field) => input[field] !== undefined)
    .map((field) => [field, input[field]]));
  return {
    expectedScheduleVersion: input.expectedScheduleVersion,
    phaseId: input.phaseId,
    title: input.title,
    objective: input.objective,
    nonGoals: input.nonGoals,
    acceptanceCriteria: input.acceptanceCriteria,
    testCommands: input.testCommands,
    issue: input.issue,
    starred: input.starred,
    scheduledFor: input.scheduledFor,
    dependsOnTaskIds: input.dependsOnTaskIds,
    parallelPolicy: input.parallelPolicy,
    riskTier: input.riskTier,
    weight: input.weight,
    ...(Object.keys(planning).length > 0 ? { planning } : {}),
    source: input.source
  };
}

function mutationOptions(identity, tool, input) {
  const reportedSource = input.source;
  return {
    actor: identity.actor,
    client: identity.clientName,
    tool,
    idempotencyKey: input.idempotencyKey,
    source: {
      ...(reportedSource ? { reportedSource } : {}),
      kind: tool === 'lifeline_sync_plan' ? 'codex-plan' : 'codex-mcp',
      tool
    }
  };
}

function toolResult(result) {
  const payload = { result };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function resourceResult(uri, value) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(value, null, 2)
    }]
  };
}

function paginate(items, { cursor, limit = DEFAULT_PAGE_SIZE }) {
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    total: items.length,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null
  };
}

function filterSchedule(schedule, input) {
  const flattened = schedule.phases.flatMap((phase) => phase.tasks.map((task) => ({ phase, task })))
    .filter(({ task }) => !input.status || task.status === input.status)
    .filter(({ task }) => !input.kind || task.planning?.kind === input.kind);
  const page = paginate(flattened, input);
  const phases = [];
  for (const { phase, task } of page.items) {
    let target = phases.find((entry) => entry.id === phase.id);
    if (!target) {
      target = { ...phase, tasks: [] };
      phases.push(target);
    }
    target.tasks.push(task);
  }
  return {
    project: schedule.project,
    scheduleVersion: schedule.scheduleVersion,
    phases,
    totalTasks: page.total,
    nextCursor: page.nextCursor,
    lastModified: schedule.lastModified
  };
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(value.offset) || value.offset < 0) throw new Error('invalid offset');
    return value.offset;
  } catch {
    throw new Error('cursor is invalid or expired');
  }
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function singleVariable(value) {
  return Array.isArray(value) ? value[0] : value;
}

function readOnlyAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function writeAnnotations(idempotentHint, destructiveHint = false) {
  return { readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: false };
}

async function main() {
  const dataFile = process.env.LIFELINE_DATA_FILE ?? resolve(ROOT, 'data', 'lifeline.json');
  const actor = process.env.LIFELINE_LOCAL_USER_ID ?? 'local-owner';
  const clientName = process.env.LIFELINE_MCP_CLIENT_NAME ?? 'codex';
  const store = new JsonStore(dataFile);
  await store.ready();
  const service = new LifelineService({
    store,
    executor: new MockExecutor({ delayMs: 0 }),
    localUserId: actor,
    logger: { error: (...args) => console.error(...args) }
  });
  const handle = serveStdio(
    () => createLifelineMcpServer({ service, actor, clientName }),
    { onerror: (error) => console.error('Lifeline MCP error', error) }
  );
  console.error(`Lifeline MCP ready on stdio · data=${dataFile}`);
  process.on('SIGINT', async () => {
    await handle.close();
    process.exit(0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Lifeline MCP failed to start', error);
    process.exit(1);
  });
}

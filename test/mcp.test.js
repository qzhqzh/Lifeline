import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MockExecutor } from '../src/executor.js';
import { createLifelineMcpServer } from '../src/mcp-server.js';
import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';

const silentLogger = { error() {} };

test('MCP syncs a plan idempotently and enforces completion verification', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const service = await createService(file);
  const server = createLifelineMcpServer({ service, actor: 'codex-test', clientName: 'node-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lifeline-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'lifeline_cancel_task',
    'lifeline_create_phase',
    'lifeline_create_project',
    'lifeline_create_task',
    'lifeline_get_schedule',
    'lifeline_get_task',
    'lifeline_list_projects',
    'lifeline_list_scan_proposals',
    'lifeline_propose_scan_finding',
    'lifeline_reorder_tasks',
    'lifeline_review_scan_proposal',
    'lifeline_start_task',
    'lifeline_submit_completion',
    'lifeline_sync_plan',
    'lifeline_update_phase',
    'lifeline_update_task',
    'lifeline_verify_task'
  ]);
  const verifyTool = listed.tools.find((tool) => tool.name === 'lifeline_verify_task');
  assert.deepEqual(verifyTool.inputSchema.properties.verificationMethod.enum, [
    'DETERMINISTIC_TEST',
    'INDEPENDENT_REVIEW',
    'HUMAN_APPROVAL'
  ]);

  const projectResult = await callTool(client, 'lifeline_create_project', {
    name: 'MCP Test Project',
    headline: 'Turn Agent work into visible momentum',
    description: 'Exercises the real MCP scheduling contract.',
    strategicValue: 9,
    idempotencyKey: 'mcp-test-project'
  });
  const project = projectResult.project ?? projectResult;
  const planInput = {
    projectId: project.id,
    planId: 'goal:mcp-test:v1',
    phase: {
      title: 'Open Agent workflow',
      goal: 'Make planning and verified completion visible in the portfolio board.',
      phaseOrder: 1
    },
    tasks: [
      {
        title: 'Create the MCP planning adapter',
        objective: 'Expose an idempotent Project to Phase to Task planning workflow.',
        acceptanceCriteria: ['Repeating one plan produces no duplicate tasks'],
        testCommands: ['node --test test/mcp.test.js'],
        taskOrder: 1,
        priority: 'P0',
        commitment: 'COMMITTED',
        riskTier: 'medium'
      },
      {
        title: 'Persist verified Agent completion',
        objective: 'Record the model, elapsed time, evidence, review, and verification state.',
        issue: 'https://github.com/example/lifeline/issues/12',
        starred: true,
        scheduledFor: '2026-08-03',
        acceptanceCriteria: ['Agent completion stops at REVIEW until evidence is verified'],
        testCommands: ['node --test test/mcp.test.js'],
        taskOrder: 2,
        priority: 'P0',
        commitment: 'COMMITTED',
        riskTier: 'high'
      }
    ]
  };

  const firstPlan = await callTool(client, 'lifeline_sync_plan', planInput);
  const secondPlan = await callTool(client, 'lifeline_sync_plan', planInput);
  assert.deepEqual(secondPlan.tasks.map((task) => task.id), firstPlan.tasks.map((task) => task.id));

  const scheduleBefore = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  assert.equal(scheduleBefore.totalTasks, 2);
  assert.equal(scheduleBefore.phases.length, 1);
  assert.deepEqual(scheduleBefore.phases[0].parallelTaskIds, firstPlan.tasks.map((task) => task.id));

  const updatedPhase = await callTool(client, 'lifeline_update_phase', {
    phaseId: firstPlan.phase.id,
    title: 'Open Agent workflow, clarified',
    goal: 'Keep the Phase title and goal editable without adding another hierarchy level.',
    expectedScheduleVersion: scheduleBefore.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:update-phase:1'
  });
  assert.equal(updatedPhase.title, 'Open Agent workflow, clarified');
  const scheduleAfterPhaseUpdate = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  assert.equal(scheduleAfterPhaseUpdate.phases[0].goal, 'Keep the Phase title and goal editable without adding another hierarchy level.');
  assert.ok(scheduleAfterPhaseUpdate.phases[0].tasks.every((task) => task.planning.phase === updatedPhase.title));

  const updatedTask = await callTool(client, 'lifeline_update_task', {
    taskId: firstPlan.tasks[1].id,
    title: 'Persist auditable Agent completion',
    expectedScheduleVersion: scheduleAfterPhaseUpdate.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:update:1'
  });
  assert.equal(updatedTask.title, 'Persist auditable Agent completion');
  assert.equal(updatedTask.issue, 'https://github.com/example/lifeline/issues/12');
  assert.equal(updatedTask.starred, true);
  assert.equal(updatedTask.scheduledFor, '2026-08-03');
  assert.equal(updatedTask.planning.priority, 'P0');
  assert.equal(updatedTask.planning.commitment, 'COMMITTED');
  assert.equal(updatedTask.riskTier, 'high');

  const scheduleBeforeIssueClear = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  const clearedIssueTask = await callTool(client, 'lifeline_update_task', {
    taskId: firstPlan.tasks[1].id,
    issue: null,
    expectedScheduleVersion: scheduleBeforeIssueClear.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:update:clear-issue:1'
  });
  assert.equal(clearedIssueTask.issue, null);

  const scheduleAfterUpdate = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  const reordered = await callTool(client, 'lifeline_reorder_tasks', {
    projectId: project.id,
    phaseId: firstPlan.phase.id,
    orderedTaskIds: [firstPlan.tasks[1].id, firstPlan.tasks[0].id],
    expectedScheduleVersion: scheduleAfterUpdate.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:reorder:1'
  });
  assert.deepEqual(reordered.phases[0].tasks.map((entry) => entry.id), [firstPlan.tasks[1].id, firstPlan.tasks[0].id]);

  const removable = await callTool(client, 'lifeline_create_task', {
    projectId: project.id,
    phaseId: firstPlan.phase.id,
    title: 'Temporary planning branch',
    objective: 'Prove that removing a task preserves an auditable cancelled record.',
    acceptanceCriteria: ['Cancelled tasks disappear from the active schedule'],
    testCommands: ['node --test test/mcp.test.js'],
    taskOrder: 3,
    dependsOnTaskIds: [firstPlan.tasks[1].id],
    parallelPolicy: 'PARALLEL_ALLOWED',
    idempotencyKey: 'goal:mcp-test:create:temporary'
  });
  assert.deepEqual(removable.dependsOnTaskIds, [firstPlan.tasks[1].id]);
  assert.equal(removable.parallelPolicy, 'PARALLEL_ALLOWED');
  const scheduleWithTemporary = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  const cancelled = await callTool(client, 'lifeline_cancel_task', {
    taskId: removable.id,
    reason: 'No longer part of the accepted plan.',
    expectedScheduleVersion: scheduleWithTemporary.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:cancel:temporary'
  });
  assert.equal(cancelled.status, 'CANCELLED');
  const scheduleAfterCancel = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  const linkedCancelled = await callTool(client, 'lifeline_update_task', {
    taskId: cancelled.id,
    issue: 'https://github.com/example/lifeline/issues/99',
    expectedScheduleVersion: scheduleAfterCancel.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:update:cancelled-issue:1'
  });
  assert.equal(linkedCancelled.status, 'CANCELLED');
  assert.equal(linkedCancelled.issue, 'https://github.com/example/lifeline/issues/99');
  assert.equal((await callTool(client, 'lifeline_get_schedule', { projectId: project.id })).totalTasks, 2);
  assert.equal((await callTool(client, 'lifeline_get_task', { taskId: removable.id })).task.status, 'CANCELLED');

  const scanFinding = {
    projectId: project.id,
    phaseId: firstPlan.phase.id,
    fingerprint: 'review:no-timeout:test/mcp.test.js:1',
    scanner: 'review-agent',
    severity: 'medium',
    title: 'Add an MCP timeout regression',
    objective: 'Keep an MCP request from waiting forever when its downstream executor disconnects.',
    acceptanceCriteria: ['The timed request exits with a structured timeout error'],
    testCommands: [],
    issue: 'https://github.com/example/lifeline/issues/44',
    idempotencyKey: 'goal:mcp-test:scan:1'
  };
  const proposed = await callTool(client, 'lifeline_propose_scan_finding', scanFinding);
  const duplicate = await callTool(client, 'lifeline_propose_scan_finding', {
    ...scanFinding,
    idempotencyKey: 'goal:mcp-test:scan:2'
  });
  assert.equal(proposed.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.proposal.id, proposed.proposal.id);
  assert.equal((await callTool(client, 'lifeline_list_scan_proposals', {
    projectId: project.id,
    status: 'PENDING'
  })).total, 1);
  const scheduleBeforeScanReview = await callTool(client, 'lifeline_get_schedule', { projectId: project.id });
  const acceptedScan = await callTool(client, 'lifeline_review_scan_proposal', {
    proposalId: proposed.proposal.id,
    decision: 'ACCEPT',
    summary: 'The finding is actionable and ready for scheduling.',
    expectedScheduleVersion: scheduleBeforeScanReview.scheduleVersion,
    idempotencyKey: 'goal:mcp-test:scan-review:1'
  });
  assert.equal(acceptedScan.proposal.status, 'ACCEPTED');
  assert.equal(acceptedScan.task.status, 'PLANNED');
  assert.equal(acceptedScan.task.issue, scanFinding.issue);

  const task = firstPlan.tasks[0];
  const reportedStartedAt = '2026-08-03T12:00:00.000Z';
  const completion = await callTool(client, 'lifeline_submit_completion', {
    taskId: task.id,
    resultSummary: 'Implemented and exercised through the MCP client.',
    startedAt: reportedStartedAt,
    completedAt: '2026-08-03T12:00:01.200Z',
    executor: 'codex',
    modelRef: 'gpt-5.6-test',
    reasoningEffort: 'high',
    evidence: [{
      type: 'TEST_COMMAND',
      summary: 'MCP integration test passed.',
      metadata: { command: 'node --test test/mcp.test.js', exitCode: 0 }
    }],
    idempotencyKey: 'goal:mcp-test:complete:1'
  });
  assert.equal(completion.task.status, 'REVIEW');
  assert.equal(completion.run.kind, 'AGENT');
  assert.equal(completion.run.reportedAtCompletion, true);
  assert.equal(completion.completionRecord.startedAt, reportedStartedAt);
  assert.equal(completion.completionRecord.durationMs, 1200);
  assert.equal(completion.completionRecord.outcome, 'COMPLETED');
  assert.equal((await service.dashboard()).projects[0].verifiedProgress, 0);

  const verified = await callTool(client, 'lifeline_verify_task', {
    taskId: task.id,
    completionRecordId: completion.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'The declared MCP test command passed with exit code 0.',
    evidenceIds: completion.evidence.map((entry) => entry.id),
    idempotencyKey: 'goal:mcp-test:verify:1'
  });
  assert.equal(verified.task.status, 'VERIFIED');
  assert.ok((await service.dashboard()).projects[0].verifiedProgress > 0);

  const taskResource = await client.readResource({ uri: `lifeline://tasks/${task.id}` });
  const taskDetails = JSON.parse(taskResource.contents[0].text);
  assert.equal(taskDetails.task.status, 'VERIFIED');
  assert.equal(taskDetails.completionRecords[0].modelRef, 'gpt-5.6-test');

  const migrationStore = new JsonStore(file);
  await migrationStore.ready();
  await migrationStore.mutate((state) => {
    const recurringTask = state.workItems.find((entry) => entry.id === task.id);
    recurringTask.status = 'RECURRING';
    recurringTask.recurrence = { enabled: true };
  });
  const recurringRun = await callTool(client, 'lifeline_start_task', {
    taskId: task.id,
    modelRef: 'gpt-5.6-test',
    idempotencyKey: 'goal:mcp-test:start:recurring'
  });
  assert.equal(recurringRun.run.attempt, 2);
  const recurringCompletion = await callTool(client, 'lifeline_submit_completion', {
    taskId: task.id,
    runId: recurringRun.run.id,
    resultSummary: 'Completed another recurring cycle.',
    evidence: [{
      type: 'TEST_COMMAND',
      summary: 'Recurring MCP cycle passed.',
      metadata: { exitCode: 0 }
    }],
    idempotencyKey: 'goal:mcp-test:complete:recurring'
  });
  const recurringVerified = await callTool(client, 'lifeline_verify_task', {
    taskId: task.id,
    completionRecordId: recurringCompletion.completionRecord.id,
    verificationMethod: 'DETERMINISTIC_TEST',
    summary: 'Recurring cycle evidence passed.',
    evidenceIds: recurringCompletion.evidence.map((entry) => entry.id),
    idempotencyKey: 'goal:mcp-test:verify:recurring'
  });
  assert.equal(recurringVerified.task.status, 'RECURRING');

  const unverifiedTask = firstPlan.tasks[1];
  const secondRun = await callTool(client, 'lifeline_start_task', {
    taskId: unverifiedTask.id,
    modelRef: 'gpt-5.6-test',
    idempotencyKey: 'goal:mcp-test:start:2'
  });
  const secondCompletion = await callTool(client, 'lifeline_submit_completion', {
    taskId: unverifiedTask.id,
    runId: secondRun.run.id,
    resultSummary: 'Submitted an artifact without passing test evidence.',
    evidence: [{ type: 'ARTIFACT', summary: 'A patch exists but has not passed verification.' }],
    idempotencyKey: 'goal:mcp-test:complete:2'
  });
  const rejectedVerification = await client.callTool({
    name: 'lifeline_verify_task',
    arguments: {
      taskId: unverifiedTask.id,
      completionRecordId: secondCompletion.completionRecord.id,
      verificationMethod: 'DETERMINISTIC_TEST',
      summary: 'This must not pass.',
      idempotencyKey: 'goal:mcp-test:verify:2'
    }
  });
  assert.equal(rejectedVerification.isError, true);
  assert.equal((await service.getWorkItem(unverifiedTask.id)).status, 'REVIEW');

  const blockedTask = await service.createWorkItem({
    projectId: project.id,
    phaseId: firstPlan.phase.id,
    title: 'Report a blocked result once',
    objective: 'Record a truthful blocked outcome without a separate start call.',
    acceptanceCriteria: ['The external blocker is recorded truthfully.'],
    testCommands: ['node --test test/mcp.test.js'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 },
    planning: { phaseId: firstPlan.phase.id, taskOrder: 3, kind: 'feature', priority: 'P1', commitment: 'COMMITTED' }
  });
  const blockedResult = await callTool(client, 'lifeline_submit_completion', {
    taskId: blockedTask.id,
    outcome: 'BLOCKED',
    startedAt: '2026-08-03T12:05:00.000Z',
    completedAt: '2026-08-03T12:06:00.000Z',
    modelRef: 'gpt-5.6-test',
    resultSummary: 'A required external credential was unavailable.',
    idempotencyKey: 'goal:mcp-test:blocked:1'
  });
  assert.equal(blockedResult.task.status, 'BLOCKED');
  assert.equal(blockedResult.run.status, 'FAILED');
  assert.equal(blockedResult.completionRecord.outcome, 'BLOCKED');
  assert.equal(blockedResult.evidence.length, 0);
});

test('MCP accepts a maximum-length Unicode planId without overflowing derived keys', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-mcp-long-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Long plan identifiers' });
  const server = createLifelineMcpServer({ service, actor: 'codex-test', clientName: 'node-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lifeline-long-plan-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const input = {
    projectId: project.id,
    planId: '排'.repeat(256),
    phase: { title: 'Long identifier phase', phaseOrder: 1 },
    tasks: [{
      title: 'Reuse one task for a long plan identifier',
      objective: 'Keep derived idempotency keys within the storage contract.',
      acceptanceCriteria: ['Repeated sync returns the same task'],
      testCommands: ['node --test test/mcp.test.js'],
      taskOrder: 1,
      riskTier: 'low'
    }]
  };
  const first = await callTool(client, 'lifeline_sync_plan', input);
  const repeated = await callTool(client, 'lifeline_sync_plan', input);

  assert.equal(repeated.phase.id, first.phase.id);
  assert.equal(repeated.tasks[0].id, first.tasks[0].id);
  assert.equal((await service.getSchedule(project.id)).phases[0].tasks.length, 1);
});

test('JsonStore preserves writes from separate Web and MCP service instances', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const webService = await createService(file);
  const mcpService = await createService(file);
  const project = await webService.createProject({ name: 'Shared process state' });

  assert.equal((await mcpService.getProject(project.id)).id, project.id);
  await Promise.all([
    webService.createPhase(
      { projectId: project.id, title: 'Web phase', phaseOrder: 1 },
      { actor: 'web', idempotencyKey: 'web-phase' }
    ),
    mcpService.createPhase(
      { projectId: project.id, title: 'MCP phase', phaseOrder: 2 },
      { actor: 'mcp', idempotencyKey: 'mcp-phase' }
    )
  ]);

  assert.deepEqual((await webService.listPhases(project.id)).map((phase) => phase.title), ['Web phase', 'MCP phase']);
});

test('STDIO serving entry exposes the Lifeline tools', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-stdio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const [transport, wire] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createLifelineMcpServer({ service, actor: 'stdio-test', clientName: 'node-test' }),
    { transport: wire }
  );
  const client = new Client(
    { name: 'lifeline-stdio-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await handle.close();
  });

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 17);
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

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  assert.ok(response.structuredContent?.result, `Tool ${name} did not return structuredContent.result`);
  return response.structuredContent.result;
}

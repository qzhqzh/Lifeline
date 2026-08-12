import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const AGENT_TOKEN = 'autonomous-rest-fixture-token-00000001';

test('autonomous REST vertical slice dispatches, claims, extends, restores, and rebalances', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-autonomous-api-'));
  const port = await availablePort();
  const logs = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LIFELINE_DATA_FILE: join(directory, 'state.json'),
      LIFELINE_AGENT_TOKEN: AGENT_TOKEN,
      LIFELINE_AGENT_CLIENT_ID: 'rest-executor',
      LIFELINE_AGENT_SCOPES: 'portfolio:read,schedule:write,task:claim'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000))
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, logs);
  await api(baseUrl, '/api/subscriptions/pairing-token', {
    method: 'POST',
    origin: baseUrl,
    body: { accountId: 'subscription_codex_a' }
  }, 401);
  const pairing = await api(baseUrl, '/api/subscriptions/pairing-token', {
    method: 'POST',
    origin: baseUrl,
    token: AGENT_TOKEN,
    body: { accountId: 'subscription_codex_a' }
  }, 201);
  assert.equal(pairing.accountId, 'subscription_codex_a');
  const collector = await api(baseUrl, '/api/subscriptions/collectors/pair', {
    method: 'POST',
    origin: `chrome-extension://${'a'.repeat(32)}`,
    body: { pairingToken: pairing.pairingToken, profileName: 'REST owner fixture' }
  }, 201);
  const revokedCollector = await api(baseUrl, `/api/subscriptions/collectors/${collector.collectorId}`, {
    method: 'DELETE',
    origin: baseUrl,
    token: AGENT_TOKEN
  });
  assert.equal(revokedCollector.status, 'REVOKED');
  const project = await api(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Autonomous API fixture', strategicValue: 9 }
  }, 201);
  const phase = await api(baseUrl, '/api/phases', {
    method: 'POST',
    body: { projectId: project.id, title: 'Atomic control path', rank: 1024 }
  }, 201);
  const executionTask = await createTask(baseUrl, project.id, phase.id, 1, 'Execute through REST');
  const cancellableTask = await createTask(baseUrl, project.id, phase.id, 2, 'Restore through REST');

  const dispatch = await api(baseUrl, '/api/portfolio/dispatch');
  assert.equal(dispatch.decisions.find((entry) => entry.taskId === executionTask.id).batch, 'NEXT');
  assert.equal(dispatch.decisions.find((entry) => entry.taskId === cancellableTask.id).batch, 'RESERVE');

  await api(baseUrl, '/api/agent-runs/claim', {
    method: 'POST',
    body: { modelRef: 'gpt-rest-fixture' }
  }, 401);
  await api(baseUrl, '/api/agent-runs/claim', {
    method: 'POST',
    token: AGENT_TOKEN,
    body: { modelRef: 'gpt-rest-fixture' }
  }, 400);

  const claim = await api(baseUrl, '/api/agent-runs/claim', {
    method: 'POST',
    token: AGENT_TOKEN,
    idempotencyKey: 'rest-claim',
    body: { agentId: 'rest-executor', modelRef: 'gpt-rest-fixture', projectIds: [project.id] }
  }, 201);
  assert.equal(claim.task.id, executionTask.id);
  assert.equal(claim.task.status, 'RUNNING');
  assert.equal(claim.run.status, 'RUNNING');
  assert.equal(claim.lease.agentId, 'rest-executor');

  const extended = await api(baseUrl, `/api/runs/${claim.run.id}/lease`, {
    method: 'POST',
    token: AGENT_TOKEN,
    idempotencyKey: 'rest-lease',
    body: { agentId: 'rest-executor', extensionMinutes: 15 }
  });
  assert.ok(Date.parse(extended.lease.leaseExpiresAt) > Date.parse(claim.lease.leaseExpiresAt));

  let currentProject = await api(baseUrl, `/api/projects/${project.id}`);
  const cancelled = await api(baseUrl, `/api/work-items/${cancellableTask.id}`, {
    method: 'DELETE',
    idempotencyKey: 'rest-cancel',
    body: { expectedScheduleVersion: currentProject.scheduleVersion, reason: 'Exercise reversible audit' }
  });
  assert.equal(cancelled.status, 'CANCELLED');
  currentProject = await api(baseUrl, `/api/projects/${project.id}`);
  const restored = await api(baseUrl, `/api/work-items/${cancellableTask.id}/restore`, {
    method: 'POST',
    idempotencyKey: 'rest-restore',
    body: { expectedScheduleVersion: currentProject.scheduleVersion, reason: 'Return fixture to dispatch' }
  });
  assert.equal(restored.status, 'PLANNED');

  const rebalanced = await api(baseUrl, '/api/portfolio/rebalance', {
    method: 'POST',
    token: AGENT_TOKEN,
    idempotencyKey: 'rest-rebalance',
    body: { now: '2099-01-01T00:00:00.000Z' }
  });
  assert.equal(rebalanced.policy.version, 'autonomous-board-v1');
  assert.ok(Date.parse(rebalanced.generatedAt) < Date.parse('2099-01-01T00:00:00.000Z'));
  assert.equal(rebalanced.lanes.now.some((entry) => entry.taskId === executionTask.id), true);
  assert.equal(rebalanced.recentChanges.some((entry) => entry.type === 'work_item.restored'), true);

  const openapi = await api(baseUrl, '/api/openapi.json');
  for (const path of [
    '/api/portfolio/dispatch',
    '/api/portfolio/rebalance',
    '/api/agent-runs/claim',
    '/api/runs/{runId}/lease',
    '/api/work-items/{workItemId}/restore'
  ]) assert.ok(openapi.paths[path], `OpenAPI is missing ${path}`);
});

async function createTask(baseUrl, projectId, phaseId, taskOrder, title) {
  return api(baseUrl, '/api/work-items', {
    method: 'POST',
    body: {
      projectId,
      phaseId,
      title,
      objective: 'Exercise the autonomous REST contract end to end.',
      acceptanceCriteria: ['The requested state transition is observable through the API'],
      testCommands: [],
      riskTier: 'low',
      resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 5 },
      planning: { phaseId, taskOrder, kind: 'feature', priority: 'P0', commitment: 'COMMITTED' },
      recommendation: { executor: 'codex', capability: 'agentic-coding', compute: 'low', reasoningEffort: 'medium', estimateMinutes: 30 }
    }
  }, 201);
}

async function api(baseUrl, path, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Lifeline exited early:\n${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Lifeline did not become healthy:\n${logs.join('')}`);
}

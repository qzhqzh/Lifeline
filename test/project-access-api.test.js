import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('project access API scopes list/read/write and invalidates a revoked share link', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-project-access-api-'));
  const dataFile = join(directory, 'state.json');
  const port = await availablePort();
  const logs = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LIFELINE_DATA_FILE: dataFile },
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
  const first = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST', body: { name: 'Protected project' }
  });
  await jsonRequest(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Other project' } });
  const crossOrigin = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/access-grants`, {
    method: 'POST',
    origin: 'https://attacker.example',
    body: { displayName: 'Cross-site owner', role: 'OWNER' }
  });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.body.error.code, 'OWNER_ORIGIN_REQUIRED');
  const grant = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/access-grants`, {
    method: 'POST', body: { displayName: '客户观察员', role: 'VIEWER' }
  });
  assert.equal(grant.response.status, 201);
  assert.match(grant.body.token, /^lfp_/);

  const scoped = await jsonRequest(baseUrl, '/api/projects', { token: grant.body.token });
  assert.deepEqual(scoped.body.items.map((project) => project.id), [first.body.id]);
  const schedule = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/schedule`, { token: grant.body.token });
  assert.equal(schedule.response.status, 200);
  const testMap = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/test-map`, { token: grant.body.token });
  assert.equal(testMap.response.status, 200);
  assert.equal(testMap.body.access.role, 'VIEWER');
  assert.equal(testMap.body.access.capabilities.includes('test-governance:review'), false);
  const denied = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/schedule`, {
    method: 'PATCH', token: grant.body.token, body: {}
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'PROJECT_CAPABILITY_DENIED');
  const deniedReview = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/test-scenario-proposals/scenario-any`, {
    method: 'PATCH', token: grant.body.token, body: { action: 'START_REVIEW' }
  });
  assert.equal(deniedReview.response.status, 403);
  assert.equal(deniedReview.body.error.code, 'PROJECT_CAPABILITY_DENIED');

  const stored = await readFile(dataFile, 'utf8');
  assert.doesNotMatch(stored, new RegExp(grant.body.token));
  const revoked = await jsonRequest(baseUrl, `/api/projects/${first.body.id}/access-grants/${grant.body.id}`, {
    method: 'DELETE', body: { reason: '访问期结束' }
  });
  assert.equal(revoked.body.status, 'REVOKED');
  const rejected = await jsonRequest(baseUrl, '/api/projects', { token: grant.body.token });
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.body.error.code, 'PROJECT_ACCESS_INVALID');
});

async function jsonRequest(baseUrl, path, { method = 'GET', body, token, origin } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { response, body: await response.json() };
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Lifeline exited early:\n${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Lifeline did not become healthy:\n${logs.join('')}`);
}

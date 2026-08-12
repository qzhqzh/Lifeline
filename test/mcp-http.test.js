import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const TOKEN = 'http-mcp-test-token-with-fixture-entropy';

test('LAN Streamable HTTP MCP requires a bearer token and propagates scopes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-mcp-http-'));
  const port = await availablePort();
  const logs = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LIFELINE_DATA_FILE: join(directory, 'state.json'),
      LIFELINE_AGENT_TOKEN: TOKEN,
      LIFELINE_AGENT_CLIENT_ID: 'http-test-agent',
      LIFELINE_AGENT_SCOPES: 'portfolio:read'
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
  const unauthenticated = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('www-authenticate'), 'Bearer');

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: { token: async () => TOKEN }
  });
  const client = new Client({ name: 'lifeline-http-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.callTool({ name: 'lifeline_list_projects', arguments: {} });
  assert.notEqual(listed.isError, true);
  assert.deepEqual(listed.structuredContent.result.items, []);
  const denied = await client.callTool({
    name: 'lifeline_create_project',
    arguments: { name: 'Denied over HTTP', idempotencyKey: 'http-scope-denied' }
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /schedule:write/);
});

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

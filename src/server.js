import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateAgentRequest, validateAgentHttpBoundary } from './agent-auth.js';
import { DomainError } from './domain.js';
import { createLifelineMcpServer } from './mcp-server.js';
import { LifelineService, isTerminalRunStatus } from './service.js';
import { JsonStore } from './store.js';
import { SubscriptionService } from './subscriptions.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_ROOT = join(ROOT, 'public');
const dataFile = process.env.LIFELINE_DATA_FILE ?? join(ROOT, 'data', 'lifeline.json');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const devReloadEnabled = process.env.LIFELINE_DEV_RELOAD === '1';

const store = new JsonStore(dataFile);
const service = new LifelineService({
  store
});
const subscriptionService = new SubscriptionService({ store });
await service.start();
await subscriptionService.start();
if (process.env.LIFELINE_SEED_DEMO === '1') await service.seedDemo();

const mcpHandler = createMcpHandler((context) => createLifelineMcpServer({
  service,
  actor: context.authInfo?.clientId ?? 'lifeline-lan-agent',
  clientName: 'streamable-http',
  scopes: context.authInfo?.scopes ?? []
}), {
  onerror: (error) => console.error('MCP request failed', error),
  responseMode: 'json'
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const corsAllowed = setCommonHeaders(request, response, url);

    if (request.method === 'OPTIONS') {
      response.writeHead(corsAllowed ? 204 : 403);
      response.end();
      return;
    }

    if (url.pathname === '/mcp') {
      await handleMcp(request, response, url);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    handleError(response, error);
  }
});

server.listen(port, host, () => {
  console.log(`Lifeline control plane listening on http://${host}:${port}`);
  console.log(`Persisting state to ${dataFile}`);
});

async function handleApi(request, response, url) {
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, {
      status: 'ok',
      service: 'lifeline-control-plane',
      time: new Date().toISOString(),
      devReload: devReloadEnabled
    });
  }
  if (method === 'GET' && url.pathname === '/api/dev-events' && devReloadEnabled) {
    return openDevEventStream(request, response);
  }
  if (method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(response, 200, await service.dashboard());
  }
  if (method === 'GET' && url.pathname === '/api/portfolio/dispatch') {
    return sendJson(response, 200, await service.getDispatchBoard());
  }
  if (method === 'POST' && url.pathname === '/api/portfolio/rebalance') {
    const identity = requireAgentRestAccess(request, 'schedule:write');
    const idempotencyKey = requireIdempotencyKey(request);
    return sendJson(response, 200, await service.rebalancePortfolio(
      await readJsonBody(request),
      agentMutationOptions(identity, idempotencyKey, 'portfolio.rebalance')
    ));
  }
  if (method === 'POST' && url.pathname === '/api/agent-runs/claim') {
    const identity = requireAgentRestAccess(request, 'task:claim');
    const idempotencyKey = requireIdempotencyKey(request);
    const input = bindAgentIdentity(await readJsonBody(request), identity);
    return sendJson(response, 201, await service.claimNextTask(
      input,
      agentMutationOptions(identity, idempotencyKey, 'agent_run.claim')
    ));
  }
  if (method === 'GET' && url.pathname === '/api/trajectory') {
    return sendJson(response, 200, await service.getTrajectory(url.searchParams.get('window') ?? '7d'));
  }
  if (method === 'GET' && url.pathname === '/api/subscriptions/summary') {
    return sendJson(response, 200, await subscriptionService.getSummary());
  }
  if (method === 'GET' && url.pathname === '/api/subscriptions/accounts') {
    return sendJson(response, 200, await subscriptionService.listAccounts());
  }
  if (method === 'POST' && url.pathname === '/api/subscriptions/pairing-token') {
    requireOwnerBrowserMutation(request);
    return sendJson(response, 201, await subscriptionService.createPairingToken(await readJsonBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/subscriptions/collectors/pair') {
    return sendJson(response, 201, await subscriptionService.pairCollector(
      await readJsonBody(request),
      request.headers.origin
    ));
  }
  if (method === 'POST' && url.pathname === '/api/subscriptions/snapshots') {
    return sendJson(response, 202, await subscriptionService.submitSnapshot(
      await readJsonBody(request),
      { authorization: request.headers.authorization, origin: request.headers.origin }
    ));
  }
  const subscriptionAccountMatch = /^\/api\/subscriptions\/accounts\/([^/]+)$/.exec(url.pathname);
  if (method === 'PATCH' && subscriptionAccountMatch) {
    requireOwnerBrowserMutation(request);
    return sendJson(response, 200, await subscriptionService.updateAccount(
      decodeURIComponent(subscriptionAccountMatch[1]),
      await readJsonBody(request)
    ));
  }
  const subscriptionHistoryMatch = /^\/api\/subscriptions\/accounts\/([^/]+)\/history$/.exec(url.pathname);
  if (method === 'GET' && subscriptionHistoryMatch) {
    return sendJson(response, 200, await subscriptionService.getHistory(
      decodeURIComponent(subscriptionHistoryMatch[1]),
      url.searchParams.get('window') ?? '7d'
    ));
  }
  const subscriptionCollectorMatch = /^\/api\/subscriptions\/collectors\/([^/]+)$/.exec(url.pathname);
  if (method === 'DELETE' && subscriptionCollectorMatch) {
    const extensionRequest = /^chrome-extension:\/\//.test(String(request.headers.origin ?? ''));
    const collectorContext = extensionRequest
      ? { authorization: request.headers.authorization, origin: request.headers.origin }
      : { ownerApproved: requireOwnerBrowserMutation(request) };
    return sendJson(response, 200, await subscriptionService.revokeCollector(
      decodeURIComponent(subscriptionCollectorMatch[1]),
      collectorContext
    ));
  }
  if (method === 'GET' && url.pathname === '/api/bootstrap/portfolio-v2') {
    return sendJson(response, 200, await service.getBootstrapStatus());
  }
  if (method === 'POST' && url.pathname === '/api/bootstrap/portfolio-v2') {
    const result = await service.bootstrapPortfolioV2({
      idempotencyKey: request.headers['idempotency-key'] ?? null
    });
    return sendJson(response, result.created ? 201 : 200, result);
  }
  if (method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(response, 200, { items: await service.listProjects() });
  }
  if (method === 'POST' && url.pathname === '/api/projects') {
    return sendJson(response, 201, await service.createProject(
      await readJsonBody(request),
      webMutationOptions(request, 'project.create')
    ));
  }
  if (method === 'POST' && url.pathname === '/api/phases') {
    return sendJson(response, 201, await service.createPhase(
      await readJsonBody(request),
      webMutationOptions(request, 'phase.create')
    ));
  }
  const phaseMatch = /^\/api\/phases\/([^/]+)$/.exec(url.pathname);
  if (method === 'PATCH' && phaseMatch) {
    return sendJson(response, 200, await service.updatePhase(
      decodeURIComponent(phaseMatch[1]),
      await readJsonBody(request),
      webMutationOptions(request, 'phase.update')
    ));
  }
  if (method === 'GET' && url.pathname === '/api/work-items') {
    return sendJson(response, 200, { items: await service.listWorkItems(url.searchParams.get('projectId')) });
  }
  if (method === 'POST' && url.pathname === '/api/work-items') {
    return sendJson(response, 201, await service.createWorkItem(
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.create')
    ));
  }
  if (method === 'POST' && url.pathname === '/api/demo') {
    return sendJson(response, 201, await service.seedDemo());
  }
  if (method === 'GET' && url.pathname === '/api/openapi.json') {
    return sendJson(response, 200, JSON.parse(await readFile(join(ROOT, 'openapi.json'), 'utf8')));
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && projectMatch) {
    return sendJson(response, 200, await service.getProject(decodeURIComponent(projectMatch[1])));
  }

  const scheduleMatch = /^\/api\/projects\/([^/]+)\/schedule$/.exec(url.pathname);
  if (method === 'GET' && scheduleMatch) {
    return sendJson(response, 200, await service.getSchedule(decodeURIComponent(scheduleMatch[1])));
  }
  if (method === 'PATCH' && scheduleMatch) {
    const projectId = decodeURIComponent(scheduleMatch[1]);
    return sendJson(response, 200, await service.reorderPhaseTasks(
      projectId,
      await readJsonBody(request),
      webMutationOptions(request, 'schedule.reorder')
    ));
  }

  const workItemMatch = /^\/api\/work-items\/([^/]+)$/.exec(url.pathname);
  const workItemDetailsMatch = /^\/api\/work-items\/([^/]+)\/details$/.exec(url.pathname);
  if (method === 'GET' && workItemDetailsMatch) {
    return sendJson(response, 200, await service.getTaskDetails(decodeURIComponent(workItemDetailsMatch[1])));
  }
  const workItemRestoreMatch = /^\/api\/work-items\/([^/]+)\/restore$/.exec(url.pathname);
  if (method === 'POST' && workItemRestoreMatch) {
    return sendJson(response, 200, await service.restoreWorkItem(
      decodeURIComponent(workItemRestoreMatch[1]),
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.restore')
    ));
  }
  if (method === 'GET' && workItemMatch) {
    return sendJson(response, 200, await service.getWorkItem(decodeURIComponent(workItemMatch[1])));
  }
  if (method === 'PATCH' && workItemMatch) {
    const workItemId = decodeURIComponent(workItemMatch[1]);
    return sendJson(response, 200, await service.updateWorkItem(
      workItemId,
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.update')
    ));
  }
  if (method === 'DELETE' && workItemMatch) {
    const workItemId = decodeURIComponent(workItemMatch[1]);
    return sendJson(response, 200, await service.cancelWorkItem(
      workItemId,
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.cancel')
    ));
  }

  const readyMatch = /^\/api\/work-items\/([^/]+)\/ready$/.exec(url.pathname);
  if (method === 'POST' && readyMatch) {
    return sendJson(response, 200, await service.markReady(decodeURIComponent(readyMatch[1])));
  }

  const queueMatch = /^\/api\/work-items\/([^/]+)\/queue$/.exec(url.pathname);
  if (method === 'POST' && queueMatch) {
    return sendJson(response, 202, await service.queueWorkItem(decodeURIComponent(queueMatch[1])));
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && runMatch) {
    return sendJson(response, 200, await service.getRun(decodeURIComponent(runMatch[1])));
  }
  const leaseMatch = /^\/api\/runs\/([^/]+)\/lease$/.exec(url.pathname);
  if (method === 'POST' && leaseMatch) {
    const identity = requireAgentRestAccess(request, 'task:claim');
    const idempotencyKey = requireIdempotencyKey(request);
    const input = bindAgentIdentity(await readJsonBody(request), identity);
    return sendJson(response, 200, await service.extendTaskLease(
      decodeURIComponent(leaseMatch[1]),
      input,
      agentMutationOptions(identity, idempotencyKey, 'agent_run.extend_lease')
    ));
  }

  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (method === 'GET' && eventsMatch) {
    const after = Number(url.searchParams.get('after') ?? 0);
    return sendJson(response, 200, {
      items: await service.getRunEvents(decodeURIComponent(eventsMatch[1]), after)
    });
  }

  const streamMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
  if (method === 'GET' && streamMatch) {
    return streamRun(response, decodeURIComponent(streamMatch[1]), Number(url.searchParams.get('after') ?? 0));
  }

  throw new HttpError(404, 'Route not found');
}

async function streamRun(response, runId, initialSequence) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  let lastSequence = initialSequence;
  let closed = false;
  response.on('close', () => {
    closed = true;
  });

  while (!closed) {
    const events = await service.getRunEvents(runId, lastSequence);
    for (const event of events) {
      response.write(`id: ${event.sequence}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      lastSequence = event.sequence;
    }
    const run = await service.getRun(runId);
    if (isTerminalRunStatus(run.status)) {
      response.write(`event: terminal\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
      response.end();
      return;
    }
    response.write(': heartbeat\n\n');
    await delay(500);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

async function handleMcp(request, response, url) {
  const authenticated = authenticateAgentRequest(request.headers);
  if (!authenticated.ok) {
    if (authenticated.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    return sendJson(response, authenticated.status, { error: { code: authenticated.code } });
  }
  const boundary = validateAgentHttpBoundary({
    host: request.headers.host,
    origin: request.headers.origin,
    remoteAddress: request.socket?.remoteAddress
  }, authenticated.allowedOrigins);
  if (!boundary.ok) return sendJson(response, boundary.status, { error: { code: boundary.code } });

  const method = request.method ?? 'GET';
  const body = ['GET', 'HEAD'].includes(method) ? undefined : await readRawBody(request);
  const webRequest = new Request(url, {
    method,
    headers: new Headers(Object.entries(request.headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])),
    ...(body ? { body, duplex: 'half' } : {})
  });
  const mcpResponse = await mcpHandler.fetch(webRequest, { authInfo: authenticated.authInfo });
  response.writeHead(mcpResponse.status, Object.fromEntries(mcpResponse.headers.entries()));
  if (!mcpResponse.body) return response.end();
  const reader = mcpResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = normalize(decodeURIComponent(requested)).replace(/^([.][.][/\\])+/, '');
  const filePath = join(PUBLIC_ROOT, normalizedPath);
  if (!filePath.startsWith(PUBLIC_ROOT)) throw new HttpError(403, 'Forbidden');

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new HttpError(404, 'Not found');
    response.writeHead(200, { 'Content-Type': contentType(extname(filePath)) });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'Not found');
    throw error;
  }
}

function handleError(response, error) {
  const domainStatus = error instanceof DomainError
    ? ({ NOT_FOUND: 404, SCHEDULE_VERSION_CONFLICT: 409 }[error.code] ?? 422)
    : null;
  const status = error instanceof HttpError ? error.status : domainStatus ?? 500;
  const payload = {
    error: {
      code: error?.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status === 500 ? 'Internal server error' : error.message,
      details: error?.details
    }
  };
  if (status === 500) console.error(error);
  if (status === 401 && !response.headersSent) response.setHeader('WWW-Authenticate', 'Bearer');
  if (!response.headersSent) sendJson(response, status, payload);
  else response.end();
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function openDevEventStream(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  response.write('event: ready\ndata: {}\n\n');
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
  request.on('close', () => clearInterval(heartbeat));
}

function setCommonHeaders(request, response, url) {
  const origin = request.headers.origin;
  const corsAllowed = !origin || isAllowedCorsOrigin(origin, request.headers.host, url.pathname);
  if (origin && corsAllowed) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  return corsAllowed;
}

function isAllowedCorsOrigin(origin, requestHost, pathname) {
  if (isSameOrigin(origin, requestHost)) return true;
  if (pathname.startsWith('/api/subscriptions/') && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  return String(process.env.LIFELINE_MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(origin);
}

function isSameOrigin(origin, requestHost) {
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === String(requestHost ?? '');
  } catch {
    return false;
  }
}

function requireOwnerBrowserMutation(request) {
  if (!isSameOrigin(request.headers.origin, request.headers.host)) {
    throw new HttpError(403, 'Owner mutations require a same-origin Lifeline page', 'OWNER_ORIGIN_REQUIRED');
  }
  const authenticated = authenticateAgentRequest(request.headers);
  if (!authenticated.ok) {
    throw new HttpError(authenticated.status, 'A Lifeline management token is required', authenticated.code);
  }
  if (!authenticated.authInfo.scopes.includes('schedule:write')) {
    throw new HttpError(403, 'Management token is missing schedule:write', 'MCP_SCOPE_DENIED');
  }
  return true;
}

function requireAgentRestAccess(request, requiredScope) {
  const authenticated = authenticateAgentRequest(request.headers);
  if (!authenticated.ok) {
    throw new HttpError(authenticated.status, 'Agent bearer token is required', authenticated.code);
  }
  const boundary = validateAgentHttpBoundary({
    host: request.headers.host,
    origin: request.headers.origin,
    remoteAddress: request.socket?.remoteAddress
  }, authenticated.allowedOrigins);
  if (!boundary.ok) throw new HttpError(boundary.status, 'Agent request boundary rejected', boundary.code);
  if (!authenticated.authInfo.scopes.includes(requiredScope)) {
    throw new HttpError(403, `Agent token is missing ${requiredScope}`, 'MCP_SCOPE_DENIED');
  }
  return authenticated.authInfo;
}

function requireIdempotencyKey(request) {
  const value = String(request.headers['idempotency-key'] ?? '').trim();
  if (!value || value.length > 256) {
    throw new HttpError(400, 'Idempotency-Key is required and must not exceed 256 characters', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return value;
}

function bindAgentIdentity(input, identity) {
  if (input?.agentId && input.agentId !== identity.clientId) {
    throw new HttpError(403, 'agentId must match the authenticated Agent token', 'AGENT_IDENTITY_MISMATCH');
  }
  return { ...input, agentId: identity.clientId };
}

function agentMutationOptions(identity, idempotencyKey, tool) {
  return {
    actor: identity.clientId,
    client: 'agent-rest',
    tool,
    idempotencyKey,
    authoritativeAgentClock: true,
    requireClaimLease: true,
    source: { kind: 'agent-rest', clientId: identity.clientId }
  };
}

function webMutationOptions(request, tool) {
  return {
    client: 'web',
    tool,
    idempotencyKey: request.headers['idempotency-key'] ?? null,
    authoritativeAgentClock: ['agent_run.claim', 'agent_run.extend_lease'].includes(tool),
    source: { kind: 'web-ui' }
  };
}

function contentType(extension) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extension] ?? 'application/octet-stream';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class HttpError extends Error {
  constructor(status, message, code = `HTTP_${status}`) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

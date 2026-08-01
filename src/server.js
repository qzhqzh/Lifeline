import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from './domain.js';
import { MockExecutor } from './executor.js';
import { LifelineService, isTerminalRunStatus } from './service.js';
import { JsonStore } from './store.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_ROOT = join(ROOT, 'public');
const dataFile = process.env.LIFELINE_DATA_FILE ?? join(ROOT, 'data', 'lifeline.json');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const store = new JsonStore(dataFile);
const service = new LifelineService({
  store,
  executor: new MockExecutor({ delayMs: Number(process.env.MOCK_STEP_DELAY_MS ?? 180) })
});
await service.start();
if (process.env.LIFELINE_SEED_DEMO === '1') await service.seedDemo();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    setCommonHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
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
    return sendJson(response, 200, { status: 'ok', service: 'lifeline-control-plane', time: new Date().toISOString() });
  }
  if (method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(response, 200, await service.dashboard());
  }
  if (method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(response, 200, { items: await service.listProjects() });
  }
  if (method === 'POST' && url.pathname === '/api/projects') {
    return sendJson(response, 201, await service.createProject(await readJsonBody(request)));
  }
  if (method === 'GET' && url.pathname === '/api/work-items') {
    return sendJson(response, 200, { items: await service.listWorkItems(url.searchParams.get('projectId')) });
  }
  if (method === 'POST' && url.pathname === '/api/work-items') {
    return sendJson(response, 201, await service.createWorkItem(await readJsonBody(request)));
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

  const workItemMatch = /^\/api\/work-items\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && workItemMatch) {
    return sendJson(response, 200, await service.getWorkItem(decodeURIComponent(workItemMatch[1])));
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
  const domainStatus = error instanceof DomainError ? (error.code === 'NOT_FOUND' ? 404 : 422) : null;
  const status = error instanceof HttpError ? error.status : domainStatus ?? 500;
  const payload = {
    error: {
      code: error?.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status === 500 ? 'Internal server error' : error.message,
      details: error?.details
    }
  };
  if (status === 500) console.error(error);
  if (!response.headersSent) sendJson(response, status, payload);
  else response.end();
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function setCommonHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
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
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = `HTTP_${status}`;
  }
}

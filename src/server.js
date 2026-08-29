import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateAgentRequest, validateAgentHttpBoundary } from './agent-auth.js';
import {
  CanvasConfigurationError,
  DEFAULT_CANVAS_BASE_PATH,
  DEFAULT_CANVAS_SESSION_TTL_SECONDS,
  buildWboProxyUrl,
  createWboCanvasSession,
  normalizeCanvasBasePath,
  verifyWboCanvasToken,
  wboTokenAllowsPath
} from './canvas.js';
import { DomainError } from './domain.js';
import { createLifelineMcpServer } from './mcp-server.js';
import { LifelineService, isTerminalRunStatus } from './service.js';
import { JsonStore } from './store.js';
import { SubscriptionService } from './subscriptions.js';
import { getProjectTestMap } from './project-test-map.js';
import {
  PROJECT_ACCESS_CAPABILITIES,
  ProjectCollaborationService,
  hasProjectCapability,
  projectBearerToken
} from './project-collaboration.js';
import { TestGovernanceWorkflowService } from './test-governance-workflow.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_ROOT = join(ROOT, 'public');
const dataFile = process.env.LIFELINE_DATA_FILE ?? join(ROOT, 'data', 'lifeline.json');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const devReloadEnabled = process.env.LIFELINE_DEV_RELOAD === '1';
const canvasUpstreamUrl = String(process.env.LIFELINE_CANVAS_UPSTREAM_URL ?? '').trim();
const canvasSigningSecret = String(process.env.WBO_AUTH_SECRET_KEY ?? '').trim();
const canvasBasePath = normalizeCanvasBasePath(
  process.env.LIFELINE_CANVAS_BASE_PATH ?? DEFAULT_CANVAS_BASE_PATH
);
const canvasSessionTtlSeconds = Number(
  process.env.LIFELINE_CANVAS_SESSION_TTL_SECONDS ?? DEFAULT_CANVAS_SESSION_TTL_SECONDS
);

const store = new JsonStore(dataFile);
const service = new LifelineService({
  store
});
const subscriptionService = new SubscriptionService({ store });
const collaborationService = new ProjectCollaborationService({ store });
const testGovernanceWorkflow = new TestGovernanceWorkflowService({ store, lifelineService: service });
await service.start();
await subscriptionService.start();
await collaborationService.start();
await testGovernanceWorkflow.start();
if (process.env.LIFELINE_SEED_DEMO === '1') await service.seedDemo();

const mcpHandler = createMcpHandler((context) => createLifelineMcpServer({
  service,
  testGovernanceWorkflow,
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
    if (isCanvasProxyPath(url.pathname)) {
      await proxyCanvasHttp(request, response, url);
      return;
    }
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

server.on('upgrade', async (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  if (!isCanvasProxyPath(url.pathname)) return rejectUpgrade(socket, 404, 'Not Found');
  if (!await isCanvasProxyAuthorized(url)) return rejectUpgrade(socket, 403, 'Forbidden');
  proxyCanvasUpgrade(request, socket, head, url);
});

server.listen(port, host, () => {
  console.log(`Lifeline control plane listening on http://${host}:${port}`);
  console.log(`Persisting state to ${dataFile}`);
});

async function handleApi(request, response, url) {
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/api/health') {
    const canvasConfigured = isCanvasConfigured();
    const canvasAvailable = canvasConfigured ? await probeCanvasUpstream() : false;
    return sendJson(response, 200, {
      status: canvasConfigured && !canvasAvailable ? 'degraded' : 'ok',
      service: 'lifeline-control-plane',
      time: new Date().toISOString(),
      devReload: devReloadEnabled,
      canvas: {
        configured: canvasConfigured,
        available: canvasAvailable
      }
    });
  }
  if (method === 'GET' && url.pathname === '/api/dev-events' && devReloadEnabled) {
    return openDevEventStream(request, response);
  }
  if (method === 'GET' && url.pathname === '/api/dashboard') {
    await requireControlPlaneOwner(request);
    return sendJson(response, 200, await service.dashboard());
  }
  if (method === 'GET' && url.pathname === '/api/portfolio/dispatch') {
    await requireControlPlaneOwner(request);
    return sendJson(response, 200, await service.getDispatchBoard());
  }
  if (method === 'GET' && url.pathname === '/api/portfolio/reporting') {
    await requireControlPlaneOwner(request);
    return sendJson(response, 200, await service.getAgentReporting());
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
    await requireControlPlaneOwner(request);
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
    await requireControlPlaneOwner(request);
    return sendJson(response, 200, await service.getBootstrapStatus());
  }
  if (method === 'POST' && url.pathname === '/api/bootstrap/portfolio-v2') {
    await requireControlPlaneOwner(request);
    const input = await readJsonBody(request);
    const result = await service.bootstrapPortfolioV2({
      idempotencyKey: request.headers['idempotency-key'] ?? null,
      conflictResolution: input.conflictResolution ?? null
    });
    return sendJson(response, result.created ? 201 : 200, result);
  }
  if (method === 'GET' && url.pathname === '/api/projects') {
    const projects = await service.listProjects();
    const identity = await optionalProjectAccessIdentity(request);
    if (identity?.kind === 'project-access') {
      return sendJson(response, 200, {
        items: projects
          .filter((project) => project.id === identity.projectId)
          .map(clientProjectProjection),
        access: { role: identity.role, capabilities: identity.capabilities }
      });
    }
    if (identity?.kind === 'local-owner') return sendJson(response, 200, {
      items: projects,
      access: { role: identity.role, capabilities: identity.capabilities }
    });
    const visible = [];
    for (const project of projects) {
      if (!await collaborationService.hasProjectAccessControl(project.id)) visible.push(project);
    }
    return sendJson(response, 200, {
      items: visible,
      access: { role: 'OWNER', capabilities: [...PROJECT_ACCESS_CAPABILITIES.OWNER] }
    });
  }
  if (method === 'POST' && url.pathname === '/api/projects') {
    await requireControlPlaneOwner(request);
    return sendJson(response, 201, await service.createProject(
      await readJsonBody(request),
      webMutationOptions(request, 'project.create')
    ));
  }
  if (method === 'POST' && url.pathname === '/api/phases') {
    const input = await readJsonBody(request);
    const identity = await requireProjectCapability(request, input.projectId, 'project:write');
    return sendJson(response, 201, await service.createPhase(
      input,
      webMutationOptions(request, 'phase.create', identity)
    ));
  }
  const phaseMatch = /^\/api\/phases\/([^/]+)$/.exec(url.pathname);
  if (method === 'PATCH' && phaseMatch) {
    const phaseId = decodeURIComponent(phaseMatch[1]);
    const projectId = await projectIdForPhase(phaseId);
    const identity = await requireProjectCapability(request, projectId, 'project:write');
    return sendJson(response, 200, await service.updatePhase(
      phaseId,
      await readJsonBody(request),
      webMutationOptions(request, 'phase.update', identity)
    ));
  }
  if (method === 'GET' && url.pathname === '/api/work-items') {
    const projectId = url.searchParams.get('projectId');
    if (projectId) {
      await requireProjectCapability(request, projectId, 'project:read');
      return sendJson(response, 200, { items: await service.listWorkItems(projectId) });
    }
    const identity = await optionalProjectAccessIdentity(request);
    if (identity?.kind === 'project-access') {
      return sendJson(response, 200, { items: await service.listWorkItems(identity.projectId) });
    }
    await requireControlPlaneOwner(request);
    return sendJson(response, 200, { items: await service.listWorkItems() });
  }
  if (method === 'POST' && url.pathname === '/api/work-items') {
    const input = await readJsonBody(request);
    const identity = await requireProjectCapability(request, input.projectId, 'project:write');
    return sendJson(response, 201, await service.createWorkItem(
      input,
      webMutationOptions(request, 'work_item.create', identity)
    ));
  }
  if (method === 'POST' && url.pathname === '/api/demo') {
    await requireControlPlaneOwner(request);
    return sendJson(response, 201, await service.seedDemo());
  }
  if (method === 'GET' && url.pathname === '/api/openapi.json') {
    return sendJson(response, 200, JSON.parse(await readFile(join(ROOT, 'openapi.json'), 'utf8')));
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    await requireProjectCapability(request, projectId, 'project:read');
    return sendJson(response, 200, await service.getProject(projectId));
  }

  const scheduleMatch = /^\/api\/projects\/([^/]+)\/schedule$/.exec(url.pathname);
  if (method === 'GET' && scheduleMatch) {
    const projectId = decodeURIComponent(scheduleMatch[1]);
    await requireProjectCapability(request, projectId, 'project:read');
    return sendJson(response, 200, await service.getSchedule(projectId));
  }
  if (method === 'PATCH' && scheduleMatch) {
    const projectId = decodeURIComponent(scheduleMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'project:write');
    return sendJson(response, 200, await service.reorderPhaseTasks(
      projectId,
      await readJsonBody(request),
      webMutationOptions(request, 'schedule.reorder', identity)
    ));
  }

  const testMapMatch = /^\/api\/projects\/([^/]+)\/test-map$/.exec(url.pathname);
  if (method === 'GET' && testMapMatch) {
    const projectId = decodeURIComponent(testMapMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'project:read');
    const project = await service.getProject(projectId);
    const map = await getProjectTestMap(project, ROOT);
    if (map.configured && map.scenarioCatalog?.scenarios?.length) {
      await testGovernanceWorkflow.syncScenarioCatalog(projectId, map.scenarioCatalog, {
        actor: 'test-map-catalog',
        provenance: 'DETERMINISTIC'
      });
      const proposals = await testGovernanceWorkflow.listScenarioProposals(projectId);
      const proposalsByFingerprint = new Map(proposals.map((proposal) => [proposal.fingerprint, proposal]));
      map.scenarioCatalog = {
        ...map.scenarioCatalog,
        scenarios: map.scenarioCatalog.scenarios.map((scenario) => {
          const proposal = proposalsByFingerprint.get(scenario.fingerprint ?? scenario.scenarioId);
          return proposal ? {
            ...scenario,
            proposalId: proposal.id,
            reviewState: proposal.status,
            coverageState: proposal.coverageState
          } : scenario;
        })
      };
      map.scenarioGaps = proposals
        .filter((proposal) => ['missing', 'partial', 'unobserved'].includes(proposal.coverageState))
        .map((proposal) => ({
          id: proposal.id,
          scenarioId: proposal.scenarioId,
          title: proposal.title,
          categoryIds: proposal.categoryIds,
          preconditions: proposal.preconditions,
          action: proposal.action,
          expected: proposal.expected,
          riskIds: proposal.riskIds,
          coverageState: proposal.coverageState,
          workflowState: proposal.status,
          sourceEvidence: proposal.sourceEvidence,
          matchedTestIds: proposal.matchedTestIds
        }));
    }
    map.access = { role: identity.role, capabilities: identity.capabilities };
    response.setHeader('Cache-Control', 'no-store');
    return sendJson(response, 200, map);
  }

  const canvasSessionMatch = /^\/api\/projects\/([^/]+)\/canvas-session$/.exec(url.pathname);
  if (method === 'GET' && canvasSessionMatch) {
    const projectId = decodeURIComponent(canvasSessionMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'canvas:open');
    await service.getProject(projectId);
    if (!isCanvasConfigured()) {
      throw new HttpError(503, 'Collaborative canvas is not configured', 'CANVAS_NOT_CONFIGURED');
    }
    if (!await probeCanvasUpstream()) {
      throw new HttpError(503, 'Collaborative canvas is temporarily unavailable', 'CANVAS_UNAVAILABLE');
    }
    response.setHeader('Cache-Control', 'no-store');
    const session = createWboCanvasSession({
      projectId,
      secret: canvasSigningSecret,
      subjectId: identity.subjectId,
      grantId: identity.grantId ?? null,
      ttlSeconds: canvasSessionTtlSeconds,
      publicBasePath: canvasBasePath
    });
    await collaborationService.recordCanvasSession(projectId, session, {
      actor: identity.subjectId,
      grantId: identity.grantId ?? null
    });
    return sendJson(response, 200, { ...session, accessModel: 'project-rbac' });
  }

  const projectAccessMatch = /^\/api\/projects\/([^/]+)\/access-grants$/.exec(url.pathname);
  if (projectAccessMatch) {
    const projectId = decodeURIComponent(projectAccessMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'access:manage');
    if (method === 'GET') {
      return sendJson(response, 200, { items: await collaborationService.listAccessGrants(projectId) });
    }
    if (method === 'POST') {
      return sendJson(response, 201, await collaborationService.createAccessGrant(
        projectId,
        await readJsonBody(request),
        { actor: identity.subjectId }
      ));
    }
  }
  const projectAccessGrantMatch = /^\/api\/projects\/([^/]+)\/access-grants\/([^/]+)$/.exec(url.pathname);
  if (method === 'DELETE' && projectAccessGrantMatch) {
    const projectId = decodeURIComponent(projectAccessGrantMatch[1]);
    const grantId = decodeURIComponent(projectAccessGrantMatch[2]);
    const identity = await requireProjectCapability(request, projectId, 'access:manage');
    return sendJson(response, 200, await collaborationService.revokeAccessGrant(
      projectId,
      grantId,
      await readJsonBody(request),
      { actor: identity.subjectId }
    ));
  }

  const canvasContextMatch = /^\/api\/projects\/([^/]+)\/canvas-context$/.exec(url.pathname);
  if (method === 'GET' && canvasContextMatch) {
    const projectId = decodeURIComponent(canvasContextMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'project:read');
    return sendJson(response, 200, {
      ...await collaborationService.getCanvasContext(projectId),
      access: {
        role: identity.role,
        capabilities: identity.capabilities
      }
    });
  }
  const canvasBindingsMatch = /^\/api\/projects\/([^/]+)\/canvas-bindings$/.exec(url.pathname);
  if (method === 'POST' && canvasBindingsMatch) {
    const projectId = decodeURIComponent(canvasBindingsMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'canvas:bind');
    return sendJson(response, 201, await collaborationService.createCanvasBinding(
      projectId,
      await readJsonBody(request),
      { actor: identity.subjectId }
    ));
  }
  const canvasProposalsMatch = /^\/api\/projects\/([^/]+)\/canvas-change-proposals$/.exec(url.pathname);
  if (method === 'POST' && canvasProposalsMatch) {
    const projectId = decodeURIComponent(canvasProposalsMatch[1]);
    const identity = await requireProjectCapability(request, projectId, 'canvas-change:create');
    return sendJson(response, 201, await collaborationService.createCanvasChangeProposal(
      projectId,
      await readJsonBody(request),
      { actor: identity.subjectId }
    ));
  }
  const canvasProposalMatch = /^\/api\/projects\/([^/]+)\/canvas-change-proposals\/([^/]+)$/.exec(url.pathname);
  if (method === 'PATCH' && canvasProposalMatch) {
    const projectId = decodeURIComponent(canvasProposalMatch[1]);
    const proposalId = decodeURIComponent(canvasProposalMatch[2]);
    const identity = await requireProjectCapability(request, projectId, 'canvas-change:review');
    const input = await readJsonBody(request);
    const proposal = await collaborationService.getCanvasChangeProposal(projectId, proposalId);
    let result = null;
    if (String(input.decision ?? '').toUpperCase() === 'ACCEPT' && proposal.status === 'PENDING') {
      const moved = await service.moveWorkItemOnClientBoard(proposal.command.workItemId, {
        phaseId: proposal.command.targetPhaseId,
        statusId: proposal.command.statusId,
        expectedScheduleVersion: proposal.expectedScheduleVersion
      }, {
        actor: identity.subjectId,
        client: 'canvas',
        tool: 'canvas.change.accept',
        idempotencyKey: `canvas-proposal:${proposal.id}`,
        source: { kind: 'canvas-change-proposal', proposalId: proposal.id }
      });
      result = { workItemId: moved.id, status: moved.status, updatedAt: moved.updatedAt };
    }
    return sendJson(response, 200, await collaborationService.reviewCanvasChangeProposal(
      projectId,
      proposalId,
      { ...input, result },
      { actor: identity.subjectId }
    ));
  }

  const scenarioProposalsMatch = /^\/api\/projects\/([^/]+)\/test-scenario-proposals$/.exec(url.pathname);
  if (scenarioProposalsMatch) {
    const projectId = decodeURIComponent(scenarioProposalsMatch[1]);
    if (method === 'GET') {
      await requireProjectCapability(request, projectId, 'project:read');
      return sendJson(response, 200, { items: await testGovernanceWorkflow.listScenarioProposals(projectId, {
        status: url.searchParams.get('status'),
        categoryId: url.searchParams.get('categoryId')
      }) });
    }
    if (method === 'POST') {
      const identity = await requireProjectCapability(request, projectId, 'project:write');
      return sendJson(response, 201, await testGovernanceWorkflow.proposeScenario(
        projectId,
        await readJsonBody(request),
        { actor: identity.subjectId, provenance: 'SEMANTIC' }
      ));
    }
  }
  const scenarioProposalMatch = /^\/api\/projects\/([^/]+)\/test-scenario-proposals\/([^/]+)$/.exec(url.pathname);
  if (method === 'PATCH' && scenarioProposalMatch) {
    const projectId = decodeURIComponent(scenarioProposalMatch[1]);
    const proposalId = decodeURIComponent(scenarioProposalMatch[2]);
    const identity = await requireProjectCapability(request, projectId, 'test-governance:review');
    return sendJson(response, 200, await testGovernanceWorkflow.reviewScenarioProposal(
      projectId,
      proposalId,
      await readJsonBody(request),
      { actor: identity.subjectId }
    ));
  }
  const scenarioDraftMatch = /^\/api\/projects\/([^/]+)\/test-scenario-proposals\/([^/]+)\/draft$/.exec(url.pathname);
  if (method === 'POST' && scenarioDraftMatch) {
    const projectId = decodeURIComponent(scenarioDraftMatch[1]);
    const proposalId = decodeURIComponent(scenarioDraftMatch[2]);
    const identity = await requireProjectCapability(request, projectId, 'project:write');
    return sendJson(response, 201, await testGovernanceWorkflow.createTestDraft(
      projectId,
      proposalId,
      await readJsonBody(request),
      { actor: identity.subjectId }
    ));
  }
  const scenarioRunsMatch = /^\/api\/projects\/([^/]+)\/test-scenario-proposals\/([^/]+)\/runs$/.exec(url.pathname);
  if (method === 'POST' && scenarioRunsMatch) {
    const projectId = decodeURIComponent(scenarioRunsMatch[1]);
    const proposalId = decodeURIComponent(scenarioRunsMatch[2]);
    const identity = await requireProjectCapability(request, projectId, 'project:write');
    return sendJson(response, 201, await testGovernanceWorkflow.recordScenarioRun(
      projectId,
      proposalId,
      await readJsonBody(request),
      { actor: identity.subjectId }
    ));
  }
  const scenarioVerifyMatch = /^\/api\/projects\/([^/]+)\/test-scenario-proposals\/([^/]+)\/verify$/.exec(url.pathname);
  if (method === 'POST' && scenarioVerifyMatch) {
    const projectId = decodeURIComponent(scenarioVerifyMatch[1]);
    const proposalId = decodeURIComponent(scenarioVerifyMatch[2]);
    const identity = await requireProjectCapability(request, projectId, 'test-governance:verify');
    const input = await readJsonBody(request);
    if (String(input.method ?? '').toUpperCase() === 'OWNER_APPROVAL' && identity.role !== 'OWNER') {
      throw new HttpError(403, 'Only the project owner can provide owner approval', 'OWNER_APPROVAL_REQUIRED');
    }
    return sendJson(response, 200, await testGovernanceWorkflow.verifyScenario(
      projectId,
      proposalId,
      input,
      { actor: identity.subjectId }
    ));
  }

  const workItemMatch = /^\/api\/work-items\/([^/]+)$/.exec(url.pathname);
  const workItemDetailsMatch = /^\/api\/work-items\/([^/]+)\/details$/.exec(url.pathname);
  const workItemClientBoardMatch = /^\/api\/work-items\/([^/]+)\/client-board$/.exec(url.pathname);
  if (method === 'GET' && workItemDetailsMatch) {
    const workItemId = decodeURIComponent(workItemDetailsMatch[1]);
    const workItem = await service.getWorkItem(workItemId);
    await requireProjectCapability(request, workItem.projectId, 'project:read');
    return sendJson(response, 200, await service.getTaskDetails(workItemId));
  }
  if (method === 'PATCH' && workItemClientBoardMatch) {
    const workItemId = decodeURIComponent(workItemClientBoardMatch[1]);
    const workItem = await service.getWorkItem(workItemId);
    const identity = await requireProjectCapability(request, workItem.projectId, 'project:write');
    return sendJson(response, 200, await service.moveWorkItemOnClientBoard(
      workItemId,
      await readJsonBody(request),
      webMutationOptions(request, 'client_board.move', identity)
    ));
  }
  const workItemRestoreMatch = /^\/api\/work-items\/([^/]+)\/restore$/.exec(url.pathname);
  if (method === 'POST' && workItemRestoreMatch) {
    const workItemId = decodeURIComponent(workItemRestoreMatch[1]);
    const projectId = await projectIdForWorkItem(workItemId);
    const identity = await requireProjectCapability(request, projectId, 'project:write');
    return sendJson(response, 200, await service.restoreWorkItem(
      workItemId,
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.restore', identity)
    ));
  }
  if (method === 'GET' && workItemMatch) {
    const workItemId = decodeURIComponent(workItemMatch[1]);
    await requireProjectCapability(request, await projectIdForWorkItem(workItemId), 'project:read');
    return sendJson(response, 200, await service.getWorkItem(workItemId));
  }
  if (method === 'PATCH' && workItemMatch) {
    const workItemId = decodeURIComponent(workItemMatch[1]);
    const identity = await requireProjectCapability(request, await projectIdForWorkItem(workItemId), 'project:write');
    return sendJson(response, 200, await service.updateWorkItem(
      workItemId,
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.update', identity)
    ));
  }
  if (method === 'DELETE' && workItemMatch) {
    const workItemId = decodeURIComponent(workItemMatch[1]);
    const identity = await requireProjectCapability(request, await projectIdForWorkItem(workItemId), 'project:write');
    return sendJson(response, 200, await service.cancelWorkItem(
      workItemId,
      await readJsonBody(request),
      webMutationOptions(request, 'work_item.cancel', identity)
    ));
  }

  const readyMatch = /^\/api\/work-items\/([^/]+)\/ready$/.exec(url.pathname);
  if (method === 'POST' && readyMatch) {
    const workItemId = decodeURIComponent(readyMatch[1]);
    await requireProjectCapability(request, await projectIdForWorkItem(workItemId), 'project:write');
    return sendJson(response, 200, await service.markReady(workItemId));
  }

  const queueMatch = /^\/api\/work-items\/([^/]+)\/queue$/.exec(url.pathname);
  if (method === 'POST' && queueMatch) {
    const workItemId = decodeURIComponent(queueMatch[1]);
    await requireProjectCapability(request, await projectIdForWorkItem(workItemId), 'project:write');
    return sendJson(response, 202, await service.queueWorkItem(workItemId));
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

function isCanvasConfigured() {
  return Boolean(canvasUpstreamUrl && canvasSigningSecret.length >= 32);
}

function isCanvasProxyPath(pathname) {
  return pathname === canvasBasePath || pathname.startsWith(`${canvasBasePath}/`);
}

async function proxyCanvasHttp(request, response, url) {
  if (!isCanvasConfigured()) {
    throw new HttpError(503, 'Collaborative canvas is not configured', 'CANVAS_NOT_CONFIGURED');
  }
  if (!await isCanvasProxyAuthorized(url)) {
    throw new HttpError(403, 'Canvas session is invalid, expired, or revoked', 'CANVAS_SESSION_DENIED');
  }
  const target = buildWboProxyUrl(url, canvasUpstreamUrl, canvasBasePath);
  const client = target.protocol === 'https:' ? https : http;
  await new Promise((resolveProxy, rejectProxy) => {
    const proxyRequest = client.request(target, {
      method: request.method,
      headers: canvasProxyHeaders(request)
    });
    proxyRequest.once('response', (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers, 'referrer-policy': 'no-referrer' };
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
      upstreamResponse.once('end', resolveProxy);
      upstreamResponse.once('error', rejectProxy);
    });
    proxyRequest.once('error', rejectProxy);
    request.once('aborted', () => proxyRequest.destroy());
    request.pipe(proxyRequest);
  }).catch((error) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    console.error('Canvas proxy request failed', error.message);
    sendJson(response, 502, {
      error: { code: 'CANVAS_UPSTREAM_ERROR', message: 'Collaborative canvas is temporarily unavailable' }
    });
  });
}

async function isCanvasProxyAuthorized(url) {
  const suffix = url.pathname.slice(canvasBasePath.length);
  const protectedRequest = suffix.startsWith('/boards/') || suffix.startsWith('/socket.io/');
  if (!protectedRequest) return true;
  const token = url.searchParams.get('token');
  const payload = verifyWboCanvasToken({ token, secret: canvasSigningSecret });
  if (!payload) return false;
  if (!wboTokenAllowsPath(payload, url.pathname, canvasBasePath)) return false;
  if (!payload.grant) return true;
  const match = /^lifeline:(project_[^:]+):/.exec(String(payload.sub ?? ''));
  if (!match) return false;
  return collaborationService.isAccessGrantActive(payload.grant, match[1]);
}

function proxyCanvasUpgrade(request, socket, head, url) {
  if (!isCanvasConfigured()) return rejectUpgrade(socket, 503, 'Service Unavailable');
  let target;
  try {
    target = buildWboProxyUrl(url, canvasUpstreamUrl, canvasBasePath);
  } catch {
    return rejectUpgrade(socket, 503, 'Service Unavailable');
  }
  const client = target.protocol === 'https:' ? https : http;
  const proxyRequest = client.request(target, {
    method: request.method ?? 'GET',
    headers: canvasProxyHeaders(request, { upgrade: true })
  });
  proxyRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    writeRawResponseHead(socket, upstreamResponse);
    if (head?.length) upstreamSocket.write(head);
    if (upstreamHead?.length) socket.write(upstreamHead);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxyRequest.once('response', (upstreamResponse) => {
    writeRawResponseHead(socket, upstreamResponse);
    upstreamResponse.pipe(socket);
  });
  proxyRequest.once('error', (error) => {
    console.error('Canvas WebSocket proxy failed', error.message);
    rejectUpgrade(socket, 502, 'Bad Gateway');
  });
  proxyRequest.end();
}

function canvasProxyHeaders(request, { upgrade = false } = {}) {
  const headers = { ...request.headers };
  const remoteAddress = String(request.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  headers['x-forwarded-for'] = remoteAddress;
  headers['x-forwarded-host'] = String(request.headers.host ?? '');
  headers['x-forwarded-proto'] = request.socket?.encrypted ? 'https' : 'http';
  if (!upgrade) {
    delete headers.connection;
    delete headers.upgrade;
    delete headers['proxy-connection'];
  }
  return headers;
}

async function probeCanvasUpstream() {
  if (!isCanvasConfigured()) return false;
  let target;
  try {
    target = buildWboProxyUrl(
      new URL(`${canvasBasePath}/`, 'http://lifeline.local'),
      canvasUpstreamUrl,
      canvasBasePath
    );
  } catch {
    return false;
  }
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    const socket = net.connect({
      host: target.hostname,
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      finish(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      finish(true);
    });
    socket.once('error', () => finish(false));
  });
}

function writeRawResponseHead(socket, upstreamResponse) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ''}\r\n`);
  for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
    socket.write(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}\r\n`);
  }
  socket.write('\r\n');
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function handleError(response, error) {
  const domainStatus = error instanceof DomainError
    ? ({ NOT_FOUND: 404, SCHEDULE_VERSION_CONFLICT: 409 }[error.code] ?? 422)
    : null;
  const status = error instanceof HttpError
    ? error.status
    : error instanceof CanvasConfigurationError
      ? 503
      : domainStatus ?? 500;
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

function webMutationOptions(request, tool, identity = null) {
  return {
    actor: identity?.subjectId,
    client: 'web',
    tool,
    idempotencyKey: request.headers['idempotency-key'] ?? null,
    authoritativeAgentClock: ['agent_run.claim', 'agent_run.extend_lease'].includes(tool),
    source: { kind: 'web-ui' }
  };
}

async function optionalProjectAccessIdentity(request) {
  const token = projectBearerToken(request.headers);
  if (token) {
    const identity = await collaborationService.authenticateProjectToken(token);
    if (!identity) throw new HttpError(401, 'Project access link is invalid or expired', 'PROJECT_ACCESS_INVALID');
    return identity;
  }
  if (isLoopbackAddress(request.socket?.remoteAddress)) {
    return localOwnerIdentity();
  }
  const agent = authenticateAgentRequest(request.headers);
  if (agent.ok && agent.authInfo.scopes.includes('schedule:write')) {
    return localOwnerIdentity(agent.authInfo.clientId);
  }
  return null;
}

async function requireProjectCapability(request, projectId, capability) {
  const token = projectBearerToken(request.headers);
  if (token) {
    const identity = await collaborationService.authenticateProjectToken(token, projectId);
    if (!identity) throw new HttpError(403, 'This access link does not grant access to the project', 'PROJECT_ACCESS_DENIED');
    if (!hasProjectCapability(identity, capability)) {
      throw new HttpError(403, `Project role is missing ${capability}`, 'PROJECT_CAPABILITY_DENIED');
    }
    return identity;
  }
  if (isLoopbackAddress(request.socket?.remoteAddress)) {
    requireTrustedOwnerMutationOrigin(request);
    return localOwnerIdentity();
  }
  const agent = authenticateAgentRequest(request.headers);
  if (agent.ok && agent.authInfo.scopes.includes('schedule:write')) return localOwnerIdentity(agent.authInfo.clientId);
  if (!await collaborationService.hasProjectAccessControl(projectId)) {
    requireTrustedOwnerMutationOrigin(request);
    return localOwnerIdentity('legacy-project-owner');
  }
  throw new HttpError(401, 'A project access link is required', 'PROJECT_ACCESS_REQUIRED');
}

async function requireControlPlaneOwner(request) {
  if (isLoopbackAddress(request.socket?.remoteAddress)) {
    requireTrustedOwnerMutationOrigin(request);
    return localOwnerIdentity();
  }
  const agent = authenticateAgentRequest(request.headers);
  if (agent.ok && agent.authInfo.scopes.includes('schedule:write')) return localOwnerIdentity(agent.authInfo.clientId);
  if (!await collaborationService.hasAnyProjectAccessControl()) {
    requireTrustedOwnerMutationOrigin(request);
    return localOwnerIdentity('legacy-control-plane-owner');
  }
  throw new HttpError(401, 'A Lifeline management token is required', 'CONTROL_PLANE_ACCESS_REQUIRED');
}

function requireTrustedOwnerMutationOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(request.method ?? 'GET').toUpperCase())) return;
  const origin = request.headers.origin;
  if (origin && !isSameOrigin(origin, request.headers.host)) {
    throw new HttpError(403, 'Owner mutations require a same-origin Lifeline page', 'OWNER_ORIGIN_REQUIRED');
  }
}

async function projectIdForWorkItem(workItemId) {
  const state = await store.read();
  const workItem = state.workItems.find((entry) => entry.id === workItemId);
  if (!workItem) throw new DomainError(`work item not found: ${workItemId}`, 'NOT_FOUND');
  return workItem.projectId;
}

async function projectIdForPhase(phaseId) {
  const state = await store.read();
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (!phase) throw new DomainError(`phase not found: ${phaseId}`, 'NOT_FOUND');
  return phase.projectId;
}

function localOwnerIdentity(subjectId = 'local-owner') {
  return {
    kind: 'local-owner',
    subjectId,
    role: 'OWNER',
    capabilities: [...PROJECT_ACCESS_CAPABILITIES.OWNER]
  };
}

function clientProjectProjection(project) {
  return {
    id: project.id,
    name: project.name,
    headline: project.headline ?? null,
    description: project.description ?? '',
    repositoryUrl: project.repositoryUrl ?? null,
    status: project.status,
    scheduleVersion: Number(project.scheduleVersion) || 0,
    updatedAt: project.updatedAt
  };
}

function isLoopbackAddress(value) {
  const address = String(value ?? '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function contentType(extension) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
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

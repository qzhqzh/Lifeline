import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { DomainError, createId, nowIso } from './domain.js';

export const PROJECT_ACCESS_ROLES = Object.freeze(['VIEWER', 'EDITOR', 'MANAGER', 'OWNER']);
export const PROJECT_ACCESS_CAPABILITIES = Object.freeze({
  VIEWER: Object.freeze(['project:read']),
  EDITOR: Object.freeze(['project:read', 'project:write', 'canvas:open', 'canvas:edit', 'canvas:bind', 'canvas-change:create']),
  MANAGER: Object.freeze([
    'project:read',
    'project:write',
    'canvas:open',
    'canvas:edit',
    'canvas:bind',
    'canvas-change:create',
    'canvas-change:review',
    'access:manage',
    'test-governance:review',
    'test-governance:verify'
  ]),
  OWNER: Object.freeze([
    'project:read',
    'project:write',
    'canvas:open',
    'canvas:edit',
    'canvas:bind',
    'canvas-change:create',
    'canvas-change:review',
    'access:manage',
    'test-governance:review',
    'test-governance:verify'
  ])
});

const ACCESS_TOKEN_PREFIX = 'lfp_';
const CANVAS_ENTITY_TYPES = new Set(['PHASE', 'TASK']);
const CANVAS_CHANGE_STATUSES = new Set(['PENDING', 'ACCEPTED', 'DISMISSED']);

export class ProjectCollaborationService {
  #store;

  constructor({ store }) {
    this.#store = store;
  }

  async start() {
    await this.#store.ready();
  }

  async hasProjectAccessControl(projectId) {
    const state = await this.#store.read();
    requireProject(state, projectId);
    return state.projectAccessGrants.some((grant) => grant.projectId === projectId);
  }

  async hasAnyProjectAccessControl() {
    const state = await this.#store.read();
    return state.projectAccessGrants.length > 0;
  }

  async authenticateProjectToken(token, projectId = null, at = nowIso()) {
    const value = String(token ?? '').trim();
    if (!value.startsWith(ACCESS_TOKEN_PREFIX) || value.length > 512) return null;
    const tokenHash = hashToken(value);
    const state = await this.#store.read();
    const grant = state.projectAccessGrants.find((entry) => (
      secureEqual(entry.tokenHash, tokenHash)
        && (!projectId || entry.projectId === projectId)
    ));
    if (!grant || grant.status !== 'ACTIVE') return null;
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(at)) return null;
    return accessIdentity(grant);
  }

  async isAccessGrantActive(grantId, projectId, at = nowIso()) {
    const state = await this.#store.read();
    const grant = state.projectAccessGrants.find((entry) => entry.id === grantId && entry.projectId === projectId);
    return Boolean(grant
      && grant.status === 'ACTIVE'
      && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(at)));
  }

  async listAccessGrants(projectId) {
    const state = await this.#store.read();
    requireProject(state, projectId);
    return state.projectAccessGrants
      .filter((grant) => grant.projectId === projectId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(publicGrant);
  }

  async createAccessGrant(projectId, input = {}, options = {}) {
    const role = normalizeRole(input.role ?? 'VIEWER');
    const displayName = requireText(input.displayName, 'displayName', 120);
    const organizationId = optionalText(input.organizationId, 'organizationId', 160);
    const subjectId = optionalText(input.subjectId, 'subjectId', 160) ?? `guest:${slug(displayName)}`;
    const expiresAt = normalizeFutureTimestamp(input.expiresAt);
    const createdAt = nowIso();
    const token = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const actor = options.actor ?? 'local-owner';
    const grant = await this.#store.mutate((state) => {
      requireProject(state, projectId);
      const record = {
        id: createId('access'),
        projectId,
        subjectId,
        organizationId,
        displayName,
        role,
        capabilities: [...PROJECT_ACCESS_CAPABILITIES[role]],
        status: 'ACTIVE',
        tokenHash: hashToken(token),
        tokenHint: token.slice(-6),
        expiresAt,
        createdAt,
        createdBy: actor,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null
      };
      state.projectAccessGrants.push(record);
      appendAudit(state, 'project_access.granted', 'Project access granted', {
        projectId,
        grantId: record.id,
        subjectId,
        organizationId,
        role,
        expiresAt,
        actor
      });
      return record;
    });
    return { ...publicGrant(grant), token };
  }

  async revokeAccessGrant(projectId, grantId, input = {}, options = {}) {
    const reason = requireText(input.reason, 'reason', 500);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const grant = state.projectAccessGrants.find((entry) => entry.id === grantId && entry.projectId === projectId);
      if (!grant) throw new DomainError(`access grant not found: ${grantId}`, 'NOT_FOUND');
      if (grant.status === 'REVOKED') return publicGrant(grant);
      grant.status = 'REVOKED';
      grant.revokedAt = nowIso();
      grant.revokedBy = actor;
      grant.revokeReason = reason;
      appendAudit(state, 'project_access.revoked', 'Project access revoked', {
        projectId,
        grantId,
        subjectId: grant.subjectId,
        role: grant.role,
        reason,
        actor
      });
      return publicGrant(grant);
    });
  }

  async getCanvasContext(projectId) {
    const state = await this.#store.read();
    const project = requireProject(state, projectId);
    const phases = state.phases
      .filter((phase) => phase.projectId === projectId && phase.status !== 'CANCELLED')
      .sort((left, right) => Number(left.rank) - Number(right.rank))
      .map((phase) => ({
        id: phase.id,
        type: 'PHASE',
        title: phase.title,
        status: phase.status,
        href: `/client.html?project=${encodeURIComponent(projectId)}#phase=${encodeURIComponent(phase.id)}`
      }));
    const phaseIds = new Set(phases.map((phase) => phase.id));
    const tasks = state.workItems
      .filter((task) => task.projectId === projectId && task.status !== 'ARCHIVED')
      .sort((left, right) => Number(left.planning?.taskOrder) - Number(right.planning?.taskOrder))
      .map((task) => ({
        id: task.id,
        type: 'TASK',
        phaseId: phaseIds.has(task.phaseId ?? task.planning?.phaseId) ? task.phaseId ?? task.planning?.phaseId : null,
        title: task.title,
        status: task.status,
        href: `/client.html?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(task.id)}`
      }));
    return {
      project: { id: project.id, name: project.name, scheduleVersion: Number(project.scheduleVersion) || 0 },
      phases,
      tasks,
      bindings: state.canvasBindings.filter((entry) => entry.projectId === projectId),
      changeProposals: state.canvasChangeProposals
        .filter((entry) => entry.projectId === projectId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .map(publicCanvasProposal)
    };
  }

  async createCanvasBinding(projectId, input = {}, options = {}) {
    const entityType = String(input.entityType ?? '').trim().toUpperCase();
    if (!CANVAS_ENTITY_TYPES.has(entityType)) {
      throw new DomainError('entityType must be PHASE or TASK', 'INVALID_INPUT');
    }
    const entityId = requireText(input.entityId, 'entityId', 180);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      const project = requireProject(state, projectId);
      const entity = entityType === 'PHASE'
        ? state.phases.find((entry) => entry.id === entityId && entry.projectId === projectId)
        : state.workItems.find((entry) => entry.id === entityId && entry.projectId === projectId);
      if (!entity) throw new DomainError(`${entityType.toLowerCase()} not found: ${entityId}`, 'NOT_FOUND');
      const existing = state.canvasBindings.find((entry) => (
        entry.projectId === projectId && entry.entityType === entityType && entry.entityId === entityId
      ));
      if (existing) return existing;
      const binding = {
        id: createId('canvas_binding'),
        projectId,
        entityType,
        entityId,
        label: entity.title,
        boardId: input.boardId ?? null,
        canvasObjectId: optionalText(input.canvasObjectId, 'canvasObjectId', 180),
        href: entityType === 'TASK'
          ? `/client.html?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(entityId)}`
          : `/client.html?project=${encodeURIComponent(projectId)}#phase=${encodeURIComponent(entityId)}`,
        createdAt: nowIso(),
        createdBy: actor,
        projectScheduleVersion: Number(project.scheduleVersion) || 0
      };
      state.canvasBindings.push(binding);
      appendAudit(state, 'canvas.binding_created', 'Canvas project object binding created', {
        projectId,
        bindingId: binding.id,
        entityType,
        entityId,
        actor
      });
      return binding;
    });
  }

  async createCanvasChangeProposal(projectId, input = {}, options = {}) {
    const workItemId = requireText(input.workItemId, 'workItemId', 180);
    const targetPhaseId = requireText(input.targetPhaseId, 'targetPhaseId', 180);
    const statusId = normalizeClientStatus(input.statusId);
    const reason = requireText(input.reason, 'reason', 1000);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      const project = requireProject(state, projectId);
      const task = state.workItems.find((entry) => entry.id === workItemId && entry.projectId === projectId);
      const phase = state.phases.find((entry) => entry.id === targetPhaseId && entry.projectId === projectId);
      if (!task) throw new DomainError(`work item not found: ${workItemId}`, 'NOT_FOUND');
      if (!phase || phase.status === 'CANCELLED') throw new DomainError(`phase not found: ${targetPhaseId}`, 'NOT_FOUND');
      const fingerprint = hashStable([projectId, workItemId, targetPhaseId, statusId, reason]);
      const existing = state.canvasChangeProposals.find((entry) => (
        entry.projectId === projectId && entry.fingerprint === fingerprint && entry.status === 'PENDING'
      ));
      if (existing) return publicCanvasProposal(existing);
      const proposal = {
        id: createId('canvas_change'),
        fingerprint,
        projectId,
        kind: 'TASK_CLIENT_BOARD_MOVE',
        status: 'PENDING',
        title: `移动「${task.title}」`,
        reason,
        command: { workItemId, targetPhaseId, statusId },
        expectedScheduleVersion: Number(project.scheduleVersion) || 0,
        createdAt: nowIso(),
        createdBy: actor,
        reviewedAt: null,
        reviewedBy: null,
        reviewReason: null,
        result: null
      };
      state.canvasChangeProposals.push(proposal);
      appendAudit(state, 'canvas.change_proposed', 'Canvas project change proposed', {
        projectId,
        proposalId: proposal.id,
        workItemId,
        targetPhaseId,
        statusId,
        actor
      });
      return publicCanvasProposal(proposal);
    });
  }

  async getCanvasChangeProposal(projectId, proposalId) {
    const state = await this.#store.read();
    requireProject(state, projectId);
    const proposal = state.canvasChangeProposals.find((entry) => entry.id === proposalId && entry.projectId === projectId);
    if (!proposal) throw new DomainError(`canvas change proposal not found: ${proposalId}`, 'NOT_FOUND');
    return structuredClone(proposal);
  }

  async reviewCanvasChangeProposal(projectId, proposalId, input = {}, options = {}) {
    const decision = String(input.decision ?? '').trim().toUpperCase();
    if (!['ACCEPT', 'DISMISS'].includes(decision)) {
      throw new DomainError('decision must be ACCEPT or DISMISS', 'INVALID_INPUT');
    }
    const reason = requireText(input.reason, 'reason', 1000);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const proposal = state.canvasChangeProposals.find((entry) => entry.id === proposalId && entry.projectId === projectId);
      if (!proposal) throw new DomainError(`canvas change proposal not found: ${proposalId}`, 'NOT_FOUND');
      if (!CANVAS_CHANGE_STATUSES.has(proposal.status)) {
        throw new DomainError(`invalid canvas change proposal status: ${proposal.status}`, 'INVALID_INPUT');
      }
      const targetStatus = decision === 'ACCEPT' ? 'ACCEPTED' : 'DISMISSED';
      if (proposal.status === targetStatus) return publicCanvasProposal(proposal);
      if (proposal.status !== 'PENDING') {
        throw new DomainError('Canvas change proposal has already been reviewed', 'PROPOSAL_ALREADY_REVIEWED');
      }
      proposal.status = targetStatus;
      proposal.reviewedAt = nowIso();
      proposal.reviewedBy = actor;
      proposal.reviewReason = reason;
      proposal.result = input.result ? structuredClone(input.result) : null;
      appendAudit(state, `canvas.change_${decision === 'ACCEPT' ? 'accepted' : 'dismissed'}`, 'Canvas project change reviewed', {
        projectId,
        proposalId,
        decision,
        reason,
        actor,
        result: proposal.result
      });
      return publicCanvasProposal(proposal);
    });
  }

  async recordCanvasSession(projectId, input = {}, options = {}) {
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      appendAudit(state, 'canvas.session_issued', 'Canvas session issued', {
        projectId,
        boardId: input.boardId ?? null,
        expiresAt: input.expiresAt ?? null,
        grantId: options.grantId ?? null,
        actor
      });
      return true;
    });
  }
}

export function hasProjectCapability(identity, capability) {
  return Boolean(identity?.capabilities?.includes(capability));
}

export function projectBearerToken(headers = {}) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ''));
  const value = match?.[1]?.trim() ?? '';
  return value.startsWith(ACCESS_TOKEN_PREFIX) ? value : null;
}

function accessIdentity(grant) {
  return {
    kind: 'project-access',
    grantId: grant.id,
    projectId: grant.projectId,
    subjectId: grant.subjectId,
    organizationId: grant.organizationId,
    displayName: grant.displayName,
    role: grant.role,
    capabilities: [...grant.capabilities]
  };
}

function publicGrant(grant) {
  const { tokenHash: _tokenHash, ...safe } = grant;
  return structuredClone(safe);
}

function publicCanvasProposal(proposal) {
  return structuredClone(proposal);
}

function requireProject(state, projectId) {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw new DomainError(`project not found: ${projectId}`, 'NOT_FOUND');
  return project;
}

function normalizeRole(value) {
  const role = String(value ?? '').trim().toUpperCase();
  if (!PROJECT_ACCESS_ROLES.includes(role)) {
    throw new DomainError(`role must be one of: ${PROJECT_ACCESS_ROLES.join(', ')}`, 'INVALID_INPUT');
  }
  return role;
}

function normalizeClientStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  if (!['pending', 'scheduled', 'running', 'review'].includes(status)) {
    throw new DomainError('statusId must be pending, scheduled, running, or review', 'INVALID_INPUT');
  }
  return status;
}

function normalizeFutureTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw new DomainError('expiresAt must be a future ISO timestamp', 'INVALID_INPUT');
  }
  return date.toISOString();
}

function requireText(value, name, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) {
    throw new DomainError(`${name} is required and must not exceed ${maxLength} characters`, 'INVALID_INPUT');
  }
  return text;
}

function optionalText(value, name, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  return requireText(value, name, maxLength);
}

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashStable(parts) {
  return createHash('sha256').update(parts.map((entry) => String(entry ?? '').trim()).join('\u0000')).digest('hex');
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'guest';
}

function appendAudit(state, type, message, metadata) {
  const sequence = Math.max(0, ...state.events.map((entry) => Number(entry.sequence) || 0)) + 1;
  state.events.push({
    id: createId('event'),
    sequence,
    type,
    message,
    metadata: structuredClone(metadata),
    createdAt: nowIso()
  });
}

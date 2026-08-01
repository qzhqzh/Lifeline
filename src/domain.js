import { randomUUID } from 'node:crypto';

export const WORK_ITEM_STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  TRIAGED: 'TRIAGED',
  PLANNED: 'PLANNED',
  READY: 'READY',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  REVIEW: 'REVIEW',
  BLOCKED: 'BLOCKED',
  VERIFIED: 'VERIFIED',
  RELEASED: 'RELEASED',
  ARCHIVED: 'ARCHIVED'
});

export const RUN_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const RISK_TIERS = Object.freeze(['low', 'medium', 'high', 'critical']);

const TRANSITIONS = Object.freeze({
  [WORK_ITEM_STATUS.DISCOVERED]: [WORK_ITEM_STATUS.TRIAGED],
  [WORK_ITEM_STATUS.TRIAGED]: [WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.PLANNED]: [WORK_ITEM_STATUS.READY, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.READY]: [WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.QUEUED]: [WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.RUNNING]: [WORK_ITEM_STATUS.REVIEW, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.REVIEW]: [WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.VERIFIED, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.BLOCKED]: [WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.READY],
  [WORK_ITEM_STATUS.VERIFIED]: [WORK_ITEM_STATUS.RELEASED, WORK_ITEM_STATUS.ARCHIVED],
  [WORK_ITEM_STATUS.RELEASED]: [WORK_ITEM_STATUS.ARCHIVED],
  [WORK_ITEM_STATUS.ARCHIVED]: []
});

export class DomainError extends Error {
  constructor(message, code = 'DOMAIN_ERROR', details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(clock = Date) {
  return new clock().toISOString();
}

export function assertTransition(from, to) {
  if (from === to) return;
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new DomainError(`Invalid work item transition: ${from} -> ${to}`, 'INVALID_TRANSITION', {
      from,
      to,
      allowed
    });
  }
}

export function transitionWorkItem(workItem, nextStatus, at = nowIso()) {
  assertTransition(workItem.status, nextStatus);
  return {
    ...workItem,
    status: nextStatus,
    updatedAt: at
  };
}

export function validateProjectInput(input) {
  const name = requireString(input?.name, 'name', 2, 120);
  const repositoryUrl = optionalString(input?.repositoryUrl, 'repositoryUrl', 500);
  const description = optionalString(input?.description, 'description', 2000) ?? '';
  const strategicValue = normalizeNumber(input?.strategicValue ?? 5, 'strategicValue', 1, 10);
  return { name, repositoryUrl, description, strategicValue };
}

export function validateWorkItemInput(input) {
  const projectId = requireString(input?.projectId, 'projectId', 3, 120);
  const title = requireString(input?.title, 'title', 3, 180);
  const objective = requireString(input?.objective, 'objective', 8, 4000);
  const nonGoals = normalizeStringArray(input?.nonGoals ?? [], 'nonGoals', 20, 500);
  const acceptanceCriteria = normalizeStringArray(input?.acceptanceCriteria ?? [], 'acceptanceCriteria', 30, 1000);
  const testCommands = normalizeStringArray(input?.testCommands ?? [], 'testCommands', 20, 500);
  const riskTier = input?.riskTier ?? 'medium';
  if (!RISK_TIERS.includes(riskTier)) {
    throw new DomainError(`riskTier must be one of: ${RISK_TIERS.join(', ')}`, 'INVALID_INPUT');
  }
  const weight = normalizeNumber(input?.weight ?? 1, 'weight', 0.1, 100);
  const resourceProfile = {
    cpu: normalizeNumber(input?.resourceProfile?.cpu ?? 1, 'resourceProfile.cpu', 0, 512),
    memoryGb: normalizeNumber(input?.resourceProfile?.memoryGb ?? 1, 'resourceProfile.memoryGb', 0, 4096),
    apiBudgetUsd: normalizeNumber(input?.resourceProfile?.apiBudgetUsd ?? 1, 'resourceProfile.apiBudgetUsd', 0, 100000),
    humanReviewMinutes: normalizeNumber(
      input?.resourceProfile?.humanReviewMinutes ?? 5,
      'resourceProfile.humanReviewMinutes',
      0,
      100000
    )
  };

  return {
    projectId,
    title,
    objective,
    nonGoals,
    acceptanceCriteria,
    testCommands,
    riskTier,
    weight,
    resourceProfile
  };
}

export function validateReadyContract(workItem) {
  const violations = [];
  if (!workItem.objective?.trim()) violations.push('objective is required');
  if (!Array.isArray(workItem.acceptanceCriteria) || workItem.acceptanceCriteria.length === 0) {
    violations.push('at least one acceptance criterion is required');
  }
  if (!Array.isArray(workItem.testCommands) || workItem.testCommands.length === 0) {
    violations.push('at least one test command is required');
  }
  if (!RISK_TIERS.includes(workItem.riskTier)) violations.push('risk tier is invalid');
  if (!workItem.resourceProfile) violations.push('resource profile is required');

  if (violations.length > 0) {
    throw new DomainError('Work item is not ready for execution', 'INVALID_EXECUTION_CONTRACT', { violations });
  }
  return true;
}

export function evidenceScoreForWorkItem(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return 0;
  return Math.max(...evidence.map((entry) => clamp(Number(entry.score) || 0, 0, 1)));
}

export function calculateProjectProgress(workItems, evidence) {
  const eligible = workItems.filter((item) => item.status !== WORK_ITEM_STATUS.ARCHIVED);
  const totalWeight = eligible.reduce((sum, item) => sum + (Number(item.weight) || 1), 0);
  if (totalWeight === 0) return 0;

  const weighted = eligible.reduce((sum, item) => {
    const itemEvidence = evidence.filter((entry) => entry.workItemId === item.id);
    return sum + (Number(item.weight) || 1) * evidenceScoreForWorkItem(itemEvidence);
  }, 0);

  return Number((weighted / totalWeight).toFixed(4));
}

export function createProject(input, at = nowIso()) {
  const normalized = validateProjectInput(input);
  return {
    id: createId('project'),
    ...normalized,
    status: 'ACTIVE',
    createdAt: at,
    updatedAt: at
  };
}

export function createWorkItem(input, at = nowIso()) {
  const normalized = validateWorkItemInput(input);
  return {
    id: createId('work'),
    ...normalized,
    status: WORK_ITEM_STATUS.PLANNED,
    currentRunId: null,
    createdAt: at,
    updatedAt: at
  };
}

function requireString(value, name, min, max) {
  if (typeof value !== 'string') {
    throw new DomainError(`${name} must be a string`, 'INVALID_INPUT');
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new DomainError(`${name} length must be between ${min} and ${max}`, 'INVALID_INPUT');
  }
  return normalized;
}

function optionalString(value, name, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new DomainError(`${name} must be a string no longer than ${max} characters`, 'INVALID_INPUT');
  }
  return value.trim();
}

function normalizeStringArray(value, name, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DomainError(`${name} must be an array with at most ${maxItems} items`, 'INVALID_INPUT');
  }
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`, 1, maxLength));
}

function normalizeNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new DomainError(`${name} must be between ${min} and ${max}`, 'INVALID_INPUT');
  }
  return number;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

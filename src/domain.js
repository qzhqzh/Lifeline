import { randomUUID } from 'node:crypto';

export const WORK_ITEM_STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  TRIAGED: 'TRIAGED',
  PLANNED: 'PLANNED',
  DEFERRED: 'DEFERRED',
  READY: 'READY',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  REVIEW: 'REVIEW',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  RECURRING: 'RECURRING',
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
export const WORK_ITEM_KINDS = Object.freeze(['feature', 'bug', 'scan', 'research', 'ops', 'review']);
export const WORK_ITEM_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const SCHEDULE_COMMITMENTS = Object.freeze(['COMMITTED', 'TENTATIVE']);
export const COMPUTE_CLASSES = Object.freeze(['low', 'medium', 'high']);
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const PARALLEL_POLICIES = Object.freeze(['AUTO', 'SEQUENTIAL', 'PARALLEL_ALLOWED']);
export const PHASE_STATUS = Object.freeze(['ACTIVE', 'COMPLETED', 'CANCELLED']);
export const COMPLETION_METHODS = Object.freeze(['AGENT_RUN', 'HUMAN', 'IMPORTED_HISTORY']);
export const TASK_ORIGINS = Object.freeze(['HUMAN', 'AI', 'IMPORTED', 'UNKNOWN']);
// Version 2 introduced planning/recommendation metadata. Version 3 adds
// Phase, bootstrap receipt, migration snapshot and completion collections.
// Version 4 adds durable, fingerprinted scan proposals before task creation.
export const CURRENT_SCHEMA_VERSION = 4;
export const DEFAULT_LOCAL_USER_ID = 'local-owner';
export const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

const RECOMMENDATION_DEFAULTS = Object.freeze({
  feature: {
    capability: 'agentic-coding',
    executor: 'codex',
    reasoningEffort: 'high',
    compute: 'high',
    estimateMinutes: 90,
    approach: '先确认执行契约与验收证据，再实现并独立审查。'
  },
  bug: {
    capability: 'code-repair',
    executor: 'codex',
    reasoningEffort: 'high',
    compute: 'medium',
    estimateMinutes: 45,
    approach: '先复现并补回归测试，再做最小修复。'
  },
  scan: {
    capability: 'repository-scan',
    executor: 'codex',
    reasoningEffort: 'low',
    compute: 'low',
    estimateMinutes: 20,
    approach: '先跑确定性检查，只把异常和高价值区域交给模型分析。'
  },
  research: {
    capability: 'research-synthesis',
    executor: 'codex',
    reasoningEffort: 'medium',
    compute: 'medium',
    estimateMinutes: 40,
    approach: '先快速铺开证据，再用强推理收敛分歧和方案。'
  },
  ops: {
    capability: 'safe-automation',
    executor: 'shell',
    reasoningEffort: 'medium',
    compute: 'low',
    estimateMinutes: 30,
    approach: '优先使用确定性脚本，高风险动作保留人工审批。'
  },
  review: {
    capability: 'independent-review',
    executor: 'codex',
    reasoningEffort: 'high',
    compute: 'medium',
    estimateMinutes: 35,
    approach: '与实现上下文隔离审查，先报告可验证问题再决定修改。'
  }
});

const TRANSITIONS = Object.freeze({
  [WORK_ITEM_STATUS.DISCOVERED]: [WORK_ITEM_STATUS.TRIAGED, WORK_ITEM_STATUS.CANCELLED],
  [WORK_ITEM_STATUS.TRIAGED]: [WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.BLOCKED, WORK_ITEM_STATUS.CANCELLED],
  [WORK_ITEM_STATUS.PLANNED]: [WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.READY, WORK_ITEM_STATUS.BLOCKED, WORK_ITEM_STATUS.CANCELLED],
  [WORK_ITEM_STATUS.DEFERRED]: [WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.READY, WORK_ITEM_STATUS.CANCELLED],
  [WORK_ITEM_STATUS.READY]: [WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.BLOCKED, WORK_ITEM_STATUS.CANCELLED],
  [WORK_ITEM_STATUS.QUEUED]: [WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.RUNNING]: [WORK_ITEM_STATUS.REVIEW, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.REVIEW]: [WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.RECURRING, WORK_ITEM_STATUS.VERIFIED, WORK_ITEM_STATUS.BLOCKED],
  [WORK_ITEM_STATUS.BLOCKED]: [WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.READY, WORK_ITEM_STATUS.CANCELLED],
  [WORK_ITEM_STATUS.CANCELLED]: [],
  [WORK_ITEM_STATUS.RECURRING]: [WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.ARCHIVED],
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

/**
 * Resolve the local identity used by the JSON MVP.  This is deliberately
 * deterministic: a browser cache or request body must not decide ownership
 * of a bootstrap receipt.
 */
export function resolveLocalUserId(value = process.env.LIFELINE_LOCAL_USER_ID) {
  const userId = value === undefined || value === null || value === '' ? DEFAULT_LOCAL_USER_ID : value;
  return requireString(userId, 'localUserId', 1, 160);
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
  const issue = optionalString(input?.issue, 'issue', 1000);
  const starred = input?.starred ?? false;
  if (typeof starred !== 'boolean') {
    throw new DomainError('starred must be a boolean', 'INVALID_INPUT');
  }
  const scheduledFor = normalizeDateString(input?.scheduledFor, 'scheduledFor');
  const dependsOnTaskIds = normalizeStringArray(input?.dependsOnTaskIds ?? [], 'dependsOnTaskIds', 100, 160);
  if (new Set(dependsOnTaskIds).size !== dependsOnTaskIds.length) {
    throw new DomainError('dependsOnTaskIds must not contain duplicates', 'INVALID_INPUT');
  }
  const parallelPolicy = input?.parallelPolicy ?? 'AUTO';
  if (!PARALLEL_POLICIES.includes(parallelPolicy)) {
    throw new DomainError(`parallelPolicy must be one of: ${PARALLEL_POLICIES.join(', ')}`, 'INVALID_INPUT');
  }
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
  const planning = normalizePlanning(input?.planning);
  const recommendation = normalizeRecommendation(input?.recommendation, planning.kind);
  const phaseId = optionalString(input?.phaseId, 'phaseId', 160);

  return {
    projectId,
    title,
    objective,
    nonGoals,
    acceptanceCriteria,
    testCommands,
    issue,
    starred,
    scheduledFor,
    dependsOnTaskIds,
    parallelPolicy,
    riskTier,
    weight,
    resourceProfile,
    planning,
    recommendation,
    ...(phaseId ? { phaseId } : {})
  };
}

export function hydrateWorkItemMetadata(workItem) {
  const planning = normalizePlanning(workItem?.planning);
  const phaseId = optionalString(workItem?.phaseId, 'phaseId', 160);
  if (phaseId && !planning.phaseId) planning.phaseId = phaseId;
  return {
    ...workItem,
    issue: optionalString(workItem?.issue, 'issue', 1000),
    starred: workItem?.starred === true,
    scheduledFor: normalizeDateString(workItem?.scheduledFor, 'scheduledFor'),
    dependsOnTaskIds: normalizeStringArray(workItem?.dependsOnTaskIds ?? [], 'dependsOnTaskIds', 100, 160),
    parallelPolicy: PARALLEL_POLICIES.includes(workItem?.parallelPolicy) ? workItem.parallelPolicy : 'AUTO',
    planning,
    recommendation: normalizeRecommendation(workItem?.recommendation, planning.kind),
    provenance: hydrateTaskProvenance(workItem)
  };
}

export function hydrateTaskProvenance(workItem = {}) {
  const existing = workItem?.provenance && typeof workItem.provenance === 'object'
    ? workItem.provenance
    : {};
  const origin = TASK_ORIGINS.includes(existing.origin)
    ? existing.origin
    : inferTaskOrigin(workItem?.source, workItem);
  return {
    origin,
    createdVia: existing.createdVia ?? createdViaForOrigin(origin, workItem?.source),
    createdBy: existing.createdBy ?? workItem?.createdBy ?? null,
    contentAdjustedByHuman: Boolean(existing.contentAdjustedByHuman),
    lastContentEditorType: ['HUMAN', 'AI'].includes(existing.lastContentEditorType)
      ? existing.lastContentEditorType
      : null,
    lastContentEditedAt: existing.lastContentEditedAt ?? null,
    edits: Array.isArray(existing.edits) ? structuredClone(existing.edits) : []
  };
}

export function inferTaskOrigin(source, workItem = {}) {
  const kind = String(typeof source === 'string' ? source : source?.kind ?? '').toLowerCase();
  if (workItem?.templateKey || workItem?.historySources?.length || /template|import|history|demo|bootstrap/.test(kind)) {
    return 'IMPORTED';
  }
  if (/mcp|codex|agent|\bai\b/.test(kind)) return 'AI';
  if (/web|human|manual|ui/.test(kind)) return 'HUMAN';
  return 'UNKNOWN';
}

function createdViaForOrigin(origin, source) {
  const kind = String(typeof source === 'string' ? source : source?.kind ?? '').toLowerCase();
  if (origin === 'AI') return 'MCP';
  if (origin === 'IMPORTED') return 'IMPORT';
  if (origin === 'HUMAN' && /web|ui/.test(kind)) return 'WEB';
  return 'SERVICE';
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
  const eligible = workItems.filter((item) => ![WORK_ITEM_STATUS.ARCHIVED, WORK_ITEM_STATUS.CANCELLED].includes(item.status));
  const totalWeight = eligible.reduce((sum, item) => sum + (Number(item.weight) || 1), 0);
  if (totalWeight === 0) return 0;

  const weighted = eligible.reduce((sum, item) => {
    if (item.status === WORK_ITEM_STATUS.RECURRING) {
      return sum + (Number(item.weight) || 1);
    }
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
    currentTaskId: null,
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

export function validatePhaseInput(input) {
  const projectId = requireString(input?.projectId, 'projectId', 3, 120);
  const title = requireString(input?.title, 'title', 1, 180);
  const goal = optionalString(input?.goal, 'goal', 2000) ?? '';
  const rank = normalizeNumber(input?.rank ?? input?.phaseOrder ?? 1024, 'rank', 1, 1000000000);
  const status = input?.status ?? 'ACTIVE';
  if (!PHASE_STATUS.includes(status)) {
    throw new DomainError(`status must be one of: ${PHASE_STATUS.join(', ')}`, 'INVALID_INPUT');
  }
  const createdBy = optionalString(input?.createdBy, 'createdBy', 160);
  return { projectId, title, goal, rank, status, createdBy };
}

export function createPhase(input, at = nowIso()) {
  const normalized = validatePhaseInput(input);
  return {
    id: createId('phase'),
    ...normalized,
    phaseOrder: normalized.rank >= 1024 && normalized.rank % 1024 === 0
      ? normalized.rank / 1024
      : normalized.rank,
    createdAt: at,
    updatedAt: at
  };
}

export function validateBootstrapReceiptInput(input) {
  const userId = requireString(input?.userId, 'userId', 1, 160);
  const templateKey = requireString(input?.templateKey, 'templateKey', 1, 180);
  const templateVersion = requireString(input?.templateVersion, 'templateVersion', 1, 80);
  const appliedAt = requireString(input?.appliedAt ?? nowIso(), 'appliedAt', 1, 80);
  const resultProjectIds = normalizeStringArray(
    input?.resultProjectIds ?? input?.projectIds ?? [],
    'resultProjectIds',
    100,
    160
  );
  const sourceSnapshotHash = optionalString(input?.sourceSnapshotHash, 'sourceSnapshotHash', 256);
  const idempotencyKey = optionalString(input?.idempotencyKey, 'idempotencyKey', 256);
  return {
    userId,
    templateKey,
    templateVersion,
    appliedAt,
    resultProjectIds,
    sourceSnapshotHash,
    idempotencyKey
  };
}

export function createBootstrapReceipt(input, at = nowIso()) {
  const normalized = validateBootstrapReceiptInput({ ...input, appliedAt: input?.appliedAt ?? at });
  return {
    id: createId('bootstrap'),
    ...normalized,
    projectIds: normalized.resultProjectIds,
    createdAt: at
  };
}

export function validateCompletionRecordInput(input) {
  const taskId = requireString(input?.taskId ?? input?.workItemId, 'taskId', 3, 160);
  const completionMethod = input?.completionMethod ?? 'HUMAN';
  if (!COMPLETION_METHODS.includes(completionMethod)) {
    throw new DomainError(
      `completionMethod must be one of: ${COMPLETION_METHODS.join(', ')}`,
      'INVALID_INPUT'
    );
  }
  const runId = optionalString(input?.runId, 'runId', 160);
  const agentId = optionalString(input?.agentId, 'agentId', 160);
  const executor = optionalString(input?.executor, 'executor', 160);
  const provider = optionalString(input?.provider, 'provider', 160);
  const modelRef = optionalString(input?.modelRef, 'modelRef', 240);
  const reasoningEffort = optionalString(input?.reasoningEffort, 'reasoningEffort', 80);
  const promptVersion = optionalString(input?.promptVersion, 'promptVersion', 160);
  const policyVersion = optionalString(input?.policyVersion, 'policyVersion', 160);
  const commitSha = optionalString(input?.commitSha, 'commitSha', 200);
  const prUrl = optionalString(input?.prUrl, 'prUrl', 1000);
  const artifactUris = normalizeStringArray(input?.artifactUris ?? [], 'artifactUris', 100, 1000);
  const testEvidenceIds = normalizeStringArray(input?.testEvidenceIds ?? [], 'testEvidenceIds', 100, 160);
  const reviewEvidenceIds = normalizeStringArray(input?.reviewEvidenceIds ?? [], 'reviewEvidenceIds', 100, 160);
  const resultSummary = optionalString(input?.resultSummary, 'resultSummary', 4000) ?? '';
  const submittedBy = optionalString(input?.submittedBy, 'submittedBy', 160);
  const verifiedBy = optionalString(input?.verifiedBy, 'verifiedBy', 160);
  const inputTokens = normalizeOptionalNumber(input?.inputTokens, 'inputTokens', 0, 1000000000);
  const outputTokens = normalizeOptionalNumber(input?.outputTokens, 'outputTokens', 0, 1000000000);
  const cost = normalizeOptionalNumber(input?.cost, 'cost', 0, 1000000000);
  const durationMs = normalizeOptionalNumber(input?.durationMs, 'durationMs', 0, 100000000000);
  return {
    taskId,
    runId,
    completionMethod,
    agentId,
    executor,
    provider,
    modelRef,
    modelSnapshot: input?.modelSnapshot ?? null,
    reasoningEffort,
    promptVersion,
    policyVersion,
    startedAt: optionalString(input?.startedAt, 'startedAt', 80),
    completedAt: optionalString(input?.completedAt, 'completedAt', 80),
    durationMs,
    inputTokens,
    outputTokens,
    cost,
    commitSha,
    prUrl,
    artifactUris,
    testEvidenceIds,
    reviewEvidenceIds,
    submittedAt: optionalString(input?.submittedAt, 'submittedAt', 80),
    submittedBy,
    verifiedAt: optionalString(input?.verifiedAt, 'verifiedAt', 80),
    verifiedBy,
    resultSummary
  };
}

export function createCompletionRecord(input, at = nowIso()) {
  const normalized = validateCompletionRecordInput({
    ...input,
    submittedAt: input?.submittedAt ?? at
  });
  return {
    id: createId('completion'),
    ...normalized,
    // Keep both names during the Task/WorkItem compatibility window.
    workItemId: normalized.taskId,
    createdAt: at
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

function normalizeDateString(value, name) {
  const normalized = optionalString(value, name, 10);
  if (normalized === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new DomainError(`${name} must use YYYY-MM-DD`, 'INVALID_INPUT');
  }
  const [year, month, day] = normalized.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new DomainError(`${name} must be a valid calendar date`, 'INVALID_INPUT');
  }
  return normalized;
}

function normalizeStringArray(value, name, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DomainError(`${name} must be an array with at most ${maxItems} items`, 'INVALID_INPUT');
  }
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`, 1, maxLength));
}

function normalizePlanning(input = {}) {
  const kind = input?.kind ?? 'feature';
  if (!WORK_ITEM_KINDS.includes(kind)) {
    throw new DomainError(`planning.kind must be one of: ${WORK_ITEM_KINDS.join(', ')}`, 'INVALID_INPUT');
  }
  const priority = input?.priority ?? 'P1';
  if (!WORK_ITEM_PRIORITIES.includes(priority)) {
    throw new DomainError(`planning.priority must be one of: ${WORK_ITEM_PRIORITIES.join(', ')}`, 'INVALID_INPUT');
  }
  const commitment = input?.commitment ?? 'TENTATIVE';
  if (!SCHEDULE_COMMITMENTS.includes(commitment)) {
    throw new DomainError(
      `planning.commitment must be one of: ${SCHEDULE_COMMITMENTS.join(', ')}`,
      'INVALID_INPUT'
    );
  }
  const planning = {
    phase: optionalString(input?.phase, 'planning.phase', 120) ?? '待排期',
    phaseOrder: normalizeNumber(input?.phaseOrder ?? 99, 'planning.phaseOrder', 1, 999),
    taskOrder: normalizeNumber(input?.taskOrder ?? 99, 'planning.taskOrder', 1, 999),
    kind,
    priority,
    commitment
  };
  const phaseId = optionalString(input?.phaseId, 'planning.phaseId', 160);
  if (phaseId) planning.phaseId = phaseId;
  return planning;
}

function normalizeRecommendation(input = {}, kind = 'feature') {
  const defaults = RECOMMENDATION_DEFAULTS[kind] ?? RECOMMENDATION_DEFAULTS.feature;
  const reasoningEffort = input?.reasoningEffort ?? defaults.reasoningEffort;
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new DomainError(
      `recommendation.reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}`,
      'INVALID_INPUT'
    );
  }
  const compute = input?.compute ?? defaults.compute;
  if (!COMPUTE_CLASSES.includes(compute)) {
    throw new DomainError(`recommendation.compute must be one of: ${COMPUTE_CLASSES.join(', ')}`, 'INVALID_INPUT');
  }
  return {
    capability: optionalString(input?.capability, 'recommendation.capability', 120) ?? defaults.capability,
    executor: optionalString(input?.executor, 'recommendation.executor', 120) ?? defaults.executor,
    reasoningEffort,
    compute,
    estimateMinutes: normalizeNumber(
      input?.estimateMinutes ?? defaults.estimateMinutes,
      'recommendation.estimateMinutes',
      1,
      100000
    ),
    approach: optionalString(input?.approach, 'recommendation.approach', 500) ?? defaults.approach
  };
}

function normalizeNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new DomainError(`${name} must be between ${min} and ${max}`, 'INVALID_INPUT');
  }
  return number;
}

function normalizeOptionalNumber(value, name, min, max) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeNumber(value, name, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

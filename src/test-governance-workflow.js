import { createHash } from 'node:crypto';

import { DomainError, createId, nowIso } from './domain.js';

export const TEST_SCENARIO_WORKFLOW_STATES = Object.freeze([
  'PROPOSED',
  'REVIEW',
  'ACCEPTED',
  'TEST_DRAFT',
  'RED_PROVEN',
  'IMPLEMENTING',
  'GREEN',
  'VERIFIED',
  'COVERED_EXISTING',
  'NEEDS_CORRECTION',
  'DISMISSED',
  'SUPPRESSED',
  'OBSOLETE'
]);

const REVIEW_ACTIONS = Object.freeze({
  START_REVIEW: { from: ['PROPOSED'], to: 'REVIEW' },
  ACCEPT: { from: ['REVIEW'], to: 'ACCEPTED' },
  DISMISS: { from: ['REVIEW'], to: 'DISMISSED' },
  SUPPRESS: { from: ['REVIEW'], to: 'SUPPRESSED' },
  REOPEN: { from: ['DISMISSED', 'SUPPRESSED', 'OBSOLETE'], to: 'REVIEW' }
});

const TEST_FRAMEWORKS = new Set(['NODE_TEST', 'PYTEST', 'JUNIT']);
const RUN_STAGES = new Set(['BASELINE', 'IMPLEMENTATION']);
const RUN_OUTCOMES = new Set(['PASSED', 'FAILED']);
const VERIFICATION_METHODS = new Set(['DETERMINISTIC_TEST', 'INDEPENDENT_REVIEW', 'OWNER_APPROVAL']);

export class TestGovernanceWorkflowService {
  #store;
  #lifelineService;

  constructor({ store, lifelineService }) {
    this.#store = store;
    this.#lifelineService = lifelineService;
  }

  async start() {
    await this.#store.ready();
  }

  async syncScenarioCatalog(projectId, scenarioCatalog, options = {}) {
    const incoming = Array.isArray(scenarioCatalog?.scenarios) ? scenarioCatalog.scenarios : [];
    const actor = options.actor ?? 'test-catalog';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const seen = new Set();
      let created = 0;
      let updated = 0;
      let obsoleted = 0;
      for (const scenario of incoming) {
        const normalized = normalizeScenario(projectId, scenario, {
          provenance: options.provenance ?? 'DETERMINISTIC',
          analysis: options.analysis ?? null,
          seenAt: scenarioCatalog?.generatedAt ?? nowIso()
        });
        seen.add(normalized.fingerprint);
        const existing = state.testScenarioProposals.find((entry) => (
          entry.projectId === projectId && entry.fingerprint === normalized.fingerprint
        ));
        if (existing) {
          const before = scenarioComparable(existing);
          Object.assign(existing, {
            title: normalized.title,
            categoryIds: normalized.categoryIds,
            preconditions: normalized.preconditions,
            action: normalized.action,
            expected: normalized.expected,
            riskIds: normalized.riskIds,
            sourceEvidence: normalized.sourceEvidence,
            matchedTestIds: normalized.matchedTestIds,
            coverageState: normalized.coverageState,
            lastSeenAt: normalized.lastSeenAt,
            extractorVersion: normalized.extractorVersion,
            analysis: normalized.analysis
          });
          if (existing.status === 'OBSOLETE') existing.status = 'PROPOSED';
          if (before !== scenarioComparable(existing)) updated += 1;
          continue;
        }
        state.testScenarioProposals.push(normalized);
        created += 1;
      }
      for (const proposal of state.testScenarioProposals) {
        if (proposal.projectId !== projectId || proposal.provenance !== 'DETERMINISTIC') continue;
        if (!seen.has(proposal.fingerprint) && !['VERIFIED', 'SUPPRESSED'].includes(proposal.status)) {
          proposal.status = 'OBSOLETE';
          proposal.coverageState = 'obsolete';
          proposal.updatedAt = nowIso();
          obsoleted += 1;
        }
      }
      if (created || updated || obsoleted) {
        appendAudit(state, 'test_scenarios.synced', 'Test scenario catalog synchronized', {
          projectId,
          actor,
          extractorVersion: scenarioCatalog?.extractorVersion ?? null,
          created,
          updated,
          obsoleted,
          total: incoming.length
        });
      }
      return { created, updated, obsoleted, total: incoming.length };
    });
  }

  async proposeScenario(projectId, input = {}, options = {}) {
    const normalized = normalizeScenario(projectId, input, {
      provenance: String(options.provenance ?? input.provenance ?? 'SEMANTIC').toUpperCase(),
      analysis: {
        analyzer: optionalText(input.analyzer, 'analyzer', 160),
        analyzerVersion: optionalText(input.analyzerVersion, 'analyzerVersion', 160),
        model: optionalText(input.model, 'model', 240),
        rationale: optionalText(input.rationale, 'rationale', 4000)
      }
    });
    const actor = options.actor ?? 'test-analyzer';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const existing = state.testScenarioProposals.find((entry) => (
        entry.projectId === projectId && entry.fingerprint === normalized.fingerprint
      ));
      if (existing) {
        existing.lastSeenAt = normalized.lastSeenAt;
        existing.sourceEvidence = normalized.sourceEvidence;
        existing.matchedTestIds = normalized.matchedTestIds;
        existing.coverageState = normalized.coverageState;
        existing.analysis = normalized.analysis;
        return publicProposal(existing);
      }
      state.testScenarioProposals.push(normalized);
      appendAudit(state, 'test_scenario.proposed', 'Test scenario proposed', {
        projectId,
        proposalId: normalized.id,
        fingerprint: normalized.fingerprint,
        provenance: normalized.provenance,
        actor
      });
      return publicProposal(normalized);
    });
  }

  async listScenarioProposals(projectId, { status = null, categoryId = null } = {}) {
    const state = await this.#store.read();
    requireProject(state, projectId);
    const normalizedStatus = status ? normalizeWorkflowState(status) : null;
    return state.testScenarioProposals
      .filter((entry) => entry.projectId === projectId)
      .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
      .filter((entry) => !categoryId || entry.categoryIds.includes(categoryId))
      .sort(compareProposals)
      .map(publicProposal);
  }

  async getScenarioProposal(projectId, proposalId) {
    const state = await this.#store.read();
    requireProject(state, projectId);
    return publicProposal(requireProposal(state, projectId, proposalId));
  }

  async reviewScenarioProposal(projectId, proposalId, input = {}, options = {}) {
    const action = String(input.action ?? '').trim().toUpperCase();
    const rule = REVIEW_ACTIONS[action];
    if (!rule) throw new DomainError(`Unsupported review action: ${action}`, 'INVALID_INPUT');
    const reason = action === 'START_REVIEW'
      ? optionalText(input.reason, 'reason', 1000)
      : requireText(input.reason, 'reason', 1000);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const proposal = requireProposal(state, projectId, proposalId);
      if (proposal.status === rule.to) return publicProposal(proposal);
      if (!rule.from.includes(proposal.status)) {
        throw new DomainError(`Invalid scenario workflow transition: ${proposal.status} -> ${rule.to}`, 'INVALID_SCENARIO_TRANSITION');
      }
      proposal.status = rule.to;
      proposal.reviewState = rule.to;
      proposal.reviewReason = reason;
      proposal.reviewedAt = nowIso();
      proposal.reviewedBy = actor;
      proposal.updatedAt = proposal.reviewedAt;
      appendAudit(state, 'test_scenario.reviewed', 'Test scenario proposal reviewed', {
        projectId,
        proposalId,
        action,
        reason,
        actor
      });
      return publicProposal(proposal);
    });
  }

  async createTestDraft(projectId, proposalId, input = {}, options = {}) {
    const framework = String(input.framework ?? '').trim().toUpperCase();
    if (!TEST_FRAMEWORKS.has(framework)) {
      throw new DomainError(`framework must be one of: ${[...TEST_FRAMEWORKS].join(', ')}`, 'INVALID_INPUT');
    }
    const expectedFailure = requireText(input.expectedFailure, 'expectedFailure', 2000);
    const suggestedPath = requireText(input.suggestedPath, 'suggestedPath', 500);
    const command = normalizeCommand(input.command);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const proposal = requireProposal(state, projectId, proposalId);
      if (!['ACCEPTED', 'NEEDS_CORRECTION', 'TEST_DRAFT'].includes(proposal.status)) {
        throw new DomainError('Scenario must be accepted before creating a test draft', 'INVALID_SCENARIO_TRANSITION');
      }
      proposal.testDraft = {
        framework,
        suggestedPath,
        command,
        expectedFailure,
        expectedFailureFingerprint: failureFingerprint(expectedFailure),
        content: createScenarioTestTemplate(proposal, framework),
        createdAt: nowIso(),
        createdBy: actor
      };
      proposal.status = 'TEST_DRAFT';
      proposal.reviewState = 'TEST_DRAFT';
      proposal.updatedAt = proposal.testDraft.createdAt;
      appendAudit(state, 'test_scenario.draft_created', 'Test scenario draft created', {
        projectId,
        proposalId,
        framework,
        suggestedPath,
        actor
      });
      return publicProposal(proposal);
    });
  }

  async recordScenarioRun(projectId, proposalId, input = {}, options = {}) {
    const stage = String(input.stage ?? '').trim().toUpperCase();
    const outcome = String(input.outcome ?? '').trim().toUpperCase();
    if (!RUN_STAGES.has(stage)) throw new DomainError('stage must be BASELINE or IMPLEMENTATION', 'INVALID_INPUT');
    if (!RUN_OUTCOMES.has(outcome)) throw new DomainError('outcome must be PASSED or FAILED', 'INVALID_INPUT');
    const sourceUri = requireText(input.sourceUri, 'sourceUri', 1000);
    const actor = options.actor ?? 'test-runner';
    const run = await this.#store.mutate((state) => {
      requireProject(state, projectId);
      const proposal = requireProposal(state, projectId, proposalId);
      const replay = state.testEvidenceHistory.find((entry) => (
        entry.projectId === projectId
          && entry.proposalId === proposalId
          && entry.stage === stage
          && entry.sourceUri === sourceUri
      ));
      if (replay) {
        if (replay.outcome !== outcome) {
          throw new DomainError('Run evidence source already exists with another outcome', 'TEST_EVIDENCE_CONFLICT');
        }
        return { proposal: publicProposal(proposal), evidence: structuredClone(replay), replayed: true };
      }
      validateRunTransition(proposal, stage);
      const observedFailure = optionalText(input.observedFailure, 'observedFailure', 8000);
      const record = {
        id: createId('test_run_evidence'),
        projectId,
        proposalId,
        stage,
        outcome,
        command: normalizeCommand(input.command ?? proposal.testDraft?.command),
        observedFailure,
        failureFingerprint: observedFailure ? failureFingerprint(observedFailure) : null,
        sourceUri,
        commitSha: optionalText(input.commitSha, 'commitSha', 200),
        observedAt: normalizeTimestamp(input.observedAt ?? nowIso(), 'observedAt'),
        recordedBy: actor
      };
      state.testEvidenceHistory.push(record);
      proposal.runEvidenceIds = [...new Set([...(proposal.runEvidenceIds ?? []), record.id])];
      if (stage === 'BASELINE') {
        if (outcome === 'PASSED') {
          proposal.status = 'COVERED_EXISTING';
          proposal.coverageState = 'covered';
          proposal.resolution = 'BASELINE_ALREADY_PASSED';
        } else if (failureMatches(proposal.testDraft, record)) {
          proposal.status = 'RED_PROVEN';
          proposal.coverageState = 'missing';
          proposal.resolution = 'EXPECTED_BASELINE_FAILURE';
        } else {
          proposal.status = 'NEEDS_CORRECTION';
          proposal.resolution = 'UNEXPECTED_BASELINE_FAILURE';
        }
      } else if (outcome === 'PASSED') {
        proposal.status = 'GREEN';
        proposal.coverageState = 'covered';
        proposal.resolution = 'IMPLEMENTATION_PASSED';
      } else {
        proposal.status = 'IMPLEMENTING';
        proposal.resolution = 'IMPLEMENTATION_STILL_FAILING';
      }
      proposal.reviewState = proposal.status;
      proposal.updatedAt = record.observedAt;
      appendAudit(state, 'test_scenario.run_recorded', 'Test scenario run evidence recorded', {
        projectId,
        proposalId,
        evidenceId: record.id,
        stage,
        outcome,
        nextState: proposal.status,
        actor
      });
      return { proposal: publicProposal(proposal), evidence: structuredClone(record) };
    });

    if (run.proposal.status !== 'RED_PROVEN' || run.proposal.implementationTaskId) return run;
    const task = await this.#createImplementationTask(run.proposal, input, actor);
    const attached = await this.#store.mutate((state) => {
      const proposal = requireProposal(state, projectId, proposalId);
      if (!proposal.implementationTaskId) proposal.implementationTaskId = task.id;
      proposal.status = 'IMPLEMENTING';
      proposal.reviewState = 'IMPLEMENTING';
      proposal.updatedAt = nowIso();
      appendAudit(state, 'test_scenario.implementation_started', 'Implementation task created after RED proof', {
        projectId,
        proposalId,
        workItemId: proposal.implementationTaskId,
        actor
      });
      return publicProposal(proposal);
    });
    return { ...run, proposal: attached, implementationTask: task };
  }

  async verifyScenario(projectId, proposalId, input = {}, options = {}) {
    const method = String(input.method ?? '').trim().toUpperCase();
    if (!VERIFICATION_METHODS.has(method)) {
      throw new DomainError(`method must be one of: ${[...VERIFICATION_METHODS].join(', ')}`, 'INVALID_INPUT');
    }
    const summary = requireText(input.summary, 'summary', 2000);
    const actor = options.actor ?? 'local-owner';
    return this.#store.mutate((state) => {
      requireProject(state, projectId);
      const proposal = requireProposal(state, projectId, proposalId);
      if (proposal.status !== 'GREEN') {
        throw new DomainError('Only a green scenario can be verified', 'INVALID_SCENARIO_TRANSITION');
      }
      proposal.status = 'VERIFIED';
      proposal.reviewState = 'VERIFIED';
      proposal.verification = { method, summary, verifiedAt: nowIso(), verifiedBy: actor };
      proposal.updatedAt = proposal.verification.verifiedAt;
      appendAudit(state, 'test_scenario.verified', 'Test scenario verified', {
        projectId,
        proposalId,
        method,
        summary,
        actor
      });
      return publicProposal(proposal);
    });
  }

  async #createImplementationTask(proposal, input, actor) {
    if (!this.#lifelineService) throw new DomainError('Lifeline service is required to create implementation tasks', 'SERVICE_UNAVAILABLE');
    const phaseId = optionalText(input.phaseId, 'phaseId', 180);
    const project = await this.#lifelineService.getProject(proposal.projectId);
    const phase = phaseId
      ? project.phases.find((entry) => entry.id === phaseId)
      : project.phases.find((entry) => entry.status !== 'CANCELLED');
    if (!phase) throw new DomainError('A target phase is required before implementation can start', 'PHASE_REQUIRED');
    return this.#lifelineService.createWorkItem({
      projectId: proposal.projectId,
      phaseId: phase.id,
      title: `补测场景：${proposal.title}`,
      objective: `实现已经通过 RED 证明的场景，并让 focused test 与受影响契约边界通过。来源：${proposal.sourceEvidence[0].uri}`,
      acceptanceCriteria: [
        '新测试因预期原因从红转绿',
        '受影响契约边界通过',
        '运行证据回写测试地图'
      ],
      testCommands: [proposal.testDraft.command.join(' ')],
      riskTier: proposal.riskIds.some((risk) => ['auth', 'data-loss', 'concurrency'].includes(risk)) ? 'high' : 'medium',
      planning: {
        phaseId: phase.id,
        phase: phase.title,
        phaseOrder: phase.phaseOrder,
        taskOrder: 999,
        kind: 'feature',
        priority: 'P1',
        commitment: 'COMMITTED'
      },
      issue: `test-scenario:${proposal.id}`
    }, {
      actor,
      client: 'test-governance',
      tool: 'test_scenario.red_proven',
      idempotencyKey: `test-scenario:${proposal.id}:implementation`,
      source: { kind: 'test-governance', scenarioId: proposal.id }
    });
  }
}

export function createScenarioTestTemplate(proposal, framework) {
  const title = String(proposal.title).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const source = proposal.sourceEvidence[0]?.uri ?? 'source';
  if (framework === 'PYTEST') {
    return `def test_${pythonIdentifier(title)}():\n    \"\"\"${title} · ${source}\"\"\"\n    raise AssertionError("TODO: prove the expected behavior")\n`;
  }
  if (framework === 'JUNIT') {
    return `@Test\nvoid ${javaIdentifier(title)}() {\n    fail("TODO: ${escapeJava(title)} · ${escapeJava(source)}");\n}\n`;
  }
  return `test('${title}', async () => {\n  assert.fail('TODO: prove the expected behavior from ${String(source).replaceAll("'", "\\'")}');\n});\n`;
}

export function failureFingerprint(value) {
  return createHash('sha256').update(normalizeFailure(value)).digest('hex');
}

function normalizeScenario(projectId, input, { provenance, analysis, seenAt = nowIso() }) {
  const fingerprint = requireText(input.fingerprint ?? input.scenarioId, 'fingerprint', 240);
  const sourceEvidence = normalizeSourceEvidence(input.sourceEvidence);
  const at = normalizeTimestamp(seenAt, 'seenAt');
  return {
    id: input.id ?? input.scenarioId ?? createId('test_scenario'),
    scenarioId: input.scenarioId ?? fingerprint,
    fingerprint,
    projectId,
    title: requireText(input.title, 'title', 300),
    categoryIds: normalizeTextList(input.categoryIds, 'categoryIds', 20),
    preconditions: structuredClone(input.preconditions ?? []),
    action: structuredClone(input.action ?? {}),
    expected: structuredClone(input.expected ?? {}),
    riskIds: normalizeTextList(input.riskIds, 'riskIds', 30),
    sourceEvidence,
    matchedTestIds: normalizeTextList(input.matchedTestIds ?? [], 'matchedTestIds', 100),
    coverageState: normalizeCoverageState(input.coverageState ?? 'missing'),
    status: 'PROPOSED',
    reviewState: 'PROPOSED',
    reviewReason: null,
    suppression: null,
    provenance,
    extractorVersion: input.extractorVersion ?? null,
    analysis: analysis ? compactObject(analysis) : null,
    firstSeenAt: at,
    lastSeenAt: at,
    updatedAt: at,
    testDraft: null,
    runEvidenceIds: [],
    implementationTaskId: null,
    resolution: null,
    verification: null
  };
}

function scenarioComparable(value) {
  return JSON.stringify({
    title: value.title,
    categoryIds: value.categoryIds,
    preconditions: value.preconditions,
    action: value.action,
    expected: value.expected,
    riskIds: value.riskIds,
    sourceEvidence: value.sourceEvidence,
    matchedTestIds: value.matchedTestIds,
    coverageState: value.coverageState,
    lastSeenAt: value.lastSeenAt,
    extractorVersion: value.extractorVersion,
    analysis: value.analysis,
    status: value.status
  });
}

function normalizeSourceEvidence(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError('Every scenario proposal requires sourceEvidence', 'SOURCE_EVIDENCE_REQUIRED');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new DomainError(`sourceEvidence[${index}] must be an object`, 'INVALID_INPUT');
    return {
      type: requireText(entry.type, `sourceEvidence[${index}].type`, 80),
      uri: requireText(entry.uri, `sourceEvidence[${index}].uri`, 1000),
      ...(entry.line === undefined ? {} : { line: normalizeSourceLine(entry.line, index) }),
      ...(entry.pointer ? { pointer: requireText(entry.pointer, `sourceEvidence[${index}].pointer`, 500) } : {}),
      ...(entry.symbol ? { symbol: requireText(entry.symbol, `sourceEvidence[${index}].symbol`, 500) } : {})
    };
  });
}

function validateRunTransition(proposal, stage) {
  const allowed = stage === 'BASELINE' ? ['TEST_DRAFT'] : ['RED_PROVEN', 'IMPLEMENTING'];
  if (!allowed.includes(proposal.status)) {
    throw new DomainError(`Cannot record ${stage} run while scenario is ${proposal.status}`, 'INVALID_SCENARIO_TRANSITION');
  }
}

function failureMatches(draft, record) {
  if (!record.observedFailure || !draft?.expectedFailure) return false;
  const expected = normalizeFailure(draft.expectedFailure);
  const observed = normalizeFailure(record.observedFailure);
  return observed.includes(expected) || record.failureFingerprint === draft.expectedFailureFingerprint;
}

function normalizeSourceLine(value, index) {
  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new DomainError(`sourceEvidence[${index}].line must be a positive integer`, 'INVALID_INPUT');
  }
  return line;
}

function publicProposal(proposal) {
  const { analysis: _analysis, ...safe } = proposal;
  return structuredClone(safe);
}

function requireProject(state, projectId) {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw new DomainError(`project not found: ${projectId}`, 'NOT_FOUND');
  return project;
}

function requireProposal(state, projectId, proposalId) {
  const proposal = state.testScenarioProposals.find((entry) => entry.id === proposalId && entry.projectId === projectId);
  if (!proposal) throw new DomainError(`test scenario proposal not found: ${proposalId}`, 'NOT_FOUND');
  return proposal;
}

function normalizeWorkflowState(value) {
  const status = String(value ?? '').trim().toUpperCase();
  if (!TEST_SCENARIO_WORKFLOW_STATES.includes(status)) {
    throw new DomainError(`Invalid scenario workflow state: ${status}`, 'INVALID_INPUT');
  }
  return status;
}

function normalizeCoverageState(value) {
  const state = String(value ?? '').trim().toLowerCase();
  if (!['covered', 'partial', 'missing', 'unobserved', 'obsolete'].includes(state)) {
    throw new DomainError(`Invalid coverageState: ${state}`, 'INVALID_INPUT');
  }
  return state;
}

function normalizeCommand(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').trim().split(/\s+/);
  const command = parts.map((entry) => String(entry).trim()).filter(Boolean);
  if (command.length === 0 || command.length > 64 || command.some((entry) => entry.length > 1000)) {
    throw new DomainError('command must contain 1-64 bounded arguments', 'INVALID_INPUT');
  }
  return command;
}

function normalizeTextList(value, name, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) throw new DomainError(`${name} must be an array`, 'INVALID_INPUT');
  return [...new Set(value.map((entry) => requireText(entry, name, 500)))];
}

function normalizeTimestamp(value, name) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new DomainError(`${name} must be an ISO timestamp`, 'INVALID_INPUT');
  return date.toISOString();
}

function requireText(value, name, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw new DomainError(`${name} is required and must not exceed ${maxLength} characters`, 'INVALID_INPUT');
  return text;
}

function optionalText(value, name, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, name, maxLength);
}

function normalizeFailure(value) {
  return String(value ?? '').toLowerCase().replace(/(?:[a-z]:)?[\\/][^\s:]+/gi, '<path>').replace(/:\d+(?::\d+)?/g, ':<line>').replace(/\s+/g, ' ').trim();
}

function compareProposals(left, right) {
  const priority = { REVIEW: 0, PROPOSED: 1, NEEDS_CORRECTION: 2, TEST_DRAFT: 3, RED_PROVEN: 4, IMPLEMENTING: 5, GREEN: 6 };
  return (priority[left.status] ?? 20) - (priority[right.status] ?? 20)
    || String(right.updatedAt).localeCompare(String(left.updatedAt));
}

function pythonIdentifier(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'scenario';
}

function javaIdentifier(value) {
  const words = String(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  const name = words.map((word, index) => index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`).join('');
  return /^[A-Za-z_$]/.test(name) ? name.slice(0, 80) : `scenario${createHash('sha1').update(value).digest('hex').slice(0, 10)}`;
}

function escapeJava(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

function appendAudit(state, type, message, metadata) {
  const sequence = Math.max(0, ...state.events.map((entry) => Number(entry.sequence) || 0)) + 1;
  state.events.push({ id: createId('event'), sequence, type, message, metadata: structuredClone(metadata), createdAt: nowIso() });
}

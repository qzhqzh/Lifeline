import { createHash } from 'node:crypto';
import {
  COMPLETION_OUTCOMES,
  DomainError,
  RUN_STATUS,
  WORK_ITEM_STATUS,
  calculateProjectProgress,
  createBootstrapReceipt,
  createId,
  createCompletionRecord,
  createPhase,
  createProject,
  createWorkItem,
  hydrateTaskProvenance,
  inferTaskOrigin,
  nowIso,
  resolveLocalUserId,
  transitionWorkItem,
  validatePhaseInput,
  validateWorkItemInput,
  validateReadyContract
} from './domain.js';
import {
  getPortfolioV2Template,
  PORTFOLIO_TEMPLATE_KEY,
  PORTFOLIO_TEMPLATE_VERSION
} from './portfolio-v2-template.js';

export const RUN_KIND = Object.freeze({
  INTERNAL_MOCK: 'INTERNAL_MOCK',
  AGENT: 'AGENT'
});

const TRAJECTORY_WINDOW_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
});

export class LifelineService {
  #store;
  #executor;
  #logger;
  #localUserId;
  #activeRuns = new Set();

  constructor({ store, executor, logger = console, localUserId, userId }) {
    this.#store = store;
    this.#executor = executor;
    this.#logger = logger;
    this.#localUserId = resolveLocalUserId(localUserId ?? userId);
  }

  async start() {
    await this.#store.ready();
  }

  async listProjects() {
    const state = await this.#store.read();
    return state.projects.filter((project) => project.status !== 'ARCHIVED').sort(compareProjects);
  }

  async getProject(projectId) {
    const state = await this.#store.read();
    return requireEntity(state.projects, projectId, 'project');
  }

  async createProject(input, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const existing = findIdempotentEntity(state.projects, context);
      if (existing) return existing;
      const project = createProject(input);
      project.headline = normalizeOptionalText(input?.headline, 'headline', 300);
      project.createdBy = context.actor;
      project.idempotencyKey = context.idempotencyKey;
      project.source = mutationSource(input, options);
      project.scheduleVersion = 0;
      state.projects.push(project);
      state.events.push(createAuditEvent({
        type: 'project.created',
        message: `Project created: ${project.name}`,
        metadata: auditMetadata(context, { projectId: project.id })
      }, nextGlobalSequence(state)));
      return project;
    });
  }

  async listPhases(projectId) {
    const state = await this.#store.read();
    requireEntity(state.projects, projectId, 'project');
    return state.phases
      .filter((phase) => phase.projectId === projectId && phase.status !== 'CANCELLED')
      .sort(comparePhases);
  }

  async createPhase(input, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const project = requireEntity(state.projects, input?.projectId, 'project');
      const existing = findIdempotentEntity(state.phases, context);
      if (existing) return existing;
      const phase = createPhase({
        ...input,
        rank: input?.rank ?? Number(input?.phaseOrder ?? nextPhaseOrder(state, project.id)) * 1024,
        createdBy: context.actor
      });
      phase.idempotencyKey = context.idempotencyKey;
      phase.source = mutationSource(input, options);
      state.phases.push(phase);
      bumpScheduleVersion(project);
      state.events.push(createAuditEvent({
        type: 'phase.created',
        message: `Phase created: ${phase.title}`,
        metadata: auditMetadata(context, { projectId: project.id, phaseId: phase.id })
      }, nextGlobalSequence(state)));
      return phase;
    });
  }

  async updatePhase(phaseId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const phase = requireEntity(state.phases, phaseId, 'phase');
      const replay = findIdempotentAuditEvent(state, 'phase.updated', context);
      if (replay) return phase;
      if (phase.status === 'CANCELLED') {
        throw new DomainError('Cancelled phases cannot be edited', 'PHASE_NOT_EDITABLE');
      }
      const project = requireEntity(state.projects, phase.projectId, 'project');
      const beforeVersion = assertExpectedScheduleVersion(project, input?.expectedScheduleVersion);
      const normalized = validatePhaseInput({
        ...phase,
        title: input?.title ?? phase.title,
        goal: input?.goal ?? phase.goal
      });
      const before = { title: phase.title, goal: phase.goal ?? '' };
      const after = { title: normalized.title, goal: normalized.goal };
      if (JSON.stringify(before) === JSON.stringify(after)) return phase;

      phase.title = after.title;
      phase.goal = after.goal;
      phase.updatedAt = nowIso();
      phase.editedBy = context.actor;
      phase.lastMutationSource = mutationSource(input, options);
      if (before.title !== after.title) {
        for (const task of state.workItems.filter((entry) => (
          entry.phaseId === phase.id || entry.planning?.phaseId === phase.id
        ))) {
          task.planning.phase = after.title;
        }
      }
      const afterVersion = bumpScheduleVersion(project);
      state.events.push(createAuditEvent({
        type: 'phase.updated',
        message: `Phase updated: ${phase.title}`,
        metadata: auditMetadata(context, {
          projectId: project.id,
          phaseId: phase.id,
          beforeVersion,
          afterVersion,
          before,
          after
        })
      }, nextGlobalSequence(state)));
      return phase;
    });
  }

  async listWorkItems(projectId = null) {
    const state = await this.#store.read();
    const archivedProjectIds = new Set(state.projects.filter((project) => project.status === 'ARCHIVED').map((project) => project.id));
    const workItems = projectId
      ? state.workItems.filter((item) => item.projectId === projectId && item.status !== WORK_ITEM_STATUS.CANCELLED)
      : state.workItems.filter((item) => !archivedProjectIds.has(item.projectId) && item.status !== WORK_ITEM_STATUS.CANCELLED);
    return workItems.sort(compareWorkItems);
  }

  async getWorkItem(workItemId) {
    const state = await this.#store.read();
    return requireEntity(state.workItems, workItemId, 'work item');
  }

  async getSchedule(projectId) {
    const state = await this.#store.read();
    return scheduleFromState(state, projectId);
  }

  async listScanProposals(projectId, status = null) {
    const state = await this.#store.read();
    requireEntity(state.projects, projectId, 'project');
    const normalizedStatus = status ? normalizeScanProposalStatus(status) : null;
    return state.scanProposals
      .filter((proposal) => proposal.projectId === projectId && (!normalizedStatus || proposal.status === normalizedStatus))
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
  }

  async proposeScanFinding(input, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const project = requireEntity(state.projects, input?.projectId, 'project');
      const phase = requireEntity(state.phases, input?.phaseId, 'phase');
      if (phase.projectId !== project.id || phase.status === 'CANCELLED') {
        throw new DomainError('phase does not belong to project or is cancelled', 'INVALID_INPUT');
      }
      const idempotent = findIdempotentEntity(state.scanProposals, context);
      if (idempotent) return { proposal: idempotent, deduplicated: true };

      const sourceFingerprint = normalizeRequiredText(input?.fingerprint, 'fingerprint', 512);
      const fingerprint = scanProposalFingerprint(project.id, sourceFingerprint);
      const duplicate = state.scanProposals.find((proposal) => (
        proposal.projectId === project.id && proposal.fingerprint === fingerprint
      ));
      const seenAt = nowIso();
      if (duplicate) {
        duplicate.occurrences = Number(duplicate.occurrences ?? 1) + 1;
        duplicate.lastSeenAt = seenAt;
        duplicate.updatedAt = seenAt;
        state.events.push(createAuditEvent({
          type: 'scan_proposal.deduplicated',
          message: `Duplicate scan finding suppressed: ${duplicate.title}`,
          metadata: auditMetadata(context, {
            projectId: project.id,
            phaseId: duplicate.phaseId,
            proposalId: duplicate.id,
            fingerprint,
            occurrences: duplicate.occurrences
          })
        }, nextGlobalSequence(state)));
        return { proposal: duplicate, deduplicated: true };
      }

      const taskOrder = Math.max(0, ...state.workItems
        .filter((task) => task.status !== WORK_ITEM_STATUS.CANCELLED && task.phaseId === phase.id)
        .map((task) => Number(task.planning?.taskOrder) || 0)) + 1;
      const taskDraft = validateWorkItemInput({
        projectId: project.id,
        phaseId: phase.id,
        title: input?.title,
        objective: input?.objective,
        nonGoals: input?.nonGoals ?? [],
        acceptanceCriteria: input?.acceptanceCriteria ?? [],
        testCommands: input?.testCommands ?? [],
        issue: input?.issue,
        starred: input?.starred ?? false,
        scheduledFor: input?.scheduledFor,
        dependsOnTaskIds: input?.dependsOnTaskIds ?? [],
        parallelPolicy: input?.parallelPolicy ?? 'AUTO',
        riskTier: input?.riskTier ?? scanRiskTier(input?.severity),
        weight: input?.weight ?? 1,
        resourceProfile: input?.resourceProfile ?? { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 5 },
        planning: {
          phaseId: phase.id,
          phase: phase.title,
          phaseOrder: phase.phaseOrder,
          taskOrder,
          kind: 'bug',
          priority: input?.priority ?? scanPriority(input?.severity),
          commitment: 'TENTATIVE'
        },
        recommendation: input?.recommendation
      });
      const proposal = {
        id: createId('scan_proposal'),
        projectId: project.id,
        phaseId: phase.id,
        fingerprint,
        sourceFingerprint,
        scanner: normalizeOptionalText(input?.scanner, 'scanner', 160) ?? 'agent-scan',
        severity: normalizeScanSeverity(input?.severity),
        title: taskDraft.title,
        objective: taskDraft.objective,
        taskDraft,
        status: 'PENDING',
        occurrences: 1,
        taskId: null,
        reviewSummary: null,
        reviewedBy: null,
        reviewedAt: null,
        idempotencyKey: context.idempotencyKey,
        source: mutationSource(input, options),
        createdBy: context.actor,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        createdAt: seenAt,
        updatedAt: seenAt
      };
      state.scanProposals.push(proposal);
      state.events.push(createAuditEvent({
        type: 'scan_proposal.created',
        message: `Scan finding proposed: ${proposal.title}`,
        metadata: auditMetadata(context, {
          projectId: project.id,
          phaseId: phase.id,
          proposalId: proposal.id,
          fingerprint,
          severity: proposal.severity
        })
      }, nextGlobalSequence(state)));
      return { proposal, deduplicated: false };
    });
  }

  async reviewScanProposal(proposalId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const proposal = requireEntity(state.scanProposals, proposalId, 'scan proposal');
      if (proposal.reviewIdempotencyKey && proposal.reviewIdempotencyKey === context.idempotencyKey) {
        const task = proposal.taskId ? state.workItems.find((entry) => entry.id === proposal.taskId) ?? null : null;
        return { proposal, task, scheduleVersion: requireEntity(state.projects, proposal.projectId, 'project').scheduleVersion ?? 0 };
      }
      if (proposal.status !== 'PENDING') {
        throw new DomainError(`Scan proposal cannot be reviewed while ${proposal.status}`, 'SCAN_PROPOSAL_ALREADY_REVIEWED');
      }

      const project = requireEntity(state.projects, proposal.projectId, 'project');
      const beforeVersion = assertExpectedScheduleVersion(project, input?.expectedScheduleVersion);
      const decision = normalizeScanReviewDecision(input?.decision);
      const reviewedAt = nowIso();
      let task = null;
      if (decision === 'ACCEPT') {
        const phase = requireEntity(state.phases, proposal.phaseId, 'phase');
        if (phase.projectId !== project.id || phase.status === 'CANCELLED') {
          throw new DomainError('scan proposal phase is no longer available', 'INVALID_INPUT');
        }
        const taskOrder = Math.max(0, ...state.workItems
          .filter((entry) => entry.status !== WORK_ITEM_STATUS.CANCELLED && entry.phaseId === phase.id)
          .map((entry) => Number(entry.planning?.taskOrder) || 0)) + 1;
        task = createWorkItem({
          ...proposal.taskDraft,
          phaseId: phase.id,
          planning: {
            ...proposal.taskDraft.planning,
            phaseId: phase.id,
            phase: phase.title,
            phaseOrder: phase.phaseOrder,
            taskOrder
          }
        });
        task.createdBy = proposal.createdBy;
        task.idempotencyKey = `scan-proposal:${proposal.id}`;
        task.source = proposal.source;
        task.provenance = hydrateTaskProvenance(task);
        assertTaskDependencies(state, task);
        state.workItems.push(task);
        bumpScheduleVersion(project);
        proposal.taskId = task.id;
        state.events.push(createAuditEvent({
          type: 'work_item.created_from_scan',
          message: `Reviewed scan finding added to schedule: ${task.title}`,
          workItemId: task.id,
          metadata: auditMetadata(context, {
            projectId: project.id,
            phaseId: phase.id,
            proposalId: proposal.id,
            fingerprint: proposal.fingerprint
          })
        }, nextGlobalSequence(state)));
      }

      proposal.status = decision === 'ACCEPT' ? 'ACCEPTED' : 'DISMISSED';
      proposal.reviewSummary = normalizeRequiredText(input?.summary, 'summary', 2000);
      proposal.reviewedBy = context.actor;
      proposal.reviewedAt = reviewedAt;
      proposal.reviewIdempotencyKey = context.idempotencyKey;
      proposal.updatedAt = reviewedAt;
      state.events.push(createAuditEvent({
        type: decision === 'ACCEPT' ? 'scan_proposal.accepted' : 'scan_proposal.dismissed',
        message: `Scan proposal ${decision === 'ACCEPT' ? 'accepted' : 'dismissed'}: ${proposal.title}`,
        workItemId: task?.id ?? null,
        metadata: auditMetadata(context, {
          projectId: project.id,
          phaseId: proposal.phaseId,
          proposalId: proposal.id,
          fingerprint: proposal.fingerprint,
          decision,
          beforeVersion,
          afterVersion: project.scheduleVersion ?? beforeVersion
        })
      }, nextGlobalSequence(state)));
      return { proposal, task, scheduleVersion: project.scheduleVersion ?? beforeVersion };
    });
  }

  async getTaskDetails(workItemId) {
    const state = await this.#store.read();
    return taskDetailsFromState(state, workItemId);
  }

  async createWorkItem(input, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const project = requireEntity(state.projects, input?.projectId, 'project');
      const existing = findIdempotentEntity(state.workItems, context);
      if (existing) return existing;

      const workItem = createWorkItem(input);
      let phase = workItem.planning.phaseId
        ? requireEntity(state.phases, workItem.planning.phaseId, 'phase')
        : state.phases.find((entry) => (
          entry.projectId === project.id
            && entry.status !== 'CANCELLED'
            && entry.title === workItem.planning.phase
            && Number(entry.phaseOrder ?? Number(entry.rank) / 1024) === Number(workItem.planning.phaseOrder)
        ));
      if (phase && (phase.projectId !== project.id || phase.status === 'CANCELLED')) {
        throw new DomainError('phase does not belong to project or is cancelled', 'INVALID_INPUT');
      }
      if (!phase) {
        phase = createPhase({
          projectId: project.id,
          title: workItem.planning.phase,
          goal: '',
          rank: Number(workItem.planning.phaseOrder) * 1024,
          createdBy: context.actor
        });
        phase.source = mutationSource(input, options);
        state.phases.push(phase);
      }
      workItem.phaseId = phase.id;
      workItem.planning = {
        ...workItem.planning,
        phaseId: phase.id,
        phase: phase.title,
        phaseOrder: phase.phaseOrder
      };
      assertTaskDependencies(state, workItem);
      workItem.createdBy = context.actor;
      workItem.idempotencyKey = context.idempotencyKey;
      workItem.source = mutationSource(input, options);
      workItem.provenance = hydrateTaskProvenance(workItem);
      state.workItems.push(workItem);
      bumpScheduleVersion(project);
      state.events.push(createAuditEvent({
        type: 'work_item.created',
        message: `Work item created in ${workItem.status}`,
        workItemId: workItem.id,
        metadata: auditMetadata(context, { projectId: workItem.projectId, phaseId: phase.id, source: workItem.source })
      }, nextGlobalSequence(state)));
      return workItem;
    });
  }

  async updateWorkItem(workItemId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const index = findIndexOrThrow(state.workItems, workItemId, 'work item');
      const workItem = state.workItems[index];
      const replay = findIdempotentAuditEvent(state, 'work_item.updated', context, workItemId);
      if (replay) return workItem;
      const issueReferenceOnly = isIssueReferenceOnlyUpdate(input);
      if (!EDITABLE_WORK_ITEM_STATUSES.has(workItem.status) && !issueReferenceOnly) {
        throw new DomainError(`Task cannot be edited while ${workItem.status}`, 'TASK_NOT_EDITABLE');
      }

      const project = requireEntity(state.projects, workItem.projectId, 'project');
      const beforeVersion = assertExpectedScheduleVersion(project, input?.expectedScheduleVersion);
      if (!EDITABLE_WORK_ITEM_STATUSES.has(workItem.status)) {
        const validatedIssue = validateWorkItemInput({ ...workItem, issue: input.issue }).issue;
        const beforeIssue = workItem.issue ?? null;
        const source = mutationSource(input, options);
        if (beforeIssue === validatedIssue) {
          if (context.idempotencyKey) {
            state.events.push(createAuditEvent({
              type: 'work_item.updated',
              message: 'Task issue reference unchanged',
              workItemId,
              metadata: auditMetadata(context, {
                projectId: project.id,
                phaseId: workItem.phaseId ?? workItem.planning?.phaseId ?? null,
                beforeVersion,
                afterVersion: beforeVersion,
                unchanged: true,
                source,
                before: { issue: beforeIssue },
                after: { issue: validatedIssue }
              })
            }, nextGlobalSequence(state)));
          }
          return workItem;
        }
        const editedAt = nowIso();
        Object.assign(workItem, {
          issue: validatedIssue,
          editedBy: context.actor,
          lastMutationSource: source,
          updatedAt: editedAt
        });
        const afterVersion = bumpScheduleVersion(project);
        state.events.push(createAuditEvent({
          type: 'work_item.updated',
          message: 'Task issue reference updated',
          workItemId,
          metadata: auditMetadata(context, {
            projectId: project.id,
            phaseId: workItem.phaseId ?? workItem.planning?.phaseId ?? null,
            beforeVersion,
            afterVersion,
            source,
            before: { issue: beforeIssue },
            after: { issue: validatedIssue }
          })
        }, nextGlobalSequence(state)));
        return workItem;
      }
      const phaseId = input?.phaseId ?? input?.planning?.phaseId ?? workItem.phaseId ?? workItem.planning?.phaseId;
      const phase = requireEntity(state.phases, phaseId, 'phase');
      if (phase.projectId !== project.id || phase.status === 'CANCELLED') {
        throw new DomainError('phase does not belong to project or is cancelled', 'INVALID_INPUT');
      }

      const nextKind = input?.planning?.kind ?? workItem.planning.kind;
      const currentPhaseId = workItem.phaseId ?? workItem.planning?.phaseId;
      const requestedPlanning = { ...(input?.planning ?? {}) };
      delete requestedPlanning.taskOrder;
      const taskOrder = phase.id === currentPhaseId
        ? workItem.planning.taskOrder
        : Math.max(0, ...state.workItems
          .filter((task) => (
            task.id !== workItem.id
              && task.status !== WORK_ITEM_STATUS.CANCELLED
              && (task.phaseId === phase.id || task.planning?.phaseId === phase.id)
          ))
          .map((task) => Number(task.planning?.taskOrder) || 0)) + 1;
      const validated = validateWorkItemInput({
        ...workItem,
        title: input?.title ?? workItem.title,
        objective: input?.objective ?? workItem.objective,
        nonGoals: input?.nonGoals ?? workItem.nonGoals,
        acceptanceCriteria: input?.acceptanceCriteria ?? workItem.acceptanceCriteria,
        testCommands: input?.testCommands ?? workItem.testCommands,
        issue: input?.issue !== undefined ? input.issue : workItem.issue,
        starred: input?.starred ?? workItem.starred,
        scheduledFor: input?.scheduledFor !== undefined ? input.scheduledFor : workItem.scheduledFor,
        dependsOnTaskIds: input?.dependsOnTaskIds ?? workItem.dependsOnTaskIds,
        parallelPolicy: input?.parallelPolicy ?? workItem.parallelPolicy,
        riskTier: input?.riskTier ?? workItem.riskTier,
        weight: input?.weight ?? workItem.weight,
        resourceProfile: input?.resourceProfile ?? workItem.resourceProfile,
        phaseId: phase.id,
        planning: {
          ...workItem.planning,
          ...requestedPlanning,
          phaseId: phase.id,
          phase: phase.title,
          phaseOrder: phase.phaseOrder,
          taskOrder
        },
        recommendation: nextKind === workItem.planning.kind
          ? (input?.recommendation ?? workItem.recommendation)
          : input?.recommendation
      });
      if (workItem.status === WORK_ITEM_STATUS.READY) {
        validateReadyContract(validated);
        assertDependenciesSatisfied(state, validated);
      }

      const before = taskContractSnapshot(workItem);
      const candidate = { ...workItem, ...validated, phaseId: phase.id };
      assertTaskDependencies(state, candidate);
      assertProjectDependencyTopology(state, project.id, candidate);
      const after = taskContractSnapshot(candidate);
      if (JSON.stringify(before) === JSON.stringify(after)) return workItem;

      const contentChanged = JSON.stringify(taskContentSnapshot(workItem))
        !== JSON.stringify(taskContentSnapshot(candidate));
      const source = mutationSource(input, options);
      const editedAt = nowIso();
      const existingProvenance = hydrateTaskProvenance(workItem);
      const editorOrigin = inferTaskOrigin(source);
      const editorType = ['HUMAN', 'AI'].includes(editorOrigin) ? editorOrigin : null;
      const provenance = contentChanged
        ? {
            ...existingProvenance,
            contentAdjustedByHuman: existingProvenance.contentAdjustedByHuman
              || (existingProvenance.origin === 'AI' && editorType === 'HUMAN'),
            lastContentEditorType: editorType,
            lastContentEditedAt: editedAt,
            edits: [
              ...existingProvenance.edits,
              {
                kind: 'CONTENT',
                editorType,
                editedBy: context.actor,
                editedAt,
                source
              }
            ]
          }
        : existingProvenance;
      Object.assign(workItem, validated, {
        phaseId: phase.id,
        editedBy: context.actor,
        lastMutationSource: source,
        provenance,
        updatedAt: editedAt
      });
      const afterVersion = bumpScheduleVersion(project);
      state.events.push(createAuditEvent({
        type: 'work_item.updated',
        message: contentChanged ? 'Task execution contract updated' : 'Task schedule placement updated',
        workItemId,
        metadata: auditMetadata(context, {
          projectId: project.id,
          phaseId: phase.id,
          beforeVersion,
          afterVersion,
          source,
          before,
          after
        })
      }, nextGlobalSequence(state)));
      return workItem;
    });
  }

  async reorderPhaseTasks(projectId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const project = requireEntity(state.projects, projectId, 'project');
      const replay = findIdempotentAuditEvent(state, 'schedule.reordered', context);
      if (replay) return scheduleFromState(state, projectId);
      const beforeVersion = assertExpectedScheduleVersion(project, input?.expectedScheduleVersion);
      const phase = requireEntity(state.phases, input?.phaseId, 'phase');
      if (phase.projectId !== projectId || phase.status === 'CANCELLED') {
        throw new DomainError('phase does not belong to project or is cancelled', 'INVALID_INPUT');
      }

      const orderedTaskIds = normalizeTaskIdOrder(input?.orderedTaskIds);
      const phaseTasks = state.workItems.filter((task) => (
        task.projectId === projectId
          && (task.phaseId === phase.id || task.planning?.phaseId === phase.id)
          && task.status !== WORK_ITEM_STATUS.CANCELLED
      ));
      const reorderable = phaseTasks.filter((task) => REORDERABLE_WORK_ITEM_STATUSES.has(task.status));
      const expectedIds = new Set(reorderable.map((task) => task.id));
      if (orderedTaskIds.length !== expectedIds.size || orderedTaskIds.some((id) => !expectedIds.has(id))) {
        throw new DomainError('orderedTaskIds must contain every reorderable task in the phase exactly once', 'INVALID_TASK_ORDER', {
          expectedTaskIds: [...expectedIds]
        });
      }

      const beforeOrder = reorderable.sort(compareWorkItems).map((task) => task.id);
      const lockedMaxOrder = Math.max(0, ...phaseTasks
        .filter((task) => !REORDERABLE_WORK_ITEM_STATUSES.has(task.status))
        .map((task) => Number(task.planning?.taskOrder) || 0));
      assertDependencyOrderForReorder(state, phase, orderedTaskIds, lockedMaxOrder);
      orderedTaskIds.forEach((taskId, index) => {
        const task = requireEntity(state.workItems, taskId, 'work item');
        task.planning.taskOrder = lockedMaxOrder + index + 1;
        task.updatedAt = nowIso();
      });
      const afterVersion = bumpScheduleVersion(project);
      state.events.push(createAuditEvent({
        type: 'schedule.reordered',
        message: `Tasks reordered in ${phase.title}`,
        metadata: auditMetadata(context, {
          projectId,
          phaseId: phase.id,
          beforeVersion,
          afterVersion,
          beforeOrder,
          afterOrder: orderedTaskIds
        })
      }, nextGlobalSequence(state)));
      return scheduleFromState(state, projectId);
    });
  }

  async cancelWorkItem(workItemId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const index = findIndexOrThrow(state.workItems, workItemId, 'work item');
      let workItem = state.workItems[index];
      const replay = findIdempotentAuditEvent(state, 'work_item.cancelled', context, workItemId);
      if (replay) return workItem;
      if (!CANCELLABLE_WORK_ITEM_STATUSES.has(workItem.status)) {
        throw new DomainError(`Task cannot be removed while ${workItem.status}`, 'TASK_NOT_CANCELLABLE');
      }
      const project = requireEntity(state.projects, workItem.projectId, 'project');
      const beforeVersion = assertExpectedScheduleVersion(project, input?.expectedScheduleVersion);
      const reason = normalizeRequiredText(input?.reason, 'reason', 1000);
      const activeDependents = state.workItems.filter((task) => (
        task.id !== workItemId
          && task.status !== WORK_ITEM_STATUS.CANCELLED
          && (task.dependsOnTaskIds ?? []).includes(workItemId)
      ));
      if (activeDependents.length > 0) {
        throw new DomainError('Task cannot be removed while active tasks depend on it', 'TASK_HAS_DEPENDENTS', {
          dependents: activeDependents.map((task) => ({ id: task.id, title: task.title, status: task.status }))
        });
      }
      workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.CANCELLED);
      workItem.cancelReason = reason;
      workItem.cancelledAt = nowIso();
      workItem.cancelledBy = context.actor;
      workItem.lastMutationSource = mutationSource(input, options);
      state.workItems[index] = workItem;
      const afterVersion = bumpScheduleVersion(project);
      state.events.push(createAuditEvent({
        type: 'work_item.cancelled',
        message: 'Task removed from the active schedule',
        workItemId,
        metadata: auditMetadata(context, {
          projectId: project.id,
          beforeVersion,
          afterVersion,
          reason
        })
      }, nextGlobalSequence(state)));
      return workItem;
    });
  }

  async markReady(workItemId) {
    return this.#store.mutate((state) => {
      const index = findIndexOrThrow(state.workItems, workItemId, 'work item');
      const workItem = state.workItems[index];
      validateReadyContract(workItem);
      assertDependenciesSatisfied(state, workItem);
      state.workItems[index] = transitionWorkItem(workItem, WORK_ITEM_STATUS.READY);
      state.events.push(createAuditEvent({
        type: 'work_item.ready',
        message: 'Execution contract validated; work item is ready',
        workItemId
      }, nextGlobalSequence(state)));
      return state.workItems[index];
    });
  }

  async queueWorkItem(workItemId) {
    await this.getWorkItem(workItemId);
    throw new DomainError(
      'Internal Mock execution is disabled; report the real result once with lifeline_submit_completion',
      'MOCK_EXECUTOR_DISABLED'
    );
  }

  async startTask(workItemId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const workItemIndex = findIndexOrThrow(state.workItems, workItemId, 'work item');
      let workItem = state.workItems[workItemIndex];
      const existingRun = state.runs.find((run) => (
        run.workItemId === workItemId
          && run.idempotencyKey === context.idempotencyKey
          && run.createdBy === context.actor
      ));
      if (existingRun && context.idempotencyKey) {
        return { task: workItem, run: existingRun };
      }

      validateReadyContract(workItem);
      assertDependenciesSatisfied(state, workItem);
      const recurring = isRecurringWorkItem(workItem);
      if (workItem.status === WORK_ITEM_STATUS.PLANNED) {
        workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.READY);
      } else if (workItem.status === WORK_ITEM_STATUS.BLOCKED) {
        workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.READY);
      }
      if (![WORK_ITEM_STATUS.READY, WORK_ITEM_STATUS.RECURRING].includes(workItem.status)) {
        throw new DomainError(
          `Task must be PLANNED, READY, BLOCKED, or RECURRING before an Agent run starts; received ${workItem.status}`,
          'INVALID_TRANSITION'
        );
      }
      workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.QUEUED);
      workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.RUNNING);

      const startedAt = normalizeOptionalText(input?.startedAt, 'startedAt', 80) ?? nowIso();
      const attempt = Number(input?.attempt ?? nextRunAttempt(state, workItemId));
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000) {
        throw new DomainError('attempt must be an integer between 1 and 1000', 'INVALID_INPUT');
      }
      const run = {
        id: createId('run'),
        workItemId,
        kind: RUN_KIND.AGENT,
        executor: normalizeRequiredText(input?.executor ?? 'codex', 'executor', 160),
        agentId: normalizeOptionalText(input?.agentId, 'agentId', 160),
        provider: normalizeOptionalText(input?.provider, 'provider', 160),
        modelRef: normalizeRequiredText(input?.modelRef, 'modelRef', 240),
        modelSnapshot: input?.modelSnapshot ?? null,
        reasoningEffort: normalizeOptionalText(input?.reasoningEffort, 'reasoningEffort', 80),
        status: RUN_STATUS.RUNNING,
        stage: 0,
        attempt,
        onSuccessStatus: recurring ? WORK_ITEM_STATUS.RECURRING : WORK_ITEM_STATUS.VERIFIED,
        error: null,
        idempotencyKey: context.idempotencyKey,
        createdBy: context.actor,
        source: mutationSource(input, options),
        createdAt: nowIso(),
        startedAt,
        finishedAt: null,
        updatedAt: nowIso()
      };
      workItem.currentRunId = run.id;
      state.workItems[workItemIndex] = workItem;
      state.runs.push(run);
      state.events.push(createRunEvent(state, run, 'run.started', 'Agent run started', auditMetadata(context, {
        executor: run.executor,
        modelRef: run.modelRef
      })));
      return { task: workItem, run };
    });
  }

  async submitCompletion(workItemId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const existingRecord = state.completionRecords.find((record) => (
        record.taskId === workItemId
          && record.idempotencyKey === context.idempotencyKey
          && record.submittedBy === context.actor
      ));
      if (existingRecord && context.idempotencyKey) {
        return completionResultFromState(state, existingRecord);
      }

      const workItemIndex = findIndexOrThrow(state.workItems, workItemId, 'work item');
      let workItem = state.workItems[workItemIndex];
      const outcome = normalizeCompletionOutcome(input?.outcome);
      const currentRun = workItem.currentRunId
        ? state.runs.find((entry) => entry.id === workItem.currentRunId)
        : null;
      const runId = input?.runId ?? (currentRun?.status === RUN_STATUS.RUNNING ? currentRun.id : null);
      const completedAt = normalizeIsoTimestamp(input?.completedAt ?? nowIso(), 'completedAt');
      let run = runId ? requireEntity(state.runs, runId, 'run') : null;
      if (run && run.workItemId !== workItemId) {
        throw new DomainError('run does not belong to task', 'INVALID_INPUT');
      }
      if (!run) {
        validateReadyContract(workItem);
        assertDependenciesSatisfied(state, workItem);
        const startedAt = normalizeIsoTimestamp(input?.startedAt, 'startedAt', true);
        if (Date.parse(startedAt) > Date.parse(completedAt)) {
          throw new DomainError('startedAt must not be after completedAt', 'INVALID_INPUT');
        }
        const recurring = isRecurringWorkItem(workItem);
        workItem = transitionReportedTaskToRunning(workItem, startedAt);
        run = {
          id: createId('run'),
          workItemId,
          kind: RUN_KIND.AGENT,
          executor: normalizeOptionalText(input?.executor, 'executor', 160) ?? 'agent',
          agentId: normalizeOptionalText(input?.agentId, 'agentId', 160),
          provider: normalizeOptionalText(input?.provider, 'provider', 160),
          modelRef: normalizeRequiredText(input?.modelRef, 'modelRef', 240),
          modelSnapshot: input?.modelSnapshot ?? null,
          reasoningEffort: normalizeOptionalText(input?.reasoningEffort, 'reasoningEffort', 80),
          status: RUN_STATUS.RUNNING,
          stage: 0,
          attempt: nextRunAttempt(state, workItemId),
          onSuccessStatus: recurring ? WORK_ITEM_STATUS.RECURRING : WORK_ITEM_STATUS.VERIFIED,
          error: null,
          idempotencyKey: context.idempotencyKey,
          createdBy: context.actor,
          source: mutationSource(input, options),
          createdAt: nowIso(),
          startedAt,
          finishedAt: null,
          updatedAt: nowIso(),
          reportedAtCompletion: true
        };
        workItem.currentRunId = run.id;
        state.runs.push(run);
        state.events.push(createRunEvent(
          state,
          run,
          'run.reported',
          'Agent reported a real task result',
          auditMetadata(context, { executor: run.executor, modelRef: run.modelRef })
        ));
      } else if (workItem.status !== WORK_ITEM_STATUS.RUNNING || run.status !== RUN_STATUS.RUNNING) {
        throw new DomainError('Only a running task can submit completion', 'INVALID_TRANSITION');
      }

      const evidenceInputs = normalizeCompletionEvidence(input?.evidence);
      const evidence = evidenceInputs.map((entry, index) => ({
        id: createId('evidence'),
        key: `agent-completion:${workItemId}:${context.idempotencyKey ?? run.id}:${index}`,
        runId: run.id,
        workItemId,
        type: entry.type,
        score: 0,
        summary: entry.summary,
        metadata: entry.metadata,
        createdAt: nowIso()
      }));
      state.evidence.push(...evidence);

      const startedAt = normalizeIsoTimestamp(input?.startedAt ?? run.startedAt, 'startedAt', true);
      if (Date.parse(startedAt) > Date.parse(completedAt)) {
        throw new DomainError('startedAt must not be after completedAt', 'INVALID_INPUT');
      }
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
      const completionRecord = createCompletionRecord({
        taskId: workItemId,
        runId: run.id,
        completionMethod: 'AGENT_RUN',
        outcome,
        agentId: input?.agentId ?? run.agentId,
        executor: input?.executor ?? run.executor,
        provider: input?.provider ?? run.provider,
        modelRef: input?.modelRef ?? run.modelRef,
        modelSnapshot: input?.modelSnapshot ?? run.modelSnapshot,
        reasoningEffort: input?.reasoningEffort ?? run.reasoningEffort,
        promptVersion: input?.promptVersion,
        policyVersion: input?.policyVersion,
        startedAt,
        completedAt,
        durationMs,
        inputTokens: input?.inputTokens,
        outputTokens: input?.outputTokens,
        cost: input?.cost,
        commitSha: input?.commitSha,
        prUrl: input?.prUrl,
        artifactUris: input?.artifactUris ?? [],
        testEvidenceIds: evidence.filter((entry) => entry.type.startsWith('TEST')).map((entry) => entry.id),
        reviewEvidenceIds: [],
        resultSummary: normalizeRequiredText(input?.resultSummary, 'resultSummary', 4000),
        submittedBy: context.actor
      });
      completionRecord.idempotencyKey = context.idempotencyKey;
      completionRecord.source = mutationSource(input, options);
      state.completionRecords.push(completionRecord);

      workItem = transitionWorkItem(
        workItem,
        outcome === 'COMPLETED' ? WORK_ITEM_STATUS.REVIEW : WORK_ITEM_STATUS.BLOCKED,
        completedAt
      );
      state.workItems[workItemIndex] = workItem;
      run.status = outcome === 'COMPLETED' ? RUN_STATUS.SUCCEEDED : RUN_STATUS.FAILED;
      run.finishedAt = completedAt;
      run.updatedAt = completedAt;
      run.error = outcome === 'COMPLETED' ? null : {
        code: outcome === 'BLOCKED' ? 'AGENT_REPORTED_BLOCKED' : 'AGENT_REPORTED_FAILURE',
        message: completionRecord.resultSummary
      };
      const eventType = outcome === 'COMPLETED' ? 'completion.submitted' : outcome === 'BLOCKED' ? 'run.blocked' : 'run.failed';
      const eventMessage = outcome === 'COMPLETED'
        ? 'Agent completion submitted for review'
        : outcome === 'BLOCKED' ? 'Agent reported the task as blocked' : 'Agent reported the task as failed';
      state.events.push(createRunEvent(state, run, eventType, eventMessage, auditMetadata(context, {
        completionRecordId: completionRecord.id,
        evidenceIds: evidence.map((entry) => entry.id),
        outcome
      })));
      return { task: workItem, run, completionRecord, evidence };
    });
  }

  async verifyTask(workItemId, input = {}, options = {}) {
    const context = mutationContext(this.#localUserId, options);
    return this.#store.mutate((state) => {
      const existingEvidence = state.evidence.find((entry) => (
        entry.workItemId === workItemId
          && entry.type === 'VERIFICATION'
          && entry.metadata?.idempotencyKey === context.idempotencyKey
          && entry.metadata?.verifiedBy === context.actor
      ));
      if (existingEvidence && context.idempotencyKey) {
        const record = state.completionRecords.find((entry) => entry.reviewEvidenceIds?.includes(existingEvidence.id));
        return verificationResultFromState(state, workItemId, record, existingEvidence);
      }

      const workItemIndex = findIndexOrThrow(state.workItems, workItemId, 'work item');
      let workItem = state.workItems[workItemIndex];
      if (workItem.status !== WORK_ITEM_STATUS.REVIEW) {
        throw new DomainError('Only a task in REVIEW can be verified', 'INVALID_TRANSITION');
      }
      const completionRecord = input?.completionRecordId
        ? requireEntity(state.completionRecords, input.completionRecordId, 'completion record')
        : state.completionRecords.filter((record) => record.taskId === workItemId).at(-1);
      if (!completionRecord || completionRecord.taskId !== workItemId) {
        throw new DomainError('completion record does not belong to task', 'INVALID_INPUT');
      }

      const verificationMethod = normalizeVerificationMethod(input?.verificationMethod);
      const testEvidence = state.evidence.filter((entry) => completionRecord.testEvidenceIds.includes(entry.id));
      if (verificationMethod === 'DETERMINISTIC_TEST' && !testEvidence.some(isPassingTestEvidence)) {
        throw new DomainError('Deterministic verification requires passing test evidence', 'INSUFFICIENT_EVIDENCE');
      }
      if (verificationMethod === 'INDEPENDENT_REVIEW' && completionRecord.submittedBy === context.actor) {
        throw new DomainError('Independent review must be submitted by a different actor', 'INSUFFICIENT_EVIDENCE');
      }

      const referencedEvidenceIds = normalizeStringList(input?.evidenceIds ?? [], 'evidenceIds', 100);
      for (const evidenceId of referencedEvidenceIds) {
        const referencedEvidence = requireEntity(state.evidence, evidenceId, 'evidence');
        if (referencedEvidence.workItemId !== workItemId) {
          throw new DomainError('verification evidence does not belong to task', 'INVALID_INPUT');
        }
      }

      const verificationEvidence = {
        id: createId('evidence'),
        key: `verification:${workItemId}:${context.idempotencyKey ?? createId('verification')}`,
        runId: completionRecord.runId,
        workItemId,
        type: 'VERIFICATION',
        score: 1,
        summary: normalizeRequiredText(input?.summary, 'summary', 2000),
        metadata: {
          verificationMethod,
          completionRecordId: completionRecord.id,
          verifiedBy: context.actor,
          idempotencyKey: context.idempotencyKey,
          evidenceIds: referencedEvidenceIds
        },
        createdAt: nowIso()
      };
      state.evidence.push(verificationEvidence);
      completionRecord.reviewEvidenceIds = [...new Set([
        ...(completionRecord.reviewEvidenceIds ?? []),
        verificationEvidence.id
      ])];
      completionRecord.verifiedAt = nowIso();
      completionRecord.verifiedBy = context.actor;
      const run = completionRecord.runId
        ? state.runs.find((entry) => entry.id === completionRecord.runId)
        : null;
      const successStatus = run?.onSuccessStatus === WORK_ITEM_STATUS.RECURRING
        ? WORK_ITEM_STATUS.RECURRING
        : WORK_ITEM_STATUS.VERIFIED;
      workItem = transitionWorkItem(workItem, successStatus);
      state.workItems[workItemIndex] = workItem;
      if (successStatus === WORK_ITEM_STATUS.VERIFIED) {
        const project = requireEntity(state.projects, workItem.projectId, 'project');
        project.currentTaskId = workItem.id;
        project.updatedAt = nowIso();
      }
      state.events.push(createAuditEvent({
        type: successStatus === WORK_ITEM_STATUS.RECURRING ? 'work_item.cycle_verified' : 'work_item.verified',
        message: successStatus === WORK_ITEM_STATUS.RECURRING
          ? `Recurring task cycle verified through ${verificationMethod}`
          : `Task verified through ${verificationMethod}`,
        workItemId,
        metadata: auditMetadata(context, {
          completionRecordId: completionRecord.id,
          evidenceId: verificationEvidence.id,
          verificationMethod
        })
      }, nextGlobalSequence(state)));
      return { task: workItem, completionRecord, evidence: verificationEvidence };
    });
  }

  async getRun(runId) {
    const state = await this.#store.read();
    const run = requireEntity(state.runs, runId, 'run');
    return {
      ...run,
      events: state.events.filter((event) => event.runId === runId),
      evidence: state.evidence.filter((entry) => entry.runId === runId)
    };
  }

  async getRunEvents(runId, afterSequence = 0) {
    const state = await this.#store.read();
    requireEntity(state.runs, runId, 'run');
    return state.events
      .filter((event) => event.runId === runId && event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getTrajectory(window = '7d', { now = nowIso() } = {}) {
    const windowMs = TRAJECTORY_WINDOW_MS[window];
    if (!windowMs) {
      throw new DomainError('window must be one of 24h, 7d, or 30d', 'INVALID_INPUT');
    }
    const endMs = Date.parse(now);
    if (!Number.isFinite(endMs)) throw new DomainError('now must be a valid timestamp', 'INVALID_INPUT');
    const startMs = endMs - windowMs;
    const state = await this.#store.read();
    const runsById = new Map(state.runs.map((run) => [run.id, run]));
    const tasksById = new Map(state.workItems.map((task) => [task.id, task]));
    const phasesById = new Map(state.phases.map((phase) => [phase.id, phase]));
    const projectsById = new Map(state.projects.map((project) => [project.id, project]));

    const intervals = state.completionRecords.flatMap((record) => {
      const run = record.runId ? runsById.get(record.runId) : null;
      if (record.completionMethod !== 'AGENT_RUN' || run?.kind !== RUN_KIND.AGENT || run?.legacyMock === true) return [];
      const taskId = record.taskId ?? record.workItemId;
      const task = tasksById.get(taskId);
      const project = task ? projectsById.get(task.projectId) : null;
      const startedMs = Date.parse(record.startedAt ?? run.startedAt ?? '');
      const completedMs = Date.parse(record.completedAt ?? run.finishedAt ?? '');
      if (!task || !project || !Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs || completedMs > endMs) return [];
      if (completedMs < startMs || startedMs > endMs) return [];
      const evidence = state.evidence.filter((entry) => (
        entry.runId === run.id && entry.metadata?.legacyMock !== true
      )).map((entry) => ({
        id: entry.id,
        type: entry.type,
        summary: entry.summary,
        metadata: entry.metadata ?? {},
        createdAt: entry.createdAt
      }));
      const phase = task.phaseId ? phasesById.get(task.phaseId) : null;
      return [{
        id: record.id,
        projectId: project.id,
        projectName: project.name,
        taskId,
        taskTitle: task.title,
        phaseId: task.phaseId ?? task.planning?.phaseId ?? null,
        phaseTitle: phase?.title ?? task.planning?.phase ?? null,
        runId: run.id,
        outcome: record.outcome ?? 'COMPLETED',
        taskStatus: task.status,
        startedAt: new Date(startedMs).toISOString(),
        completedAt: new Date(completedMs).toISOString(),
        durationMs: record.durationMs ?? Math.max(0, completedMs - startedMs),
        displayStartedAt: new Date(Math.max(startMs, startedMs)).toISOString(),
        displayCompletedAt: new Date(Math.min(endMs, completedMs)).toISOString(),
        modelRef: record.modelRef ?? run.modelRef ?? null,
        reasoningEffort: record.reasoningEffort ?? run.reasoningEffort ?? null,
        resultSummary: record.resultSummary ?? '',
        verificationStatus: (record.outcome ?? 'COMPLETED') === 'COMPLETED'
          ? record.verifiedAt ? 'VERIFIED' : 'REVIEW'
          : 'NOT_APPLICABLE',
        verifiedAt: record.verifiedAt ?? null,
        artifactUris: [...(record.artifactUris ?? [])],
        evidence
      }];
    }).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
      || Date.parse(left.completedAt) - Date.parse(right.completedAt));

    const coverageIntervals = mergeIntervals(intervals.map((interval) => ({
      startMs: Math.max(startMs, Date.parse(interval.startedAt)),
      endMs: Math.min(endMs, Date.parse(interval.completedAt))
    })));
    const recordedDurationMs = coverageIntervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
    const gaps = invertIntervals(coverageIntervals, startMs, endMs).map((gap) => ({
      startedAt: new Date(gap.startMs).toISOString(),
      completedAt: new Date(gap.endMs).toISOString(),
      durationMs: gap.endMs - gap.startMs,
      label: '未记录推进'
    }));
    const projects = [...new Set(intervals.map((interval) => interval.projectId))]
      .map((projectId) => {
        const project = projectsById.get(projectId);
        return {
          id: projectId,
          name: project.name,
          strategicValue: project.strategicValue,
          intervals: intervals.filter((interval) => interval.projectId === projectId)
        };
      })
      .sort(compareProjects);

    return {
      window,
      startedAt: new Date(startMs).toISOString(),
      completedAt: new Date(endMs).toISOString(),
      summary: {
        coverageRatio: Number((recordedDurationMs / windowMs).toFixed(4)),
        recordedDurationMs,
        unrecordedDurationMs: windowMs - recordedDurationMs,
        peakConcurrency: peakConcurrency(intervals, startMs, endMs),
        completedTaskCount: countTrajectoryOutcomes(intervals, 'COMPLETED', startMs, endMs),
        failedTaskCount: countTrajectoryOutcomes(intervals, 'FAILED', startMs, endMs),
        blockedTaskCount: countTrajectoryOutcomes(intervals, 'BLOCKED', startMs, endMs),
        projectCount: projects.length
      },
      projects,
      gaps
    };
  }

  async dashboard() {
    const state = await this.#store.read();
    const projects = state.projects.filter((project) => project.status !== 'ARCHIVED').map((project) => {
      const workItems = state.workItems.filter((item) => (
        item.projectId === project.id && item.status !== WORK_ITEM_STATUS.CANCELLED
      ));
      const workItemIds = new Set(workItems.map((item) => item.id));
      const evidence = state.evidence.filter((entry) => workItemIds.has(entry.workItemId));
      const counts = Object.fromEntries(Object.values(WORK_ITEM_STATUS).map((status) => [status, 0]));
      for (const item of workItems) counts[item.status] = (counts[item.status] ?? 0) + 1;
      return {
        ...project,
        verifiedProgress: calculateProjectProgress(workItems, evidence),
        workItemCount: workItems.length,
        phaseCount: new Set(workItems.map((item) => item.planning.phaseOrder)).size,
        unfinishedWorkItemCount: workItems.filter(isUnfinished).length,
        nextWorkItemId: workItems.filter(isUnfinished).sort(compareCandidateWorkItems)[0]?.id ?? null,
        statusCounts: counts,
        lastEvidenceAt: latestTimestamp(evidence.map((entry) => entry.createdAt))
      };
    }).sort(compareProjects);

    return {
      generatedAt: nowIso(),
      projects,
      activeRuns: state.runs.filter((run) => (
        run.kind === RUN_KIND.AGENT && [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING].includes(run.status)
      )).length,
      totalRuns: state.runs.filter((run) => run.kind === RUN_KIND.AGENT).length,
      legacyMockRuns: state.runs.filter((run) => run.kind === RUN_KIND.INTERNAL_MOCK).length,
      evidenceCount: state.evidence.length,
      bootstrap: {
        portfolioV2: bootstrapStatusFromState(state, this.#localUserId)
      }
    };
  }

  async getBootstrapStatus(userId = this.#localUserId) {
    const normalizedUserId = resolveLocalUserId(userId);
    const state = await this.#store.read();
    return bootstrapStatusFromState(state, normalizedUserId);
  }

  /**
   * Apply the immutable Portfolio V2 template exactly once per local user.
   * The uniqueness check and all project/phase/task writes happen inside one
   * JsonStore.mutate callback, so concurrent calls on a service share one
   * receipt and cannot duplicate imported records.
   */
  async bootstrapPortfolioV2({ userId = this.#localUserId, idempotencyKey = null } = {}) {
    const normalizedUserId = resolveLocalUserId(userId);
    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
    const template = getPortfolioV2Template();
    return this.#store.mutate((state) => {
      const existing = state.bootstrapReceipts.find((receipt) => (
        receipt.userId === normalizedUserId && receipt.templateKey === PORTFOLIO_TEMPLATE_KEY
      ));
      if (existing) {
        return bootstrapResult(state, normalizedUserId, existing, false, {
          conflicts: state.migrationConflicts.filter((entry) => entry.userId === normalizedUserId)
        });
      }

      const sourceSnapshot = structuredClone(state);
      const sourceSnapshotHash = hashSnapshot(sourceSnapshot);
      const migration = applyPortfolioTemplate(state, template, normalizedUserId);
      const receipt = createBootstrapReceipt({
        userId: normalizedUserId,
        templateKey: PORTFOLIO_TEMPLATE_KEY,
        templateVersion: PORTFOLIO_TEMPLATE_VERSION,
        appliedAt: nowIso(),
        resultProjectIds: migration.projectIds,
        sourceSnapshotHash,
        idempotencyKey: normalizedIdempotencyKey
      });
      state.bootstrapReceipts.push(receipt);
      state.migrationSnapshots.push({
        id: createId('migration-snapshot'),
        userId: normalizedUserId,
        templateKey: PORTFOLIO_TEMPLATE_KEY,
        templateVersion: PORTFOLIO_TEMPLATE_VERSION,
        sourceSnapshotHash,
        snapshotHash: sourceSnapshotHash,
        capturedAt: receipt.appliedAt,
        state: sourceSnapshot
      });
      return bootstrapResult(state, normalizedUserId, receipt, true, {
        conflicts: migration.conflicts,
        migratedProjectIds: migration.projectIds,
        archivedProjectIds: migration.archivedProjectIds
      });
    });
  }

  // Compatibility aliases for callers that use the generic bootstrap name.
  async bootstrapPortfolio(options = {}) {
    return this.bootstrapPortfolioV2(options);
  }

  async getPortfolioBootstrapStatus(userId = this.#localUserId) {
    return this.getBootstrapStatus(userId);
  }

  async seedDemo() {
    let projects = await this.listProjects();
    let addedProjects = 0;
    let addedWorkItems = 0;
    let advancedWorkItems = 0;
    const queuedRuns = [];
    let primaryProject = null;

    for (const projectSpec of portfolioDemo()) {
      let project = projects.find((entry) => (
        projectSpec.repositoryUrl && entry.repositoryUrl === projectSpec.repositoryUrl
      )) ?? projects.find((entry) => entry.name === projectSpec.name);
      if (!project) {
        project = await this.createProject(projectSpec);
        projects.push(project);
        addedProjects += 1;
      }
      if (projectSpec.primary) primaryProject = project;

      let workItems = await this.listWorkItems(project.id);
      for (const itemSpec of projectSpec.workItems) {
        let workItem = workItems.find((entry) => entry.title === itemSpec.title);
        if (!workItem) {
          workItem = await this.createWorkItem({
            projectId: project.id,
            title: itemSpec.title,
            objective: itemSpec.objective,
            acceptanceCriteria: itemSpec.acceptanceCriteria,
            testCommands: ['npm test'],
            riskTier: itemSpec.riskTier ?? 'low',
            weight: itemSpec.weight ?? 1,
            resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 2 },
            planning: itemSpec.planning,
            recommendation: itemSpec.recommendation
          });
          workItems.push(workItem);
          addedWorkItems += 1;
        }

        if (itemSpec.demoState === 'ready' && workItem.status === WORK_ITEM_STATUS.PLANNED) {
          await this.markReady(workItem.id);
          advancedWorkItems += 1;
        }
        if (itemSpec.demoState === 'run') {
          if (workItem.status === WORK_ITEM_STATUS.PLANNED) {
            workItem = await this.markReady(workItem.id);
            advancedWorkItems += 1;
          }
        }
      }
    }

    return {
      seeded: addedProjects + addedWorkItems + advancedWorkItems > 0,
      addedProjects,
      addedWorkItems,
      advancedWorkItems,
      queuedRunIds: queuedRuns.map((run) => run.id),
      project: primaryProject ?? projects[0] ?? null
    };
  }

  #schedule(runId) {
    if (this.#activeRuns.has(runId)) return;
    queueMicrotask(() => this.#executeRun(runId));
  }

  async #executeRun(runId) {
    if (this.#activeRuns.has(runId)) return;
    this.#activeRuns.add(runId);
    try {
      await this.#markRunning(runId);
      let run = await this.getRun(runId);
      while (run.stage < this.#executor.stepCount) {
        const workItem = await this.getWorkItem(run.workItemId);
        await this.#appendRunEvent(runId, 'step.started', `Starting executor step ${run.stage + 1}`, {
          stage: run.stage
        });
        const result = await this.#executor.executeStep(run.stage, workItem);
        await this.#checkpointStep(runId, result);
        run = await this.getRun(runId);
      }
      await this.#completeRun(runId);
    } catch (error) {
      await this.#failRun(runId, error);
      this.#logger.error?.('Lifeline run failed', { runId, error: error?.message });
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  async #markRunning(runId) {
    await this.#store.mutate((state) => {
      const runIndex = findIndexOrThrow(state.runs, runId, 'run');
      const run = state.runs[runIndex];
      if (run.status === RUN_STATUS.SUCCEEDED || run.status === RUN_STATUS.FAILED) return run;
      run.status = RUN_STATUS.RUNNING;
      run.startedAt ??= nowIso();
      run.updatedAt = nowIso();

      const itemIndex = findIndexOrThrow(state.workItems, run.workItemId, 'work item');
      const workItem = state.workItems[itemIndex];
      if (workItem.status === WORK_ITEM_STATUS.QUEUED) {
        state.workItems[itemIndex] = transitionWorkItem(workItem, WORK_ITEM_STATUS.RUNNING);
      }
      state.events.push(createRunEvent(state, run, 'run.started', 'Run started'));
      return run;
    });
  }

  async #checkpointStep(runId, result) {
    await this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      const evidenceKey = `${runId}:${result.evidence.type}`;
      if (!state.evidence.some((entry) => entry.key === evidenceKey)) {
        state.evidence.push({
          id: createId('evidence'),
          key: evidenceKey,
          runId,
          workItemId: run.workItemId,
          type: result.evidence.type,
          score: result.evidence.score,
          summary: result.evidence.summary,
          metadata: result.evidence.metadata ?? {},
          createdAt: nowIso()
        });
      }
      run.stage += 1;
      run.updatedAt = nowIso();
      state.events.push(createRunEvent(state, run, 'step.completed', result.message, {
        step: result.step,
        stage: run.stage,
        evidenceType: result.evidence.type,
        evidenceScore: result.evidence.score
      }));
      return run;
    });
  }

  async #completeRun(runId) {
    await this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      const itemIndex = findIndexOrThrow(state.workItems, run.workItemId, 'work item');
      let workItem = state.workItems[itemIndex];
      if (workItem.status === WORK_ITEM_STATUS.RUNNING) {
        workItem = transitionWorkItem(workItem, WORK_ITEM_STATUS.REVIEW);
      }
      if (workItem.status === WORK_ITEM_STATUS.REVIEW) {
        workItem = transitionWorkItem(
          workItem,
          run.onSuccessStatus === WORK_ITEM_STATUS.RECURRING
            ? WORK_ITEM_STATUS.RECURRING
            : WORK_ITEM_STATUS.VERIFIED
        );
      }
      state.workItems[itemIndex] = workItem;
      if (workItem.status === WORK_ITEM_STATUS.VERIFIED) {
        const project = requireEntity(state.projects, workItem.projectId, 'project');
        project.currentTaskId = workItem.id;
        project.updatedAt = nowIso();
      }
      run.status = RUN_STATUS.SUCCEEDED;
      run.finishedAt = nowIso();
      run.updatedAt = run.finishedAt;
      state.events.push(createRunEvent(
        state,
        run,
        'run.succeeded',
        workItem.status === WORK_ITEM_STATUS.RECURRING
          ? 'Run completed and recurring task returned to its cycle'
          : 'Run completed and work item verified'
      ));
      return run;
    });
  }

  async #failRun(runId, error) {
    await this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      run.status = RUN_STATUS.FAILED;
      run.error = {
        code: error?.code ?? 'EXECUTOR_FAILURE',
        message: error?.message ?? String(error)
      };
      run.finishedAt = nowIso();
      run.updatedAt = run.finishedAt;
      const itemIndex = findIndexOrThrow(state.workItems, run.workItemId, 'work item');
      const workItem = state.workItems[itemIndex];
      if ([WORK_ITEM_STATUS.QUEUED, WORK_ITEM_STATUS.RUNNING, WORK_ITEM_STATUS.REVIEW].includes(workItem.status)) {
        state.workItems[itemIndex] = transitionWorkItem(workItem, WORK_ITEM_STATUS.BLOCKED);
      }
      state.events.push(createRunEvent(state, run, 'run.failed', run.error.message, { error: run.error }));
      return run;
    });
  }

  async #appendRunEvent(runId, type, message, metadata = {}) {
    return this.#store.mutate((state) => {
      const run = requireEntity(state.runs, runId, 'run');
      const event = createRunEvent(state, run, type, message, metadata);
      state.events.push(event);
      return event;
    });
  }
}

export function isTerminalRunStatus(status) {
  return [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED].includes(status);
}

const EDITABLE_WORK_ITEM_STATUSES = new Set([
  WORK_ITEM_STATUS.PLANNED,
  WORK_ITEM_STATUS.DEFERRED,
  WORK_ITEM_STATUS.READY,
  WORK_ITEM_STATUS.BLOCKED
]);

function isIssueReferenceOnlyUpdate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  if (!Object.prototype.hasOwnProperty.call(input, 'issue')) return false;
  const metadataFields = new Set(['expectedScheduleVersion', 'issue', 'source']);
  return Object.entries(input).every(([key, value]) => value === undefined || metadataFields.has(key));
}

const REORDERABLE_WORK_ITEM_STATUSES = new Set([
  WORK_ITEM_STATUS.DISCOVERED,
  WORK_ITEM_STATUS.TRIAGED,
  WORK_ITEM_STATUS.PLANNED,
  WORK_ITEM_STATUS.DEFERRED,
  WORK_ITEM_STATUS.READY,
  WORK_ITEM_STATUS.BLOCKED
]);

const CANCELLABLE_WORK_ITEM_STATUSES = new Set([
  WORK_ITEM_STATUS.DISCOVERED,
  WORK_ITEM_STATUS.TRIAGED,
  WORK_ITEM_STATUS.PLANNED,
  WORK_ITEM_STATUS.DEFERRED,
  WORK_ITEM_STATUS.READY,
  WORK_ITEM_STATUS.BLOCKED
]);

const DEPENDENCY_COMPLETE_WORK_ITEM_STATUSES = new Set([
  WORK_ITEM_STATUS.RECURRING,
  WORK_ITEM_STATUS.VERIFIED,
  WORK_ITEM_STATUS.RELEASED,
  WORK_ITEM_STATUS.ARCHIVED
]);

function requireEntity(collection, id, entityName) {
  const entity = collection.find((entry) => entry.id === id);
  if (!entity) throw new DomainError(`${entityName} not found: ${id}`, 'NOT_FOUND');
  return entity;
}

function findIndexOrThrow(collection, id, entityName) {
  const index = collection.findIndex((entry) => entry.id === id);
  if (index === -1) throw new DomainError(`${entityName} not found: ${id}`, 'NOT_FOUND');
  return index;
}

function createRunEvent(state, run, type, message, metadata = {}) {
  return createAuditEvent({
    type,
    message,
    runId: run.id,
    workItemId: run.workItemId,
    metadata
  }, nextRunSequence(state, run.id));
}

function createAuditEvent(input, sequence) {
  return {
    id: createId('event'),
    sequence,
    type: input.type,
    message: input.message,
    runId: input.runId ?? null,
    workItemId: input.workItemId ?? null,
    metadata: input.metadata ?? {},
    createdAt: nowIso()
  };
}

function nextRunSequence(state, runId) {
  const sequences = state.events.filter((event) => event.runId === runId).map((event) => Number(event.sequence) || 0);
  return (sequences.length === 0 ? 0 : Math.max(...sequences)) + 1;
}

function nextGlobalSequence(state) {
  const sequences = state.events.filter((event) => !event.runId).map((event) => Number(event.sequence) || 0);
  return (sequences.length === 0 ? 0 : Math.max(...sequences)) + 1;
}

function latestTimestamp(values) {
  if (values.length === 0) return null;
  return values.sort().at(-1) ?? null;
}

function bootstrapStatusFromState(state, userId) {
  const receipt = state.bootstrapReceipts.find((entry) => (
    entry.userId === userId && entry.templateKey === PORTFOLIO_TEMPLATE_KEY
  ));
  const conflicts = state.migrationConflicts.filter((entry) => (
    entry.userId === userId && entry.templateKey === PORTFOLIO_TEMPLATE_KEY
  ));
  return {
    available: !receipt,
    templateKey: PORTFOLIO_TEMPLATE_KEY,
    templateVersion: PORTFOLIO_TEMPLATE_VERSION,
    appliedAt: receipt?.appliedAt ?? null,
    resultProjectIds: receipt?.resultProjectIds ?? [],
    sourceSnapshotHash: receipt?.sourceSnapshotHash ?? null,
    conflicts
  };
}

function bootstrapResult(state, userId, receipt, created, extra = {}) {
  const status = bootstrapStatusFromState(state, userId);
  return {
    ...status,
    receipt,
    created,
    ...extra
  };
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 256) {
    throw new DomainError('Idempotency-Key must be a string no longer than 256 characters', 'INVALID_INPUT');
  }
  return value.trim();
}

function phaseOrderFromRank(rank) {
  const number = Number(rank);
  if (!Number.isFinite(number)) return null;
  return number >= 1024 && number % 1024 === 0 ? number / 1024 : number;
}

function hashSnapshot(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mutationContext(defaultActor, options = {}) {
  return {
    actor: normalizeRequiredText(options?.actor ?? defaultActor, 'actor', 160),
    client: normalizeOptionalText(options?.client, 'client', 160),
    tool: normalizeOptionalText(options?.tool, 'tool', 160),
    idempotencyKey: normalizeIdempotencyKey(options?.idempotencyKey),
    source: normalizeSource(options?.source)
  };
}

function findIdempotentEntity(collection, context) {
  if (!context.idempotencyKey) return null;
  return collection.find((entry) => (
    entry.idempotencyKey === context.idempotencyKey
      && (entry.createdBy ?? entry.submittedBy) === context.actor
  )) ?? null;
}

function findIdempotentAuditEvent(state, type, context, workItemId = null) {
  if (!context.idempotencyKey) return null;
  return state.events.find((event) => (
    event.type === type
      && (workItemId === null || event.workItemId === workItemId)
      && event.metadata?.actor === context.actor
      && event.metadata?.idempotencyKey === context.idempotencyKey
  )) ?? null;
}

function assertExpectedScheduleVersion(project, value) {
  const expected = Number(value);
  const actual = Number(project.scheduleVersion ?? 0);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new DomainError('expectedScheduleVersion must be a non-negative integer', 'INVALID_INPUT');
  }
  if (expected !== actual) {
    throw new DomainError('Schedule changed; refresh before editing', 'SCHEDULE_VERSION_CONFLICT', {
      expectedScheduleVersion: expected,
      actualScheduleVersion: actual
    });
  }
  return actual;
}

function normalizeTaskIdOrder(value) {
  const taskIds = normalizeStringList(value, 'orderedTaskIds', 1000);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new DomainError('orderedTaskIds must not contain duplicates', 'INVALID_TASK_ORDER');
  }
  return taskIds;
}

function assertTaskDependencies(state, candidate) {
  const dependencyIds = candidate.dependsOnTaskIds ?? [];
  const dependencies = [];
  for (const dependencyId of dependencyIds) {
    if (dependencyId === candidate.id) {
      throw new DomainError('Task cannot depend on itself', 'TASK_DEPENDENCY_CYCLE', { taskId: candidate.id });
    }
    const dependency = requireEntity(state.workItems, dependencyId, 'dependency task');
    if (dependency.projectId !== candidate.projectId) {
      throw new DomainError('Task dependencies must belong to the same project', 'INVALID_TASK_DEPENDENCY', {
        taskId: candidate.id,
        dependencyId
      });
    }
    if (dependency.status === WORK_ITEM_STATUS.CANCELLED) {
      throw new DomainError('Task cannot depend on a cancelled task', 'INVALID_TASK_DEPENDENCY', {
        taskId: candidate.id,
        dependencyId
      });
    }
    dependencies.push(dependency);
  }

  const candidateId = candidate.id;
  if (candidateId) {
    const visited = new Set();
    const reachesCandidate = (taskId) => {
      if (taskId === candidateId) return true;
      if (visited.has(taskId)) return false;
      visited.add(taskId);
      const task = state.workItems.find((entry) => entry.id === taskId);
      return (task?.dependsOnTaskIds ?? []).some(reachesCandidate);
    };
    if (dependencyIds.some((dependencyId) => {
      visited.clear();
      return reachesCandidate(dependencyId);
    })) {
      throw new DomainError('Task dependencies must form a DAG', 'TASK_DEPENDENCY_CYCLE', { taskId: candidateId });
    }
  }

  for (const dependency of dependencies) {
    const dependencyPhase = Number(dependency.planning?.phaseOrder ?? 999);
    const candidatePhase = Number(candidate.planning?.phaseOrder ?? 999);
    const dependencyOrder = Number(dependency.planning?.taskOrder ?? 999);
    const candidateOrder = Number(candidate.planning?.taskOrder ?? 999);
    if (dependencyPhase > candidatePhase || (dependencyPhase === candidatePhase && dependencyOrder >= candidateOrder)) {
      throw new DomainError('A dependency must appear before the dependent task in the schedule', 'INVALID_DEPENDENCY_ORDER', {
        taskId: candidate.id,
        dependencyId: dependency.id
      });
    }
  }
}

function assertDependencyOrderForReorder(state, phase, orderedTaskIds, lockedMaxOrder) {
  const proposedOrder = new Map(orderedTaskIds.map((taskId, index) => [taskId, lockedMaxOrder + index + 1]));
  for (const taskId of orderedTaskIds) {
    const task = requireEntity(state.workItems, taskId, 'work item');
    for (const dependencyId of task.dependsOnTaskIds ?? []) {
      const dependency = state.workItems.find((entry) => entry.id === dependencyId);
      if (!dependency || dependency.phaseId !== phase.id || !proposedOrder.has(dependencyId)) continue;
      if (proposedOrder.get(dependencyId) >= proposedOrder.get(taskId)) {
        throw new DomainError('Reorder would place a task before its dependency', 'INVALID_DEPENDENCY_ORDER', {
          taskId,
          dependencyId
        });
      }
    }
  }
}

function assertProjectDependencyTopology(state, projectId, candidate) {
  const workItems = state.workItems.map((task) => task.id === candidate.id ? candidate : task);
  const candidateState = { ...state, workItems };
  for (const task of workItems) {
    if (task.projectId !== projectId || task.status === WORK_ITEM_STATUS.CANCELLED) continue;
    assertTaskDependencies(candidateState, task);
  }
}

function assertDependenciesSatisfied(state, workItem) {
  const unmet = (workItem.dependsOnTaskIds ?? []).map((dependencyId) => {
    const dependency = state.workItems.find((entry) => entry.id === dependencyId);
    return dependency && DEPENDENCY_COMPLETE_WORK_ITEM_STATUSES.has(dependency.status) ? null : {
      id: dependencyId,
      title: dependency?.title ?? 'Missing dependency',
      status: dependency?.status ?? 'MISSING'
    };
  }).filter(Boolean);
  if (unmet.length > 0) {
    throw new DomainError('Task dependencies are not complete', 'UNSATISFIED_TASK_DEPENDENCIES', { unmet });
  }
}

function latestCompletedTaskId(state, projectId) {
  const completedTasks = state.workItems.filter((task) => (
    task.projectId === projectId
      && [WORK_ITEM_STATUS.VERIFIED, WORK_ITEM_STATUS.RELEASED, WORK_ITEM_STATUS.ARCHIVED].includes(task.status)
  ));
  if (completedTasks.length === 0) return null;

  const completedTaskIds = new Set(completedTasks.map((task) => task.id));
  const completionTime = new Map();
  for (const record of state.completionRecords) {
    const taskId = record.taskId ?? record.workItemId;
    if (!completedTaskIds.has(taskId)) continue;
    const timestamp = record.verifiedAt ?? record.completedAt ?? record.startedAt;
    const time = Date.parse(timestamp ?? '');
    if (Number.isFinite(time) && time > (completionTime.get(taskId) ?? -Infinity)) {
      completionTime.set(taskId, time);
    }
  }
  return completedTasks.sort((left, right) => (
    taskCompletionTime(right, completionTime) - taskCompletionTime(left, completionTime)
      || Number(right.planning?.phaseOrder ?? 0) - Number(left.planning?.phaseOrder ?? 0)
      || Number(right.planning?.taskOrder ?? 0) - Number(left.planning?.taskOrder ?? 0)
  )).at(0)?.id ?? null;
}

function taskCompletionTime(task, completionTime) {
  const recorded = completionTime.get(task.id);
  if (Number.isFinite(recorded)) return recorded;
  const fallback = Date.parse(task.updatedAt ?? task.createdAt ?? '');
  return Number.isFinite(fallback) ? fallback : 0;
}

function taskContractSnapshot(workItem) {
  return {
    title: workItem.title,
    objective: workItem.objective,
    nonGoals: workItem.nonGoals,
    acceptanceCriteria: workItem.acceptanceCriteria,
    testCommands: workItem.testCommands,
    issue: workItem.issue ?? null,
    starred: workItem.starred === true,
    scheduledFor: workItem.scheduledFor ?? null,
    dependsOnTaskIds: workItem.dependsOnTaskIds ?? [],
    parallelPolicy: workItem.parallelPolicy ?? 'AUTO',
    riskTier: workItem.riskTier,
    weight: workItem.weight,
    resourceProfile: workItem.resourceProfile,
    phaseId: workItem.phaseId ?? workItem.planning?.phaseId ?? null,
    planning: workItem.planning,
    recommendation: workItem.recommendation
  };
}

function taskContentSnapshot(workItem) {
  const planning = { ...(workItem.planning ?? {}) };
  delete planning.phaseId;
  delete planning.phase;
  delete planning.phaseOrder;
  delete planning.taskOrder;
  return {
    title: workItem.title,
    objective: workItem.objective,
    nonGoals: workItem.nonGoals,
    acceptanceCriteria: workItem.acceptanceCriteria,
    testCommands: workItem.testCommands,
    riskTier: workItem.riskTier,
    weight: workItem.weight,
    resourceProfile: workItem.resourceProfile,
    planning,
    recommendation: workItem.recommendation
  };
}

function auditMetadata(context, extra = {}) {
  return {
    ...extra,
    actor: context.actor,
    client: context.client,
    tool: context.tool,
    idempotencyKey: context.idempotencyKey,
    source: context.source ?? extra.source ?? null
  };
}

function normalizeSource(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? { kind: value } : value;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new DomainError('source must be an object or string', 'INVALID_INPUT');
  }
  const serialized = JSON.stringify(normalized);
  if (serialized.length > 20_000) throw new DomainError('source is too large', 'INVALID_INPUT');
  return JSON.parse(serialized);
}

function mutationSource(input, options) {
  return normalizeSource(options?.source ?? input?.source);
}

function nextPhaseOrder(state, projectId) {
  const orders = state.phases
    .filter((phase) => phase.projectId === projectId)
    .map((phase) => Number(phase.phaseOrder ?? Number(phase.rank) / 1024) || 0);
  return (orders.length > 0 ? Math.max(...orders) : 0) + 1;
}

function bumpScheduleVersion(project) {
  project.scheduleVersion = Number(project.scheduleVersion ?? 0) + 1;
  project.updatedAt = nowIso();
  return project.scheduleVersion;
}

function comparePhases(left, right) {
  return Number(left.rank ?? 0) - Number(right.rank ?? 0)
    || String(left.title).localeCompare(String(right.title), 'zh-CN');
}

function scheduleFromState(state, projectId) {
  const project = requireEntity(state.projects, projectId, 'project');
  const tasks = state.workItems.filter((item) => (
    item.projectId === projectId && item.status !== WORK_ITEM_STATUS.CANCELLED
  ));
  const phases = state.phases
    .filter((phase) => phase.projectId === projectId && phase.status !== 'CANCELLED')
    .sort(comparePhases)
    .map((phase) => {
      const phaseTasks = tasks
        .filter((task) => task.phaseId === phase.id || task.planning?.phaseId === phase.id)
        .sort(compareWorkItems);
      return {
        ...phase,
        parallelTaskIds: phaseTasks.filter((task) => isParallelCandidate(state, task)).map((task) => task.id),
        tasks: phaseTasks.map((task) => taskScheduleView(state, task))
      };
    });
  const mappedTaskIds = new Set(phases.flatMap((phase) => phase.tasks.map((task) => task.id)));
  const unscheduledTasks = tasks.filter((task) => !mappedTaskIds.has(task.id)).sort(compareWorkItems);
  return {
    project,
    scheduleVersion: Number(project.scheduleVersion ?? 0),
    phases,
    unscheduledTasks: unscheduledTasks.map((task) => taskScheduleView(state, task)),
    taskCount: tasks.length,
    lastModified: latestTimestamp([
      project.updatedAt,
      ...phases.map((phase) => phase.updatedAt),
      ...tasks.map((task) => task.updatedAt)
    ].filter(Boolean))
  };
}

function isParallelCandidate(state, task) {
  return [WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.READY].includes(task.status)
    && task.parallelPolicy !== 'SEQUENTIAL'
    && (task.dependsOnTaskIds ?? []).every((dependencyId) => {
      const dependency = state.workItems.find((entry) => entry.id === dependencyId);
      return dependency && DEPENDENCY_COMPLETE_WORK_ITEM_STATUSES.has(dependency.status);
    });
}

function taskScheduleView(state, task) {
  const run = task.currentRunId ? state.runs.find((entry) => entry.id === task.currentRunId) ?? null : null;
  const completionRecord = state.completionRecords.filter((entry) => entry.taskId === task.id).at(-1) ?? null;
  return {
    ...task,
    currentRun: run,
    latestCompletion: completionRecord
  };
}

function taskDetailsFromState(state, workItemId) {
  const task = requireEntity(state.workItems, workItemId, 'work item');
  return {
    task,
    project: requireEntity(state.projects, task.projectId, 'project'),
    phase: state.phases.find((phase) => phase.id === (task.phaseId ?? task.planning?.phaseId)) ?? null,
    run: task.currentRunId ? state.runs.find((run) => run.id === task.currentRunId) ?? null : null,
    evidence: state.evidence.filter((entry) => entry.workItemId === workItemId),
    completionRecords: state.completionRecords.filter((entry) => entry.taskId === workItemId),
    auditEvents: state.events.filter((entry) => entry.workItemId === workItemId)
  };
}

function completionResultFromState(state, completionRecord) {
  return {
    task: requireEntity(state.workItems, completionRecord.taskId, 'work item'),
    run: completionRecord.runId ? requireEntity(state.runs, completionRecord.runId, 'run') : null,
    completionRecord,
    evidence: state.evidence.filter((entry) => (
      entry.runId === completionRecord.runId && entry.workItemId === completionRecord.taskId
    ))
  };
}

function verificationResultFromState(state, workItemId, completionRecord, evidence) {
  return {
    task: requireEntity(state.workItems, workItemId, 'work item'),
    completionRecord: completionRecord ?? null,
    evidence
  };
}

function normalizeCompletionEvidence(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new DomainError('evidence must contain at most 50 records', 'INVALID_INPUT');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DomainError(`evidence[${index}] must be an object`, 'INVALID_INPUT');
    }
    return {
      type: normalizeRequiredText(entry.type, `evidence[${index}].type`, 80).toUpperCase(),
      summary: normalizeRequiredText(entry.summary, `evidence[${index}].summary`, 2000),
      metadata: normalizeSource(entry.metadata) ?? {}
    };
  });
}

function normalizeCompletionOutcome(value = 'COMPLETED') {
  const outcome = String(value ?? 'COMPLETED').trim().toUpperCase();
  if (!COMPLETION_OUTCOMES.includes(outcome)) {
    throw new DomainError(`outcome must be one of: ${COMPLETION_OUTCOMES.join(', ')}`, 'INVALID_INPUT');
  }
  return outcome;
}

function normalizeIsoTimestamp(value, name, required = false) {
  const timestamp = normalizeOptionalText(value, name, 80);
  if (!timestamp) {
    if (required) throw new DomainError(`${name} is required when reporting without a started Run`, 'INVALID_INPUT');
    return null;
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new DomainError(`${name} must be an ISO-8601 timestamp`, 'INVALID_INPUT');
  }
  return new Date(milliseconds).toISOString();
}

function transitionReportedTaskToRunning(workItem, at) {
  let task = workItem;
  if ([WORK_ITEM_STATUS.PLANNED, WORK_ITEM_STATUS.DEFERRED, WORK_ITEM_STATUS.BLOCKED].includes(task.status)) {
    task = transitionWorkItem(task, WORK_ITEM_STATUS.READY, at);
  }
  if ([WORK_ITEM_STATUS.READY, WORK_ITEM_STATUS.RECURRING].includes(task.status)) {
    task = transitionWorkItem(task, WORK_ITEM_STATUS.QUEUED, at);
  }
  if (task.status === WORK_ITEM_STATUS.QUEUED) {
    task = transitionWorkItem(task, WORK_ITEM_STATUS.RUNNING, at);
  }
  if (task.status !== WORK_ITEM_STATUS.RUNNING) {
    throw new DomainError(
      `Task must be PLANNED, DEFERRED, READY, BLOCKED, or RECURRING for a one-shot result report; received ${task.status}`,
      'INVALID_TRANSITION'
    );
  }
  return task;
}

function isPassingTestEvidence(evidence) {
  const exitCode = Number(evidence.metadata?.exitCode);
  const status = String(evidence.metadata?.status ?? '').toUpperCase();
  return exitCode === 0 || evidence.metadata?.passed === true || ['PASS', 'PASSED', 'SUCCESS', 'SUCCEEDED'].includes(status);
}

function normalizeVerificationMethod(value) {
  const method = normalizeRequiredText(value, 'verificationMethod', 80).toUpperCase();
  const allowed = ['DETERMINISTIC_TEST', 'INDEPENDENT_REVIEW', 'HUMAN_APPROVAL'];
  if (!allowed.includes(method)) {
    throw new DomainError(`verificationMethod must be one of: ${allowed.join(', ')}`, 'INVALID_INPUT');
  }
  return method;
}

function normalizeStringList(value, name, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DomainError(`${name} must be an array with at most ${maxItems} items`, 'INVALID_INPUT');
  }
  return value.map((entry, index) => normalizeRequiredText(entry, `${name}[${index}]`, 1000));
}

function normalizeRequiredText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new DomainError(`${name} must be a non-empty string no longer than ${maxLength} characters`, 'INVALID_INPUT');
  }
  return value.trim();
}

function normalizeOptionalText(value, name, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeRequiredText(value, name, maxLength);
}

function normalizeScanSeverity(value = 'medium') {
  const severity = normalizeRequiredText(value, 'severity', 20).toLowerCase();
  const allowed = ['low', 'medium', 'high', 'critical'];
  if (!allowed.includes(severity)) {
    throw new DomainError(`severity must be one of: ${allowed.join(', ')}`, 'INVALID_INPUT');
  }
  return severity;
}

function normalizeScanProposalStatus(value) {
  const status = normalizeRequiredText(value, 'status', 20).toUpperCase();
  const allowed = ['PENDING', 'ACCEPTED', 'DISMISSED'];
  if (!allowed.includes(status)) {
    throw new DomainError(`status must be one of: ${allowed.join(', ')}`, 'INVALID_INPUT');
  }
  return status;
}

function normalizeScanReviewDecision(value) {
  const decision = normalizeRequiredText(value, 'decision', 20).toUpperCase();
  if (!['ACCEPT', 'DISMISS'].includes(decision)) {
    throw new DomainError('decision must be ACCEPT or DISMISS', 'INVALID_INPUT');
  }
  return decision;
}

function scanProposalFingerprint(projectId, value) {
  return createHash('sha256').update(`${projectId}\u0000${value.trim().toLowerCase()}`).digest('hex');
}

function scanPriority(severity) {
  return { critical: 'P0', high: 'P0', medium: 'P1', low: 'P2' }[normalizeScanSeverity(severity)];
}

function scanRiskTier(severity) {
  return { critical: 'critical', high: 'high', medium: 'medium', low: 'low' }[normalizeScanSeverity(severity)];
}

function applyPortfolioTemplate(state, template, userId) {
  const projectIds = [];
  const archivedProjectIds = [];
  const conflicts = [];

  for (const projectSpec of template) {
    let project = state.projects.find((entry) => (
      entry.templateKey === PORTFOLIO_TEMPLATE_KEY && entry.templateVersion === PORTFOLIO_TEMPLATE_VERSION
        && entry.name === projectSpec.name
    ));
    const wasTemplateOwned = Boolean(project);
    let untouchedLegacy = false;
    if (!project) {
      const legacy = findLegacyProject(state, projectSpec);
      if (legacy) {
        const changedFields = legacyProjectChanges(state, legacy, projectSpec);
        if (changedFields.length > 0) {
          const conflict = recordMigrationConflict(state, {
            userId,
            sourceProjectId: legacy.id,
            sourceName: legacy.name,
            targetName: projectSpec.name,
            changedFields,
            reason: 'USER_MODIFIED_LEGACY_TEMPLATE'
          });
          conflicts.push(conflict);
        } else if (projectSpec.name === 'Lifeline') {
          // The first vertical slice is real user data: keep its project ID
          // and any existing Run while applying only product metadata.
          project = legacy;
          untouchedLegacy = true;
          project.name = projectSpec.name;
          project.description = projectSpec.description;
          project.headline = projectSpec.headline;
        } else {
          archiveLegacyProject(state, legacy);
          archivedProjectIds.push(legacy.id);
        }
      }
    }

    if (!project) {
      project = createProject({
        name: projectSpec.name,
        description: projectSpec.description,
        repositoryUrl: projectSpec.repositoryUrl,
        strategicValue: projectSpec.strategicValue
      });
      project.headline = projectSpec.headline;
      state.projects.push(project);
    }
    project.templateKey = PORTFOLIO_TEMPLATE_KEY;
    project.templateVersion = PORTFOLIO_TEMPLATE_VERSION;
    project.headline = projectSpec.headline;
    if (!wasTemplateOwned) project.updatedAt = nowIso();
    projectIds.push(project.id);

    const phases = new Map();
    for (const itemSpec of projectSpec.workItems) {
      const phaseKey = `${project.id}|${itemSpec.planning.phaseOrder}|${itemSpec.planning.phase}`;
      let phase = phases.get(phaseKey) ?? state.phases.find((entry) => (
        entry.projectId === project.id
          && phaseOrderFromRank(entry.rank) === Number(itemSpec.planning.phaseOrder)
          && entry.title === itemSpec.planning.phase
      ));
      if (!phase) {
        phase = createPhase({
          projectId: project.id,
          title: itemSpec.planning.phase,
          goal: `完成${itemSpec.planning.phase}阶段目标`,
          rank: Number(itemSpec.planning.phaseOrder) * 1024,
          createdBy: userId
        });
        state.phases.push(phase);
      }
      phases.set(phaseKey, phase);

      let item = state.workItems.find((entry) => (
        entry.projectId === project.id && entry.title === itemSpec.title
      ));
      if (item) {
        const changedFields = untouchedLegacy ? [] : templateTaskChanges(item, itemSpec);
        if (changedFields.length > 0 && !item.templateKey) {
          const conflict = recordMigrationConflict(state, {
            userId,
            sourceProjectId: project.id,
            sourceWorkItemId: item.id,
            sourceName: item.title,
            targetName: itemSpec.title,
            changedFields,
            reason: 'USER_MODIFIED_LEGACY_TASK'
          });
          conflicts.push(conflict);
          continue;
        }
      }
      if (!item) {
        item = createWorkItem({
          projectId: project.id,
          title: itemSpec.title,
          objective: itemSpec.objective,
          acceptanceCriteria: itemSpec.acceptanceCriteria,
          testCommands: ['npm test'],
          riskTier: itemSpec.planning.kind === 'bug' ? 'medium' : 'low',
          weight: 1,
          resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 2 },
          planning: { ...itemSpec.planning, phaseId: phase.id },
          recommendation: itemSpec.recommendation
        });
        item.status = itemSpec.status;
        if (itemSpec.status === WORK_ITEM_STATUS.RECURRING) {
          item.recurrence = { enabled: true };
        }
        item.phaseId = phase.id;
        item.templateKey = PORTFOLIO_TEMPLATE_KEY;
        item.templateVersion = PORTFOLIO_TEMPLATE_VERSION;
        state.workItems.push(item);
      } else if (item.templateKey === PORTFOLIO_TEMPLATE_KEY || untouchedLegacy) {
        item.phaseId = phase.id;
        item.planning = { ...item.planning, phaseId: phase.id };
        if (untouchedLegacy) {
          item.templateKey = PORTFOLIO_TEMPLATE_KEY;
          item.templateVersion = PORTFOLIO_TEMPLATE_VERSION;
        }
      }

      const hasTerminalHistory = ['VERIFIED', 'RELEASED', 'RECURRING'].includes(item.status);
      if (itemSpec.history && !hasTerminalHistory) {
        item.historySources = item.historySources ?? [];
        if (!item.historySources.some((entry) => JSON.stringify(entry) === JSON.stringify(itemSpec.history))) {
          item.historySources.push(itemSpec.history);
        }
      }
      if (itemSpec.history && hasTerminalHistory && !state.completionRecords.some((entry) => (
        entry.taskId === item.id && entry.completionMethod === 'IMPORTED_HISTORY'
      ))) {
        const evidence = {
          id: createId('evidence'),
          key: `history:${item.id}:${itemSpec.history.commitSha ?? itemSpec.history.artifactUris.join('|')}`,
          runId: null,
          workItemId: item.id,
          type: 'IMPORTED_HISTORY',
          score: 1,
          summary: itemSpec.history.summary,
          metadata: {
            commitSha: itemSpec.history.commitSha ?? null,
            artifactUris: itemSpec.history.artifactUris ?? []
          },
          createdAt: nowIso()
        };
        state.evidence.push(evidence);
        const completionAt = nowIso();
        state.completionRecords.push(createCompletionRecord({
          taskId: item.id,
          completionMethod: 'IMPORTED_HISTORY',
          executor: 'history-import',
          commitSha: itemSpec.history.commitSha,
          artifactUris: itemSpec.history.artifactUris,
          testEvidenceIds: [evidence.id],
          resultSummary: itemSpec.history.summary,
          startedAt: completionAt,
          completedAt: completionAt,
          submittedBy: userId,
          verifiedBy: itemSpec.status === 'VERIFIED' || itemSpec.status === 'RELEASED' ? 'history-import' : null,
          verifiedAt: itemSpec.status === 'VERIFIED' || itemSpec.status === 'RELEASED' ? nowIso() : null
        }));
      }
    }
    project.currentTaskId = latestCompletedTaskId(state, project.id);
    for (const phase of phases.values()) {
      const phaseItems = state.workItems.filter((entry) => (
        entry.phaseId === phase.id && entry.status !== WORK_ITEM_STATUS.CANCELLED
      ));
      if (phaseItems.length > 0 && phaseItems.every((entry) => (
        ['VERIFIED', 'RELEASED', 'RECURRING', 'ARCHIVED'].includes(entry.status)
      ))) {
        phase.status = 'COMPLETED';
      }
      phase.updatedAt = nowIso();
    }
  }

  return { projectIds, archivedProjectIds, conflicts };
}

function findLegacyProject(state, projectSpec) {
  const aliases = {
    Lifeline: ['Lifeline Demo'],
    EchoMe: ['Release Radar · 示例', 'Release Radar', 'Release Radar · Demo'],
    Totemora: ['Knowledge Lab · 示例', 'Knowledge Lab', 'Knowledge Lab · Demo']
  };
  const named = state.projects.find((entry) => aliases[projectSpec.name]?.includes(entry.name));
  if (named) return named;
  if (projectSpec.repositoryUrl) {
    return state.projects.find((entry) => entry.repositoryUrl === projectSpec.repositoryUrl);
  }
  return null;
}

function legacyProjectChanges(state, project, projectSpec) {
  const changes = [];
  const expected = {
    Lifeline: { description: 'First evidence-driven control-plane vertical slice', strategicValue: 10, repositoryUrl: projectSpec.repositoryUrl },
    EchoMe: { description: '用于演示较低优先级项目和 Bug 插队', strategicValue: 7, repositoryUrl: null },
    Totemora: { description: '用于演示低算力窗口可选择推进的研究型项目', strategicValue: 5, repositoryUrl: null }
  }[projectSpec.name];
  if (!expected) return ['unknown-target'];
  if (!legacyProjectNames(projectSpec.name).includes(project.name)) changes.push('project.name');
  for (const field of ['description', 'strategicValue', 'repositoryUrl']) {
    const actualValue = project[field] === undefined ? null : project[field];
    if (actualValue !== expected[field]) changes.push(`project.${field}`);
  }
  if (project.status !== 'ACTIVE') changes.push('project.status');
  const expectedTitles = legacyTaskTitles(projectSpec.name);
  const tasks = state.workItems.filter((entry) => entry.projectId === project.id);
  const expectedTitleSet = new Set(expectedTitles);
  const additionalTasks = tasks.filter((entry) => !expectedTitleSet.has(entry.title));
  const preservesManagedAdditions = additionalTasks.length === 0 || (
    projectSpec.name === 'Lifeline' && additionalTasks.every((entry) => (
      Boolean(entry.idempotencyKey) && ['codex-plan', 'codex-mcp'].includes(entry.source?.kind)
    ))
  );
  const legacyTasks = tasks.filter((entry) => expectedTitleSet.has(entry.title));
  const actualTitles = legacyTasks.map((entry) => entry.title).sort();
  if (!preservesManagedAdditions) changes.push('workItems');
  if (expectedTitles.length !== actualTitles.length || expectedTitles.some((title, index) => title !== actualTitles[index])) {
    changes.push('workItems');
  } else {
    for (const expected of legacyTaskFingerprints(projectSpec.name)) {
      const actual = legacyTasks.find((entry) => entry.title === expected.title);
      if (!actual) continue;
      if (expected.objective && actual.objective !== expected.objective) changes.push(`workItems.${expected.title}.objective`);
      if (expected.phase && actual.planning?.phase !== expected.phase) changes.push(`workItems.${expected.title}.planning.phase`);
      if (expected.phaseOrder !== undefined && Number(actual.planning?.phaseOrder) !== expected.phaseOrder) {
        changes.push(`workItems.${expected.title}.planning.phaseOrder`);
      }
      const expectedAcceptance = legacyAcceptanceCriteria(expected.title);
      if (Array.isArray(actual.acceptanceCriteria)
        && JSON.stringify(actual.acceptanceCriteria) !== JSON.stringify(expectedAcceptance)) {
        changes.push(`workItems.${expected.title}.acceptanceCriteria`);
      }
      if (Array.isArray(actual.testCommands)
        && JSON.stringify(actual.testCommands) !== JSON.stringify(['npm test'])) {
        changes.push(`workItems.${expected.title}.testCommands`);
      }
    }
  }
  return changes;
}

function legacyAcceptanceCriteria(title) {
  if (title === 'Run the first durable mock workflow') {
    return [
      'The work item reaches VERIFIED through valid state transitions',
      'The run can be replayed from persisted events',
      'Evidence raises project verified progress'
    ];
  }
  return [`${title} 具有可追溯结果或验收证据`];
}

function legacyProjectNames(name) {
  return {
    Lifeline: ['Lifeline Demo'],
    EchoMe: ['Release Radar · 示例', 'Release Radar', 'Release Radar · Demo'],
    Totemora: ['Knowledge Lab · 示例', 'Knowledge Lab', 'Knowledge Lab · Demo']
  }[name] ?? [];
}

function legacyTaskFingerprints(name) {
  if (name === 'Lifeline') {
    return [
      ['Run the first durable mock workflow', 'Validate a work item, persist every workflow checkpoint, produce evidence, and replay the run in the UI.', '待排期', 99],
      ['理解现有控制平面与首页链路', '确认项目事实、工作包状态机、首页 API 与渲染边界。', '方向收敛', 1],
      ['确定 Project × Phase × Task 两级模型', '把跨项目优先级、项目内顺序与任务推荐配置压缩到两层。', '方向收敛', 1],
      ['实现纵向项目、横向阶段的推进总览', '以项目为行、项目自己的顺序阶段为列，直观展示所有未完成工作。', '组合大板', 2],
      ['为任务补齐推荐执行配置', '展示能力档、推理强度、算力等级、估时与推荐做法，减少临场选择。', '组合大板', 2],
      ['桌面与移动端真实渲染验收', '检查横向排期、信息密度、键盘操作与移动端结构化降级。', '视觉验收', 3],
      ['修复扫描发现的首页布局问题', '只修复实际渲染或检测明确发现的问题，并保留回归证据。', '视觉验收', 3],
      ['周期扫描仓库 Bug 并回填待处理任务', '按低成本规则扫描 → 异常归纳 → 新 Bug Task 的路径持续补充排期。', '持续扫描', 4]
    ].map(([title, objective, phase, phaseOrder]) => ({ title, objective, phase, phaseOrder }));
  }
  if (name === 'EchoMe') {
    return [
      ['采集仓库、CI 与部署基线', '形成可追溯的只读项目快照。', '项目接入', 1],
      ['修复部署回滚检查失效', '复现并修复回滚门禁未覆盖失败发布的问题。', '风险修复', 2],
      ['验证发布证据链', '确认测试、审查、发布与运行验证证据可以串联。', '发布验证', 3]
    ].map(([title, objective, phase, phaseOrder]) => ({ title, objective, phase, phaseOrder }));
  }
  if (name === 'Totemora') {
    return [
      ['增量收集新证据', '用低算力扫描更新来源并去重。', '证据收集', 1],
      ['生成证据差异摘要', '只归纳新增、冲突与失效证据，保留原始引用。', '结论更新', 2],
      ['复核高影响结论', '由独立能力档审查高影响变化后再更新正式结论。', '独立复核', 3]
    ].map(([title, objective, phase, phaseOrder]) => ({ title, objective, phase, phaseOrder }));
  }
  return [];
}

function legacyTaskTitles(name) {
  if (name === 'Lifeline') return [
    'Run the first durable mock workflow',
    '理解现有控制平面与首页链路',
    '确定 Project × Phase × Task 两级模型',
    '实现纵向项目、横向阶段的推进总览',
    '为任务补齐推荐执行配置',
    '桌面与移动端真实渲染验收',
    '修复扫描发现的首页布局问题',
    '周期扫描仓库 Bug 并回填待处理任务'
  ].sort();
  if (name === 'EchoMe') return ['采集仓库、CI 与部署基线', '修复部署回滚检查失效', '验证发布证据链'].sort();
  if (name === 'Totemora') return ['增量收集新证据', '生成证据差异摘要', '复核高影响结论'].sort();
  return [];
}

function templateTaskChanges(item, spec) {
  const changes = [];
  if (item.objective && item.objective !== spec.objective) changes.push('objective');
  if (item.planning?.phase && item.planning.phase !== spec.planning.phase) changes.push('planning.phase');
  if (item.planning?.phaseOrder && Number(item.planning.phaseOrder) !== Number(spec.planning.phaseOrder)) changes.push('planning.phaseOrder');
  return changes;
}

function recordMigrationConflict(state, input) {
  const conflict = {
    id: createId('migration-conflict'),
    templateKey: PORTFOLIO_TEMPLATE_KEY,
    templateVersion: PORTFOLIO_TEMPLATE_VERSION,
    ...input,
    projectId: input.sourceProjectId ?? null,
    workItemId: input.sourceWorkItemId ?? null,
    fields: input.changedFields ?? [],
    createdAt: nowIso(),
    resolvedAt: null
  };
  state.migrationConflicts.push(conflict);
  return conflict;
}

function archiveLegacyProject(state, project) {
  project.status = 'ARCHIVED';
  project.updatedAt = nowIso();
  for (const item of state.workItems.filter((entry) => entry.projectId === project.id)) {
    item.status = WORK_ITEM_STATUS.ARCHIVED;
    item.updatedAt = nowIso();
  }
}

function compareProjects(left, right) {
  return Number(right.strategicValue ?? 0) - Number(left.strategicValue ?? 0)
    || String(left.name).localeCompare(String(right.name), 'zh-CN');
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.endMs >= interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.startMs > previous.endMs) {
      merged.push({ ...interval });
    } else {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    }
  }
  return merged;
}

function invertIntervals(intervals, startMs, endMs) {
  const gaps = [];
  let cursor = startMs;
  for (const interval of intervals) {
    if (interval.startMs > cursor) gaps.push({ startMs: cursor, endMs: interval.startMs });
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < endMs) gaps.push({ startMs: cursor, endMs });
  return gaps;
}

function peakConcurrency(intervals, startMs, endMs) {
  const points = intervals.flatMap((interval) => {
    const start = Math.max(startMs, Date.parse(interval.startedAt));
    const end = Math.min(endMs, Date.parse(interval.completedAt));
    if (end <= start) return [];
    return [{ at: start, delta: 1 }, { at: end, delta: -1 }];
  }).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function countTrajectoryOutcomes(intervals, outcome, startMs, endMs) {
  return intervals.filter((interval) => {
    const completedMs = Date.parse(interval.completedAt);
    return interval.outcome === outcome && completedMs >= startMs && completedMs <= endMs;
  }).length;
}

function compareWorkItems(left, right) {
  return Number(left.planning?.phaseOrder ?? 999) - Number(right.planning?.phaseOrder ?? 999)
    || Number(left.planning?.taskOrder ?? 999) - Number(right.planning?.taskOrder ?? 999)
    || String(left.title).localeCompare(String(right.title), 'zh-CN');
}

function compareCandidateWorkItems(left, right) {
  return candidatePriorityScore(right) - candidatePriorityScore(left) || compareWorkItems(left, right);
}

function candidatePriorityScore(workItem) {
  const priority = { P0: 40, P1: 30, P2: 20, P3: 10 }[workItem.planning?.priority] ?? 0;
  const readiness = {
    REVIEW: 48,
    RUNNING: 46,
    QUEUED: 44,
    READY: 36,
    PLANNED: 24,
    TRIAGED: 16,
    DISCOVERED: 10,
    BLOCKED: -40
  }[workItem.status] ?? 0;
  const foundation = Math.max(0, 100 - Number(workItem.planning?.phaseOrder ?? 100));
  const humanPriority = workItem.provenance?.origin === 'HUMAN' ? 8 : 0;
  return (workItem.starred === true ? 1000 : 0)
    + scheduledDatePriority(workItem.scheduledFor)
    + readiness
    + priority
    + foundation
    + humanPriority;
}

function scheduledDatePriority(value) {
  if (!value) return 0;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const target = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(target)) return 0;
  const days = Math.ceil((target - todayUtc) / 86_400_000);
  if (days <= 0) return 120;
  return Math.max(0, 100 - days * 5);
}

function isUnfinished(workItem) {
  return ![
    WORK_ITEM_STATUS.DEFERRED,
    WORK_ITEM_STATUS.RECURRING,
    WORK_ITEM_STATUS.VERIFIED,
    WORK_ITEM_STATUS.RELEASED,
    WORK_ITEM_STATUS.ARCHIVED,
    WORK_ITEM_STATUS.CANCELLED
  ].includes(workItem.status);
}

function isRecurringWorkItem(workItem) {
  return workItem.status === WORK_ITEM_STATUS.RECURRING || workItem.recurrence?.enabled === true;
}

function nextRunAttempt(state, workItemId) {
  return state.runs.filter((run) => run.workItemId === workItemId).reduce(
    (highest, run) => Math.max(highest, Number(run.attempt) || 0),
    0
  ) + 1;
}

function portfolioDemo() {
  return [
    {
      primary: true,
      name: 'Lifeline',
      description: '证据驱动的多项目 AI 研发控制平面',
      repositoryUrl: 'https://github.com/qzhqzh/Lifeline',
      strategicValue: 10,
      workItems: [
        demoItem('理解现有控制平面与首页链路', '确认项目事实、工作包状态机、首页 API 与渲染边界。', 1, 1, {
          phase: '方向收敛', kind: 'research', priority: 'P0', demoState: 'run', estimateMinutes: 30
        }),
        demoItem('确定 Project × Phase × Task 两级模型', '把跨项目优先级、项目内顺序与任务推荐配置压缩到两层。', 1, 2, {
          phase: '方向收敛', kind: 'feature', priority: 'P0', demoState: 'ready', estimateMinutes: 45
        }),
        demoItem('实现纵向项目、横向阶段的推进总览', '以项目为行、项目自己的顺序阶段为列，直观展示所有未完成工作。', 2, 1, {
          phase: '组合大板', kind: 'feature', priority: 'P0', commitment: 'COMMITTED', estimateMinutes: 120
        }),
        demoItem('为任务补齐推荐执行配置', '展示能力档、推理强度、算力等级、估时与推荐做法，减少临场选择。', 2, 2, {
          phase: '组合大板', kind: 'feature', priority: 'P1', commitment: 'COMMITTED', estimateMinutes: 60
        }),
        demoItem('桌面与移动端真实渲染验收', '检查横向排期、信息密度、键盘操作与移动端结构化降级。', 3, 1, {
          phase: '视觉验收', kind: 'review', priority: 'P0', estimateMinutes: 45
        }),
        demoItem('修复扫描发现的首页布局问题', '只修复实际渲染或检测明确发现的问题，并保留回归证据。', 3, 2, {
          phase: '视觉验收', kind: 'bug', priority: 'P1', estimateMinutes: 40
        }),
        demoItem('周期扫描仓库 Bug 并回填待处理任务', '按低成本规则扫描 → 异常归纳 → 新 Bug Task 的路径持续补充排期。', 4, 1, {
          phase: '持续扫描', kind: 'scan', priority: 'P1', estimateMinutes: 20
        })
      ]
    },
    {
      name: 'Release Radar · 示例',
      description: '用于演示较低优先级项目和 Bug 插队',
      strategicValue: 7,
      workItems: [
        demoItem('采集仓库、CI 与部署基线', '形成可追溯的只读项目快照。', 1, 1, {
          phase: '项目接入', kind: 'scan', priority: 'P1', demoState: 'ready', estimateMinutes: 20
        }),
        demoItem('修复部署回滚检查失效', '复现并修复回滚门禁未覆盖失败发布的问题。', 2, 1, {
          phase: '风险修复', kind: 'bug', priority: 'P0', commitment: 'COMMITTED', estimateMinutes: 50
        }),
        demoItem('验证发布证据链', '确认测试、审查、发布与运行验证证据可以串联。', 3, 1, {
          phase: '发布验证', kind: 'review', priority: 'P1', estimateMinutes: 35
        })
      ]
    },
    {
      name: 'Knowledge Lab · 示例',
      description: '用于演示低算力窗口可选择推进的研究型项目',
      strategicValue: 5,
      workItems: [
        demoItem('增量收集新证据', '用低算力扫描更新来源并去重。', 1, 1, {
          phase: '证据收集', kind: 'scan', priority: 'P2', demoState: 'ready', estimateMinutes: 15
        }),
        demoItem('生成证据差异摘要', '只归纳新增、冲突与失效证据，保留原始引用。', 2, 1, {
          phase: '结论更新', kind: 'research', priority: 'P2', estimateMinutes: 35
        }),
        demoItem('复核高影响结论', '由独立能力档审查高影响变化后再更新正式结论。', 3, 1, {
          phase: '独立复核', kind: 'review', priority: 'P2', estimateMinutes: 30
        })
      ]
    }
  ];
}

function demoItem(title, objective, phaseOrder, taskOrder, options) {
  return {
    title,
    objective,
    acceptanceCriteria: [`${title} 具有可追溯结果或验收证据`],
    demoState: options.demoState,
    planning: {
      phase: options.phase,
      phaseOrder,
      taskOrder,
      kind: options.kind,
      priority: options.priority,
      commitment: options.commitment ?? 'TENTATIVE'
    },
    recommendation: { estimateMinutes: options.estimateMinutes }
  };
}

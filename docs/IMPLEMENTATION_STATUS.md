# Lifeline implementation status

> Updated: 2026-08-02

## Implemented vertical slice

The repository now contains a runnable, dependency-light control-plane MVP implementing the first loop defined by the development plan:

```text
create work item
→ validate execution contract
→ queue durable run
→ execute mock stages
→ persist checkpoints and evidence
→ promote through deterministic states
→ calculate verified progress
→ replay the complete run in the UI
```

Implemented capabilities:

- projects and work items;
- explicit, validated work-item state transitions;
- execution contracts containing objective, acceptance criteria, test commands, risk, weight, and resource profile;
- atomic JSON persistence for local MVP operation;
- startup recovery of queued or running workflows;
- idempotent queueing of active work items;
- replaceable `MockExecutor` with checkpointed steps;
- evidence records with deterministic progress scoring;
- append-only run and audit events;
- portfolio dashboard API;
- Server-Sent Events run stream;
- browser portfolio board ordered by strategic value, with each project rendered as its own horizontal Phase → Task sequence;
- project detail navigation with a complete Phase → Task history, a product-level completed/current/pending state summary, browser-safe return flow, and desktop/mobile layouts;
- stable row/card detail views, complete fixed-position hover details, visually locked completed tasks, and one uniquely focused current-progress node;
- optimistic schedule editing with smooth in-Phase placeholder drag, a right-side task editor, and audited cancellation instead of physical deletion;
- one top-right creation drawer for both projects and tasks, including existing/new Phase selection, while the lower workbench keeps only run replay;
- persistent human/AI/imported task origin and an `AI submitted · human adjusted` content-edit trail that is not triggered by reordering;
- backward-compatible planning metadata and task-specific executor, reasoning, compute, estimate, and approach recommendations;
- focused work-item actions, project/task creation, compute-aware filters, and run replay;
- schema-versioned JSON migration with formal Phase, BootstrapReceipt, and CompletionRecord records;
- versioned Lifeline, EchoMe, and Totemora portfolio data with evidence-backed imported history;
- per-user, atomic Portfolio V2 bootstrap that is idempotent across double clicks and service restarts;
- legacy demo fingerprint migration that preserves the Lifeline project ID and existing runs, archives untouched demo projects, and records conflicts instead of overwriting changed data;
- dashboard bootstrap capability and a one-time UI action that is removed from the DOM after the receipt exists;
- a local stdio MCP adapter that reuses the Web Application Service and exposes Portfolio/Project/Schedule/Task/Run resources;
- MCP read and write tools for idempotent Project/Phase/Task creation, atomic plan sync, versioned task edit/reorder/cancel, Agent run start, completion submission, and evidence-gated verification;
- project-local Codex configuration and `AGENTS.md` rules that automatically track non-trivial multi-task goals without filling the board with one-step edits;
- cross-process JSON locking and reload semantics so Web and MCP processes do not overwrite each other's writes;
- OpenAPI description;
- Node native unit, integration, MCP protocol, idempotency, concurrency, and verification-gate tests;
- container image, production Docker Compose entrypoint, and a source-mounted Node watch development override;
- GitHub Actions CI.

## Why the first runtime is dependency-light

The long-term architecture still targets PostgreSQL, Prisma, Temporal, React, and the selected code-agent adapters. The first slice deliberately uses Node's standard library and an atomic JSON store so the domain boundaries and recovery semantics can be verified before infrastructure is introduced.

This is not a replacement for Temporal or PostgreSQL. It is an executable reference implementation of the contracts those adapters must preserve:

- the control plane owns state;
- executors are replaceable;
- every step is checkpointed;
- invalid transitions are rejected;
- evidence, not model claims, advances progress;
- a restart must not lose workflow intent or history.

## Next implementation increments

The local MCP vertical slice is now executable. Schedule-version conflicts, provenance-aware local task create/edit/reorder/cancel, the single creation entry with dirty-draft protection, and row/card views are implemented. Remaining S3 work includes stable filter geometry, keyboard and cross-Phase sorting, dependency validation, Diff/Undo, and parallel slots; remaining S4 production work includes scanner-finding proposals, Streamable HTTP, OAuth scopes, and true multi-user isolation. The detailed order and acceptance criteria live in [PORTFOLIO_V2_EXECUTION_PLAN.md](PORTFOLIO_V2_EXECUTION_PLAN.md).

The infrastructure migration to PostgreSQL, Temporal, the real executor, and production model routing remains planned after the Portfolio V2 control-plane contracts stabilize.

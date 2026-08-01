# Lifeline implementation status

> Updated: 2026-08-01

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
- browser dashboard for project progress, work-item actions, and run replay;
- OpenAPI description;
- Node native unit and integration tests;
- container image and Docker Compose entrypoint;
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

1. Replace `JsonStore` with a PostgreSQL repository while retaining the service contract.
2. Replace the local workflow runner with a Temporal workflow and activities.
3. Split the browser UI into the planned React application.
4. Add GitHub project ingestion and project snapshots.
5. Add a real shell/worktree executor behind the executor port.
6. Add approvals and resource-budget admission before queueing.
7. Add model-policy routing and evaluation records.

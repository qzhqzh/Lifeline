# ADR-0002: Use a dependency-light local runtime for the first vertical slice

- Status: Accepted
- Date: 2026-08-01

## Context

ADR-0001 establishes a deterministic control plane with replaceable AI executors. The planned production stack includes PostgreSQL, Prisma, Temporal, React, and external agent adapters. Introducing all of those systems before validating the core state, evidence, recovery, and replay contracts would make the first implementation expensive to diagnose and difficult to run in a newly initialized repository.

## Decision

Implement the first executable slice using:

- Node.js 22 standard library;
- an atomic JSON repository behind a storage boundary;
- a checkpointed local workflow service;
- a replaceable mock executor;
- a static browser client using the same HTTP and SSE contracts intended for the later React client.

The vertical slice must still preserve the production architecture's invariants:

1. state is external to the executor;
2. work-item transitions are deterministic and validated;
3. every workflow stage is persisted before the next stage;
4. evidence has explicit type and score;
5. progress is calculated from evidence;
6. queued and running workflows are recovered after restart;
7. the full execution can be replayed.

## Consequences

### Positive

- The repository becomes runnable without an external package registry or infrastructure.
- Domain and recovery semantics are testable immediately.
- Later PostgreSQL and Temporal adapters have a concrete behavior contract.
- The UI can validate the complete user journey before a framework migration.

### Negative

- The JSON repository is single-process and unsuitable for horizontal scale.
- The local workflow runner does not provide Temporal's distributed timers, activity queues, or operational tooling.
- The static UI is not the final React component architecture.

## Migration trigger

Move to PostgreSQL and Temporal before adding parallel real code executors, multi-host workers, production credentials, or workload admission across multiple projects.

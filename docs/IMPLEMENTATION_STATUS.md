# Lifeline implementation status

> Updated: 2026-08-12

## Current executable product

Lifeline is a local-first control plane for one project owner coordinating multiple projects and AI Agents. The active planning model remains exactly `Project → Phase → Task`; dynamic dispatch metadata does not add a third hierarchy level.

The current end-to-end path is:

```text
derive project/phase truth
→ place eligible work in NOW / NEXT / RESERVE / BACKLOG
→ one Agent atomically claims a task and bounded lease
→ the Agent submits one real completion result
→ the task enters REVIEW
→ a different Agent or deterministic gate verifies it
→ VERIFIED progress and the next dispatch batch are recomputed
```

Implemented runtime capabilities:

- one shared derivation engine for REST, MCP and the browser: phase status, current/last verified task, project health, capacity and structured dispatch reasons;
- default high/medium/low execution capacity of `1 / 1 / 2`, one independent review slot, dependency and contract gates, and one change task per project unless parallel work is explicitly allowed;
- `ON_TRACK`, `AT_RISK`, `BLOCKED`, `STALLED`, `DORMANT` and `COMPLETE` project health, including 24-hour review risk and 72-hour no-progress detection;
- auditable rebalance, create, update, reorder, defer, resume, cancel and restore operations with schedule-version conflict protection;
- atomic multi-Agent claim, `max(30 minutes, estimate × 2)` leases capped at eight hours, safe expiry recovery and rejection of late results;
- one completion report followed by independent review or deterministic verification; explicit human approval is restricted to the local project owner, the legacy Mock execution endpoint is disabled, and Mock history is isolated from formal progress;
- local stdio MCP plus LAN Streamable HTTP MCP with per-Agent bearer tokens and the scopes `portfolio:read`, `schedule:write`, `task:claim`, `completion:write`, and `verification:write`;
- 30-day real-Agent efficiency metrics by project, task kind, model and compute class, including throughput, execution/review time, failure/block and reopen rates, estimate bias, observed saturation and explicitly unknown unreported intervals;
- recommendation calibration only after five matching real samples and an outcome-quality gate; otherwise the UI and API keep the rule default and show insufficient confidence;
- a stable dark portfolio UI with the 3D Lifeline emblem, first-screen execution decisions, fixed project columns, horizontally scrolling phases, keyed ten-second refresh, a task inspector, responsive 5/4/2/1 detail cards and direction-aware hover details;
- a collapsed-by-default real progression trajectory that records results and gaps without recording Agent internal thought;
- Codex, Google AI Pro, Cursor, Grok and 小云雀 subscription snapshots through the local browser extension, kept informational and separate from V3 dispatch capacity;
- versioned, atomic JSON persistence with cross-process locking, migration repair and preservation of unknown/user-owned fields.

## Runtime and data boundary

The current MVP deliberately uses Node.js and an atomic JSON store. PostgreSQL, Temporal, React, OAuth/multi-user isolation and a production code executor are not represented as completed. The browser and Agent APIs coordinate real work performed by external Agents; Lifeline stores contracts, claims, results, evidence, review state and scheduling decisions.

LAN MCP is disabled until at least one token is configured. Tokens are stored only in the Git-ignored `.env` file and are never printed by the generator. This is a private-network single-owner boundary, not an Internet-facing authorization system.

## Release gate

The release gate is intentionally bounded:

1. run focused tests while changing each contract boundary;
2. run `npm run check` once for the completed batch;
3. rebuild and restart the service once;
4. verify health, dispatch, authenticated MCP and the 1920×1080, 1366×768 and 390×844 browser views.

The authoritative V3 scope is [PORTFOLIO_V3_AUTONOMOUS_BOARD_PLAN.md](PORTFOLIO_V3_AUTONOMOUS_BOARD_PLAN.md). Operating policy, token setup and recovery procedures are in [AUTONOMOUS_BOARD_OPERATIONS.md](AUTONOMOUS_BOARD_OPERATIONS.md).

# Lifeline Agent workflow

Use the project-local `lifeline` MCP server as the source of truth for Agent-visible planning and completion status.

- Before non-trivial work, call `lifeline_list_projects` and `lifeline_get_schedule` to select the real project and avoid duplicate plans.
- Treat each Phase's `parallelTaskIds` from `lifeline_get_schedule` as candidate hints, not a command to delegate. The primary Agent decides whether parallel work materially improves speed or quality after checking task scope, dependencies, shared files, and available concurrency.
- The primary Agent may delegate a candidate to `luna_worker` when it is clear, narrowly scoped, independently executable, and can be given explicit file ownership. Keep broad-context, architectural, or overlapping work in the primary Agent; it remains responsible for reviewing and verifying every delegated result.
- When a user request contains more than one independently verifiable functional task, or materially changes an existing schedule, decompose it into exactly `Project → Phase → Task` and call `lifeline_sync_plan` before implementation.
- Use a stable `planId` derived from the user goal, and keep the same `planId` when resuming or refining that goal. Reuse existing phases and tasks whenever their scope already matches.
- Do not create panel entries for one-step edits, read-only questions, exploratory diagnostics, or incidental implementation details unless the user asks to track them.
- Repository scanners must submit findings through `lifeline_propose_scan_finding` with a stable fingerprint. Query pending proposals first; only call `lifeline_review_scan_proposal` after the finding is reproduced or otherwise reviewed, so duplicate or low-value findings never enter the active schedule.
- By default, report a tracked task once at the end with `lifeline_submit_completion`, including the actual `startedAt`, `completedAt`, model, outcome, result, and any useful evidence. A prior `lifeline_start_task` call is optional and should be used only when live `RUNNING` visibility is worth the extra integration step.
- Agent self-report moves a task only to `REVIEW`. Call `lifeline_verify_task` only after a declared deterministic test passed, a different actor completed independent review, or the user explicitly approved it.
- Never mark a task complete merely because code was written. If verification fails or evidence is missing, leave it in `REVIEW` or update it through the normal task workflow.

## Compute and validation policy

- Route clear, low-risk, independently executable fixes, scans, fixtures, and mechanical UI work to `luna_worker` when delegation is actually cheaper than doing the work directly. Keep architecture, cross-module state semantics, migrations, and high-risk decisions in the primary Agent.
- Use the task risk tier to recommend validation: `V0` static/deterministic inspection, `V1` one focused test, `V2` focused tests plus the affected contract boundary, and `V3` full check plus runtime or browser evidence where relevant.
- During one implementation batch, run only the focused test for each changed boundary. At the end of the whole batch, run the repository-wide check once; do not run both `npm test` and `npm run check` when the latter already includes the full test suite.
- Rebuild and restart the service once after the whole batch passes, then perform the runtime health check. Restart earlier only when runtime diagnosis cannot continue without it.
- A failed focused test should be rerun only after a relevant fix. Do not repeat unchanged passing suites merely to accumulate evidence.

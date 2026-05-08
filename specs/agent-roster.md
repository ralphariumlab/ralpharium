# Spec — Agent Roster

## What

Ralpharium exposes 8 specialized agents that mirror the phases of the
Ralph Wiggum technique. Each has a fixed role and is observable in the
dashboard.

## The 8 agents

| Agent        | Phase         | Role |
|--------------|---------------|------|
| spec_writer  | phase-1       | Turn rough requirements into `specs/*.md`. |
| researcher   | phase-1       | Investigate the repo before plan/build. |
| planner      | build         | Pick the next task from `IMPLEMENTATION_PLAN.md`. |
| builder      | build         | Execute the runner subprocess (Claude / Codex / Aider). |
| reviewer     | backpressure  | Run validation; surface what broke. |
| debugger     | backpressure  | Classify validation failures. |
| magpie       | post-loop     | Collect notable artifacts (commits, diffs, notes). |
| tagger       | post-loop     | Classify the iteration (feature / fix / refactor / docs). |

## Behavior

- All 8 agents live in `RalphController.agents` (an `AgentRoster`).
- They activate synthetically from the iteration lifecycle in
  `_run_subprocess` — pre-flight runs planner+researcher, the runner
  subprocess is the builder, post-flight runs reviewer (+ debugger if
  validation fails), and magpie+tagger run only on a successful commit.
- Each agent retains a 20-entry history ring of prompts and decisions.
- Activity is broadcast over WebSocket as `{type:"agent", data:{...}}`.

## Acceptance

- `GET /api/agents` returns 8 agents with non-null `name`, `role`, `phase`.
- After one iteration with a valid runner_command, at least planner +
  researcher + builder show non-zero `invocations`.
- After a successful iteration that produces a commit, magpie + tagger
  also have non-zero `invocations`.
- The RAM page renders all 8 agent cards even when idle.

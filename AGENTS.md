# AGENTS.md — operational rules for runners working on Ralpharium

## Project

Ralpharium is a local-first control plane for the Ralph Wiggum technique.
8 specialized agents (spec_writer, researcher, planner, builder, reviewer,
debugger, magpie, tagger) coordinate through a shared-memory blackboard
exposed via a FastAPI daemon and a vanilla JS dashboard.

## Stack

- Backend: Python 3.11+, FastAPI, uvicorn, `multiprocessing.shared_memory`.
- Frontend: vanilla JS + CSS — no framework, no build step.
- CLI: small Node launcher (`bin/ralph-studio.js`) that spawns the Python
  daemon. The npm bin name is `ralpharium` (also `ralph-studio` for back-compat).

## Build / test commands

- `npm start` — boot the daemon on `localhost:3000`.
- `npm run check` — environment health check.
- `npm run smoke` — backend smoke test (no HTTP).
- `python backend/smoke_test.py` — same, direct.

## Scope rules

- Backend changes go in `backend/`; frontend in `frontend/`; CLI in `bin/`.
- Do NOT introduce a frontend framework / bundler / TypeScript without
  explicit approval — the no-build constraint is intentional.
- Keep dashboards local-only. No telemetry, no external network calls
  from the daemon.
- The 8 agents in `AgentRoster` are populated synthetically from the
  iteration lifecycle today. Real per-agent LLM calls would be a separate
  feature — discuss before shipping.

## Commit hygiene

- One iteration = one commit (atomic).
- Messages: imperative mood, ≤72 chars subject. No emoji.
- Never `--amend` or force-push.
- Refuse to start an iteration if the working tree is dirty
  (`stop_if_dirty_before_run` is the dashboard toggle for this).

## Backpressure

Validation runs after every iteration. If `npm test` or `npm run lint`
or `npm run typecheck` exits non-zero, mark the iteration failed and stop
the loop (`stop_on_failure = true`).

## When to stop and ask

- A spec contradicts another spec.
- Three consecutive iterations modify the same file with the same error.
  (The thrash detector flags this in the dashboard's Guardrails panel.)
- The runner CLI binary is missing or unauthenticated.

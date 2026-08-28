# IMPLEMENTATION_PLAN.md — Ralpharium roadmap

Persistent task list. Re-read every iteration. Check items off as they ship.
The dashboard parses this file — `- [x]` = done, `- [ ]` = pending,
`- [~]` = in-progress, `- [!]` = blocked.

## Phase 0 — Foundations (done)

- [x] FastAPI daemon + vanilla JS dashboard
- [x] Iteration JSONL store at `.ralph/iterations.jsonl`
- [x] Plan parser + spec coverage + backpressure
- [x] RAM page: blackboard, event stream, scratchpad, checkpoints
- [x] WebSocket-driven live updates

## Phase 1 — 8 agents made observable (done)

- [x] `AgentRoster` class with 8 fixed agents
- [x] Activations wired into the iteration lifecycle
- [x] 8-card grid + click-through drill-down on the RAM page
- [x] Thrash detector (3+ consecutive failures with same files / reason)
- [x] Live broadcast of agent state on every transition
- [x] localStorage cache so navigation doesn't blank the UI

## Phase 2 — Real autonomy (next)

- [ ] Per-iteration cost telemetry (parse runner stdout for token counts)
- [ ] Git-worktree-per-iteration sandbox (no edits land on main until validation passes)
- [ ] Bidirectional question channel — agent writes a question, loop pauses, user replies
- [ ] Time-budget per iteration (kill after N seconds / N tokens)
- [ ] Per-agent prompt history retention beyond the in-memory ring

## Phase 3 — Multiplayer & resilience (later)

- [ ] Daemon crash recovery — replay iterations.jsonl on boot
- [ ] Multi-client presence (cursors / who's watching)
- [ ] Replay a past iteration on a different model for regression testing

## Open questions

- Should the 8 agents become real LLM calls per iteration, or stay as
  lifecycle-synthesized roles? Real calls = ~8x cost, but truer to the pitch.
- How do we handle non-git repos for the magpie/tagger phases?

/* =====================================================================
   Ralpharium — baked demo dataset for public preview.
   Shown when ?demo=1, ?preview=1, or no real iteration data is present.
   Snapshot of a believable mid-flight session against a sample repo.
   ===================================================================== */
(function (g) {
  "use strict";

  const NOW = Math.floor(Date.now() / 1000);
  const ago = (sec) => NOW - sec;

  const ITERATIONS = [
    { id: "it_demo_12", number: 12, mode: "build", status: "running",  started_at: ago(8),    ended_at: null,       runner: "claude", prompt_mode: "build", commit_sha: null,        files_changed: [],                                            failure_reason: null,                          summary: "Wire cost telemetry into iteration JSONL", command_output: "claude > running...\n  reading PROMPT.md\n  picking task: cost telemetry" },
    { id: "it_demo_11", number: 11, mode: "build", status: "passed",   started_at: ago(180),  ended_at: ago(96),    runner: "claude", prompt_mode: "build", commit_sha: "8f3a4c2",   files_changed: ["backend/ralph.py", "backend/main.py"],       failure_reason: null,                          summary: "Add /api/agents endpoint + drill-down",     command_output: "claude > done.\n  added: AgentRoster.snapshot_agent\n  tests passed (12)" },
    { id: "it_demo_10", number: 10, mode: "build", status: "passed",   started_at: ago(720),  ended_at: ago(640),   runner: "claude", prompt_mode: "build", commit_sha: "1b9e7d0",   files_changed: ["frontend/ram.js", "frontend/style.css"],     failure_reason: null,                          summary: "Render 8-card agent grid on RAM page",      command_output: "claude > committed: 1b9e7d0\n  npm run lint passed\n  npm test passed" },
    { id: "it_demo_9",  number: 9,  mode: "build", status: "failed",   started_at: ago(1320), ended_at: ago(1228),  runner: "claude", prompt_mode: "build", commit_sha: null,        files_changed: [],                                            failure_reason: "npm test exited 1 (3 tests failing)", summary: "Wire WebSocket agent broadcasts",            command_output: "claude > running tests\n  FAIL agents.test.ts: expected 8 got 0\n  FAIL ram.test.ts: timeout" },
    { id: "it_demo_8",  number: 8,  mode: "build", status: "passed",   started_at: ago(1900), ended_at: ago(1810),  runner: "claude", prompt_mode: "build", commit_sha: "c4a812e",   files_changed: ["backend/ralph.py"],                          failure_reason: null,                          summary: "Define AgentRoster class + 8 fixed agents", command_output: "claude > done.\n  added: AgentRoster (8 agents)\n  npm test: 18 passed" },
    { id: "it_demo_7",  number: 7,  mode: "plan",  status: "passed",   started_at: ago(2400), ended_at: ago(2358),  runner: "claude", prompt_mode: "plan",  commit_sha: "2dd09a1",   files_changed: ["IMPLEMENTATION_PLAN.md"],                    failure_reason: null,                          summary: "Plan: phase 1 — 8 agents observable",       command_output: "claude > plan refined\n  6 tasks → 8 tasks (split builder/reviewer)" },
    { id: "it_demo_6",  number: 6,  mode: "build", status: "passed",   started_at: ago(3100), ended_at: ago(3015),  runner: "claude", prompt_mode: "build", commit_sha: "9a72b15",   files_changed: ["frontend/dashboard.html", "frontend/dashboard.js"], failure_reason: null,                  summary: "Add 'Repository path' switcher to dashboard", command_output: "claude > done.\n  POST /api/repo-path wired\n  tests passed" },
    { id: "it_demo_5",  number: 5,  mode: "build", status: "stopped",  started_at: ago(4200), ended_at: ago(4185),  runner: "claude", prompt_mode: "build", commit_sha: null,        files_changed: [],                                            failure_reason: "user stopped (panic)",        summary: "Refactor RamBlackboard slot defaults",       command_output: "claude > investigating slot schema\n  ^C panic" },
    { id: "it_demo_4",  number: 4,  mode: "build", status: "passed",   started_at: ago(5400), ended_at: ago(5310),  runner: "claude", prompt_mode: "build", commit_sha: "fa01c33",   files_changed: ["frontend/index.html", "frontend/style.css"], failure_reason: null,                          summary: "Springfield skyline + agent palette",        command_output: "claude > done.\n  6 buildings + nuclear plant\n  no tests for SVG art" },
    { id: "it_demo_3",  number: 3,  mode: "build", status: "passed",   started_at: ago(6600), ended_at: ago(6540),  runner: "claude", prompt_mode: "build", commit_sha: "70e2f88",   files_changed: ["backend/main.py"],                           failure_reason: null,                          summary: "Add iteration JSONL store",                  command_output: "claude > done.\n  IterationStore.add wired\n  tests passed" },
    { id: "it_demo_2",  number: 2,  mode: "build", status: "passed",   started_at: ago(8000), ended_at: ago(7910),  runner: "claude", prompt_mode: "build", commit_sha: "30bd4ae",   files_changed: ["backend/ralph.py", "specs/agent-roster.md"], failure_reason: null,                          summary: "Spec: agent-roster",                         command_output: "claude > done.\n  spec written + linked from plan" },
    { id: "it_demo_1",  number: 1,  mode: "build", status: "passed",   started_at: ago(9600), ended_at: ago(9510),  runner: "claude", prompt_mode: "build", commit_sha: "0bf8501",   files_changed: ["PROMPT.md", "AGENTS.md", "IMPLEMENTATION_PLAN.md"], failure_reason: null,                    summary: "Scaffold Ralpharium artifacts",              command_output: "claude > done.\n  npx ralpharium init\n  3 files + specs/ created" },
  ];

  const AGENTS = [
    { id: "spec_writer", name: "Spec Writer", phase: "phase-1",      color: "#FFD90F", role: "Turn rough requirements into specs/*.md the runner can read.",                  status: "idle",     current_task: null,                                          last_output: "Spec drafted: agent-roster.md (24 lines)",       last_decision: "Spec covers 8-agent contract + acceptance",       latency_ms: 1240, invocations: 4,  successes: 4,  failures: 0, last_error: null, history: [{ ts: ago(8000), kind: "prompt", text: "Draft spec for agent roster" }, { ts: ago(7990), kind: "result", text: "Spec drafted: agent-roster.md (24 lines)", success: true }], updated_at: ago(7910) },
    { id: "researcher",  name: "Researcher",  phase: "phase-1",      color: "#70C7FF", role: "Investigate the repo before plan/build — surface relevant code, prior decisions.", status: "done",     current_task: "Scan ralpharium",                              last_output: "branch=main · specs=2 · dirty=no",                last_decision: "Context ready for cost telemetry task",            latency_ms: 320,  invocations: 12, successes: 12, failures: 0, last_error: null, history: [{ ts: ago(10), kind: "prompt", text: "Scan repo for context" }, { ts: ago(8),  kind: "result", text: "branch=main · specs=2 · dirty=no", success: true }], updated_at: ago(8) },
    { id: "planner",     name: "Planner",     phase: "build",        color: "#B6F569", role: "Pick the next task from IMPLEMENTATION_PLAN.md and frame the iteration prompt.",   status: "done",     current_task: "Pick next task for iteration 12",              last_output: null,                                              last_decision: "Next: Wire cost telemetry into iteration JSONL",   latency_ms: 110,  invocations: 12, successes: 12, failures: 0, last_error: null, history: [{ ts: ago(11), kind: "prompt", text: "plan: 18 tasks, 11 done" }, { ts: ago(10), kind: "result", text: "Next: Wire cost telemetry into iteration JSONL", success: true }], updated_at: ago(10) },
    { id: "builder",     name: "Builder",     phase: "build",        color: "#A8D8B8", role: "Execute the runner subprocess (Claude / Codex / Aider) — the hands of the loop.", status: "thinking", current_task: 'Run: claude -p "$(cat PROMPT.md)"',           last_output: "claude > running...\n  reading PROMPT.md\n  picking task: cost telemetry", last_decision: null, latency_ms: null, invocations: 12, successes: 9,  failures: 3, last_error: null, history: [{ ts: ago(8),  kind: "prompt", text: 'claude -p "$(cat PROMPT.md)"' }],                                                                                                                       updated_at: ago(2) },
    { id: "reviewer",    name: "Reviewer",    phase: "backpressure", color: "#F4A8B8", role: "Run validation — tests, lint, typecheck, build — and surface what broke.",        status: "done",     current_task: "Validate: 4 checks",                           last_output: null,                                              last_decision: "all checks clean",                                  latency_ms: 4820, invocations: 11, successes: 9,  failures: 2, last_error: null, history: [{ ts: ago(98), kind: "prompt", text: "Validate: 4 checks" }, { ts: ago(94), kind: "result", text: "all checks clean", success: true }],                                                                          updated_at: ago(94) },
    { id: "debugger",    name: "Debugger",    phase: "backpressure", color: "#E84A5F", role: "When validation fails, classify the failure so the next iteration has a real chance.", status: "idle",  current_task: null,                                          last_output: null,                                              last_decision: "npm test failed: see runner output",               latency_ms: 90,   invocations: 3,  successes: 0,  failures: 3, last_error: "agents.test.ts: expected 8 got 0", history: [{ ts: ago(1230), kind: "prompt", text: "Classify npm test failure" }, { ts: ago(1228), kind: "result", text: "npm test failed: see runner output", success: false }],                            updated_at: ago(1228) },
    { id: "magpie",      name: "Magpie",      phase: "post-loop",    color: "#C7A6FF", role: "Collect notable artifacts from each iteration — commits, diffs, scratchpad notes.",  status: "done",     current_task: "Collect artifacts from 8f3a4c2",               last_output: "2 files changed · sha=8f3a4c2",                   last_decision: "Commit 8f3a4c2 captured",                          latency_ms: 50,   invocations: 9,  successes: 9,  failures: 0, last_error: null, history: [{ ts: ago(98), kind: "prompt", text: "Collect artifacts from 8f3a4c2" }, { ts: ago(96), kind: "result", text: "Commit 8f3a4c2 captured", success: true }],                                                       updated_at: ago(96) },
    { id: "tagger",      name: "Tagger",      phase: "post-loop",    color: "#7A4D38", role: "Classify what just happened — feature / fix / refactor / docs — and update the spec coverage.", status: "done", current_task: "Classify iteration",                  last_output: "2 files",                                         last_decision: "Tagged as: feature",                                latency_ms: 30,   invocations: 9,  successes: 9,  failures: 0, last_error: null, history: [{ ts: ago(97), kind: "prompt", text: "Classify iteration" },          { ts: ago(96), kind: "result", text: "Tagged as: feature",        success: true }],                                                       updated_at: ago(96) },
  ];

  const PLAN = {
    exists: true,
    total_tasks: 18,
    tasks_completed: 11,
    tasks_pending: 5,
    tasks_blocked: 1,
    tasks_stale: 1,
    next_task: { text: "Wire cost telemetry into iteration JSONL", line: 28, status: "pending" },
    drift_warnings: ["IMPLEMENTATION_PLAN.md last touched 12 iterations ago"],
    tasks: [
      { text: "FastAPI daemon + vanilla JS dashboard",                line: 8,  status: "completed" },
      { text: "Iteration JSONL store at .ralph/iterations.jsonl",     line: 9,  status: "completed" },
      { text: "Plan parser + spec coverage + backpressure",            line: 10, status: "completed" },
      { text: "RAM page: blackboard, event stream, scratchpad",        line: 11, status: "completed" },
      { text: "WebSocket-driven live updates",                          line: 12, status: "completed" },
      { text: "AgentRoster class with 8 fixed agents",                 line: 16, status: "completed" },
      { text: "Activations wired into the iteration lifecycle",        line: 17, status: "completed" },
      { text: "8-card grid + click-through drill-down on RAM page",    line: 18, status: "completed" },
      { text: "Thrash detector (3+ consecutive failures)",             line: 19, status: "completed" },
      { text: "Live broadcast of agent state on every transition",     line: 20, status: "completed" },
      { text: "localStorage cache so navigation doesn't blank the UI", line: 21, status: "completed" },
      { text: "Wire cost telemetry into iteration JSONL",              line: 28, status: "pending" },
      { text: "Git-worktree-per-iteration sandbox",                    line: 29, status: "pending" },
      { text: "Bidirectional question channel",                        line: 30, status: "pending" },
      { text: "Time-budget per iteration (kill after N seconds)",      line: 31, status: "pending" },
      { text: "Per-agent prompt history retention beyond ring",        line: 32, status: "pending" },
      { text: "Daemon crash recovery — replay iterations.jsonl",       line: 36, status: "blocked", blocked_reason: "needs lifespan event handler refactor" },
      { text: "Multi-client presence (cursors / who's watching)",      line: 37, status: "stale" },
    ],
  };

  const SPECS = {
    total: 2,
    covered: 1,
    partial: 1,
    drifting: 0,
    ignored: 0,
    specs: [
      { name: "agent-roster.md",     status: "covered",  iterations: [2, 8, 11], commits: ["30bd4ae", "c4a812e", "8f3a4c2"], summary: "8-agent contract + acceptance criteria" },
      { name: "thrash-detection.md", status: "partial",  iterations: [11],         commits: ["8f3a4c2"],                          summary: "Detection + UI surface (UI partial)" },
    ],
  };

  const BACKPRESSURE = {
    detected: true,
    last_run_at: ago(94),
    checks: [
      { id: "test",      name: "npm test",          command: "npm test",          status: "pass", duration_ms: 2410, output: "✓ 18 passed",       last_run_at: ago(94) },
      { id: "lint",      name: "npm run lint",      command: "npm run lint",      status: "pass", duration_ms: 980,  output: "0 problems",        last_run_at: ago(95) },
      { id: "typecheck", name: "npm run typecheck", command: "npm run typecheck", status: "pass", duration_ms: 1320, output: "0 errors",          last_run_at: ago(96) },
      { id: "build",     name: "npm run build",     command: "npm run build",     status: "pass", duration_ms: 110,  output: "no build script",   last_run_at: ago(97) },
    ],
    all_clean: true,
  };

  const GUARDRAILS = {
    prompt_md: { exists: true, size: 1240, last_modified: ago(11200), preview: "You are the Builder agent for Ralpharium..." },
    agents_md: { exists: true, size: 2180, last_modified: ago(11200), preview: "Operational rules for runners..." },
    suggestions: [
      { id: "g1", severity: "low", source: "history", title: "Add npm typecheck guard to AGENTS.md",     reason: "3 of last 12 iterations skipped typecheck",  rule: "typecheck must pass before commit" },
    ],
  };

  const EVENTS = [
    { id: "e_120", ts: ago(2),    kind: "process_output",   level: "debug", message: "claude > picking task: cost telemetry" },
    { id: "e_119", ts: ago(4),    kind: "process_output",   level: "debug", message: "claude > reading PROMPT.md" },
    { id: "e_118", ts: ago(6),    kind: "process_started",  level: "info",  message: "Runner process started with PID 30276" },
    { id: "e_117", ts: ago(8),    kind: "iteration_started",level: "info",  message: "Iteration 12 started" },
    { id: "e_116", ts: ago(96),   kind: "iteration_finished",level: "info", message: "Iteration 11 finished with passed" },
    { id: "e_115", ts: ago(96),   kind: "tagger",           level: "info",  message: "tagger: Tagged as: feature" },
    { id: "e_114", ts: ago(96),   kind: "magpie",           level: "info",  message: "magpie: Commit 8f3a4c2 captured" },
    { id: "e_113", ts: ago(94),   kind: "reviewer",         level: "info",  message: "reviewer: all checks clean" },
    { id: "e_112", ts: ago(98),   kind: "process_finished", level: "info",  message: "Runner process exited with code 0" },
    { id: "e_111", ts: ago(180),  kind: "iteration_started",level: "info",  message: "Iteration 11 started" },
    { id: "e_110", ts: ago(640),  kind: "iteration_finished",level: "info", message: "Iteration 10 finished with passed" },
    { id: "e_109", ts: ago(1228), kind: "iteration_finished",level: "error",message: "Iteration 9 finished with failed" },
    { id: "e_108", ts: ago(1230), kind: "debugger",         level: "error", message: "debugger: agents.test.ts: expected 8 got 0" },
    { id: "e_107", ts: ago(1232), kind: "reviewer",         level: "error", message: "reviewer: 1 failure" },
    { id: "e_106", ts: ago(1810), kind: "iteration_finished",level: "info", message: "Iteration 8 finished with passed" },
    { id: "e_105", ts: ago(2358), kind: "iteration_finished",level: "info", message: "Iteration 7 (plan) finished with passed" },
  ];

  const BLACKBOARD = {
    slots: {
      loop_mode:     { key: "loop_mode",     value: "running",                                                 updated_at: ago(8),    volatile: true },
      runner:        { key: "runner",        value: "claude",                                                   updated_at: ago(180),  volatile: true },
      repo_path:     { key: "repo_path",     value: "/Users/demo/projects/ralpharium",                          updated_at: ago(180),  volatile: true },
      current_task:  { key: "current_task",  value: "Wire cost telemetry into iteration JSONL",                 updated_at: ago(8),    volatile: true },
      next_action:   { key: "next_action",   value: "Run configured Ralph command.",                            updated_at: ago(8),    volatile: true },
      last_error:    { key: "last_error",    value: null,                                                       updated_at: ago(180),  volatile: true },
      last_commit:   { key: "last_commit",   value: "8f3a4c2",                                                  updated_at: ago(96),   volatile: true },
      test_output:   { key: "test_output",   value: "✓ 18 passed",                                              updated_at: ago(94),   volatile: true },
      files_changed: { key: "files_changed", value: ["backend/ralph.py", "backend/main.py"],                   updated_at: ago(96),   volatile: true },
      command:       { key: "command",       value: 'claude -p "$(cat PROMPT.md)"',                             updated_at: ago(180),  volatile: true },
      pid:           { key: "pid",           value: 30276,                                                      updated_at: ago(8),    volatile: true },
    },
    updated_at: ago(2),
  };

  const STATUS = {
    mode: "running",
    runner: "claude",
    runner_command: 'claude -p "$(cat PROMPT.md)"',
    repo_path: "/Users/demo/projects/ralpharium",
    iteration_count: 12,
    session_iter_count: 12,
    started_at: ago(9600),
    runtime_seconds: 9600,
    current_iteration_id: "it_demo_12",
    config: {
      runner: "claude",
      runner_command: 'claude -p "$(cat PROMPT.md)"',
      max_iterations: null,
      delay_between_iterations_seconds: 2,
      mode: "build",
      stop_on_failure: true,
      stop_if_no_commit: false,
      stop_if_dirty_before_run: false,
    },
  };

  const REPO = {
    path: "/Users/demo/projects/ralpharium",
    exists: true,
    git: true,
    branch: "main",
    dirty: false,
    recent_commits: [
      { sha: "8f3a4c2", message: "Add /api/agents endpoint + drill-down",  author: "claude",  ts: ago(96)   },
      { sha: "1b9e7d0", message: "Render 8-card agent grid on RAM page",   author: "claude",  ts: ago(640)  },
      { sha: "c4a812e", message: "Define AgentRoster class + 8 fixed agents", author: "claude", ts: ago(1810) },
      { sha: "2dd09a1", message: "Plan: phase 1 — 8 agents observable",    author: "claude",  ts: ago(2358) },
      { sha: "9a72b15", message: "Add 'Repository path' switcher to dashboard", author: "claude", ts: ago(3015) },
    ],
  };

  const MEMORY_PRESSURE = {
    prompt_bytes: 1240,
    plan_bytes: 1820,
    agents_bytes: 2180,
    specs_bytes: 1640,
    prompt_context_bytes: 6880,
    estimated_context_tokens: 1720,
    repo_scan: { bytes: 638_800, files_scanned: 47, truncated: false },
    event_buffer_bytes: 14_220,
    process: { running: true, pid: 30276, command: 'claude -p "$(cat PROMPT.md)"', started_at: ago(8), runtime_seconds: 8, memory: { pid: 30276, rss_bytes: 184_320_000, cpu_percent: 12.4, available: true } },
  };

  const RAM_SNAPSHOT = {
    blackboard: BLACKBOARD,
    events: EVENTS,
    event_stats: { total: 120, capacity: 600, by_kind: { iteration_started: 12, iteration_finished: 11, process_output: 84, reviewer: 11, magpie: 9, tagger: 9 } },
    scratchpad: [
      { id: "n1", ts: ago(1100), source: "user", text: "the cost telemetry needs to handle aider's stderr format too", tags: [], volatile: true },
      { id: "n2", ts: ago(2400), source: "user", text: "remember to make magpie idempotent on retry",                  tags: [], volatile: true },
    ],
    checkpoints: [
      { id: "cp_demo_2", ts: ago(640),  label: "before agent grid",  repo: { branch: "main", dirty: false }, plan: { tasks_completed: 9, total_tasks: 16 }, prompt: { size: 1240 }, volatile: true },
      { id: "cp_demo_1", ts: ago(2400), label: "phase-1 start",       repo: { branch: "main", dirty: false }, plan: { tasks_completed: 5, total_tasks: 16 }, prompt: { size: 1180 }, volatile: true },
    ],
    memory_pressure: MEMORY_PRESSURE,
    process: MEMORY_PRESSURE.process,
    shared_segment: { name: "ralph_studio_blackboard", size: 131072, used: 4820, last_write_at: ago(2), available: true },
    agents: { agents: AGENTS, updated_at: ago(2) },
  };

  const THRASH = { thrashing: false, consecutive_failures: 0, window: 6, repeated_files: [], repeated_failure_reasons: [], iterations_inspected: [] };

  const AGGREGATE = {
    status: STATUS,
    repo: REPO,
    plan: PLAN,
    specs: SPECS,
    backpressure: BACKPRESSURE,
    guardrails: GUARDRAILS,
    iterations: ITERATIONS,
    ram: RAM_SNAPSHOT,
    thrash: THRASH,
  };

  // ── Demo-mode detection ─────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const FORCE_DEMO = params.has("demo") || params.has("preview");

  // Auto-trigger when the API returns visibly empty data (no daemon, fresh repo).
  const looksEmpty = (agg) => {
    if (!agg) return true;
    const hasIters = (agg.iterations || []).length > 0;
    const hasPlan = (agg.plan || {}).exists;
    const hasPrompt = (agg.guardrails || {}).prompt_md?.exists;
    return !hasIters && !hasPlan && !hasPrompt;
  };

  g.RalpheriumDemo = {
    aggregate: AGGREGATE,
    ram: RAM_SNAPSHOT,
    forced: FORCE_DEMO,
    looksEmpty,
    isDemoMode: (agg) => FORCE_DEMO || looksEmpty(agg),
  };
})(window);

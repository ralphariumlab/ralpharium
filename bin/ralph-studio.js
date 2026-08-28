#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Ralpharium — local CLI launcher.
 *
 * Spawns the Python backend (FastAPI/Uvicorn) from the project root, optionally
 * opens the configured page in a browser, scaffolds Ralph artifacts, or runs
 * a quick environment health check. No external Node dependencies.
 *
 * Commands:
 *   ralph-studio                  → start backend + open /
 *   ralph-studio start            → start backend + open /
 *   ralph-studio dashboard        → start backend + open /dashboard
 *   ralph-studio ram              → start backend + open /ram
 *   ralph-studio init             → create PROMPT.md / AGENTS.md / IMPLEMENTATION_PLAN.md / specs/
 *   ralph-studio check            → diagnose Python + deps + Ralph files
 *   ralph-studio --no-open ...    → skip opening the browser
 *   ralph-studio --port=N ...     → override PORT (default 3000)
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend");
const FRONTEND_DIR = path.join(PROJECT_ROOT, "frontend");

// ─── .env loader (no external deps) ────────────────────────────────
// Loads KEY=VALUE pairs from the project-root .env (and the cwd .env if
// different) into process.env at startup. Existing process.env vars win.
function loadDotEnv() {
  const seen = new Set();
  const parse = (filePath) => {
    if (!fs.existsSync(filePath)) return 0;
    const real = fs.realpathSync(filePath);
    if (seen.has(real)) return 0;
    seen.add(real);
    let count = 0;
    const text = fs.readFileSync(filePath, "utf8");
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
        count += 1;
      }
    }
    return count;
  };
  parse(path.join(PROJECT_ROOT, ".env"));
  parse(path.join(process.cwd(), ".env"));
}
loadDotEnv();

// ─── Colors (best-effort; degrades gracefully) ──────────────────────
const SUPPORTS_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (SUPPORTS_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2"), bold = c("1"), green = c("32"), red = c("31"),
      yellow = c("33"), cyan = c("36");

// ─── Argument parsing ───────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = { open: true, port: null, force: false };
  for (const arg of argv) {
    if (arg === "--no-open") flags.open = false;
    else if (arg === "--force" || arg === "-f") flags.force = true;
    else if (arg.startsWith("--port=")) flags.port = parseInt(arg.slice(7), 10);
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  return { command: positional[0] || "start", positional, flags };
}

// ─── Python detection ──────────────────────────────────────────────
function findPython() {
  const fromEnv = process.env.RALPH_PYTHON;
  if (fromEnv && fs.existsSync(fromEnv)) return { exe: fromEnv, source: "RALPH_PYTHON" };

  const candidates = [];
  if (process.platform === "win32") {
    candidates.push("py", "python", "python3");
    const local314 = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python314", "python.exe");
    const local312 = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
    if (fs.existsSync(local314)) candidates.push(local314);
    if (fs.existsSync(local312)) candidates.push(local312);
  } else {
    candidates.push("python3", "python");
  }
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["--version"], { stdio: "pipe" });
    if (probe.status === 0) {
      const version = (probe.stdout?.toString() || probe.stderr?.toString() || "").trim();
      return { exe: cmd, source: "PATH", version };
    }
  }
  return null;
}

function pythonHasFastapi(python) {
  const probe = spawnSync(python.exe, ["-c", "import fastapi, uvicorn; print(fastapi.__version__, uvicorn.__version__)"], { stdio: "pipe" });
  if (probe.status !== 0) return { ok: false, error: (probe.stderr?.toString() || "").trim() };
  return { ok: true, versions: (probe.stdout?.toString() || "").trim() };
}

// ─── Browser open (cross-platform) ─────────────────────────────────
function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty title arg keeps quoted URLs working.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (err) {
    console.warn(yellow(`could not open browser automatically: ${err.message}`));
    console.warn(`open ${url} manually`);
  }
}

// ─── Backend launcher ──────────────────────────────────────────────
async function startBackend(targetPath, flags) {
  const python = findPython();
  if (!python) {
    console.error(red("× Ralpharium needs Python 3.11+ but none was found on PATH."));
    console.error("");
    console.error("  Install Python:");
    console.error("    Windows / macOS:  https://www.python.org/downloads/");
    console.error("    macOS (brew):     brew install python@3.12");
    console.error("    Linux (apt):      sudo apt install python3.12 python3-pip");
    console.error("");
    console.error("  Already installed? Set RALPH_PYTHON to its full path and re-run.");
    console.error("    PowerShell:  $env:RALPH_PYTHON='C:\\path\\to\\python.exe'");
    console.error("    bash/zsh:    export RALPH_PYTHON=/path/to/python");
    process.exit(1);
  }
  let fastapi = pythonHasFastapi(python);
  if (!fastapi.ok) {
    console.log(yellow("! FastAPI / uvicorn not installed — auto-installing now…"));
    const reqPath = path.join(__dirname, "..", "backend", "requirements.txt");
    const localReq = path.join("backend", "requirements.txt");
    const req = fs.existsSync(reqPath) ? reqPath : localReq;
    const install = spawnSync(python.exe, ["-m", "pip", "install", "-r", req, "--quiet", "--disable-pip-version-check"], { stdio: "inherit" });
    if (install.status !== 0) {
      console.error(red("× pip install failed."));
      console.error("  Try manually:");
      console.error(`    ${python.exe} -m pip install -r ${req}`);
      console.error("  If pip itself is missing on Windows:");
      console.error(`    ${python.exe} -m ensurepip --upgrade`);
      process.exit(1);
    }
    fastapi = pythonHasFastapi(python);
    if (!fastapi.ok) {
      console.error(red("× pip succeeded but the import still fails."));
      console.error(`  ${fastapi.error || ""}`);
      console.error(`  Try a fresh terminal, or run: ${python.exe} -m pip install -r ${req}`);
      process.exit(1);
    }
    console.log(green(`✓ installed: fastapi/uvicorn ${fastapi.versions}`));
  }

  const port = Number.isInteger(flags.port) ? flags.port : 3000;
  const env = { ...process.env, PORT: String(port) };

  // On Windows, pip installs CLI scripts (aider, codex) into Python's Scripts/ dir which
  // is often NOT on PATH. Prepend any standard Scripts dirs we can find so subprocesses
  // spawned by the backend (the runner CLI) can resolve those binaries.
  if (process.platform === "win32") {
    const scriptsCandidates = [
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python314", "Scripts"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python313", "Scripts"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "Scripts"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python311", "Scripts"),
      path.join(os.homedir(), ".local", "bin"),
    ];
    const existing = scriptsCandidates.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (existing.length) {
      env.PATH = existing.join(path.delimiter) + path.delimiter + (env.PATH || env.Path || "");
    }
  }

  console.log(cyan(`→ ralph-studio  ${dim(`(python ${python.version || python.exe})`)}`));
  console.log(`  http://localhost:${port}${targetPath || ""}`);
  if (flags.open) console.log(dim("  opening browser…"));

  const child = spawn(python.exe, [path.join(BACKEND_DIR, "main.py")], {
    cwd: PROJECT_ROOT,
    env,
    stdio: "inherit",
  });

  // Open browser shortly after the server boots.
  if (flags.open) {
    setTimeout(() => openBrowser(`http://localhost:${port}${targetPath || ""}`), 1200);
  }

  const shutdown = () => {
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch {}
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("exit", (code) => process.exit(code ?? 0));
}

// ─── init: write template files if missing ────────────────────────
const TEMPLATES = {
  "PROMPT.md": `# PROMPT.md

You are running inside a Ralph loop. This file is re-read at the start of
every iteration. Treat it as your standing orders.

## Required reading (every iteration, in order)

1. \`AGENTS.md\` — project rules. Obey them.
2. \`IMPLEMENTATION_PLAN.md\` — pick the next task.
3. \`specs/\` — read the spec(s) that map to that task.
4. \`git status\` — confirm a clean working tree before you change anything.
   If the tree is dirty, stop and ask.

## What to do this iteration

Pick **exactly one** small task from IMPLEMENTATION_PLAN.md (the first
\`- [ ]\` task, unless a \`- [/]\` task is already in progress).

- One iteration = one focused change = one commit (or zero).
- Do not bundle unrelated edits into the same iteration.
- Do not start a broad refactor. If the task implies one, split it back
  into the plan and pick a smaller piece.
- Do not invent requirements that aren't in a spec. If a spec is
  ambiguous, mark the task \`- [!]\` (blocked) with a one-line reason and
  stop.

## Plan mode vs Build mode

Ralpharium passes the loop's \`mode\` in via the runner config:

- **plan** — Update \`IMPLEMENTATION_PLAN.md\` only. Re-read specs, mark
  stale tasks \`- [~]\`, add new tasks under the right section. Do not
  edit code. Do not commit code changes. Commit *only* the plan update.
- **build** — Implement the next task. Touch only the files the task
  requires. Run validation (below) before committing.

If \`mode\` is unset, default to **build**.

## Validation gate (build mode)

Before you commit, run whatever applies to this project:

- tests:      \`npm test\` / \`pytest -q\` / \`cargo test\` / \`go test ./...\`
- types:      \`npm run typecheck\` / \`mypy\` / \`tsc --noEmit\`
- lint:       \`npm run lint\` / \`ruff check\` / \`eslint .\`
- build:      \`npm run build\` / \`cargo build\` / \`go build ./...\`

If any check fails: do not commit. Either fix the issue in this same
iteration (only if scope-appropriate) or revert and mark the task
\`- [!]\` with the failing-check name.

## Commit rules

- Only commit if validation passed.
- One commit per iteration.
- Subject under 72 chars: \`<area>: <what changed>\` (e.g.
  \`auth: add session refresh on 401\`).
- Body optional, but mention the spec/task you addressed.

## After the change

1. Update \`IMPLEMENTATION_PLAN.md\` — flip the box you finished to
   \`- [x]\`. Add follow-ups you discovered as new \`- [ ]\` tasks under
   the right section.
2. Stop. Do not start the next iteration. Ralpharium will restart you.
`,

  "AGENTS.md": `# AGENTS.md

Operational rules every Ralph runner must obey. Read this every iteration
before you read PROMPT.md.

## Pre-flight

- Run \`git status\` before any edit. If the tree is dirty, stop. Do not
  resume work on someone else's uncommitted changes.
- Run \`git rev-parse --abbrev-ref HEAD\`. Don't push to \`main\` /
  \`master\` directly unless the project's docs say it's OK.

## Scope discipline

- Touch only files required by the current task.
- If you find a tempting fix in unrelated code, **don't**. Add a
  \`- [ ] <fix description>\` to IMPLEMENTATION_PLAN.md instead.
- Do not invent requirements. If a spec is missing or ambiguous, mark
  the task \`- [!]\` and stop.
- Do not delete tests to make them pass.
- Do not commit secrets, \`.env\` files, generated build artifacts, or
  large binaries.

## Build / test / lint

Use whatever the project actually uses. Common entry points:

- Node:    \`npm test\`, \`npm run lint\`, \`npm run typecheck\`, \`npm run build\`
- Python:  \`pytest -q\`, \`ruff check\`, \`mypy\`, \`python -m build\`
- Rust:    \`cargo test\`, \`cargo clippy\`, \`cargo build\`
- Go:      \`go test ./...\`, \`go vet ./...\`, \`go build ./...\`

Validation is mandatory in **build** mode. If checks fail, do not
commit.

## Commits

- One iteration → at most one commit.
- Subject under 72 chars: \`<area>: <what changed>\`.
- Reference the task / spec in the body when the link isn't obvious.
- Squash WIP. The diff in the commit should match the task in the plan.

## Plan hygiene

- Always update \`IMPLEMENTATION_PLAN.md\` at the end of each iteration:
  flip your task to \`- [x]\`, add discovered follow-ups, mark blockers.
- Never delete completed tasks. They are the audit trail.
- Periodically run a \`mode: plan\` iteration to clean up drift.

## Forbidden

- Force-pushing shared branches.
- Disabling lint / type / test checks to ship.
- Inventing API endpoints, library functions, or environment variables
  that don't exist. Read the code instead.
- Loops over \`for i in range(1000)\` style "try until it works" without
  understanding the failure.
`,

  "IMPLEMENTATION_PLAN.md": `# Implementation Plan

Persistent task list. Ralph re-reads this every iteration and uses it as
the source of "what to do next".

Checkbox conventions parsed by Ralpharium:

- \`- [ ]\` pending
- \`- [x]\` completed
- \`- [/]\` in progress (optional, used between sub-iterations)
- \`- [!]\` blocked (with a one-line reason on the same line)
- \`- [~]\` stale (re-evaluate before working on it)

## Project Goal

Describe in 2–3 sentences what this repository is for. What does
"done" look like? Who uses it?

> Replace this with the real goal.

## Current Assumptions

Things you're assuming are true. List them so iterations don't silently
build on shaky ground.

- Replace this with a real assumption.

## Tasks

Group tasks under headings. Keep each task small enough to finish in
one iteration. Order them so the earliest unchecked task is the next
thing to do.

### Phase 1
- [ ] Replace this with the first real implementation task.

### Phase 2 (later)
- [ ] Add subsequent tasks once Phase 1 is well-defined.

## Validation

What does "passed" mean for this project? Specify the exact commands
Ralph should run before committing.

- tests:    \`npm test\`            # replace
- lint:     \`npm run lint\`        # replace
- types:    \`npm run typecheck\`   # replace
- build:    \`npm run build\`       # replace

If any of these don't apply, delete the line. Don't leave fake commands.

## Notes / Decisions

Append-only log of why you chose this approach. Don't rewrite history;
add new entries with dates.

- ${"`"}YYYY-MM-DD${"`"} — Replace with the first real decision.
`,

  "specs/README.md": `# Specs

One Markdown file per requirement / feature / acceptance criterion.

Ralpharium reads every \`specs/*.md\` file and maps it against the plan
and recent commits. Each spec gets one of four statuses on the
dashboard:

- **covered**  — referenced in the plan AND in a recent commit
- **partial**  — referenced in the plan or tasks only
- **drifting** — touched by commits but not in the plan
- **ignored**  — never referenced anywhere

Filenames matter. \`specs/auth-session-refresh.md\` is matched against
the tokens \`auth\` / \`session\` / \`refresh\` in plan task text and
commit subjects. Use kebab-case names that the runner is likely to
mention naturally.

## How to write a spec

Keep specs short. They're read by humans first, runners second.
Use this outline:

\`\`\`markdown
# <Title>

## Problem
What is broken / missing / unclear today? Why does it matter?

## User story
As a <role>, I want <capability>, so that <outcome>.

## Acceptance criteria
- [ ] Concrete, observable behavior #1
- [ ] Concrete, observable behavior #2
- [ ] Concrete, observable behavior #3

## Non-goals
What this spec is *not* trying to do. Things runners should NOT add
under the banner of this spec.

## Validation
How do we know it works? Reference the test files / commands that
confirm each acceptance criterion.
\`\`\`

## Example

A minimal spec for a session-refresh feature:

\`\`\`markdown
# Auth: refresh session on 401

## Problem
Users get logged out mid-session because the front-end never
attempts to refresh their token.

## User story
As a signed-in user, when my access token expires, I want the app
to refresh it transparently so I don't have to log in again.

## Acceptance criteria
- [ ] On a 401 from /api/*, the client posts to /api/auth/refresh.
- [ ] On 200 from refresh, the original request is retried once.
- [ ] On non-200 from refresh, the user is redirected to /login.

## Non-goals
- Server-side session storage redesign.
- Multi-device session listing.

## Validation
- \`npm test -- auth/refresh.test.ts\` passes.
- Manual: open dashboard, force token expiry, see app stay signed in.
\`\`\`
`,
};

function cmdInit(flags) {
  const force = !!(flags && flags.force);
  console.log(cyan(`→ ralph-studio init${force ? " --force" : ""}`));
  let created = 0, skipped = 0, overwritten = 0;
  for (const [rel, content] of Object.entries(TEMPLATES)) {
    const target = path.join(process.cwd(), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const exists = fs.existsSync(target);
    if (exists && !force) {
      console.log(`  ${yellow("skip")}  ${rel} (exists; --force to overwrite)`);
      skipped += 1;
      continue;
    }
    fs.writeFileSync(target, content, "utf8");
    if (exists) {
      console.log(`  ${cyan("overwr")} ${rel}`);
      overwritten += 1;
    } else {
      console.log(`  ${green("create")} ${rel}`);
      created += 1;
    }
  }
  // Also ensure .ralph/ exists for iteration history. Force does NOT delete it.
  const ralphDir = path.join(process.cwd(), ".ralph");
  if (!fs.existsSync(ralphDir)) {
    fs.mkdirSync(ralphDir, { recursive: true });
    console.log(`  ${green("create")} .ralph/`);
    created += 1;
  } else {
    console.log(`  ${yellow("skip")}  .ralph/ (exists)`);
    skipped += 1;
  }

  console.log("");
  const summary = [
    `${created} created`,
    `${skipped} skipped`,
  ];
  if (force) summary.push(`${overwritten} overwritten`);
  console.log(`${bold("done.")}  ${summary.join(", ")}.`);
  console.log("next:");
  console.log(`  ${cyan("ralph-studio check")}        # verify Python + Ralph files`);
  console.log(`  ${cyan("ralph-studio dashboard")}    # open the operator console`);
}

// ─── check: diagnose environment ──────────────────────────────────
function cmdCheck() {
  console.log(cyan("→ ralph-studio check"));
  const lines = [];
  const ok = (msg) => lines.push(`  ${green("✓")}  ${msg}`);
  const warn = (msg) => lines.push(`  ${yellow("!")}  ${msg}`);
  const bad = (msg) => lines.push(`  ${red("×")}  ${msg}`);

  // Backend present
  if (fs.existsSync(path.join(BACKEND_DIR, "main.py"))) ok("backend/main.py");
  else bad("backend/main.py missing");
  if (fs.existsSync(path.join(BACKEND_DIR, "ralph.py"))) ok("backend/ralph.py");
  else bad("backend/ralph.py missing");

  // Frontend
  for (const f of ["index.html", "dashboard.html", "ram.html", "tech.html"]) {
    if (fs.existsSync(path.join(FRONTEND_DIR, f))) ok(`frontend/${f}`);
    else bad(`frontend/${f} missing`);
  }

  // Python interpreter
  const py = findPython();
  if (py) {
    ok(`python: ${py.version || py.exe}  (${py.source})`);
    const fa = pythonHasFastapi(py);
    if (fa.ok) ok(`fastapi/uvicorn: ${fa.versions}`);
    else bad(`fastapi/uvicorn missing — run: ${py.exe} -m pip install -r backend/requirements.txt`);
  } else {
    bad("python 3.11+ not found on PATH (set RALPH_PYTHON to its full path)");
  }

  // Repo Ralph artifacts
  const cwd = process.cwd();
  for (const f of ["PROMPT.md", "AGENTS.md", "IMPLEMENTATION_PLAN.md"]) {
    if (fs.existsSync(path.join(cwd, f))) ok(`${f} present`);
    else warn(`${f} missing — run: ralph-studio init`);
  }
  if (fs.existsSync(path.join(cwd, "specs"))) ok("specs/ present");
  else warn("specs/ missing — run: ralph-studio init");

  // Runner availability
  const which = (name) => {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "pipe" });
    if (probe.status === 0) {
      const out = (probe.stdout?.toString() || "").trim().split(/\r?\n/)[0];
      return out || null;
    }
    return null;
  };
  const runners = {
    claude: which("claude"),
    codex:  which("codex"),
    aider:  which("aider"),
  };
  const installed = Object.entries(runners).filter(([, p]) => p);
  if (installed.length) {
    installed.forEach(([id, p]) => ok(`runner ${id}: ${p}`));
  } else {
    warn("no AI runner CLI found on PATH (claude / codex / aider). You can still test with a fake runner — see below.");
  }

  console.log(lines.join("\n"));
  console.log("");

  const hasErr = lines.some((l) => l.includes("×"));
  if (hasErr) {
    console.log(red("checks failed."));
    console.log("next: fix the missing pieces, then re-run check.");
    process.exit(1);
  }

  console.log(bold("ok."));
  console.log("next:");
  console.log(`  ${cyan("ralph-studio start")}        # full app`);
  console.log(`  ${cyan("ralph-studio dashboard")}    # operator console`);
  console.log(`  ${cyan("ralph-studio ram")}          # live RAM inspector`);
  console.log("");

  // ── Test with fake runner ────────────────────────────────────
  console.log(bold("Test with fake runner") + dim("  (no AI / no auth required)"));
  console.log(`  Use this to verify the loop wiring end-to-end. Stops after one`);
  console.log(`  iteration unless you change ${cyan("max_iterations")} in the dashboard.`);
  console.log("");
  if (process.platform === "win32") {
    console.log(dim("  PowerShell:"));
    console.log(`    ${cyan(`$env:RALPH_RUNNER_CMD='powershell -NoProfile -Command "Write-Output starting; Start-Sleep -Seconds 2; Write-Output finished"'`)}`);
    console.log(`    ${cyan("node bin/ralph-studio.js dashboard")}`);
  } else {
    console.log(dim("  bash/zsh:"));
    console.log(`    ${cyan(`export RALPH_RUNNER_CMD='sh -c "echo starting; sleep 2; echo finished"'`)}`);
    console.log(`    ${cyan("node bin/ralph-studio.js dashboard")}`);
  }
  console.log(`  Then click ${bold("Start loop")}.`);
  console.log("");

  // ── Test with Claude (only if installed + safety guidance) ───
  console.log(bold("Test with Claude") + dim("  (requires the claude CLI authenticated)"));
  if (runners.claude) {
    console.log(`  Detected: ${green(runners.claude)}`);
    console.log(`  Confirm Claude is signed in: ${cyan("claude --version")}, then ${cyan("claude")} once interactively.`);
  } else {
    console.log(`  ${yellow("not detected")} — install via ${cyan("npm install -g @anthropic-ai/claude-code")} and authenticate first.`);
  }
  console.log(`  Use a ${bold("throwaway repo")} for the first run. Do not run on production code.`);
  console.log(`  Recommended dashboard config:`);
  console.log(`    runner               = claude`);
  console.log(`    runner_command       = ${process.platform === "win32"
        ? `powershell -NoProfile -Command "claude -p (Get-Content -Raw PROMPT.md)"`
        : `claude -p "$(cat PROMPT.md)"`}`);
  console.log(`    max_iterations       = ${bold("2")}`);
  console.log(`    stop_on_failure      = ${bold("true")}`);
  console.log(`    stop_if_no_commit    = ${bold("true")}`);
  console.log(`    stop_if_dirty_before_run = ${bold("true")}`);
  console.log(`  These guard against runaway loops and dirty-tree corruption.`);
}

// ─── smoke: run backend smoke test ────────────────────────────────
function cmdSmoke() {
  const py = findPython();
  if (!py) {
    console.error(red("× could not find a Python 3 interpreter."));
    console.error("  Install Python 3.11+ or set RALPH_PYTHON to its full path.");
    process.exit(1);
  }
  const fa = pythonHasFastapi(py);
  if (!fa.ok) {
    console.error(red("× FastAPI / uvicorn not installed for that interpreter."));
    console.error(`  Run: ${py.exe} -m pip install -r ${path.join("backend", "requirements.txt")}`);
    process.exit(1);
  }
  console.log(cyan(`→ ralph-studio smoke  ${dim(`(python ${py.version || py.exe})`)}`));
  const child = spawnSync(py.exe, [path.join(BACKEND_DIR, "smoke_test.py")], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}

// ─── help ──────────────────────────────────────────────────────────
function printHelp() {
  console.log(`${bold("ralph-studio")}  local control plane for the Ralph Loop

USAGE
  ralph-studio                      start backend, open /
  ralph-studio start                start backend, open /
  ralph-studio dashboard            start backend, open /dashboard
  ralph-studio ram                  start backend, open /ram
  ralph-studio tech                 start backend, open /tech
  ralph-studio init [--force]       scaffold PROMPT.md / AGENTS.md / IMPLEMENTATION_PLAN.md / specs/
  ralph-studio check                diagnose Python + deps + Ralph files
  ralph-studio smoke                run backend smoke_test.py (RAM contract checks)

FLAGS
  --no-open                         do not open a browser
  --port=N                          override port (default 3000)

ENV
  RALPH_PYTHON                      full path to a Python 3.11+ interpreter
  RALPH_RUNNER                      codex | claude | aider | custom
  RALPH_RUNNER_CMD                  shell command Ralph runs each iteration
  RALPH_REPO_PATH                   override which repo to inspect
`);
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return; }

  switch (command) {
    case "start":
      await startBackend("/", flags);
      break;
    case "dashboard":
      await startBackend("/dashboard", flags);
      break;
    case "ram":
      await startBackend("/ram", flags);
      break;
    case "tech":
      await startBackend("/tech", flags);
      break;
    case "init":
      cmdInit(flags);
      break;
    case "check":
      cmdCheck();
      break;
    case "smoke":
      cmdSmoke();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(red(`unknown command: ${command}`));
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(err.stack || err.message || err));
  process.exit(1);
});

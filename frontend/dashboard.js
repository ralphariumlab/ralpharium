/* =====================================================================
   Ralpharium — operations console
   ===================================================================== */
(() => {
  "use strict";

  // ── Config ───────────────────────────────────────────────────────
  const STATUS_COLOR = {
    running: "running", passed: "passed", failed: "failed",
    stopped: "stopped", paused: "paused", idle: "idle",
    planning: "running", next: "next", pending: "pending",
    completed: "passed", in_progress: "running", blocked: "failed",
    stale: "stale", covered: "passed", partial: "warned",
    drifting: "warned", ignored: "muted", warned: "warned",
    unknown: "muted", skipped: "muted",
  };

  const $ = (id) => document.getElementById(id);

  // ── State ────────────────────────────────────────────────────────
  const state = {
    socket: null,
    reconnect: null,
    status: { mode: "idle", runner: "claude", iteration_count: 0 },
    repo: null,
    plan: null,
    specs: null,
    backpressure: null,
    guardrails: null,
    iterations: [],
    expandedCheck: null,
    drawerIter: null,
    startedClient: null,
    ram: null,
  };

  const fmtBytes = (n) => {
    if (n == null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  // ── Helpers ──────────────────────────────────────────────────────
  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtAgo = (ts) => {
    if (!ts) return "—";
    const sec = Math.max(0, Math.floor((Date.now() / 1000) - ts));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };

  const fmtAbs = (ts) => {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const fmtDuration = (ms) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const fmtUptime = (sec) => {
    if (!sec) return "00:00:00";
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const r = String(sec % 60).padStart(2, "0");
    return `${h}:${m}:${r}`;
  };

  const statusPill = (status, label) => {
    const cls = STATUS_COLOR[status] || "muted";
    return `<span class="status status-${cls}"><span class="dot"></span>${escape(label || status)}</span>`;
  };

  // ── Toast ────────────────────────────────────────────────────────
  const toast = (text, kind = "ok") => {
    const cont = $("toasts");
    if (!cont) return;
    const el = document.createElement("div");
    el.className = `toast${kind === "error" ? " error" : ""}`;
    el.innerHTML = `<span class="dot"></span><span>${escape(text)}</span>`;
    cont.appendChild(el);
    setTimeout(() => { el.classList.add("out"); }, 1900);
    setTimeout(() => el.remove(), 2300);
  };

  // ── WebSocket ────────────────────────────────────────────────────
  const connect = () => {
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    let ws;
    try { ws = new WebSocket(url); }
    catch { schedReconnect(); return; }
    state.socket = ws;
    $("hSocket").textContent = "connecting";

    ws.onopen = () => {
      $("hSocket").textContent = "open";
      $("hSocket").className = "v acc";
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      $("hSocket").textContent = "offline";
      $("hSocket").className = "v faint";
      state.socket = null;
      schedReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };

  const schedReconnect = () => {
    clearTimeout(state.reconnect);
    state.reconnect = setTimeout(connect, 2200);
  };

  const send = (action, extra = {}) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify({ action, ...extra }));
  };

  const handleMessage = (msg) => {
    switch (msg.type) {
      case "snapshot":
        applySnapshot(msg.data);
        break;
      case "status":
        state.status = msg.data;
        renderHeader();
        renderLoopCard();
        break;
      case "iteration_started":
      case "iteration_updated":
      case "iteration_finished":
        // Update or insert
        upsertIteration(msg.data);
        renderTimeline();
        renderLoopCard();
        if (msg.type === "iteration_finished") {
          toast(`Iteration #${msg.data.number} ${msg.data.status}`, msg.data.status === "passed" ? "ok" : "error");
        }
        break;
      case "backpressure":
        state.backpressure = msg.data;
        renderBackpressure();
        renderLoopCard();
        break;
      case "check_result":
        toast(`${msg.data.id}: ${msg.data.status}`, msg.data.status === "passed" ? "ok" : "error");
        break;
      case "ram":
        state.ram = msg.data;
        renderRuntime();
        break;
      case "ram_event":
        pushEvent(msg.data);
        break;
      case "ram_scratchpad":
        if (state.ram) { state.ram.scratchpad = msg.data || []; renderRuntime(); }
        break;
      case "ram_checkpoint":
        if (state.ram) {
          if (Array.isArray(msg.data)) state.ram.checkpoints = msg.data;
          else state.ram.checkpoints = [msg.data, ...(state.ram.checkpoints || [])].slice(0, 30);
          renderRuntime();
        }
        break;
      case "log":
        // Append to runtime event stream as a low-level entry
        if (msg.data && msg.data.message) {
          pushEvent({
            id: `log_${Date.now()}`, ts: Date.now() / 1000,
            kind: "log", level: msg.data.level || "info", message: msg.data.message,
            iteration_id: msg.data.iteration_id || null, data: {},
          });
        }
        break;
      case "ack":
        if (msg.action === "start" && msg.data?.ok)  toast("Loop started");
        if (msg.action === "pause" && msg.data?.ok)  toast("Paused");
        if (msg.action === "resume" && msg.data?.ok) toast("Resumed");
        if (msg.action === "stop" && msg.data?.ok)   toast("Stopped");
        if (msg.action === "panic" && msg.data?.ok)  toast("Panic stop", "error");
        break;
    }
  };

  const upsertIteration = (it) => {
    const idx = state.iterations.findIndex((x) => x.id === it.id);
    if (idx >= 0) state.iterations[idx] = it;
    else state.iterations.unshift(it);
  };

  // ── Snapshot apply ───────────────────────────────────────────────
  const applySnapshot = (data) => {
    if (!data) return;
    state.status = data.status || state.status;
    state.repo = data.repo || state.repo;
    state.plan = data.plan || state.plan;
    state.specs = data.specs || state.specs;
    state.backpressure = data.backpressure || state.backpressure;
    state.guardrails = data.guardrails || state.guardrails;
    state.iterations = (data.iterations || []).slice();
    state.ram = data.ram || state.ram;
    renderAll();
  };

  // ── Render: header ───────────────────────────────────────────────
  const renderHeader = () => {
    const s = state.status || {};
    const r = state.repo || {};
    const mode = (s.mode || "idle").toLowerCase();
    const modePill = $("modePill");
    const modeText = $("modeText");

    if (modePill) modePill.className = `dash-mode mode-${mode}`;
    if (modeText) modeText.textContent = mode;

    const max = s.config?.max_iterations;
    const iterText = max ? `${s.iteration_count || 0} (${s.session_iter_count || 0}/${max} this run)` : `${s.iteration_count || 0}`;
    if ($("hIter")) $("hIter").textContent = iterText;
    if ($("hSessionIter")) $("hSessionIter").textContent = String(s.session_iter_count || 0);
    if ($("hRunner")) $("hRunner").textContent = s.runner || "—";
    if ($("hBranch")) $("hBranch").textContent = (s.branch || r.branch || "—");

    const dirty = s.dirty ?? r.dirty;
    const dirtyEl = $("hDirty");
    if (dirtyEl) {
      if (dirty === true) { dirtyEl.textContent = "dirty"; dirtyEl.className = "v amber"; }
      else if (dirty === false) { dirtyEl.textContent = "clean"; dirtyEl.className = "v acc"; }
      else { dirtyEl.textContent = "—"; dirtyEl.className = "v faint"; }
    }

    // Buttons visibility — paused/running/idle, plus "Run once" only when idle/failed
    const start    = $("btnStart"),  runOnce = $("btnRunOnce"),
          pause    = $("btnPause"),  resume  = $("btnResume"),
          stop     = $("btnStop"),   panic   = $("btnPanic");
    [start, runOnce, pause, resume, stop, panic].forEach((b) => { if (b) b.hidden = true; });
    if (mode === "idle" || mode === "failed" || mode === "stopped") {
      if (start)   start.hidden   = false;
      if (runOnce) runOnce.hidden = false;
    } else if (mode === "paused") {
      if (resume) resume.hidden = false;
      if (stop)   stop.hidden   = false;
      if (panic)  panic.hidden  = false;
    } else { // running, planning
      if (pause) pause.hidden = false;
      if (stop)  stop.hidden  = false;
      if (panic) panic.hidden = false;
    }
  };

  // ── Render: loop card ────────────────────────────────────────────
  const renderLoopCard = () => {
    const s  = state.status || {};
    const r  = state.repo   || {};
    const p  = state.plan   || {};
    const sp = state.specs  || {};
    const bp = state.backpressure || {};

    const mode = (s.mode || "idle").toLowerCase();
    const loopMode = $("loopMode");
    loopMode.textContent = mode;
    loopMode.className = `loop-mode mode-${mode}`;

    let sub;
    const cur = s.current_iteration;
    const stopReason = s.stop_reason;
    if (cur) {
      const sess = s.session_iter_count ? ` · loop iter ${s.session_iter_count}` : "";
      sub = `<strong>Iteration #${cur.number}</strong> · ${escape(cur.mode)} · started ${fmtAgo(cur.started_at)}${sess}`;
    } else if (s.between_iterations && s.next_iteration_eta) {
      const eta = Math.max(0, Math.floor(s.next_iteration_eta - Date.now() / 1000));
      sub = `Between iterations · next in ${eta}s${s.config?.max_iterations ? ` · ${s.session_iter_count}/${s.config.max_iterations}` : ""}`;
    } else if (mode === "stopped" && stopReason) {
      sub = `Loop ended — reason: <code>${escape(stopReason)}</code>. ${s.session_iter_count || 0} iteration${s.session_iter_count === 1 ? "" : "s"} this session.`;
    } else if (mode === "idle") {
      sub = `No loop running. Press <kbd class="kbd">Start loop</kbd> for continuous mode, or <kbd class="kbd">Run once</kbd> for a single iteration. Configure a runner via <code>POST /api/runner</code> first.`;
    } else if (mode === "failed") {
      sub = `Loop failed${stopReason ? ` (${escape(stopReason)})` : ""}. Inspect the timeline below for the failure reason, then fix and restart.`;
    } else {
      sub = `Loop ${escape(mode)}.`;
    }
    if ($("loopSub")) $("loopSub").innerHTML = sub;

    // Stop-reason / ETA pills
    const srPill = $("stopReasonPill");
    if (srPill) {
      if (stopReason && (mode === "stopped" || mode === "failed")) {
        srPill.hidden = false;
        srPill.textContent = `stop: ${stopReason}`;
      } else {
        srPill.hidden = true;
      }
    }
    const etaPill = $("etaPill");
    if (etaPill) {
      if (s.between_iterations && s.next_iteration_eta) {
        const eta = Math.max(0, Math.floor(s.next_iteration_eta - Date.now() / 1000));
        etaPill.hidden = false;
        etaPill.textContent = `next iter in ${eta}s`;
      } else {
        etaPill.hidden = true;
      }
    }

    $("runnerName").textContent = s.runner || "—";
    const cmdPill = $("cmdPill");
    if (s.runner_command) {
      cmdPill.hidden = false;
      cmdPill.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 17l5-5-5-5M12 19h8"/></svg> ${escape(s.runner_command)}`;
    } else {
      cmdPill.hidden = false;
      cmdPill.textContent = "manual mode · no runner command";
      cmdPill.className = "pill";
    }
    // Mask the repo path by default — show only the basename. Click pill to toggle full.
    const fullRepoPath = (s.repo_path || r.path || "—").replace(/\\/g, "/");
    state.fullRepoPath = fullRepoPath;
    const rpEl = $("repoPath");
    const basename = fullRepoPath.split("/").filter(Boolean).pop() || fullRepoPath;
    if (state.repoPathRevealed) {
      rpEl.textContent = fullRepoPath;
    } else {
      rpEl.textContent = `…/${basename}`;
      rpEl.title = "Click to reveal full path";
    }

    $("kIter").textContent  = s.iteration_count || 0;
    $("kPlan").textContent  = p.exists ? `${p.tasks_completed} / ${p.tasks_total}` : "—";
    $("kSpecs").textContent = (sp.specs?.length ?? 0).toString();
    $("kBp").innerHTML      = bp.checks?.length
      ? (bp.all_clean ? `<span class="v acc">all clean</span>` : `<span class="v amber">${bp.checks.length} checks</span>`)
      : `<span class="v faint">none</span>`;
  };

  // ── Render: iteration timeline ──────────────────────────────────
  const renderTimeline = () => {
    const body = $("timelineBody");
    const items = state.iterations || [];
    $("tlCount").textContent = `${items.length} iteration${items.length === 1 ? "" : "s"}`;

    if (!items.length) {
      body.innerHTML = `<div class="empty">
        <strong>No iterations yet.</strong>
        <p>Start the loop, or have your CLI <code>POST /api/iterations</code> when each pass begins and <code>PATCH /api/iterations/&lt;id&gt;</code> when it ends.</p>
      </div>`;
      return;
    }

    const rows = items.map((it) => {
      const status = it.status || "running";
      const dur = it.duration_ms != null ? fmtDuration(it.duration_ms) :
                  (it.started_at ? fmtAgo(it.started_at) : "—");
      const files = it.files_changed_count ?? (it.files_changed || []).length;
      const sha = it.commit_sha ? `<code>${escape(it.commit_sha.slice(0, 7))}</code>` : `<span class="muted-meta">no commit</span>`;
      const tests = it.test_status && it.test_status !== "unknown"
        ? statusPill(it.test_status, it.test_status)
        : "";
      const summary = it.summary || it.failure_reason || (status === "running" ? "in flight" : "—");

      return `<button class="tl-row" data-iter="${escape(it.id)}">
        <span class="tl-num">#${it.number}</span>
        <span class="tl-mode pill">${escape(it.mode || "build")}</span>
        ${statusPill(status)}
        <span class="tl-time" title="${escape(fmtAbs(it.started_at))}">${escape(dur)}</span>
        <span class="tl-files"><strong>${files}</strong> file${files === 1 ? "" : "s"}</span>
        <span class="tl-sha">${sha}</span>
        <span class="tl-summary">${escape(summary).slice(0, 100)}</span>
        ${tests}
      </button>`;
    });

    body.innerHTML = `<div class="tl-list">${rows.join("")}</div>`;
    body.querySelectorAll(".tl-row").forEach((el) =>
      el.addEventListener("click", () => openDrawer(el.dataset.iter))
    );
  };

  // ── Render: plan health ─────────────────────────────────────────
  const renderPlan = () => {
    const body = $("planBody");
    const p = state.plan || {};
    if (!p.exists) {
      body.innerHTML = `<div class="empty">
        <strong>No IMPLEMENTATION_PLAN.md.</strong>
        <p>Add one to your repo root. Use checkbox tasks (<code>- [ ]</code>) — Studio parses status, blocked, stale, and drift.</p>
      </div>`;
      $("planMeta").textContent = "—";
      return;
    }

    $("planMeta").textContent = `${p.tasks_completed}/${p.tasks_total} done · updated ${fmtAgo(p.modified)}`;

    const totals = `
      <div class="plan-totals">
        <div class="kpi-min"><span class="kpi-k">Done</span><span class="kpi-v acc">${p.tasks_completed}</span></div>
        <div class="kpi-min"><span class="kpi-k">Pending</span><span class="kpi-v">${p.tasks_pending}</span></div>
        <div class="kpi-min"><span class="kpi-k">Blocked</span><span class="kpi-v ${p.tasks_blocked ? "red" : ""}">${p.tasks_blocked}</span></div>
        <div class="kpi-min"><span class="kpi-k">Stale</span><span class="kpi-v ${p.tasks_stale ? "amber" : ""}">${p.tasks_stale}</span></div>
      </div>`;

    const next = p.next_task ? `
      <div class="plan-next">
        <span class="muted-meta">Next up</span>
        <div class="plan-next-text">${escape(p.next_task.text)}</div>
        ${p.next_task.section ? `<span class="muted-meta">in <strong>${escape(p.next_task.section)}</strong> · line ${p.next_task.line}</span>` : ""}
      </div>` : "";

    const warnings = (p.warnings || []).length ? `
      <div class="plan-warns">
        ${p.warnings.map((w) => `<div class="warn warn-${w.severity || "low"}">
          <strong>${escape(w.kind)}</strong><span>${escape(w.message)}</span>
        </div>`).join("")}
      </div>` : "";

    const tasks = (p.tasks || []).slice(0, 60);
    const list = tasks.length ? `
      <div class="plan-tasks">
        ${tasks.map((t) => `
          <div class="plan-task plan-${t.status}">
            ${statusPill(t.status, t.status === "next" ? "next" : t.status)}
            <div class="plan-task-text">${escape(t.text)}</div>
            ${t.section ? `<span class="plan-task-section">${escape(t.section)}</span>` : ""}
          </div>`).join("")}
        ${(p.tasks || []).length > 60 ? `<div class="muted-meta plan-task-more">+${(p.tasks.length - 60)} more tasks…</div>` : ""}
      </div>` : "";

    body.innerHTML = totals + next + warnings + list;
  };

  // ── Render: backpressure ────────────────────────────────────────
  const renderBackpressure = () => {
    const body = $("bpBody");
    const bp = state.backpressure || { checks: [] };
    $("bpMeta").textContent = bp.checks?.length
      ? (bp.last_run ? `last run ${fmtAgo(bp.last_run)}` : "not yet run")
      : "no checks";

    if (!bp.checks?.length) {
      body.innerHTML = `<div class="empty">
        <strong>No validation detected.</strong>
        <p>Add <code>test</code> / <code>lint</code> / <code>typecheck</code> / <code>build</code> scripts to <code>package.json</code> — Studio auto-detects them.</p>
      </div>`;
      return;
    }

    const rows = bp.checks.map((c) => {
      const expanded = state.expandedCheck === c.id;
      return `<div class="bp-row ${expanded ? "open" : ""}">
        <button class="bp-head" data-check="${escape(c.id)}" data-toggle>
          <div class="bp-head-l">
            ${statusPill(c.status, c.status)}
            <strong>${escape(c.name)}</strong>
            <code>${escape(c.command)}</code>
          </div>
          <div class="bp-head-r">
            ${c.duration_ms != null ? `<span class="muted-meta">${fmtDuration(c.duration_ms)}</span>` : ""}
            ${c.ran_at ? `<span class="muted-meta">${fmtAgo(c.ran_at)}</span>` : ""}
            <button class="btn btn-xs btn-ghost" data-run="${escape(c.id)}">${c.status === "running" ? "…" : "Run"}</button>
          </div>
        </button>
        ${expanded && c.output ? `<pre class="bp-out">${escape(c.output)}</pre>` : ""}
      </div>`;
    }).join("");

    body.innerHTML = `<div class="bp-list">${rows}</div>`;

    body.querySelectorAll("[data-toggle]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-run]")) return;
        const id = el.dataset.check;
        state.expandedCheck = state.expandedCheck === id ? null : id;
        renderBackpressure();
      })
    );
    body.querySelectorAll("[data-run]").forEach((el) =>
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = el.dataset.run;
        el.textContent = "running…"; el.disabled = true;
        try {
          const r = await fetch(`/api/check/${encodeURIComponent(id)}`, { method: "POST" });
          if (r.ok) {
            const data = await r.json();
            // refresh snapshot
            send("refresh");
            const fresh = await fetch("/api/backpressure").then((x) => x.ok ? x.json() : null);
            if (fresh) { state.backpressure = fresh; renderBackpressure(); renderLoopCard(); }
            toast(`${id}: ${data.status}`, data.status === "passed" ? "ok" : "error");
          } else {
            toast(`Check failed`, "error");
          }
        } finally { el.disabled = false; }
      })
    );
  };

  // ── Render: spec coverage ───────────────────────────────────────
  const renderSpecs = () => {
    const body = $("specsBody");
    const sp = state.specs || { specs: [] };
    if (!sp.specs?.length) {
      body.innerHTML = `<div class="empty">
        <strong>No specs/ directory.</strong>
        <p>Create <code>specs/*.md</code> as the source of truth for what Ralph builds. Studio maps each one against your plan and recent commits.</p>
      </div>`;
      $("specsMeta").textContent = "—";
      return;
    }

    const t = sp.totals || {};
    $("specsMeta").textContent = `${sp.specs.length} specs · ${t.covered || 0} covered`;

    const totals = `<div class="spec-totals">
      <span class="spec-tot covered"><span class="dot"></span>covered ${t.covered||0}</span>
      <span class="spec-tot partial"><span class="dot"></span>partial ${t.partial||0}</span>
      <span class="spec-tot drifting"><span class="dot"></span>drifting ${t.drifting||0}</span>
      <span class="spec-tot ignored"><span class="dot"></span>ignored ${t.ignored||0}</span>
    </div>`;

    const rows = sp.specs.map((s) => `
      <div class="spec-row spec-${s.status}">
        ${statusPill(s.status, s.status)}
        <div class="spec-mid">
          <strong>${escape(s.title)}</strong>
          <span class="muted-meta"><code>${escape(s.file)}</code></span>
        </div>
        <div class="spec-r">
          <span title="tasks referencing this spec">${s.tasks_referenced} tasks</span>
          <span title="commits referencing this spec">${s.commits_referenced} commits</span>
        </div>
      </div>`).join("");

    body.innerHTML = totals + `<div class="spec-list">${rows}</div>`;
  };

  // ── Render: guardrails ──────────────────────────────────────────
  const renderGuardrails = () => {
    const g = state.guardrails || {};
    const fileBlock = (key, file) => {
      const elId = key === "prompt" ? "grPrompt" : "grAgents";
      const el = $(elId);
      if (!el) return;
      const exists = !!file?.exists;
      const head = el.querySelector(".gr-file-head");
      const pre = el.querySelector(".gr-preview");
      head.innerHTML = `<strong>${key === "prompt" ? "PROMPT.md" : "AGENTS.md"}</strong>
        ${exists ? statusPill("passed", "present") : `<span class="status status-muted">missing</span>`}`;
      if (exists) {
        const sub = file.modified ? `<div class="gr-file-meta">modified ${fmtAgo(file.modified)} · ${file.size}B</div>` : "";
        const preview = (file.preview || "").trim();
        pre.innerHTML = preview ? escape(preview) : "<em>(empty)</em>";
        head.insertAdjacentHTML("beforeend", sub);
      } else {
        pre.textContent = `# ${key === "prompt" ? "PROMPT.md" : "AGENTS.md"} not found in repo root`;
      }
    };
    fileBlock("prompt", g.prompt);
    fileBlock("agents", g.agents);

    const sug = $("grSuggest");
    const list = (g.suggestions || []);
    $("grMeta").textContent = list.length
      ? `${list.length} suggestion${list.length === 1 ? "" : "s"}`
      : "no failure patterns yet";

    if (!list.length) {
      sug.innerHTML = `<h4>Suggestions</h4>
        <div class="empty"><strong>Looking good.</strong>
        <p>No failure patterns detected. Suggestions appear after a few iterations.</p></div>`;
      return;
    }
    sug.innerHTML = `<h4>Suggestions</h4>
      <div class="gr-list">
        ${list.map((s) => `<div class="gr-item gr-${s.severity || "low"}">
          ${statusPill(s.severity === "high" ? "failed" : s.severity === "medium" ? "warned" : "muted", s.severity || "info")}
          <div class="gr-item-body">
            <p>${escape(s.message)}</p>
            <span class="muted-meta">${escape(s.kind || "")} · ${escape(s.based_on || "")}</span>
          </div>
        </div>`).join("")}
      </div>`;
  };

  // ── Render: runtime / RAM ───────────────────────────────────────
  const KIND_LABEL = {
    boot: "boot", iteration_started: "iter start", iteration_finished: "iter end",
    validation: "check", scratchpad: "note", checkpoint: "snap",
    log: "log", system: "system",
  };

  const renderRuntime = () => {
    const ram = state.ram || {};
    const board = ram.blackboard?.slots || {};
    const events = ram.events || [];
    const stats = ram.event_stats || { count: 0, capacity: 0 };
    const pressure = ram.memory_pressure || {};
    const notes = ram.scratchpad || [];
    const checkpoints = ram.checkpoints || [];

    // Meta
    const meta = $("ramMeta");
    if (meta) meta.textContent = `${stats.count}/${stats.capacity} events · ${notes.length} notes · ${checkpoints.length} snaps`;

    // Blackboard slots
    const boardEl = $("ramBoard");
    if (boardEl) {
      const slots = Object.entries(board);
      const meaningful = slots.filter(([_, v]) => v.value !== null && v.value !== undefined && !(Array.isArray(v.value) && v.value.length === 0));
      if (!meaningful.length) {
        boardEl.innerHTML = `<div class="empty"><strong>Volatile slots.</strong><p>Loop mode, current task, last error — populated when a runner is active.</p></div>`;
      } else {
        boardEl.innerHTML = meaningful.map(([k, v]) => {
          let val = v.value;
          if (Array.isArray(val)) val = val.length ? `${val.length} items · ${val.slice(0, 2).join(", ")}` : "—";
          else if (typeof val === "object" && val) val = JSON.stringify(val).slice(0, 60);
          else if (typeof val === "string" && val.length > 80) val = val.slice(0, 80) + "…";
          return `<div class="slot">
            <span class="slot-k">${escape(k)}</span>
            <span class="slot-v">${escape(String(val))}</span>
            <span class="slot-meta">${fmtAgo(v.updated_at)}</span>
          </div>`;
        }).join("");
      }
    }

    // Memory pressure
    const promptCtx = pressure.prompt_context_bytes ?? 0;
    const ctxBudget = 200_000; // generous "context budget" in bytes (~50K tokens)
    const fillPct = Math.min(100, Math.round((promptCtx / ctxBudget) * 100));
    $("ppPromptCtx").textContent = `${fmtBytes(promptCtx)} · ~${(pressure.estimated_context_tokens || 0).toLocaleString()} tok`;
    $("ppPromptFill").style.width = `${fillPct}%`;
    $("ppPromptFill").style.background = fillPct > 80 ? "var(--red)" : fillPct > 50 ? "var(--amber)" : "var(--acc)";
    $("ppRepo").textContent     = `${fmtBytes(pressure.repo_scan?.bytes)} · ${pressure.repo_scan?.files_scanned || 0} files`;
    $("ppEvents").textContent   = fmtBytes(pressure.event_buffer_bytes);
    const proc = pressure.process || {};
    $("ppRss").textContent = proc.running
      ? `${fmtBytes(proc.memory?.rss_bytes)}${proc.memory?.cpu_percent != null ? ` · ${proc.memory.cpu_percent.toFixed(1)}%` : ""}`
      : "no runner";

    // Events stream
    renderEvents(events);

    // Notes
    const notesEl = $("ramNotes");
    if (notesEl) {
      notesEl.innerHTML = notes.length
        ? notes.map((n) => `<li><span class="note-text">${escape(n.text)}</span><span class="note-meta">${escape(n.source || "user")} · ${fmtAgo(n.ts)}</span></li>`).join("")
        : `<li class="muted-meta">No notes yet — pin a thought to remember it across the session.</li>`;
    }

    // Checkpoints
    const cpEl = $("ramCheckpoints");
    if (cpEl) {
      cpEl.innerHTML = checkpoints.length
        ? checkpoints.map((c) => `<li><strong>${escape(c.label || "checkpoint")}</strong><span class="muted-meta">${fmtAgo(c.ts)} · ${(c.plan?.tasks_total) ?? 0} tasks</span></li>`).join("")
        : `<li class="muted-meta">Snapshot the repo + plan to compare later.</li>`;
    }
  };

  const renderEvents = (events) => {
    const el = $("ramEvents");
    if (!el) return;
    const meta = $("ramStreamMeta");
    if (meta) meta.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
    if (!events.length) {
      el.innerHTML = `<div class="empty"><strong>No events yet.</strong><p>Loop start, iteration boundaries, scratchpad notes, and checkpoints stream here in real time.</p></div>`;
      return;
    }
    el.innerHTML = events.slice(0, 60).map((e) => {
      const lvl = e.level || "info";
      return `<div class="ev ev-${lvl}">
        <span class="ev-ts">${fmtAgo(e.ts)}</span>
        <span class="ev-kind">${escape(KIND_LABEL[e.kind] || e.kind)}</span>
        <span class="ev-msg">${escape(e.message)}</span>
      </div>`;
    }).join("");
  };

  const pushEvent = (event) => {
    if (!state.ram) state.ram = { events: [] };
    state.ram.events = [event, ...(state.ram.events || [])].slice(0, 200);
    renderEvents(state.ram.events);
    if (state.ram.event_stats) state.ram.event_stats.count = (state.ram.event_stats.count || 0) + 1;
    const meta = $("ramMeta");
    if (meta && state.ram.event_stats) {
      meta.textContent = `${state.ram.event_stats.count}/${state.ram.event_stats.capacity} events · ${state.ram.scratchpad?.length || 0} notes · ${state.ram.checkpoints?.length || 0} snaps`;
    }
  };

  // ── Render all ──────────────────────────────────────────────────
  const renderAll = () => {
    renderHeader();
    renderLoopCard();
    renderTimeline();
    renderPlan();
    renderBackpressure();
    renderSpecs();
    renderGuardrails();
    renderRuntime();
    if (typeof state.afterRender === "function") state.afterRender();
  };

  // ── Drawer (iteration replay) ───────────────────────────────────
  const openDrawer = async (iterId) => {
    const drawer = $("drawer");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    state.drawerIter = iterId;

    let it = state.iterations.find((x) => x.id === iterId);
    if (!it) {
      try {
        const res = await fetch(`/api/iterations/${encodeURIComponent(iterId)}`);
        if (res.ok) it = await res.json();
      } catch {}
    }
    if (!it) return;

    $("drNumber").textContent = `#${it.number}`;
    $("drawerTitle").textContent = `Iteration ${it.id}`;
    $("drStatus").outerHTML = statusPill(it.status, it.status);

    // re-grab in case statusPill replaced it
    const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    setText("drMode", it.mode || "—");
    setText("drRunner", it.runner || "—");
    setText("drStarted", fmtAbs(it.started_at));
    setText("drDuration", fmtDuration(it.duration_ms));
    setText("drFilesCount", String(it.files_changed_count ?? (it.files_changed || []).length));
    setText("drCommit", it.commit_sha ? it.commit_sha.slice(0, 12) : "—");

    setText("drSummary", it.summary || "No summary recorded.");

    const failureWrap = $("drFailureWrap");
    if (it.failure_reason) {
      failureWrap.hidden = false;
      $("drFailure").textContent = it.failure_reason;
    } else {
      failureWrap.hidden = true;
    }

    const files = it.files_changed || [];
    $("drFilesMeta").textContent = String(files.length);
    $("drFiles").innerHTML = files.length
      ? files.map((f) => `<li><code>${escape(f)}</code></li>`).join("")
      : `<li class="muted-meta">No files recorded.</li>`;

    const v = it.validation || [];
    $("drValidation").innerHTML = v.length
      ? v.map((c) => `<li>${statusPill(c.status, c.name || c.id)}<span class="muted-meta">${escape(c.command || "")}</span></li>`).join("")
      : `<li class="muted-meta">No validation results recorded.</li>`;

    $("drOutput").textContent = it.command_output || "(empty)";

    const planWrap = $("drPlanWrap");
    if (it.plan_diff) {
      planWrap.hidden = false;
      $("drPlanDiff").textContent = it.plan_diff;
    } else {
      planWrap.hidden = true;
    }
  };

  const closeDrawer = () => {
    const drawer = $("drawer");
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    state.drawerIter = null;
  };

  // ── Loop config form ────────────────────────────────────────────
  const renderConfigForm = () => {
    const cfg = state.status?.config;
    if (!cfg) return;
    if (!state.cfgDirty) {
      const r = $("cfgRunner");        if (r) r.value = cfg.runner;
      const c = $("cfgRunnerCmd");     if (c) c.value = cfg.runner_command || "";
      const m = $("cfgMax");           if (m) m.value = cfg.max_iterations ?? "";
      const d = $("cfgDelay");         if (d) d.value = cfg.delay_between_iterations_seconds ?? 2;
      const md = $("cfgMode");         if (md) md.value = cfg.mode || "build";
      const f = $("cfgFail");          if (f) f.checked = !!cfg.stop_on_failure;
      const nc = $("cfgNoCommit");     if (nc) nc.checked = !!cfg.stop_if_no_commit;
      const dt = $("cfgDirty");        if (dt) dt.checked = !!cfg.stop_if_dirty_before_run;
    }
    // Repo path field tracks the live status (independent of cfgDirty)
    const rp = $("cfgRepoPath");
    const liveRepo = state.status?.repo_path || state.repo?.path;
    if (rp && !state.repoDirty && liveRepo) rp.value = liveRepo;
    if ($("cfgMeta")) {
      const bits = [];
      if (cfg.max_iterations) bits.push(`max ${cfg.max_iterations}`);
      bits.push(`every ${cfg.delay_between_iterations_seconds}s`);
      if (cfg.stop_on_failure) bits.push("stop on failure");
      if (cfg.stop_if_no_commit) bits.push("require commit");
      if (cfg.stop_if_dirty_before_run) bits.push("clean tree only");
      $("cfgMeta").textContent = bits.join(" · ");
    }
    // Update runner hint based on /api/runners (cached)
    const hint = $("cfgRunnerHint");
    if (hint && state.runners) {
      const preset = state.runners.find((p) => p.id === cfg.runner);
      if (preset) {
        if (preset.command_exists) hint.textContent = `installed at ${preset.command_path}`;
        else if (preset.id === "custom") hint.textContent = "User-provided shell command.";
        else hint.textContent = preset.recommended_install || "executable not found";
      }
    }
  };

  const collectConfig = () => ({
    runner: $("cfgRunner")?.value,
    runner_command: $("cfgRunnerCmd")?.value || null,
    max_iterations: ($("cfgMax")?.value === "" ? null : parseInt($("cfgMax")?.value || "0", 10)),
    delay_between_iterations_seconds: parseFloat($("cfgDelay")?.value || "0"),
    mode: $("cfgMode")?.value,
    stop_on_failure: !!$("cfgFail")?.checked,
    stop_if_no_commit: !!$("cfgNoCommit")?.checked,
    stop_if_dirty_before_run: !!$("cfgDirty")?.checked,
  });

  const saveConfig = async () => {
    try {
      const r = await fetch("/api/loop/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectConfig()),
      });
      if (!r.ok) throw new Error("config save failed");
      state.cfgDirty = false;
      const save = $("cfgSave"); if (save) save.hidden = true;
      toast("Loop config saved");
      send("refresh");
    } catch {
      toast("Failed to save config", "error");
    }
  };

  // renderAll calls state.afterRender at the end so we can keep the config
  // form in sync without monkey-patching the existing render functions.
  state.afterRender = renderConfigForm;

  // ── Boot ─────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    // Header buttons
    $("btnStart")  .addEventListener("click", () => send("start"));
    $("btnRunOnce")?.addEventListener("click", () => send("start_once"));
    $("btnPause") .addEventListener("click", () => send("pause"));
    $("btnResume").addEventListener("click", () => send("resume"));
    $("btnStop")  .addEventListener("click", () => send("stop"));
    $("btnPanic") .addEventListener("click", () => {
      if (confirm("Panic stop the loop? The current iteration is killed and marked stopped.")) send("panic");
    });

    // Loop config form
    const cfgFields = ["cfgRunner", "cfgRunnerCmd", "cfgMax", "cfgDelay", "cfgMode",
                       "cfgFail", "cfgNoCommit", "cfgDirty"];
    const markDirty = () => {
      state.cfgDirty = true;
      const save = $("cfgSave"); if (save) save.hidden = false;
    };
    cfgFields.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", markDirty);
      el.addEventListener("change", markDirty);
    });
    $("cfgSave")?.addEventListener("click", saveConfig);
    $("cfgForm")?.addEventListener("submit", (ev) => { ev.preventDefault(); saveConfig(); });

    // Runner-command quick actions
    const fillRunnerCmd = (value) => {
      const input = $("cfgRunnerCmd");
      if (!input) return;
      input.value = value || "";
      markDirty();
    };
    $("cfgCmdCopy")?.addEventListener("click", async () => {
      const value = $("cfgRunnerCmd")?.value || "";
      if (!value) { toast("Nothing to copy", "error"); return; }
      try {
        await navigator.clipboard.writeText(value);
        toast("Copied runner command");
      } catch {
        toast("Copy failed — select the field and ⌘/Ctrl+C", "error");
      }
    });
    $("cfgCmdUsePreset")?.addEventListener("click", () => {
      const sel = $("cfgRunner")?.value;
      const preset = (state.runners || []).find((p) => p.id === sel);
      if (!preset) { toast("Runner presets not loaded yet", "error"); return; }
      if (!preset.command) { toast(`No preset command for "${sel}"`, "error"); return; }
      fillRunnerCmd(preset.command);
      toast(`Loaded preset: ${sel}`);
    });

    // Repo-path Apply button — POST /api/repo-path
    $("cfgRepoPath")?.addEventListener("input", () => { state.repoDirty = true; });
    $("cfgRepoApply")?.addEventListener("click", async () => {
      const path = $("cfgRepoPath")?.value?.trim();
      if (!path) { toast("Enter a repository path", "error"); return; }
      try {
        const r = await fetch("/api/repo-path", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const j = await r.json();
        if (!j.ok) { toast(j.reason || "Repo switch refused", "error"); return; }
        state.repoDirty = false;
        toast(`Switched to ${j.repo_path}`);
        send("refresh");
      } catch {
        toast("Failed to switch repo", "error");
      }
    });

    // Safety panel toggle
    $("safetyToggle")?.addEventListener("click", () => {
      const card = document.querySelector(".safety-card");
      const btn = $("safetyToggle");
      if (!card || !btn) return;
      const collapsed = card.classList.toggle("is-collapsed");
      btn.textContent = collapsed ? "Show" : "Hide";
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

    // Pull runner presets once for hints
    fetch("/api/runners")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.runners) { state.runners = data.runners; renderConfigForm(); } })
      .catch(() => {});

    $("tlRefresh").addEventListener("click", () => send("refresh"));

    // Runtime / RAM controls
    const scratchForm = $("ramScratchForm");
    if (scratchForm) {
      scratchForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const input = $("ramScratchInput");
        const text = input?.value?.trim();
        if (!text) return;
        send("scratchpad_add", { text });
        if (input) input.value = "";
      });
    }
    $("ramCheckpoint")?.addEventListener("click", async () => {
      try {
        const r = await fetch("/api/ram/checkpoints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: `manual @ ${new Date().toLocaleTimeString()}` }),
        });
        if (r.ok) toast("Checkpoint snapped");
        else toast("Snapshot failed", "error");
      } catch { toast("Snapshot failed", "error"); }
    });
    $("bpRunAll").addEventListener("click", async () => {
      const checks = (state.backpressure?.checks || []);
      for (const c of checks) {
        try { await fetch(`/api/check/${encodeURIComponent(c.id)}`, { method: "POST" }); }
        catch {}
      }
      const fresh = await fetch("/api/backpressure").then((r) => r.ok ? r.json() : null);
      if (fresh) { state.backpressure = fresh; renderBackpressure(); renderLoopCard(); }
      toast("All checks finished");
    });

    // Drawer close
    document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeDrawer));

    // Keyboard
    document.addEventListener("keydown", (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        const m = (state.status?.mode || "idle").toLowerCase();
        if (m === "idle" || m === "failed") send("start");
        else if (m === "paused") send("resume");
        else send("pause");
      }
      if (ev.key === "Escape") closeDrawer();
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "p") { ev.preventDefault(); send("panic"); }
    });

    // Click the repo pill to reveal/hide the full path
    const repoPillEl = $("repoPill");
    if (repoPillEl) {
      repoPillEl.style.cursor = "pointer";
      repoPillEl.addEventListener("click", () => {
        state.repoPathRevealed = !state.repoPathRevealed;
        const rpEl = $("repoPath");
        if (state.repoPathRevealed) {
          rpEl.textContent = state.fullRepoPath || "—";
          rpEl.title = "Click to hide";
        } else {
          const fp = state.fullRepoPath || "";
          const basename = fp.split("/").filter(Boolean).pop() || fp;
          rpEl.textContent = `…/${basename}`;
          rpEl.title = "Click to reveal full path";
        }
      });
    }

    // Mask the repository-path input by default. Toggle with a small button.
    const cfgRepoInput = $("cfgRepoPath");
    if (cfgRepoInput) {
      cfgRepoInput.style.fontFamily = "var(--mono)";
      cfgRepoInput.dataset.masked = "true";
      const mask = () => {
        if (cfgRepoInput.dataset.masked === "true" && document.activeElement !== cfgRepoInput) {
          cfgRepoInput.style.webkitTextSecurity = "disc";
          cfgRepoInput.style.textSecurity = "disc";
        } else {
          cfgRepoInput.style.webkitTextSecurity = "none";
          cfgRepoInput.style.textSecurity = "none";
        }
      };
      cfgRepoInput.addEventListener("focus", mask);
      cfgRepoInput.addEventListener("blur", mask);
      mask();
    }

    // Collapsible "How to use" intro
    const howtoToggle = $("dashHowtoToggle");
    const howtoBody = $("dashHowtoBody");
    if (howtoToggle && howtoBody) {
      howtoToggle.addEventListener("click", () => {
        const isOpen = !howtoBody.hasAttribute("hidden");
        if (isOpen) {
          howtoBody.setAttribute("hidden", "");
          howtoToggle.textContent = "Show";
          howtoToggle.setAttribute("aria-expanded", "false");
        } else {
          howtoBody.removeAttribute("hidden");
          howtoToggle.textContent = "Hide";
          howtoToggle.setAttribute("aria-expanded", "true");
        }
      });
    }

    // Show the preview banner when we end up in demo mode.
    const showPreviewBanner = (active) => {
      const el = document.getElementById("previewBanner");
      if (el) el.hidden = !active;
      document.body.classList.toggle("is-preview", !!active);
    };
    const previewClose = document.getElementById("previewBannerClose");
    if (previewClose) previewClose.addEventListener("click", () => showPreviewBanner(false));

    // ── Forced demo mode (?demo=1 / ?preview=1) ────────────────────
    if (window.RalpheriumDemo?.forced) {
      applySnapshot(window.RalpheriumDemo.aggregate);
      showPreviewBanner(true);
      return;
    }

    // Bootstrap from REST first (fast first paint), then attach WS for live updates.
    fetch("/api/state")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        // Auto-fallback to demo when the backend returns visibly empty data.
        if (window.RalpheriumDemo && window.RalpheriumDemo.looksEmpty(data)) {
          applySnapshot(window.RalpheriumDemo.aggregate);
          showPreviewBanner(true);
          return;
        }
        if (data) applySnapshot(data);
        else if (window.RalpheriumDemo) {
          applySnapshot(window.RalpheriumDemo.aggregate);
          showPreviewBanner(true);
        } else {
          renderAll();
        }
      })
      .catch(() => {
        if (window.RalpheriumDemo) {
          applySnapshot(window.RalpheriumDemo.aggregate);
          showPreviewBanner(true);
        } else {
          renderAll();
        }
      });

    connect();

    // Periodic uptime tick
    setInterval(() => {
      const sec = state.status?.uptime_seconds;
      if (typeof sec === "number") $("hUptime").textContent = fmtUptime(sec);
    }, 1000);

    // Periodic refresh of derived data while connected
    setInterval(() => {
      if (state.socket?.readyState === WebSocket.OPEN) send("refresh");
    }, 8000);

    window.addEventListener("beforeunload", () => {
      if (state.reconnect) clearTimeout(state.reconnect);
      if (state.socket) state.socket.close();
    });
  });
})();

/* =====================================================================
   Ralpharium — RAM live inspector
   ===================================================================== */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ── Format helpers ────────────────────────────────────────────────
  const fmtBytes = (n) => {
    if (n == null || Number.isNaN(n)) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const fmtNum = (n) => {
    if (n == null || Number.isNaN(n)) return "—";
    return n.toLocaleString();
  };

  const fmtSeconds = (s) => {
    if (s == null || Number.isNaN(s)) return "—";
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const fmtAgo = (ts) => {
    if (!ts) return "—";
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (sec < 1) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };

  const fmtAbs = (ts) => {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  };

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    socket: null,
    reconnect: null,
    pollTimer: null,
    pollFallback: false,
    wsAttempts: 0,
    ram: null,
    eventsPaused: false,
    bufferedEvents: [],
    expandedCheckpoint: null,
    lastUpdate: null,
  };

  // ── Toast ─────────────────────────────────────────────────────────
  const toast = (text, kind = "ok") => {
    const cont = $("toasts");
    if (!cont) return;
    const el = document.createElement("div");
    el.className = `toast${kind === "error" ? " error" : ""}`;
    el.innerHTML = `<span class="dot"></span><span>${escape(text)}</span>`;
    cont.appendChild(el);
    setTimeout(() => el.classList.add("out"), 1900);
    setTimeout(() => el.remove(), 2300);
  };

  // ── Hero strip ────────────────────────────────────────────────────
  const renderHero = () => {
    const ram = state.ram || {};
    const seg = ram.shared_segment || {};
    const proc = ram.process || {};
    const slots = ram.blackboard?.slots || {};
    const stats = ram.event_stats || { count: 0, capacity: 0 };
    const updated = seg.updated_at || ram.blackboard?.updated_at;

    // Live indicator
    const dot = $("ramLiveDot");
    const liveText = $("ramLiveText");
    if (state.pollFallback) {
      if (dot) dot.style.background = "var(--amber)";
      if (liveText) liveText.textContent = "polling · 4s";
    } else if (state.socket?.readyState === WebSocket.OPEN) {
      if (dot) dot.style.background = "var(--acc)";
      if (liveText) liveText.textContent = "live · websocket";
    } else {
      if (dot) dot.style.background = "var(--faint)";
      if (liveText) liveText.textContent = "connecting";
    }

    $("ramHeroSegName").textContent = seg.name || "—";
    $("ramHeroSegBytes").textContent = `${fmtBytes(seg.used_bytes)} / ${fmtBytes(seg.size)}`;

    const segPill = $("ramSegPill");
    const segPillText = $("ramSegPillText");
    if (seg.error) {
      segPill.className = "pill pill-red";
      segPillText.textContent = "segment error";
    } else if (seg.available) {
      segPill.className = "pill pill-acc";
      segPillText.textContent = "segment live";
    } else {
      segPill.className = "pill";
      segPillText.textContent = "segment offline";
    }

    $("hMode").textContent = slots.loop_mode?.value || "idle";
    $("hRunner").textContent = slots.runner?.value || "—";
    $("hPid").textContent = proc.pid != null ? String(proc.pid) : "—";
    $("hRss").textContent = proc.memory?.rss_bytes != null
      ? fmtBytes(proc.memory.rss_bytes)
      : (proc.running ? "—" : "—");
    $("hEvents").textContent = `${fmtNum(stats.count)} / ${fmtNum(stats.capacity)}`;
    $("hUpdated").textContent = updated ? fmtAgo(updated) : "never";
  };

  // ── Memory pressure tiles ─────────────────────────────────────────
  const renderPressure = () => {
    const p = state.ram?.memory_pressure || {};
    const promptCtx = p.prompt_context_bytes || 0;
    const tokens = p.estimated_context_tokens || 0;
    const ctxBudget = 200_000; // ~50K tokens worth of bytes

    const tiles = [
      { k: "PROMPT.md",              v: fmtBytes(p.prompt_bytes),   color: "acc",    sub: "per-iteration instruction" },
      { k: "IMPLEMENTATION_PLAN.md", v: fmtBytes(p.plan_bytes),     color: "cyan",   sub: "persistent task list" },
      { k: "AGENTS.md",              v: fmtBytes(p.agents_bytes),   color: "purple", sub: "operational rules" },
      { k: "specs/*.md",             v: fmtBytes(p.specs_bytes),    color: "amber",  sub: "source of truth" },
      { k: "context tokens", v: fmtNum(tokens),             color: "acc",    sub: `~${fmtBytes(promptCtx)} of prompt context` },
      { k: "repo scan",      v: fmtBytes(p.repo_scan?.bytes), color: "cyan", sub: `${fmtNum(p.repo_scan?.files_scanned)} files scanned${p.repo_scan?.truncated ? " (truncated)" : ""}` },
      { k: "event buffer",   v: fmtBytes(p.event_buffer_bytes), color: "purple", sub: "RAM ring buffer JSON" },
    ];

    const fillPct = Math.min(100, Math.round((promptCtx / ctxBudget) * 100));
    const fillColor = fillPct > 80 ? "var(--red)" : fillPct > 50 ? "var(--amber)" : "var(--acc)";

    const tileMarkup = tiles.map((t) => `
      <div class="tile">
        <div class="tile-k">${escape(t.k)}</div>
        <div class="tile-v ${t.color}">${t.v}</div>
        <div class="tile-sub">${escape(t.sub)}</div>
      </div>
    `).join("");

    const budgetTile = `
      <div class="tile tile-wide">
        <div class="tile-k">prompt context budget</div>
        <div class="tile-v">${fmtBytes(promptCtx)}<span class="tile-suffix">${fillPct}%</span></div>
        <div class="tile-bar"><div class="tile-bar-fill" style="width:${fillPct}%; background:${fillColor};"></div></div>
        <div class="tile-sub">${fmtNum(tokens)} tokens · 200KB ceiling for safe iteration context</div>
      </div>
    `;

    $("metricTiles").innerHTML = tileMarkup + budgetTile;
    $("mpMeta").textContent = `${fmtBytes(promptCtx)} prompt context · ${fmtNum(tokens)} tokens`;
  };

  // ── Shared segment viewer ─────────────────────────────────────────
  const renderSegment = () => {
    const seg = state.ram?.shared_segment;
    const status = $("segStatus");
    const meta = $("segMeta");
    const errorEl = $("segError");

    if (!seg) {
      status.className = "status status-muted";
      status.innerHTML = `<span class="dot"></span>unknown`;
      meta.textContent = "no data";
      return;
    }

    if (seg.error) {
      status.className = "status status-failed";
      status.innerHTML = `<span class="dot"></span>error`;
      meta.textContent = "segment error";
      errorEl.hidden = false;
      errorEl.innerHTML = `<strong>Segment error</strong><span>${escape(seg.error)}</span>`;
    } else if (seg.available) {
      status.className = "status status-passed";
      status.innerHTML = `<span class="dot"></span>live`;
      meta.textContent = `${fmtBytes(seg.used_bytes)} of ${fmtBytes(seg.size)}`;
      errorEl.hidden = true;
    } else {
      status.className = "status status-muted";
      status.innerHTML = `<span class="dot"></span>unavailable`;
      meta.textContent = "shared memory unavailable on this host";
      errorEl.hidden = true;
    }

    $("segName").textContent = seg.name || "—";
    $("segSize").textContent = fmtBytes(seg.size);
    const usedPct = seg.size ? Math.round((seg.used_bytes / seg.size) * 100) : 0;
    $("segUsed").textContent = `${fmtBytes(seg.used_bytes)} (${usedPct}%)`;
    $("segUpdated").textContent = seg.updated_at
      ? `${fmtAgo(seg.updated_at)} · ${fmtAbs(seg.updated_at)}`
      : "never written";

    const fillPct = seg.size ? Math.min(100, (seg.used_bytes / seg.size) * 100) : 0;
    $("segFill").style.width = `${fillPct}%`;
    $("segFill").style.background = fillPct > 80 ? "var(--amber)" : "var(--acc)";

    // Hex preview
    const hexEl = $("segHex");
    if (!seg.hex_preview || !seg.used_bytes) {
      hexEl.innerHTML = `<div class="empty">
        <strong>Empty segment.</strong>
        <p>The segment exists but has no payload yet. Start the loop to populate it.</p>
      </div>`;
      $("segHexMeta").textContent = "0 B";
    } else {
      const bytes = seg.hex_preview.split(/\s+/).filter(Boolean);
      const lines = [];
      const max = Math.min(bytes.length, 192); // 12 rows
      for (let i = 0; i < max; i += 16) {
        const row = bytes.slice(i, i + 16);
        const addr = i.toString(16).padStart(8, "0");
        const hexCells = row.map((h) => {
          const v = parseInt(h, 16);
          let cls = "hb";
          if (v === 0) cls += " z";
          else if (v >= 32 && v <= 126) cls += " p";
          else cls += " b";
          return `<span class="${cls}">${h}</span>`;
        }).join("");
        const ascii = row.map((h) => {
          const v = parseInt(h, 16);
          return (v >= 32 && v <= 126) ? String.fromCharCode(v) : ".";
        }).join("").padEnd(16, " ");
        lines.push(`<div class="hex-row">
          <span class="hex-addr">${addr}</span>
          <span class="hex-bytes">${hexCells}</span>
          <span class="hex-ascii">${escape(ascii)}</span>
        </div>`);
      }
      hexEl.innerHTML = lines.join("");
      $("segHexMeta").textContent = `${Math.min(192, bytes.length)} of ${fmtBytes(seg.used_bytes)}`;
    }

    // Decoded
    const decoded = $("segDecoded");
    if (seg.preview && seg.used_bytes) {
      try {
        const obj = JSON.parse(seg.preview);
        decoded.textContent = JSON.stringify(obj, null, 2);
        decoded.classList.remove("is-raw");
      } catch {
        decoded.textContent = seg.preview;
        decoded.classList.add("is-raw");
      }
    } else {
      decoded.textContent = "(empty)";
      decoded.classList.add("is-raw");
    }
  };

  // ── Process monitor ───────────────────────────────────────────────
  const renderProcess = () => {
    const proc = state.ram?.process || {};
    const status = $("procStatus");
    const body = $("procBody");

    if (!proc.running) {
      status.className = "status status-muted";
      status.innerHTML = `<span class="dot"></span>stopped`;
      body.innerHTML = `<div class="empty">
        <strong>No active runner process.</strong>
        <p>Configure <code>RALPH_RUNNER_CMD</code> and start the loop to see live PID, RSS, and runtime stats.</p>
      </div>`;
      return;
    }

    status.className = "status status-running";
    status.innerHTML = `<span class="dot"></span>running`;

    const mem = proc.memory || {};
    body.innerHTML = `
      <div class="proc-grid">
        <div class="proc-kv"><span class="k">PID</span><span class="v mono">${proc.pid ?? "—"}</span></div>
        <div class="proc-kv"><span class="k">runtime</span><span class="v mono">${fmtSeconds(proc.runtime_seconds)}</span></div>
        <div class="proc-kv"><span class="k">RSS</span><span class="v mono">${mem.rss_bytes != null ? fmtBytes(mem.rss_bytes) : "—"}</span></div>
        <div class="proc-kv"><span class="k">CPU</span><span class="v mono">${mem.cpu_percent != null ? mem.cpu_percent.toFixed(1) + "%" : "—"}</span></div>
      </div>
      ${proc.command ? `<div class="proc-cmd">
        <span class="k">command</span>
        <code class="proc-code">${escape(proc.command)}</code>
      </div>` : ""}
      ${mem.source ? `<div class="proc-foot">memory source · ${escape(mem.source)}</div>` : ""}
    `;
  };

  // ── Live blackboard ───────────────────────────────────────────────
  const SLOT_DEFS = [
    { key: "loop_mode",     label: "Loop mode",     desc: "Current orchestrator state" },
    { key: "runner",        label: "Runner",        desc: "Active runner backend" },
    { key: "current_task",  label: "Current task",  desc: "What Ralph is working on" },
    { key: "next_action",   label: "Next action",   desc: "Suggested move" },
    { key: "last_error",    label: "Last error",    desc: "Most recent failure", danger: true },
    { key: "last_commit",   label: "Last commit",   desc: "SHA produced by the loop" },
    { key: "test_output",   label: "Test output",   desc: "Tail of last validation run" },
    { key: "files_changed", label: "Files changed", desc: "From the last iteration" },
    { key: "command",       label: "Command",       desc: "Configured runner shell" },
    { key: "repo_path",     label: "Repo path",     desc: "Working directory" },
    { key: "pid",           label: "PID",           desc: "Subprocess identifier" },
  ];

  const renderBlackboard = () => {
    const slots = state.ram?.blackboard?.slots || {};
    const updated = state.ram?.blackboard?.updated_at;
    $("bbMeta").textContent = updated ? `last write ${fmtAgo(updated)}` : "no writes yet";

    const cards = SLOT_DEFS.map((def) => {
      const slot = slots[def.key];
      const value = slot?.value;
      const isEmpty =
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);

      let body;
      if (isEmpty) {
        body = `<span class="bb-empty">unset</span>`;
      } else if (Array.isArray(value)) {
        const items = value.slice(0, 5).map((v) => `<li><code>${escape(v)}</code></li>`).join("");
        const more = value.length > 5 ? `<li class="muted-meta">+${value.length - 5} more</li>` : "";
        body = `<ul class="bb-list">${items}${more}</ul>`;
      } else if (typeof value === "object") {
        body = `<pre class="bb-pre">${escape(JSON.stringify(value, null, 2))}</pre>`;
      } else if (typeof value === "string" && value.length > 140) {
        body = `<pre class="bb-pre">${escape(value.slice(0, 600))}${value.length > 600 ? "\n…" : ""}</pre>`;
      } else if (typeof value === "string" && /^[0-9a-f]{6,40}$/i.test(value)) {
        body = `<code class="bb-mono">${escape(value)}</code>`;
      } else {
        body = `<span class="bb-v">${escape(String(value))}</span>`;
      }

      const danger = def.danger && !isEmpty;

      return `<article class="bb-card${isEmpty ? " is-empty" : ""}${danger ? " is-danger" : ""}">
        <header class="bb-head">
          <span class="bb-key">${escape(def.label)}</span>
          ${slot?.updated_at ? `<span class="bb-time">${fmtAgo(slot.updated_at)}</span>` : ""}
        </header>
        <div class="bb-body">${body}</div>
        <footer class="bb-foot">
          <code class="bb-name">${escape(def.key)}</code>
          <span class="bb-desc">${escape(def.desc)}</span>
        </footer>
      </article>`;
    }).join("");

    $("bbGrid").innerHTML = cards;
  };

  // ── Event stream ──────────────────────────────────────────────────
  const KIND_LABEL = {
    boot: "boot",
    iteration_started: "iter start",
    iteration_finished: "iter end",
    validation: "check",
    scratchpad: "note",
    checkpoint: "snap",
    log: "log",
    system: "system",
  };

  const renderEvents = () => {
    const events = state.ram?.events || [];
    const stats = state.ram?.event_stats || { count: 0, capacity: 0 };
    $("evMeta").textContent = `${fmtNum(stats.count)} / ${fmtNum(stats.capacity)} events`;

    const list = $("evList");
    if (!events.length) {
      list.innerHTML = `<li class="empty-row">
        <strong>No events yet.</strong>
        <p>Events appear when the loop boots, iterations begin and end, validation runs, scratchpad notes are pinned, or checkpoints are taken.</p>
      </li>`;
      return;
    }

    const rows = events.slice(0, 120).map((e) => {
      const lvl = e.level || "info";
      const kind = KIND_LABEL[e.kind] || e.kind;
      const iter = e.iteration_id ? `<span class="ev-iter" title="${escape(e.iteration_id)}">${escape(e.iteration_id.slice(-6))}</span>` : "";
      return `<li class="ev ev-${lvl}">
        <span class="ev-time" title="${escape(fmtAbs(e.ts))}">${fmtAgo(e.ts)}</span>
        <span class="ev-kind">${escape(kind)}</span>
        <span class="ev-msg">${escape(e.message || "")}</span>
        ${iter}
      </li>`;
    }).join("");
    list.innerHTML = rows;
  };

  const pushLiveEvent = (event) => {
    if (!event || !event.id) return;
    if (!state.ram) state.ram = {};
    if (state.eventsPaused) {
      state.bufferedEvents.unshift(event);
      if (state.bufferedEvents.length > 200) state.bufferedEvents.pop();
      const btn = $("evPause");
      if (btn) btn.textContent = `Resume (${state.bufferedEvents.length})`;
      return;
    }
    const events = state.ram.events || [];
    state.ram.events = [event, ...events].slice(0, 200);
    if (state.ram.event_stats) {
      state.ram.event_stats.count = (state.ram.event_stats.count || 0) + 1;
    }
    renderEvents();
    renderHero();
  };

  // ── Scratchpad ────────────────────────────────────────────────────
  const renderScratchpad = () => {
    const notes = state.ram?.scratchpad || [];
    const list = $("scList");
    if (!notes.length) {
      list.innerHTML = `<li class="empty-row">
        <strong>Nothing pinned.</strong>
        <p>Scratchpad notes are RAM-only — useful for "the spec is wrong" reminders during a session.</p>
      </li>`;
      return;
    }
    list.innerHTML = notes.map((n) => {
      const tags = (n.tags || []).map((t) => `<span class="sc-tag">${escape(t)}</span>`).join("");
      return `<li class="sc-note">
        <div class="sc-note-text">${escape(n.text)}</div>
        <div class="sc-note-meta">
          <span>${escape(n.source || "user")}</span>
          <span title="${escape(fmtAbs(n.ts))}">${fmtAgo(n.ts)}</span>
          ${tags}
        </div>
      </li>`;
    }).join("");
  };

  // ── Checkpoints ───────────────────────────────────────────────────
  const renderCheckpoints = () => {
    const cps = state.ram?.checkpoints || [];
    const list = $("cpList");
    $("cpMeta").textContent = `${cps.length} checkpoint${cps.length === 1 ? "" : "s"}`;

    if (!cps.length) {
      list.innerHTML = `<li class="empty-row">
        <strong>No checkpoints yet.</strong>
        <p>Snapshot the repo + plan + prompt to compare later. Checkpoints live in memory only and disappear on daemon restart.</p>
      </li>`;
      return;
    }

    list.innerHTML = cps.map((c) => {
      const repo = c.repo || {};
      const plan = c.plan || {};
      const prompt = c.prompt || {};
      const expanded = state.expandedCheckpoint === c.id;
      return `<li class="cp-item${expanded ? " is-open" : ""}">
        <button class="cp-head" data-cp="${escape(c.id)}">
          <div class="cp-l">
            <span class="cp-chevron">▸</span>
            <strong>${escape(c.label || "checkpoint")}</strong>
            <code class="cp-id">${escape(c.id.slice(-8))}</code>
          </div>
          <div class="cp-r">
            <span class="status ${repo.dirty ? "status-warned" : "status-passed"}">
              <span class="dot"></span>${repo.dirty ? "dirty" : "clean"}
            </span>
            <span class="cp-branch"><code>${escape(repo.branch || "—")}</code></span>
            <span class="cp-tasks">${plan.tasks_completed || 0} / ${plan.tasks_total || 0} tasks</span>
            <span class="cp-time" title="${escape(fmtAbs(c.ts))}">${fmtAgo(c.ts)}</span>
          </div>
        </button>
        ${expanded ? `<div class="cp-detail">
          <div class="cp-detail-grid">
            <div class="cp-kv"><span class="k">branch</span><span class="v mono">${escape(repo.branch || "—")}</span></div>
            <div class="cp-kv"><span class="k">tree</span><span class="v ${repo.dirty ? "amber" : "acc"}">${repo.dirty ? "dirty" : "clean"}</span></div>
            <div class="cp-kv"><span class="k">commits</span><span class="v">${(repo.commits || []).length}</span></div>
            <div class="cp-kv"><span class="k">plan tasks</span><span class="v">${plan.tasks_completed || 0} / ${plan.tasks_total || 0}</span></div>
            <div class="cp-kv"><span class="k">specs</span><span class="v">${(repo.files?.specs?.files || []).length}</span></div>
            <div class="cp-kv"><span class="k">prompt</span><span class="v mono">${fmtBytes(prompt.size)}</span></div>
          </div>
          ${repo.dirty_files?.length ? `<div class="cp-files">
            <h5>dirty files</h5>
            <ul>${repo.dirty_files.slice(0, 12).map((f) => `<li><code>${escape(f)}</code></li>`).join("")}</ul>
          </div>` : ""}
          ${prompt.preview ? `<div class="cp-prompt">
            <h5>PROMPT.md preview</h5>
            <pre>${escape(prompt.preview)}</pre>
          </div>` : ""}
        </div>` : ""}
      </li>`;
    }).join("");

    list.querySelectorAll("[data-cp]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.expandedCheckpoint = state.expandedCheckpoint === btn.dataset.cp ? null : btn.dataset.cp;
        renderCheckpoints();
      })
    );
  };

  // ── localStorage cache for cross-page persistence ────────────────
  const CACHE_KEY = "ralpharium.ram.cache.v1";
  const cacheRam = (data) => {
    try {
      const slim = {
        agents: data.agents,
        blackboard: data.blackboard,
        memory_pressure: data.memory_pressure,
        process: data.process,
        scratchpad: data.scratchpad,
        checkpoints: data.checkpoints,
        events: (data.events || []).slice(0, 60),
        event_stats: data.event_stats,
        thrash: data.thrash,
        cached_at: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(slim));
    } catch {}
  };
  const loadCachedRam = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  };

  // ── Apply snapshot ────────────────────────────────────────────────
  const applyRam = (data) => {
    if (!data) return;
    state.ram = data;
    state.lastUpdate = Date.now();
    cacheRam(data);
    renderAll();
  };

  const renderAll = () => {
    renderHero();
    renderAgents();
    renderThrash();
    renderPressure();
    renderSegment();
    renderProcess();
    renderBlackboard();
    renderEvents();
    renderScratchpad();
    renderCheckpoints();
  };

  // ── Agents ─────────────────────────────────────────────────────────
  const STATUS_COPY = {
    idle:     { label: "idle",     dot: "rgba(255,255,255,.35)" },
    thinking: { label: "thinking", dot: "var(--acc, #b6f569)" },
    done:     { label: "done",     dot: "var(--acc, #b6f569)" },
    blocked:  { label: "blocked",  dot: "var(--amber, #f5a623)" },
    error:    { label: "error",    dot: "var(--pink, #E84A5F)" },
  };

  const renderAgents = () => {
    const grid = $("agentGrid");
    const meta = $("agentsMeta");
    if (!grid) return;
    const roster = state.ram?.agents?.agents || [];
    if (!roster.length) {
      grid.innerHTML = `<div class="empty"><strong>No agents.</strong><p>Backend not connected yet.</p></div>`;
      if (meta) meta.textContent = "—";
      return;
    }
    if (meta) {
      const active = roster.filter((a) => a.status === "thinking").length;
      meta.textContent = `${roster.length} agents · ${active ? `${active} active` : "all idle"}`;
    }
    grid.innerHTML = roster.map((a) => {
      const sc = STATUS_COPY[a.status] || STATUS_COPY.idle;
      const isThinking = a.status === "thinking";
      const last = a.last_decision || a.last_output || a.last_error || "(no activity yet)";
      const latency = a.latency_ms != null ? `${a.latency_ms}ms` : "—";
      const phase = (a.phase || "").replace("-", " ");
      return `
        <button type="button" class="agent-card status-${a.status}" data-agent="${escape(a.id)}"
                style="--agent-color:${escape(a.color)}">
          <div class="agent-card-h">
            <span class="agent-name">${escape(a.name)}</span>
            <span class="agent-status${isThinking ? ' is-active' : ''}">
              <span class="dot" style="background:${sc.dot}"></span>${escape(sc.label)}
            </span>
          </div>
          <div class="agent-phase">${escape(phase)}</div>
          <div class="agent-task" title="${escape(a.current_task || '')}">${escape(a.current_task || a.role || "—")}</div>
          <div class="agent-last">${escape(last)}</div>
          <div class="agent-stats">
            <span>${a.invocations}× runs</span>
            <span>${a.successes}/${a.failures + a.successes || 0} ok</span>
            <span>${escape(latency)}</span>
          </div>
        </button>
      `;
    }).join("");
  };

  const renderThrash = () => {
    const sec = $("thrashSection");
    const body = $("thrashBody");
    const meta = $("thrashMeta");
    const sub = $("thrashSub");
    if (!sec || !body) return;
    const t = state.ram?.thrash || state.thrash;
    if (!t || !t.thrashing) { sec.hidden = true; return; }
    sec.hidden = false;
    if (meta) meta.textContent = `${t.consecutive_failures} consecutive · ${t.window} inspected`;
    const reasons = (t.repeated_failure_reasons || []).map(r =>
      `<li><code>${escape(r.reason)}</code> · ${r.count}×</li>`).join("");
    const files = (t.repeated_files || []).map(f =>
      `<li><code>${escape(f)}</code></li>`).join("");
    if (sub) sub.textContent = `Same files / failure repeating ${t.consecutive_failures} times. Pause and adjust PROMPT.md or AGENTS.md before continuing.`;
    body.innerHTML = `
      <div class="thrash-grid">
        ${files ? `<div><strong>Files keep changing:</strong><ul>${files}</ul></div>` : ""}
        ${reasons ? `<div><strong>Failure reasons repeating:</strong><ul>${reasons}</ul></div>` : ""}
      </div>
    `;
  };

  // ── Agent drill-down drawer ────────────────────────────────────────
  const openAgentDrawer = (agentId) => {
    const drawer = $("agentDrawer");
    if (!drawer) return;
    const a = (state.ram?.agents?.agents || []).find((x) => x.id === agentId);
    if (!a) return;
    $("adName").textContent = a.name;
    $("adRole").textContent = a.role;
    const hist = (a.history || []).slice().reverse();
    const histHtml = hist.length
      ? hist.map(h => `
          <li class="ad-h ad-h-${h.kind}${h.success === false ? ' is-fail' : ''}">
            <div class="ad-h-meta">
              <span class="ad-h-kind">${escape(h.kind)}</span>
              <span class="ad-h-ts">${fmtAgo(h.ts)}</span>
            </div>
            <div class="ad-h-text">${escape(h.text)}</div>
          </li>`).join("")
      : `<li class="empty-row"><strong>No history yet.</strong><p>Activity appears as iterations run.</p></li>`;
    $("adBody").innerHTML = `
      <div class="ad-stats">
        <div><span class="k">Status</span><span class="v">${escape(a.status)}</span></div>
        <div><span class="k">Phase</span><span class="v">${escape(a.phase)}</span></div>
        <div><span class="k">Runs</span><span class="v">${a.invocations}</span></div>
        <div><span class="k">Success</span><span class="v">${a.successes}</span></div>
        <div><span class="k">Failures</span><span class="v">${a.failures}</span></div>
        <div><span class="k">Last latency</span><span class="v">${a.latency_ms != null ? a.latency_ms + 'ms' : '—'}</span></div>
      </div>
      ${a.current_task ? `<div class="ad-section"><strong>Current task</strong><p>${escape(a.current_task)}</p></div>` : ""}
      ${a.last_decision ? `<div class="ad-section"><strong>Last decision</strong><p>${escape(a.last_decision)}</p></div>` : ""}
      ${a.last_output ? `<div class="ad-section"><strong>Last output</strong><pre>${escape(a.last_output)}</pre></div>` : ""}
      ${a.last_error ? `<div class="ad-section is-fail"><strong>Last error</strong><pre>${escape(a.last_error)}</pre></div>` : ""}
      <div class="ad-section"><strong>Activity history</strong><ul class="ad-list">${histHtml}</ul></div>
    `;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  };
  const closeAgentDrawer = () => {
    const drawer = $("agentDrawer");
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  };

  // ── WebSocket ─────────────────────────────────────────────────────
  const connect = () => {
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    let ws;
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    state.socket = ws;

    ws.onopen = () => {
      state.wsAttempts = 0;
      state.pollFallback = false;
      stopPolling();
      // Ask server for a fresh RAM snapshot through the WS contract.
      try { ws.send(JSON.stringify({ action: "ram_snapshot" })); } catch {}
      try { ws.send(JSON.stringify({ action: "refresh" })); } catch {}
      renderHero();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case "ram":
          applyRam(msg.data);
          break;
        case "snapshot":
          // Aggregate snapshot from /dashboard contract — extract the ram slice.
          if (msg.data?.ram) applyRam(msg.data.ram);
          if (msg.data?.thrash) { state.thrash = msg.data.thrash; renderThrash(); }
          break;
        case "agent":
          if (state.ram?.agents?.agents && msg.data?.id) {
            const list = state.ram.agents.agents;
            const idx = list.findIndex((a) => a.id === msg.data.id);
            if (idx >= 0) list[idx] = msg.data; else list.push(msg.data);
            state.ram.agents.updated_at = msg.data.updated_at;
            renderAgents();
          }
          break;
        case "ram_event":
          pushLiveEvent(msg.data);
          break;
        case "ram_checkpoint":
          if (state.ram) {
            if (Array.isArray(msg.data)) state.ram.checkpoints = msg.data;
            else state.ram.checkpoints = [msg.data, ...(state.ram.checkpoints || [])].slice(0, 30);
            renderCheckpoints();
          }
          break;
        case "ram_scratchpad":
          if (state.ram) {
            state.ram.scratchpad = msg.data || [];
            renderScratchpad();
          }
          break;
        case "status":
          // Minor: pull fresh RAM snapshot when loop status changes.
          ws.send(JSON.stringify({ action: "ram_snapshot" }));
          break;
      }
    };

    ws.onclose = () => {
      state.socket = null;
      state.wsAttempts += 1;
      renderHero();
      if (state.wsAttempts >= 3 && !state.pollFallback) {
        state.pollFallback = true;
        startPolling();
        toast("WebSocket unavailable — falling back to polling", "error");
      } else {
        scheduleReconnect();
      }
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
  };

  const scheduleReconnect = () => {
    clearTimeout(state.reconnect);
    state.reconnect = setTimeout(connect, 2200);
  };

  // ── Polling fallback ─────────────────────────────────────────────
  const pollOnce = async () => {
    try {
      const r = await fetch("/api/ram", { cache: "no-store" });
      if (r.ok) applyRam(await r.json());
    } catch {}
  };

  const startPolling = () => {
    if (state.pollTimer) return;
    pollOnce();
    state.pollTimer = setInterval(pollOnce, 4000);
  };

  const stopPolling = () => {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  };

  // ── Boot ──────────────────────────────────────────────────────────
  const showPreviewBanner = (active) => {
    const el = $("previewBanner");
    if (el) el.hidden = !active;
    document.body.classList.toggle("is-preview", !!active);
  };
  const previewClose = $("previewBannerClose");
  if (previewClose) previewClose.addEventListener("click", () => showPreviewBanner(false));

  document.addEventListener("DOMContentLoaded", async () => {
    // 1. If forced demo mode (?demo=1 or ?preview=1), skip the network and
    //    show baked data immediately so visitors see a populated dashboard.
    if (window.RalpheriumDemo?.forced) {
      applyRam(window.RalpheriumDemo.ram);
      showPreviewBanner(true);
      // Don't connect to the WS — there's no backend to listen to in preview.
      return;
    }

    // 2. Instant paint from localStorage so navigation feels snappy.
    const cached = loadCachedRam();
    if (cached) {
      state.ram = cached;
      renderAll();
    }

    // 3. Try the real backend.
    let serverEmpty = false;
    try {
      const r = await fetch("/api/ram", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        // Heuristic: if there are zero events and no shared segment usage and no
        // PROMPT.md, treat this as a fresh empty repo and auto-fall-back to demo.
        const events = (data.events || []).length;
        const segUsed = data.shared_segment?.used || 0;
        const promptBytes = data.memory_pressure?.prompt_bytes || 0;
        if (events === 0 && segUsed === 0 && promptBytes === 0) {
          serverEmpty = true;
        } else {
          applyRam(data);
        }
      } else if (!cached) renderAll();
    } catch {
      if (!cached) renderAll();
    }

    if (serverEmpty && window.RalpheriumDemo) {
      applyRam(window.RalpheriumDemo.ram);
      showPreviewBanner(true);
    }

    connect();

    // 3. When the tab regains focus, force a fresh fetch so background
    //    activity that happened on another tab is reflected here.
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/ram", { cache: "no-store" });
        if (r.ok) applyRam(await r.json());
      } catch {}
    });

    // ── Agent drill-down ──────────────────────────────────────
    document.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-agent]");
      if (btn) {
        openAgentDrawer(btn.dataset.agent);
        return;
      }
      if (ev.target.closest("[data-close]")) closeAgentDrawer();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeAgentDrawer();
    });

    // ── Pause / resume event stream ────────────────────────────
    const evPause = $("evPause");
    if (evPause) {
      evPause.addEventListener("click", () => {
        state.eventsPaused = !state.eventsPaused;
        evPause.textContent = state.eventsPaused
          ? `Resume${state.bufferedEvents.length ? ` (${state.bufferedEvents.length})` : ""}`
          : "Pause";
        if (!state.eventsPaused && state.bufferedEvents.length) {
          // flush buffered events into the stream (newest first preserved)
          if (!state.ram) state.ram = {};
          const buffered = state.bufferedEvents.slice();
          state.bufferedEvents = [];
          state.ram.events = [...buffered, ...(state.ram.events || [])].slice(0, 200);
          renderEvents();
        }
      });
    }

    // ── Scratchpad ────────────────────────────────────────────
    const scForm = $("scForm");
    const scInput = $("scInput");
    const scCount = $("scCount");

    if (scInput) {
      const updateCount = () => { if (scCount) scCount.textContent = `${scInput.value.length} / 2000`; };
      scInput.addEventListener("input", updateCount);
      scInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          scForm?.requestSubmit();
        }
      });
      updateCount();
    }

    if (scForm) {
      scForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const text = scInput?.value?.trim();
        if (!text) return;
        try {
          const r = await fetch("/api/ram/scratchpad", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, source: "ram-page" }),
          });
          if (!r.ok) throw new Error(await r.text());
          scInput.value = "";
          if (scCount) scCount.textContent = "0 / 2000";
          // The server broadcasts a fresh `ram` snapshot — but optimistic update too.
          if (state.ram) {
            const note = await r.json();
            state.ram.scratchpad = [note, ...(state.ram.scratchpad || [])];
            renderScratchpad();
          }
          toast("Note pinned");
        } catch (err) {
          toast("Failed to pin note", "error");
        }
      });
    }

    $("scClear")?.addEventListener("click", async () => {
      if (!confirm("Clear all scratchpad notes? They are RAM-only and will be lost.")) return;
      try {
        const r = await fetch("/api/ram/scratchpad", { method: "DELETE" });
        if (!r.ok) throw new Error("clear failed");
        if (state.ram) { state.ram.scratchpad = []; renderScratchpad(); }
        toast("Scratchpad cleared");
      } catch {
        toast("Failed to clear scratchpad", "error");
      }
    });

    // ── Checkpoints ──────────────────────────────────────────
    $("cpCreate")?.addEventListener("click", async () => {
      const label = `manual @ ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      try {
        const r = await fetch("/api/ram/checkpoints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        if (!r.ok) throw new Error("checkpoint failed");
        const cp = await r.json();
        if (state.ram) {
          state.ram.checkpoints = [cp, ...(state.ram.checkpoints || [])].slice(0, 30);
          renderCheckpoints();
        }
        toast(`Checkpoint snapped · ${cp.id.slice(-8)}`);
      } catch {
        toast("Failed to snapshot", "error");
      }
    });

    // ── Auto refresh small UI bits ───────────────────────────
    setInterval(() => {
      // Refresh "ago" timestamps without re-rendering everything
      renderHero();
    }, 1000);

    // Refresh hex preview & pressure every few seconds even if WS sends nothing
    setInterval(() => {
      if (state.socket?.readyState === WebSocket.OPEN) {
        try { state.socket.send(JSON.stringify({ action: "ram_snapshot" })); } catch {}
      } else if (!state.pollFallback) {
        pollOnce();
      }
    }, 6000);

    // Cleanup
    window.addEventListener("beforeunload", () => {
      if (state.reconnect) clearTimeout(state.reconnect);
      if (state.pollTimer) clearInterval(state.pollTimer);
      if (state.socket) state.socket.close();
    });
  });
})();

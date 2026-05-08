"""
Ralpharium — local control plane for the Ralph Loop.

Provides:
- RepoInspector   : git state + Ralph file detection.
- PlanParser      : IMPLEMENTATION_PLAN.md → structured tasks.
- SpecCoverage    : specs/* mapped against plan + recent commits.
- Backpressure    : run validation commands (tests, lint, typecheck, build).
- IterationStore  : append-only JSONL of iterations.
- Guardrails      : read PROMPT.md / AGENTS.md, suggest rules from history.
- RalphController : orchestrates the above + WebSocket broadcast.

Stdlib only. Designed for Python 3.11+ with FastAPI/uvicorn already installed.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
import uuid
from collections import Counter, deque
from dataclasses import asdict, dataclass, field
from multiprocessing import shared_memory
from pathlib import Path
from typing import Any, Optional


# ── Helpers ──────────────────────────────────────────────────────────
def _now() -> float:
    return time.time()


def _short_id() -> str:
    return uuid.uuid4().hex[:8]


def _read_text(path: Path, limit: int = 200_000) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:limit]
    except (FileNotFoundError, IsADirectoryError, PermissionError, OSError):
        return None


def _stat(path: Path) -> Optional[dict]:
    try:
        s = path.stat()
        return {"size": s.st_size, "modified": s.st_mtime}
    except OSError:
        return None


def _run(cmd: list[str], cwd: Path, timeout: int = 8) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (FileNotFoundError, PermissionError, NotADirectoryError):
        return -1, "", "command not available"
    except subprocess.TimeoutExpired:
        return -1, "", f"timed out after {timeout}s"
    except OSError as e:
        return -1, "", str(e)


def _safe_file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _count_repo_bytes(root: Path, limit_files: int = 4000) -> dict:
    """Cheap size scan for pressure metrics. Skips noisy/vendor directories."""
    skipped = {
        ".git",
        ".ralph",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        "dist",
        "build",
        ".next",
        ".turbo",
    }
    total = 0
    files = 0
    truncated = False
    try:
        for path in root.rglob("*"):
            if files >= limit_files:
                truncated = True
                break
            if any(part in skipped for part in path.parts):
                continue
            if not path.is_file():
                continue
            files += 1
            total += _safe_file_size(path)
    except OSError:
        truncated = True
    return {"bytes": total, "files_scanned": files, "truncated": truncated}


def _process_memory(pid: int) -> dict:
    """Return best-effort process RSS/CPU using only stdlib shell commands.

    Windows: tries `tasklist` first (fast, always present), falls back to
    PowerShell `Get-Process` for WorkingSet64 + accumulated CPU seconds.
    Unix: uses `ps -o rss=,pcpu=` for RSS (KB) and live CPU%.

    Always returns a dict with `pid`, `rss_bytes`, `cpu_percent`, `available`
    and either `source` (on success) or `error` (on failure). Never raises.
    """
    if not pid:
        return {"pid": None, "rss_bytes": None, "cpu_percent": None, "available": False}

    if os.name == "nt":
        # Primary: tasklist CSV (always available on Windows)
        rc, out, err = _run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            Path.cwd(),
            timeout=3,
        )
        if rc == 0 and out.strip() and "No tasks" not in out and "INFO:" not in out:
            try:
                row = next(line for line in out.splitlines() if line.strip())
                # CSV format: "image","PID","Session","SessionN","12,345 K"
                columns = [part.strip().strip('"') for part in row.split('","')]
                memory_text = columns[-1].replace(",", "").replace("K", "").strip()
                return {
                    "pid": pid,
                    "rss_bytes": int(memory_text) * 1024,
                    "cpu_percent": None,  # tasklist doesn't report CPU%
                    "available": True,
                    "source": "tasklist",
                }
            except (StopIteration, ValueError, IndexError):
                pass

        # Fallback: PowerShell Get-Process
        rc, out, _ = _run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                (
                    f"$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; "
                    "if ($p) { Write-Output ($p.WorkingSet64.ToString() + ',' + $p.CPU) }"
                ),
            ],
            Path.cwd(),
            timeout=4,
        )
        if rc == 0 and out.strip():
            try:
                rss_text, cpu_text = (out.strip().split(",", 1) + [""])[:2]
                rss = int(rss_text)
                cpu_seconds = float(cpu_text) if cpu_text.strip() not in ("", "None") else None
                return {
                    "pid": pid,
                    "rss_bytes": rss,
                    "cpu_percent": None,            # accumulated seconds, not %
                    "cpu_seconds": cpu_seconds,
                    "available": True,
                    "source": "powershell",
                }
            except (ValueError, IndexError):
                pass

        return {
            "pid": pid,
            "rss_bytes": None,
            "cpu_percent": None,
            "available": False,
            "error": (err or "").strip() or "process not found via tasklist or powershell",
        }

    # POSIX
    rc, out, err = _run(["ps", "-o", "rss=,pcpu=", "-p", str(pid)], Path.cwd(), timeout=3)
    if rc != 0 or not out.strip():
        return {
            "pid": pid,
            "rss_bytes": None,
            "cpu_percent": None,
            "available": False,
            "error": (err or "").strip() or "process not found",
        }
    try:
        rss_kb, cpu = out.strip().split()[:2]
        return {
            "pid": pid,
            "rss_bytes": int(float(rss_kb)) * 1024,
            "cpu_percent": float(cpu),
            "available": True,
            "source": "ps",
        }
    except (ValueError, IndexError):
        return {"pid": pid, "rss_bytes": None, "cpu_percent": None, "available": False}


# RAM observability
@dataclass
class RamEvent:
    id: str
    ts: float
    kind: str
    level: str
    message: str
    iteration_id: Optional[str] = None
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class RamEventStream:
    """In-memory ring buffer for live loop events. Never writes to disk."""

    def __init__(self, max_events: int = 600):
        self.max_events = max_events
        self._events: deque[RamEvent] = deque(maxlen=max_events)

    def append(
        self,
        kind: str,
        message: str,
        *,
        level: str = "info",
        iteration_id: Optional[str] = None,
        data: Optional[dict] = None,
    ) -> dict:
        event = RamEvent(
            id=f"evt_{int(_now() * 1000)}_{_short_id()}",
            ts=_now(),
            kind=kind,
            level=level,
            message=message,
            iteration_id=iteration_id,
            data=data or {},
        )
        self._events.append(event)
        return event.to_dict()

    def latest(self, limit: int = 100, since: Optional[float] = None) -> list[dict]:
        events = list(self._events)
        if since is not None:
            events = [event for event in events if event.ts > since]
        return [event.to_dict() for event in events[-max(1, min(500, limit)):]][::-1]

    def stats(self) -> dict:
        by_kind: dict[str, int] = {}
        by_level: dict[str, int] = {}
        for event in self._events:
            by_kind[event.kind] = by_kind.get(event.kind, 0) + 1
            by_level[event.level] = by_level.get(event.level, 0) + 1
        return {
            "capacity": self.max_events,
            "count": len(self._events),
            "by_kind": by_kind,
            "by_level": by_level,
            "oldest_ts": self._events[0].ts if self._events else None,
            "newest_ts": self._events[-1].ts if self._events else None,
        }


class RamBlackboard:
    """Volatile working memory the dashboard can read live."""

    DEFAULT_SLOTS = {
        "loop_mode": "idle",
        "runner": None,
        "repo_path": None,
        "current_task": None,
        "next_action": None,
        "last_error": None,
        "last_commit": None,
        "test_output": None,
        "files_changed": [],
        "command": None,
        "pid": None,
    }

    def __init__(self):
        self._slots: dict[str, dict] = {}
        self.reset()

    def reset(self) -> None:
        now = _now()
        self._slots = {
            key: {"key": key, "value": value, "updated_at": now, "volatile": True}
            for key, value in self.DEFAULT_SLOTS.items()
        }

    def set(self, key: str, value: Any) -> dict:
        self._slots[key] = {
            "key": key,
            "value": value,
            "updated_at": _now(),
            "volatile": True,
        }
        return dict(self._slots[key])

    def update(self, **values: Any) -> None:
        for key, value in values.items():
            self.set(key, value)

    def get(self, key: str) -> Optional[dict]:
        slot = self._slots.get(key)
        return dict(slot) if slot else None

    def snapshot(self) -> dict:
        return {
            "slots": {key: dict(value) for key, value in self._slots.items()},
            "updated_at": max((slot["updated_at"] for slot in self._slots.values()), default=None),
        }


class AgentRoster:
    """The 8 specialized Ralpharium agents and their live state.

    The agents don't run as separate processes today — they're populated
    synthetically from the existing iteration lifecycle so the dashboard can
    show *which* part of the Ralph loop is currently active and what each
    agent's recent decisions were. This is the visualization layer that makes
    Ralpharium distinct from vanilla Ralph Loop.
    """

    AGENTS = [
        {
            "id": "spec_writer",
            "name": "Spec Writer",
            "phase": "phase-1",
            "color": "#FFD90F",
            "role": "Turn rough requirements into specs/*.md the runner can read.",
        },
        {
            "id": "researcher",
            "name": "Researcher",
            "phase": "phase-1",
            "color": "#70C7FF",
            "role": "Investigate the repo before plan/build — surface relevant code, prior decisions, gotchas.",
        },
        {
            "id": "planner",
            "name": "Planner",
            "phase": "build",
            "color": "#B6F569",
            "role": "Pick the next task from IMPLEMENTATION_PLAN.md and frame the iteration prompt.",
        },
        {
            "id": "builder",
            "name": "Builder",
            "phase": "build",
            "color": "#A8D8B8",
            "role": "Execute the runner subprocess (Claude / Codex / Aider) — the hands of the loop.",
        },
        {
            "id": "reviewer",
            "name": "Reviewer",
            "phase": "backpressure",
            "color": "#F4A8B8",
            "role": "Run validation — tests, lint, typecheck, build — and surface what broke.",
        },
        {
            "id": "debugger",
            "name": "Debugger",
            "phase": "backpressure",
            "color": "#E84A5F",
            "role": "When validation fails, classify the failure so the next iteration has a real chance.",
        },
        {
            "id": "magpie",
            "name": "Magpie",
            "phase": "post-loop",
            "color": "#C7A6FF",
            "role": "Collect notable artifacts from each iteration — commits, diffs, scratchpad notes.",
        },
        {
            "id": "tagger",
            "name": "Tagger",
            "phase": "post-loop",
            "color": "#7A4D38",
            "role": "Classify what just happened — feature / fix / refactor / docs — and update the spec coverage.",
        },
    ]

    def __init__(self, history_limit: int = 20):
        self.history_limit = history_limit
        now = _now()
        self._agents: dict[str, dict] = {
            spec["id"]: {
                **spec,
                "status": "idle",
                "current_task": None,
                "last_output": None,
                "last_decision": None,
                "latency_ms": None,
                "invocations": 0,
                "successes": 0,
                "failures": 0,
                "last_error": None,
                "history": deque(maxlen=history_limit),
                "updated_at": now,
                "_started_at": None,
            }
            for spec in self.AGENTS
        }

    def _touch(self, agent_id: str) -> Optional[dict]:
        agent = self._agents.get(agent_id)
        if not agent:
            return None
        agent["updated_at"] = _now()
        return agent

    def activate(self, agent_id: str, task: str, *, prompt: Optional[str] = None) -> Optional[dict]:
        agent = self._touch(agent_id)
        if not agent:
            return None
        agent["status"] = "thinking"
        agent["current_task"] = (task or "")[:240]
        agent["_started_at"] = _now()
        agent["invocations"] += 1
        if prompt:
            agent["history"].append({
                "ts": _now(),
                "kind": "prompt",
                "text": prompt[:600],
            })
        return self.snapshot_agent(agent_id)

    def complete(
        self,
        agent_id: str,
        *,
        output: Optional[str] = None,
        decision: Optional[str] = None,
        success: bool = True,
        error: Optional[str] = None,
    ) -> Optional[dict]:
        agent = self._touch(agent_id)
        if not agent:
            return None
        started = agent.get("_started_at") or agent["updated_at"]
        agent["latency_ms"] = int(max(0, (_now() - started) * 1000))
        agent["_started_at"] = None
        if success:
            agent["status"] = "done"
            agent["successes"] += 1
            agent["last_error"] = None
        else:
            agent["status"] = "error" if error else "blocked"
            agent["failures"] += 1
            agent["last_error"] = (error or "")[:240] or None
        if output is not None:
            agent["last_output"] = output[:1200]
        if decision is not None:
            agent["last_decision"] = decision[:480]
        agent["history"].append({
            "ts": _now(),
            "kind": "result",
            "text": (decision or output or error or "(no output)")[:600],
            "success": success,
        })
        return self.snapshot_agent(agent_id)

    def reset_idle(self, agent_id: str) -> Optional[dict]:
        agent = self._touch(agent_id)
        if not agent:
            return None
        agent["status"] = "idle"
        agent["current_task"] = None
        agent["_started_at"] = None
        return self.snapshot_agent(agent_id)

    def snapshot_agent(self, agent_id: str) -> Optional[dict]:
        agent = self._agents.get(agent_id)
        if not agent:
            return None
        return self._serialize(agent)

    def snapshot(self) -> dict:
        return {
            "agents": [self._serialize(self._agents[spec["id"]]) for spec in self.AGENTS],
            "updated_at": max((a["updated_at"] for a in self._agents.values()), default=None),
        }

    @staticmethod
    def _serialize(agent: dict) -> dict:
        return {
            "id": agent["id"],
            "name": agent["name"],
            "phase": agent["phase"],
            "color": agent["color"],
            "role": agent["role"],
            "status": agent["status"],
            "current_task": agent["current_task"],
            "last_output": agent["last_output"],
            "last_decision": agent["last_decision"],
            "latency_ms": agent["latency_ms"],
            "invocations": agent["invocations"],
            "successes": agent["successes"],
            "failures": agent["failures"],
            "last_error": agent["last_error"],
            "history": list(agent["history"]),
            "updated_at": agent["updated_at"],
        }


class RamScratchpad:
    """Temporary notes/logs for a RAM page. Explicitly not persistent."""

    def __init__(self, max_notes: int = 80):
        self.max_notes = max_notes
        self._notes: deque[dict] = deque(maxlen=max_notes)

    def add(self, text: str, *, source: str = "user", tags: Optional[list[str]] = None) -> dict:
        note = {
            "id": f"note_{int(_now() * 1000)}_{_short_id()}",
            "ts": _now(),
            "source": source,
            "text": text[:8000],
            "tags": tags or [],
            "volatile": True,
        }
        self._notes.append(note)
        return dict(note)

    def latest(self, limit: int = 50) -> list[dict]:
        return list(self._notes)[-max(1, min(200, limit)):][::-1]

    def clear(self) -> None:
        self._notes.clear()


class RamCheckpoints:
    """In-memory snapshots for comparing repo/plan/prompt state during a session."""

    def __init__(self, max_checkpoints: int = 30):
        self.max_checkpoints = max_checkpoints
        self._checkpoints: deque[dict] = deque(maxlen=max_checkpoints)

    def create(self, repo: "RepoInspector", plan: "PlanParser", label: str = "manual") -> dict:
        checkpoint = {
            "id": f"cp_{int(_now() * 1000)}_{_short_id()}",
            "ts": _now(),
            "label": label[:120],
            "repo": repo.snapshot(),
            "plan": plan.parse(),
            "prompt": {
                "size": _safe_file_size(repo.repo_path / "PROMPT.md"),
                "preview": (_read_text(repo.repo_path / "PROMPT.md", 1200) or ""),
            },
            "volatile": True,
        }
        self._checkpoints.append(checkpoint)
        return dict(checkpoint)

    def latest(self, limit: int = 20) -> list[dict]:
        return list(self._checkpoints)[-max(1, min(100, limit)):][::-1]

    def get(self, checkpoint_id: str) -> Optional[dict]:
        return next((dict(item) for item in self._checkpoints if item["id"] == checkpoint_id), None)


class RamSharedSegment:
    """Actual OS shared-memory segment containing the latest blackboard JSON."""

    def __init__(self, name: str = "ralph_studio_blackboard", size: int = 131_072):
        self.name = name
        self.size = size
        self.created = False
        self.error: Optional[str] = None
        self.updated_at: Optional[float] = None
        self._shm: Optional[shared_memory.SharedMemory] = None
        try:
            self._shm = shared_memory.SharedMemory(name=name, create=True, size=size)
            self.created = True
        except FileExistsError:
            try:
                self._shm = shared_memory.SharedMemory(name=name, create=False)
                self.size = self._shm.size
            except Exception as exc:
                self.error = str(exc)
        except Exception as exc:
            self.error = str(exc)

    def write(self, payload: dict) -> dict:
        if not self._shm:
            return self.snapshot()
        try:
            raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
            raw = raw[: self.size - 1]
            self._shm.buf[: self.size] = b"\x00" * self.size
            self._shm.buf[: len(raw)] = raw
            self.updated_at = _now()
        except Exception as exc:
            self.error = str(exc)
        return self.snapshot()

    def read_bytes(self, limit: int = 4096) -> bytes:
        if not self._shm:
            return b""
        raw = bytes(self._shm.buf[: min(self.size, limit)])
        return raw.split(b"\x00", 1)[0]

    def snapshot(self) -> dict:
        raw = self.read_bytes()
        preview = raw[:512]
        return {
            "available": self._shm is not None,
            "name": self.name,
            "size": self.size,
            "created_by_this_process": self.created,
            "updated_at": self.updated_at,
            "used_bytes": len(raw),
            "preview": preview.decode("utf-8", errors="replace"),
            "hex_preview": preview.hex(" "),
            "error": self.error,
        }

    def close(self, unlink: bool = False) -> None:
        if not self._shm:
            return
        try:
            self._shm.close()
            if unlink and self.created:
                self._shm.unlink()
        except FileNotFoundError:
            pass
        except Exception as exc:
            self.error = str(exc)


# ── Repo inspection ──────────────────────────────────────────────────
class RepoInspector:
    """Inspect a local repo: git state, Ralph file presence, recent commits."""

    def __init__(self, repo_path: Path):
        self.repo_path = repo_path

    def is_git(self) -> bool:
        return (self.repo_path / ".git").is_dir()

    def git_branch(self) -> Optional[str]:
        if not self.is_git():
            return None
        rc, out, _ = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], self.repo_path)
        return out.strip() if rc == 0 else None

    def git_dirty(self) -> Optional[bool]:
        if not self.is_git():
            return None
        rc, out, _ = _run(["git", "status", "--porcelain"], self.repo_path)
        if rc != 0:
            return None
        return bool(out.strip())

    def git_dirty_files(self) -> list[str]:
        if not self.is_git():
            return []
        rc, out, _ = _run(["git", "status", "--porcelain"], self.repo_path)
        if rc != 0:
            return []
        files = []
        for line in out.splitlines():
            line = line.rstrip()
            if not line:
                continue
            files.append(line[3:].strip() if len(line) > 3 else line)
        return files

    def git_ahead_behind(self) -> Optional[list[int]]:
        if not self.is_git():
            return None
        rc, out, _ = _run(
            ["git", "rev-list", "--left-right", "--count", "HEAD...@{u}"],
            self.repo_path,
        )
        if rc != 0:
            return None
        try:
            a, b = out.strip().split()
            return [int(a), int(b)]
        except ValueError:
            return None

    def recent_commits(self, n: int = 12) -> list[dict]:
        if not self.is_git():
            return []
        rc, out, _ = _run(
            [
                "git",
                "log",
                f"-n{max(1, n)}",
                "--pretty=format:%h%x1f%s%x1f%an%x1f%at",
            ],
            self.repo_path,
        )
        if rc != 0:
            return []
        commits = []
        for line in out.strip().split("\n"):
            if not line:
                continue
            parts = line.split("\x1f")
            if len(parts) < 4:
                continue
            try:
                ts = float(parts[3])
            except ValueError:
                ts = 0.0
            commits.append(
                {
                    "sha": parts[0],
                    "subject": parts[1],
                    "author": parts[2],
                    "timestamp": ts,
                }
            )
        return commits

    def commit_files(self, sha: str) -> list[str]:
        if not self.is_git() or not sha:
            return []
        rc, out, _ = _run(
            ["git", "show", "--name-only", "--pretty=format:", sha], self.repo_path
        )
        if rc != 0:
            return []
        return [f.strip() for f in out.splitlines() if f.strip()]

    def file_state(self, name: str) -> dict:
        path = self.repo_path / name
        st = _stat(path)
        return {"exists": st is not None, "name": name, "path": name, **(st or {})}

    def specs_dir(self) -> dict:
        path = self.repo_path / "specs"
        if not path.is_dir():
            return {"exists": False, "path": "specs", "files": []}
        files = sorted(
            p.name
            for p in path.iterdir()
            if p.is_file() and p.suffix in (".md", ".markdown")
        )
        return {"exists": True, "path": "specs", "files": files}

    def snapshot(self) -> dict:
        return {
            "path": str(self.repo_path),
            "exists": self.repo_path.exists(),
            "is_git": self.is_git(),
            "branch": self.git_branch(),
            "dirty": self.git_dirty(),
            "dirty_files": self.git_dirty_files()[:20],
            "ahead_behind": self.git_ahead_behind(),
            "commits": self.recent_commits(8),
            "files": {
                "prompt": self.file_state("PROMPT.md"),
                "agents": self.file_state("AGENTS.md"),
                "plan": self.file_state("IMPLEMENTATION_PLAN.md"),
                "specs": self.specs_dir(),
            },
        }


# ── Plan parser ──────────────────────────────────────────────────────
TASK_RE = re.compile(r"^(\s*)-\s+\[(?P<mark>[ xX~/!])\]\s+(?P<text>.+?)\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


class PlanParser:
    """Parse IMPLEMENTATION_PLAN.md into structured tasks + warnings."""

    def __init__(self, repo: RepoInspector):
        self.repo = repo

    def parse(self) -> dict:
        path = self.repo.repo_path / "IMPLEMENTATION_PLAN.md"
        text = _read_text(path)
        if text is None:
            return {
                "exists": False,
                "tasks": [],
                "tasks_total": 0,
                "tasks_completed": 0,
                "tasks_pending": 0,
                "tasks_blocked": 0,
                "tasks_stale": 0,
                "next_task": None,
                "sections": [],
                "warnings": [],
            }

        sections: list[str] = []
        current_section = ""
        tasks: list[dict] = []
        for i, line in enumerate(text.splitlines(), start=1):
            mh = HEADING_RE.match(line)
            if mh:
                current_section = mh.group(2).strip()
                if current_section not in sections:
                    sections.append(current_section)
                continue
            mt = TASK_RE.match(line)
            if mt:
                mark = mt.group("mark").lower()
                if mark == "x":
                    status = "completed"
                elif mark == "/":
                    status = "in_progress"
                elif mark == "!":
                    status = "blocked"
                elif mark == "~":
                    status = "stale"
                else:
                    status = "pending"
                tasks.append(
                    {
                        "id": f"t{i}",
                        "line": i,
                        "text": mt.group("text").strip(),
                        "status": status,
                        "section": current_section,
                    }
                )

        next_task = next((t for t in tasks if t["status"] == "pending"), None)
        if next_task:
            for t in tasks:
                if t["id"] == next_task["id"]:
                    t["status"] = "next"
                    next_task = dict(t)
                    break

        completed = sum(1 for t in tasks if t["status"] == "completed")
        pending = sum(1 for t in tasks if t["status"] in ("pending", "next", "in_progress"))
        blocked = sum(1 for t in tasks if t["status"] == "blocked")
        stale = sum(1 for t in tasks if t["status"] == "stale")

        warnings: list[dict] = []
        st = _stat(path)
        if st and (_now() - st["modified"]) > 86400 and tasks:
            warnings.append(
                {
                    "kind": "stale",
                    "severity": "low",
                    "message": "Plan hasn't been updated in over 24 hours.",
                }
            )

        # Repeated work: duplicate task texts
        seen: dict[str, int] = {}
        for t in tasks:
            seen[t["text"]] = seen.get(t["text"], 0) + 1
        dups = [text for text, count in seen.items() if count > 1]
        if dups:
            warnings.append(
                {
                    "kind": "repeated",
                    "severity": "medium",
                    "message": f"{len(dups)} task(s) appear more than once. First: '{dups[0][:60]}'",
                }
            )

        # Drift: long sections of completed tasks with no pending
        if tasks and completed > 0 and pending == 0 and blocked == 0:
            warnings.append(
                {
                    "kind": "drift",
                    "severity": "low",
                    "message": "All tasks marked completed — re-plan or close out the loop.",
                }
            )

        return {
            "exists": True,
            "path": "IMPLEMENTATION_PLAN.md",
            "modified": st["modified"] if st else None,
            "size": st["size"] if st else 0,
            "tasks_total": len(tasks),
            "tasks_completed": completed,
            "tasks_pending": pending,
            "tasks_blocked": blocked,
            "tasks_stale": stale,
            "tasks": tasks,
            "next_task": next_task,
            "sections": sections,
            "warnings": warnings,
        }


# ── Spec coverage ────────────────────────────────────────────────────
class SpecCoverage:
    """Map specs/* against plan tasks and recent commits."""

    def __init__(self, repo: RepoInspector, plan: PlanParser):
        self.repo = repo
        self.plan = plan

    @staticmethod
    def _tokens(stem: str) -> list[str]:
        parts = re.split(r"[-_\s]+", stem.lower())
        return [p for p in parts if len(p) >= 4]

    def map(self) -> dict:
        specs_path = self.repo.repo_path / "specs"
        if not specs_path.is_dir():
            return {"specs_dir": None, "specs": [], "totals": {"covered": 0, "partial": 0, "ignored": 0, "drifting": 0}}

        plan_data = self.plan.parse()
        plan_path = self.repo.repo_path / "IMPLEMENTATION_PLAN.md"
        plan_text = (_read_text(plan_path) or "").lower() if plan_data["exists"] else ""

        commits = self.repo.recent_commits(40)
        commit_corpus = " ".join(c["subject"] for c in commits).lower()

        specs: list[dict] = []
        for p in sorted(specs_path.iterdir()):
            if not p.is_file() or p.suffix not in (".md", ".markdown"):
                continue
            tokens = self._tokens(p.stem)
            in_plan = any(tok in plan_text for tok in tokens) if tokens else False
            commit_hits = sum(1 for tok in tokens if tok in commit_corpus)
            tasks_referenced = sum(
                1
                for t in plan_data["tasks"]
                if any(tok in t["text"].lower() for tok in tokens)
            )

            if commit_hits > 0 and in_plan and tasks_referenced > 0:
                status = "covered"
            elif in_plan or tasks_referenced > 0:
                status = "partial"
            elif commit_hits > 0:
                status = "drifting"
            else:
                status = "ignored"

            title = p.stem.replace("_", " ").replace("-", " ").title()
            head = _read_text(p, limit=400) or ""
            for line in head.splitlines():
                m = HEADING_RE.match(line)
                if m:
                    title = m.group(2).strip()
                    break

            st = _stat(p)
            specs.append(
                {
                    "file": p.name,
                    "title": title,
                    "status": status,
                    "tasks_referenced": tasks_referenced,
                    "commits_referenced": commit_hits,
                    "size": st["size"] if st else 0,
                    "modified": st["modified"] if st else None,
                }
            )

        totals = {
            "covered": sum(1 for s in specs if s["status"] == "covered"),
            "partial": sum(1 for s in specs if s["status"] == "partial"),
            "drifting": sum(1 for s in specs if s["status"] == "drifting"),
            "ignored": sum(1 for s in specs if s["status"] == "ignored"),
        }
        return {"specs_dir": "specs", "specs": specs, "totals": totals}


# ── Backpressure ─────────────────────────────────────────────────────
class Backpressure:
    """Detect and run validation commands. Auto-detects from package.json / pyproject."""

    def __init__(self, repo: RepoInspector):
        self.repo = repo
        self.results: dict[str, dict] = {}
        self._proc_lock = asyncio.Lock()

    def detected_checks(self) -> list[dict]:
        checks: list[dict] = []
        pkg_path = self.repo.repo_path / "package.json"
        scripts: dict = {}
        if pkg_path.is_file():
            try:
                scripts = json.loads(pkg_path.read_text(encoding="utf-8")).get("scripts", {})
            except (json.JSONDecodeError, OSError):
                scripts = {}

        if "test" in scripts:
            checks.append({"id": "tests", "name": "Tests", "command": ["npm", "test"]})
        if "lint" in scripts:
            checks.append({"id": "lint", "name": "Lint", "command": ["npm", "run", "lint"]})
        if "typecheck" in scripts:
            checks.append({"id": "typecheck", "name": "Typecheck", "command": ["npm", "run", "typecheck"]})
        if "build" in scripts:
            checks.append({"id": "build", "name": "Build", "command": ["npm", "run", "build"]})

        # Python project hints
        py_indicators = ["pyproject.toml", "requirements.txt", "setup.py"]
        if any((self.repo.repo_path / f).is_file() for f in py_indicators):
            if not any(c["id"] == "tests" for c in checks):
                checks.append(
                    {"id": "py-tests", "name": "Pytest", "command": ["pytest", "-q"]}
                )

        # Only meaningful when the repo is a git repo; otherwise
        # `git status` errors out and looks like a "failed" check.
        if self.repo.is_git():
            checks.append(
                {
                    "id": "git-clean",
                    "name": "Working tree",
                    "command": ["git", "status", "--porcelain"],
                }
            )
        return checks

    def snapshot(self) -> dict:
        meta = self.detected_checks()
        out = []
        for c in meta:
            r = self.results.get(
                c["id"],
                {"status": "unknown", "output": "", "ran_at": None, "duration_ms": None},
            )
            out.append(
                {
                    "id": c["id"],
                    "name": c["name"],
                    "command": " ".join(c["command"]),
                    **r,
                }
            )
        all_clean = bool(out) and all(r["status"] == "passed" for r in out)
        last_run = max(
            (r.get("ran_at") or 0 for r in self.results.values()),
            default=None,
        )
        return {
            "checks": out,
            "all_clean": all_clean,
            "last_run": last_run if last_run else None,
        }

    async def run_check(self, check_id: str) -> dict:
        check = next((c for c in self.detected_checks() if c["id"] == check_id), None)
        if not check:
            return {"id": check_id, "status": "unknown", "error": "check not found"}

        async with self._proc_lock:
            self.results[check_id] = {
                "status": "running",
                "output": "",
                "ran_at": _now(),
                "duration_ms": None,
            }
            t0 = _now()
            timeout = 6 if check_id == "git-clean" else 180
            loop = asyncio.get_event_loop()
            rc, out, err = await loop.run_in_executor(
                None, lambda: _run(check["command"], self.repo.repo_path, timeout)
            )
            output = (out + ("\n" + err if err else ""))[-4000:]

            if check_id == "git-clean":
                status = "passed" if rc == 0 and not out.strip() else (
                    "warned" if rc == 0 else "failed"
                )
            else:
                status = "passed" if rc == 0 else "failed"

            self.results[check_id] = {
                "status": status,
                "output": output,
                "ran_at": _now(),
                "duration_ms": int((_now() - t0) * 1000),
            }
            return {"id": check_id, **self.results[check_id]}


# ── Iteration store ──────────────────────────────────────────────────
@dataclass
class Iteration:
    id: str
    number: int
    mode: str = "build"  # plan | build
    status: str = "running"  # running | passed | failed | stopped
    started_at: float = field(default_factory=_now)
    ended_at: Optional[float] = None
    summary: str = ""
    files_changed: list[str] = field(default_factory=list)
    commit_sha: Optional[str] = None
    test_status: str = "unknown"  # unknown | passed | failed | skipped
    prompt_mode: Optional[str] = None
    runner: Optional[str] = None
    command_output: str = ""
    validation: list[dict] = field(default_factory=list)
    failure_reason: Optional[str] = None
    plan_diff: Optional[str] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["files_changed_count"] = len(self.files_changed)
        d["duration_ms"] = (
            int((self.ended_at - self.started_at) * 1000) if self.ended_at else None
        )
        return d


class IterationStore:
    """Append-only JSONL of iterations. Cheap rewrite on update (history is small)."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._cache: list[Iteration] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                        valid = {
                            k: v
                            for k, v in d.items()
                            if k in Iteration.__dataclass_fields__
                        }
                        self._cache.append(Iteration(**valid))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except OSError:
            return

    def _rewrite(self) -> None:
        tmp = self.path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for it in self._cache:
                f.write(json.dumps(asdict(it)) + "\n")
        tmp.replace(self.path)

    def add(self, it: Iteration) -> None:
        self._cache.append(it)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(it)) + "\n")

    def update(self, it: Iteration) -> None:
        for i, existing in enumerate(self._cache):
            if existing.id == it.id:
                self._cache[i] = it
                break
        self._rewrite()

    def all(self) -> list[Iteration]:
        return list(self._cache)

    def latest(self, n: int = 50) -> list[Iteration]:
        return self._cache[-n:][::-1]

    def get(self, iter_id: str) -> Optional[Iteration]:
        return next((it for it in self._cache if it.id == iter_id), None)

    def next_number(self) -> int:
        return (self._cache[-1].number + 1) if self._cache else 1


# ── Guardrails ───────────────────────────────────────────────────────
class Guardrails:
    """Read PROMPT.md / AGENTS.md and propose rules from iteration history."""

    def __init__(self, repo: RepoInspector, store: IterationStore):
        self.repo = repo
        self.store = store

    def snapshot(self) -> dict:
        prompt_path = self.repo.repo_path / "PROMPT.md"
        agents_path = self.repo.repo_path / "AGENTS.md"
        prompt_text = _read_text(prompt_path, limit=8000) or ""
        agents_text = _read_text(agents_path, limit=8000) or ""

        last_mode = None
        if self.store.all():
            last = self.store.all()[-1]
            last_mode = last.prompt_mode or last.mode

        return {
            "prompt": {
                "exists": prompt_path.is_file(),
                **(_stat(prompt_path) or {}),
                "preview": prompt_text[:600],
            },
            "agents": {
                "exists": agents_path.is_file(),
                **(_stat(agents_path) or {}),
                "preview": agents_text[:600],
            },
            "last_prompt_mode": last_mode,
            "suggestions": self._suggest(),
        }

    def _suggest(self) -> list[dict]:
        suggestions: list[dict] = []
        recent = self.store.all()[-20:]

        if not recent:
            # Bootstrap suggestions when there's no history yet
            if not (self.repo.repo_path / "AGENTS.md").is_file():
                suggestions.append(
                    {
                        "id": "create-agents-md",
                        "kind": "scaffold",
                        "severity": "high",
                        "message": "No AGENTS.md found. Create one to give Ralph operational rules: build/test commands, commit hygiene, scope limits.",
                        "based_on": "scaffold check",
                    }
                )
            if not (self.repo.repo_path / "PROMPT.md").is_file():
                suggestions.append(
                    {
                        "id": "create-prompt-md",
                        "kind": "scaffold",
                        "severity": "high",
                        "message": "No PROMPT.md found. Create one — it's the per-iteration instruction Ralph re-reads each loop.",
                        "based_on": "scaffold check",
                    }
                )
            if not (self.repo.repo_path / "IMPLEMENTATION_PLAN.md").is_file():
                suggestions.append(
                    {
                        "id": "create-plan-md",
                        "kind": "scaffold",
                        "severity": "medium",
                        "message": "No IMPLEMENTATION_PLAN.md found. Ralph uses this as persistent state between iterations.",
                        "based_on": "scaffold check",
                    }
                )
            return suggestions

        test_fails = sum(1 for it in recent if it.test_status == "failed")
        if test_fails >= 3:
            suggestions.append(
                {
                    "id": "tests-required",
                    "kind": "validation_gap",
                    "severity": "high",
                    "message": f"Tests failed {test_fails} times in the last {len(recent)} iterations. Add a guardrail: always run tests before commit.",
                    "based_on": f"{test_fails} failed test runs",
                }
            )

        no_commit = sum(
            1 for it in recent if it.status == "passed" and not it.commit_sha
        )
        if no_commit >= 3:
            suggestions.append(
                {
                    "id": "commit-required",
                    "kind": "commit_skip",
                    "severity": "medium",
                    "message": f"{no_commit} recent iterations passed without producing a commit. Require a commit per iteration in AGENTS.md.",
                    "based_on": f"{no_commit} commit-less iterations",
                }
            )

        last5 = recent[-5:]
        if last5 and sum(1 for it in last5 if it.status == "failed") >= 3:
            suggestions.append(
                {
                    "id": "failure-cluster",
                    "kind": "convergence",
                    "severity": "high",
                    "message": "3+ failures in the last 5 iterations. Re-plan or reduce task scope.",
                    "based_on": "recent failure cluster",
                }
            )

        if recent and self.repo.git_dirty():
            suggestions.append(
                {
                    "id": "dirty-tree",
                    "kind": "tree_dirty",
                    "severity": "medium",
                    "message": "Working tree is dirty. Refuse to start a new iteration with uncommitted changes.",
                    "based_on": "git status",
                }
            )

        return suggestions


# ── Controller ───────────────────────────────────────────────────────
RUNNERS = ["codex", "claude", "aider", "openrouter", "custom"]
LOOP_MODES = ["idle", "planning", "running", "paused", "failed", "stopped"]
STOP_REASONS = {
    "user_stop", "panic", "max_iterations", "failure_stop",
    "no_commit_stop", "dirty_tree_stop", "completed", "no_runner_command",
}


def _runner_preset_command(preset_id: str) -> str:
    """Return a sensible default command for a runner preset on this OS."""
    if preset_id == "codex":
        # codex CLI reads stdin; cmd /C is needed for redirection on Windows.
        return ("cmd /C \"codex exec < PROMPT.md\"" if os.name == "nt"
                else "codex exec < PROMPT.md")
    if preset_id == "claude":
        return ('powershell -NoProfile -Command "claude -p (Get-Content -Raw PROMPT.md)"'
                if os.name == "nt"
                else 'claude -p "$(cat PROMPT.md)"')
    if preset_id == "aider":
        return "aider --yes"
    if preset_id == "openrouter":
        # OpenRouter has no CLI of its own — aider speaks to it natively via OPENROUTER_API_KEY.
        # Pick a reasonable default model; user can swap to any model on https://openrouter.ai/models.
        # Resolve aider via shutil.which() so the preset works even when aider's Scripts dir
        # isn't on PATH (common on Windows when installed via py launcher).
        import shutil as _shutil
        aider_bin = _shutil.which("aider") or "aider"
        return (f'"{aider_bin}" --model openrouter/anthropic/claude-sonnet-4.5 '
                f'--yes --message-file PROMPT.md')
    return ""


def _runner_install_hint(preset_id: str) -> Optional[str]:
    return {
        "codex":      "Install: see https://github.com/openai/codex (npm/pip distribution).",
        "claude":     "Install: npm install -g @anthropic-ai/claude-code (https://www.anthropic.com/code).",
        "aider":      "Install: pip install aider-install && aider-install (https://aider.chat).",
        "openrouter": "Install aider (pip install aider-install && aider-install), then set OPENROUTER_API_KEY. "
                      "Pick any model from https://openrouter.ai/models (e.g. openrouter/openai/gpt-4o, "
                      "openrouter/google/gemini-2.5-flash, openrouter/deepseek/deepseek-chat-v3.1).",
        "custom":     None,
    }.get(preset_id)


def _runner_executable(preset_id: str) -> Optional[str]:
    return {
        "codex":      "codex",
        "claude":     "claude",
        "aider":      "aider",
        "openrouter": "aider",  # OpenRouter is a backend for aider; same binary on PATH
        "custom":     None,
    }.get(preset_id)


def _which(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    import shutil
    found = shutil.which(name)
    return str(found) if found else None


@dataclass
class LoopConfig:
    """Continuous-loop runner configuration. All fields tunable at runtime."""
    max_iterations: Optional[int] = None  # None = unlimited
    stop_on_failure: bool = True
    stop_if_no_commit: bool = False
    stop_if_dirty_before_run: bool = False
    delay_between_iterations_seconds: float = 2.0
    mode: str = "build"  # build | plan
    runner: str = "claude"
    runner_command: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)

    def apply(self, patch: dict) -> "LoopConfig":
        """Merge a partial dict into this config in-place. Ignores unknown keys."""
        if not patch:
            return self
        if "max_iterations" in patch:
            v = patch["max_iterations"]
            self.max_iterations = int(v) if v not in (None, "", 0) else None
        for bool_field in ("stop_on_failure", "stop_if_no_commit", "stop_if_dirty_before_run"):
            if bool_field in patch:
                self.__setattr__(bool_field, bool(patch[bool_field]))
        if "delay_between_iterations_seconds" in patch:
            try:
                self.delay_between_iterations_seconds = max(0.0, float(patch["delay_between_iterations_seconds"]))
            except (TypeError, ValueError):
                pass
        if "mode" in patch and patch["mode"] in ("build", "plan"):
            self.mode = patch["mode"]
        if "runner" in patch and patch["runner"] in RUNNERS:
            self.runner = patch["runner"]
        if "runner_command" in patch:
            cmd = patch["runner_command"]
            self.runner_command = (cmd or None) if isinstance(cmd, str) else None
        return self


class RalphController:
    """Top-level orchestrator. Tracks loop state, iterations, and broadcasts."""

    def __init__(self, repo_path: Path, data_dir: Path):
        self.repo = RepoInspector(repo_path)
        self.plan = PlanParser(self.repo)
        self.specs = SpecCoverage(self.repo, self.plan)
        self.bp = Backpressure(self.repo)
        self.store = IterationStore(data_dir / "iterations.jsonl")
        self.guards = Guardrails(self.repo, self.store)
        self.ram_events = RamEventStream()
        self.ram_board = RamBlackboard()
        self.ram_scratchpad = RamScratchpad()
        self.ram_checkpoints = RamCheckpoints()
        self.ram_segment = RamSharedSegment()
        self.agents = AgentRoster()

        # Loop runtime state
        self.mode: str = "idle"
        self.config: LoopConfig = LoopConfig(
            runner=os.environ.get("RALPH_RUNNER", "claude"),
            runner_command=os.environ.get("RALPH_RUNNER_CMD") or None,
        )
        self.started_at: Optional[float] = None
        self.current_iter_id: Optional[str] = None
        self.session_iter_count: int = 0
        self.stop_reason: Optional[str] = None
        self.next_iteration_eta: Optional[float] = None
        self._between_iterations: bool = False

        # Internal control plumbing
        self._ws_clients: list = []
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._proc_task: Optional[asyncio.Task] = None
        self._loop_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._stop_requested = False
        self._panic_requested = False
        self._resume_event: asyncio.Event = asyncio.Event()
        self._resume_event.set()  # not paused initially
        self.ram_board.update(
            loop_mode=self.mode,
            runner=self.config.runner,
            repo_path=str(self.repo.repo_path),
            command=self.config.runner_command,
            next_action="Configure RALPH_RUNNER_CMD or start a manual iteration.",
        )
        self.ram_events.append(
            "boot",
            "RAM backend initialized",
            data={"repo_path": str(self.repo.repo_path), "data_dir": str(data_dir)},
        )

    # ── Convenience accessors (preserve old attribute API) ────
    @property
    def runner(self) -> str:
        return self.config.runner

    @runner.setter
    def runner(self, value: str) -> None:
        self.config.runner = value

    @property
    def runner_command(self) -> Optional[str]:
        return self.config.runner_command

    @runner_command.setter
    def runner_command(self, value: Optional[str]) -> None:
        self.config.runner_command = value or None

    # ── WebSocket ──────────────────────────────────────────────
    def register_ws(self, client) -> None:
        if client not in self._ws_clients:
            self._ws_clients.append(client)

    def remove_ws(self, client) -> None:
        if client in self._ws_clients:
            self._ws_clients.remove(client)

    async def broadcast(self, type_: str, data: Any) -> None:
        msg = json.dumps({"type": type_, "data": data, "ts": _now()})
        for client in self._ws_clients[:]:
            try:
                await client.send_text(msg)
            except Exception:
                self.remove_ws(client)

    async def agent_activate(self, agent_id: str, task: str, *, prompt: Optional[str] = None) -> None:
        snap = self.agents.activate(agent_id, task, prompt=prompt)
        if snap:
            await self.broadcast("agent", snap)

    async def agent_complete(
        self,
        agent_id: str,
        *,
        output: Optional[str] = None,
        decision: Optional[str] = None,
        success: bool = True,
        error: Optional[str] = None,
    ) -> None:
        snap = self.agents.complete(
            agent_id, output=output, decision=decision, success=success, error=error
        )
        if snap:
            await self.broadcast("agent", snap)

    async def ram_event(
        self,
        kind: str,
        message: str,
        *,
        level: str = "info",
        iteration_id: Optional[str] = None,
        data: Optional[dict] = None,
    ) -> dict:
        event = self.ram_events.append(
            kind,
            message,
            level=level,
            iteration_id=iteration_id,
            data=data,
        )
        await self.broadcast("ram_event", event)
        return event

    # ── State ──────────────────────────────────────────────────
    def status(self) -> dict:
        current = self.store.get(self.current_iter_id) if self.current_iter_id else None
        process = self.process_snapshot()
        return {
            "mode": self.mode,
            "runner": self.config.runner,
            "runner_command": self.config.runner_command,
            "repo_path": str(self.repo.repo_path),
            "branch": self.repo.git_branch(),
            "dirty": self.repo.git_dirty(),
            "started_at": self.started_at,
            "uptime_seconds": int(_now() - self.started_at) if self.started_at else 0,
            "iteration_count": len(self.store.all()),
            "current_iteration": current.to_dict() if current else None,
            "process": process,
            "config": self.config.to_dict(),
            "session_iter_count": self.session_iter_count,
            "stop_reason": self.stop_reason,
            "next_iteration_eta": self.next_iteration_eta,
            "between_iterations": self._between_iterations,
        }

    def aggregate(self) -> dict:
        """Combined snapshot for the dashboard's first paint."""
        return {
            "status": self.status(),
            "repo": self.repo.snapshot(),
            "plan": self.plan.parse(),
            "specs": self.specs.map(),
            "backpressure": self.bp.snapshot(),
            "guardrails": self.guards.snapshot(),
            "iterations": [it.to_dict() for it in self.store.latest(30)],
            "ram": self.ram_snapshot(),
            "thrash": self.detect_thrash(),
        }

    def process_snapshot(self) -> dict:
        pid = self._proc.pid if self._proc else None
        memory = _process_memory(pid) if pid else {
            "pid": None,
            "rss_bytes": None,
            "cpu_percent": None,
            "available": False,
        }
        return {
            "running": bool(self._proc and self._proc.returncode is None),
            "pid": pid,
            "command": self.runner_command,
            "started_at": self.started_at if pid else None,
            "runtime_seconds": int(_now() - self.started_at) if pid and self.started_at else 0,
            "memory": memory,
        }

    def detect_thrash(self, *, window: int = 6, repeat_threshold: int = 3) -> dict:
        """Scan the last `window` iterations for repeat-failure patterns.

        Returns an alert if the same files have been touched with the same
        kind of failure (or no commit produced) `repeat_threshold` or more
        times in a row. This is the "Ralph keeps Ralphing the wrong thing"
        anti-thrash signal that the magpie/tagger phases watch for.
        """
        recent = self.store.latest(window)
        if len(recent) < repeat_threshold:
            return {"thrashing": False, "reason": "not enough iterations", "window": len(recent)}

        # Count consecutive failures from most-recent
        consecutive_fail = 0
        for it in recent:
            if it.status == "failed" or not it.commit_sha:
                consecutive_fail += 1
            else:
                break

        # Bucket files touched across recent failures
        file_counter: Counter[str] = Counter()
        reason_counter: Counter[str] = Counter()
        for it in recent[:consecutive_fail]:
            for f in (it.files_changed or []):
                file_counter[f] += 1
            if it.failure_reason:
                reason_counter[it.failure_reason[:120]] += 1

        repeated_files = [f for f, n in file_counter.items() if n >= repeat_threshold]
        repeated_reasons = [(r, n) for r, n in reason_counter.most_common() if n >= repeat_threshold]

        thrashing = (
            consecutive_fail >= repeat_threshold
            or bool(repeated_files)
            or bool(repeated_reasons)
        )

        return {
            "thrashing": thrashing,
            "consecutive_failures": consecutive_fail,
            "window": len(recent),
            "repeated_files": repeated_files,
            "repeated_failure_reasons": [
                {"reason": r, "count": n} for r, n in repeated_reasons
            ],
            "iterations_inspected": [
                {
                    "id": it.id,
                    "number": it.number,
                    "status": it.status,
                    "files_changed": it.files_changed or [],
                    "failure_reason": it.failure_reason,
                    "commit_sha": it.commit_sha,
                }
                for it in recent[:consecutive_fail or 1]
            ],
        }

    def memory_pressure(self) -> dict:
        prompt_size = _safe_file_size(self.repo.repo_path / "PROMPT.md")
        plan_size = _safe_file_size(self.repo.repo_path / "IMPLEMENTATION_PLAN.md")
        agents_size = _safe_file_size(self.repo.repo_path / "AGENTS.md")
        specs_size = 0
        specs_path = self.repo.repo_path / "specs"
        if specs_path.is_dir():
            specs_size = sum(_safe_file_size(path) for path in specs_path.glob("*.md"))
        repo_scan = _count_repo_bytes(self.repo.repo_path)
        event_bytes = sum(
            len(json.dumps(event, ensure_ascii=False))
            for event in self.ram_events.latest(500)
        )
        prompt_context_bytes = prompt_size + plan_size + agents_size + specs_size
        return {
            "prompt_bytes": prompt_size,
            "plan_bytes": plan_size,
            "agents_bytes": agents_size,
            "specs_bytes": specs_size,
            "prompt_context_bytes": prompt_context_bytes,
            "estimated_context_tokens": max(1, prompt_context_bytes // 4) if prompt_context_bytes else 0,
            "repo_scan": repo_scan,
            "event_buffer_bytes": event_bytes,
            "process": self.process_snapshot(),
        }

    def ram_snapshot(self) -> dict:
        blackboard = self.ram_board.snapshot()
        process = self.process_snapshot()
        event_stats = self.ram_events.stats()
        memory_pressure = self.memory_pressure()
        segment = self.ram_segment.write(
            {
                "blackboard": blackboard,
                "process": process,
                "event_stats": event_stats,
                "memory_pressure": memory_pressure,
            }
        )
        return {
            "blackboard": blackboard,
            "events": self.ram_events.latest(100),
            "event_stats": event_stats,
            "scratchpad": self.ram_scratchpad.latest(20),
            "checkpoints": self.ram_checkpoints.latest(10),
            "memory_pressure": memory_pressure,
            "process": process,
            "shared_segment": segment,
            "agents": self.agents.snapshot(),
        }

    # ── Iteration lifecycle ────────────────────────────────────
    def begin_iteration(
        self, mode: str = "build", prompt_mode: Optional[str] = None,
        runner: Optional[str] = None,
    ) -> Iteration:
        plan_data = self.plan.parse()
        next_task = plan_data.get("next_task") or {}
        it = Iteration(
            id=f"it_{int(_now())}_{_short_id()}",
            number=self.store.next_number(),
            mode=mode,
            prompt_mode=prompt_mode,
            runner=runner or self.runner,
            summary=next_task.get("text", ""),
        )
        self.store.add(it)
        self.current_iter_id = it.id
        self.ram_board.update(
            loop_mode="running" if mode == "build" else "planning",
            runner=runner or self.runner,
            current_task=next_task.get("text"),
            next_action="Run configured Ralph command." if self.runner_command else "Manual iteration active. Configure RALPH_RUNNER_CMD to execute from the dashboard.",
            last_error=None,
            command=self.runner_command,
        )
        self.ram_events.append(
            "iteration_started",
            f"Iteration {it.number} started",
            iteration_id=it.id,
            data={"mode": mode, "task": next_task.get("text")},
        )
        return it

    def finish_iteration(
        self, iter_id: str, status: str, **fields
    ) -> Optional[Iteration]:
        it = self.store.get(iter_id)
        if not it:
            return None
        it.status = status
        it.ended_at = _now()
        for k, v in fields.items():
            if hasattr(it, k) and v is not None:
                setattr(it, k, v)
        self.store.update(it)
        if self.current_iter_id == iter_id:
            self.current_iter_id = None
        self.ram_board.update(
            loop_mode=self.mode,
            last_error=it.failure_reason,
            files_changed=it.files_changed,
            last_commit=it.commit_sha,
            test_output=it.command_output[-1200:] if it.command_output else None,
            next_action="Review failure and adjust prompt." if status == "failed" else "Ready for next iteration.",
        )
        self.ram_events.append(
            "iteration_finished",
            f"Iteration {it.number} finished with {status}",
            level="error" if status == "failed" else "info",
            iteration_id=it.id,
            data={"files_changed": it.files_changed, "commit_sha": it.commit_sha},
        )
        return it

    # ── Loop control: continuous + start-once ─────────────────
    def _fallback_runner_command(self) -> str:
        """Pick a safe default command when the user clicks Run/Loop without
        configuring one. If the repo is a git repo, use an empty commit so the
        full 8-agent flow (incl. magpie + tagger) fires; otherwise just echo."""
        if self.repo.is_git():
            return 'git commit --allow-empty -m "ralpharium iteration"'
        return 'echo "ralpharium iteration (no git repo — magpie + tagger will skip)"'

    async def _ensure_runner_command(self) -> None:
        """If no runner command is configured, fall back to a safe default and
        announce it. Saves the fallback into config so the UI reflects what's
        running and the user can edit it before the next iteration."""
        if self.config.runner_command:
            return
        cmd = self._fallback_runner_command()
        self.config.runner_command = cmd
        self.ram_board.update(command=cmd)
        await self.ram_event(
            "runner_fallback",
            f"No runner command configured — using fallback: {cmd}",
            level="warn",
            data={"command": cmd},
        )

    async def start(self) -> dict:
        """Start a continuous loop using LoopConfig. See start_once() for single-shot."""
        async with self._lock:
            if self.mode in ("running", "planning"):
                return {"ok": False, "reason": "already running"}
            await self._ensure_runner_command()
            self._stop_requested = False
            self._panic_requested = False
            self.stop_reason = None
            self.session_iter_count = 0
            self.mode = "running"
            self.started_at = self.started_at or _now()
            self._resume_event.set()
            self.ram_board.update(
                loop_mode=self.mode,
                runner=self.config.runner,
                command=self.config.runner_command,
                next_action="Continuous loop active.",
                last_error=None,
            )
            await self.ram_event(
                "loop_started",
                "Continuous loop started",
                data={"config": self.config.to_dict()},
            )
            await self.broadcast("status", self.status())
            self._loop_task = asyncio.create_task(self._continuous_loop())
            return {"ok": True, "config": self.config.to_dict()}

    async def start_once(self) -> dict:
        """Run a single iteration. Falls back to a safe default command if none configured."""
        async with self._lock:
            if self.mode in ("running", "planning"):
                return {"ok": False, "reason": "already running"}
            await self._ensure_runner_command()
            self._stop_requested = False
            self._panic_requested = False
            self.stop_reason = None
            self.mode = "running"
            self.started_at = self.started_at or _now()
            self._resume_event.set()

            it = self.begin_iteration(mode=self.config.mode or "build")
            self.ram_board.update(loop_mode=self.mode, runner=self.config.runner, command=self.config.runner_command)
            await self.ram_event("loop_started", "Single-shot iteration started", iteration_id=it.id, data={"once": True})
            await self.broadcast("status", self.status())
            await self.broadcast("iteration_started", it.to_dict())

            self._proc_task = asyncio.create_task(self._run_iteration_once(it))
            return {"ok": True, "iteration": it.to_dict()}

    async def _run_iteration_once(self, it: Iteration) -> None:
        """Single-shot subprocess wrapper: runs one iteration, returns mode to idle."""
        result = await self._run_subprocess(it)
        if result["passed"]:
            self.mode = "idle"
        else:
            self.mode = "failed"
        self.ram_board.update(
            loop_mode=self.mode,
            pid=None,
            last_error=None if result["passed"] else result.get("failure_reason"),
            next_action="Ready for next iteration." if result["passed"] else "Review failure before restarting.",
        )
        await self.broadcast("status", self.status())
        # Push a full RAM snapshot so every connected page (RAM + Dashboard)
        # refreshes without the user having to hit reload.
        await self.broadcast("ram", self.ram_snapshot())
        await self.broadcast("snapshot", self.aggregate())

    # ── Continuous loop ────────────────────────────────────────
    async def _continuous_loop(self) -> None:
        """Run iterations until stop conditions are met."""
        try:
            while True:
                if self._panic_requested:
                    self.stop_reason = self.stop_reason or "panic"
                    break
                if self._stop_requested:
                    self.stop_reason = self.stop_reason or "user_stop"
                    break

                # Pause gate (between iterations). Keeps mode == "paused" while not set.
                if not self._resume_event.is_set():
                    self._between_iterations = True
                    await self.broadcast("status", self.status())
                    await self._resume_event.wait()
                    if self._stop_requested or self._panic_requested:
                        self.stop_reason = self.stop_reason or ("panic" if self._panic_requested else "user_stop")
                        break

                # Pre-flight: dirty tree
                if self.config.stop_if_dirty_before_run and self.repo.git_dirty():
                    self.stop_reason = "dirty_tree_stop"
                    self.ram_board.update(last_error="dirty tree before run", next_action="Commit or stash before restarting.")
                    await self.ram_event(
                        "loop_dirty_tree_stop",
                        "Aborting loop — working tree is dirty",
                        level="error",
                    )
                    break

                # Pre-flight: max iterations
                if self.config.max_iterations and self.session_iter_count >= self.config.max_iterations:
                    self.stop_reason = "max_iterations"
                    await self.ram_event(
                        "loop_max_iterations_reached",
                        f"Reached max_iterations={self.config.max_iterations}",
                    )
                    break

                # Begin iteration
                it = self.begin_iteration(mode=self.config.mode or "build")
                await self.ram_event(
                    "loop_iteration_started",
                    f"Loop iteration {it.number} started "
                    f"(session #{self.session_iter_count + 1})",
                    iteration_id=it.id,
                    data={"session": self.session_iter_count + 1, "config": self.config.to_dict()},
                )
                await self.broadcast("iteration_started", it.to_dict())
                await self.broadcast("status", self.status())

                # Run the subprocess (this completes even if pause was requested)
                result = await self._run_subprocess(it)
                self.session_iter_count += 1

                await self.ram_event(
                    "loop_iteration_finished",
                    f"Loop iteration {it.number} finished: {result['status']}",
                    level="info" if result["passed"] else "error",
                    iteration_id=it.id,
                    data={"status": result["status"], "commit_sha": result.get("commit_sha"), "exit_code": result.get("exit_code")},
                )
                await self.broadcast("status", self.status())
                # Full snapshot push so every page sees agents/events/state without reloading.
                await self.broadcast("ram", self.ram_snapshot())
                await self.broadcast("snapshot", self.aggregate())

                # Post-flight: failure stop
                if not result["passed"] and self.config.stop_on_failure:
                    self.stop_reason = "failure_stop"
                    await self.ram_event(
                        "loop_failure_stop",
                        f"Stopping loop — iteration failed ({result.get('failure_reason')})",
                        level="error",
                    )
                    break

                # Post-flight: no commit
                if not result.get("commit_sha") and self.config.stop_if_no_commit:
                    self.stop_reason = "no_commit_stop"
                    await self.ram_event(
                        "loop_no_commit_stop",
                        "Stopping loop — iteration produced no commit",
                        level="warn",
                    )
                    break

                # Wait between iterations (interruptible by stop/panic/resume changes)
                delay = max(0.0, float(self.config.delay_between_iterations_seconds))
                if delay > 0:
                    self.next_iteration_eta = _now() + delay
                    self._between_iterations = True
                    await self.broadcast("status", self.status())
                    try:
                        await asyncio.wait_for(self._wait_for_stop_or_pause(), timeout=delay)
                    except asyncio.TimeoutError:
                        pass
                    self.next_iteration_eta = None
                    self._between_iterations = False

                if self._panic_requested:
                    self.stop_reason = self.stop_reason or "panic"
                    break
                if self._stop_requested:
                    self.stop_reason = self.stop_reason or "user_stop"
                    break
        except asyncio.CancelledError:
            self.stop_reason = self.stop_reason or "cancelled"
        except Exception as exc:
            self.stop_reason = "loop_error"
            await self.ram_event("loop_error", f"Loop crashed: {exc!r}", level="error")
        finally:
            self.next_iteration_eta = None
            self._between_iterations = False
            if self._panic_requested:
                self.mode = "stopped"
            elif self.stop_reason in ("failure_stop", "loop_error"):
                self.mode = "failed"
            elif self.stop_reason in ("user_stop", "panic", "max_iterations",
                                       "no_commit_stop", "dirty_tree_stop", "completed", "cancelled"):
                self.mode = "stopped" if self.stop_reason in ("user_stop", "panic", "cancelled") else "idle"
            else:
                self.mode = "idle"
            self.ram_board.update(loop_mode=self.mode, pid=None,
                                  next_action=f"Loop ended: {self.stop_reason or 'idle'}.")
            await self.ram_event(
                "loop_stopped",
                f"Continuous loop ended (reason={self.stop_reason})",
                data={"reason": self.stop_reason, "session_iterations": self.session_iter_count},
            )
            await self.broadcast("status", self.status())
            self._loop_task = None

    async def _wait_for_stop_or_pause(self) -> None:
        """Poll for stop / panic / pause requests so the inter-iteration delay is interruptible."""
        while True:
            if self._stop_requested or self._panic_requested:
                return
            if not self._resume_event.is_set():
                return
            await asyncio.sleep(0.2)

    async def _run_subprocess(self, it: Iteration) -> dict:
        """Run the configured runner_command for a single iteration.

        Returns a result dict:
          {"passed": bool, "status": "passed|failed|stopped",
           "commit_sha": str | None, "exit_code": int | None,
           "failure_reason": str | None, "files_changed": [str]}
        """
        cmd = self.config.runner_command or ""

        # ── Pre-flight agent phase: planner + researcher pick context ──
        plan_data = self.plan.parse()
        next_task = plan_data.get("next_task") or {}
        task_text = next_task.get("text") or "no next task in plan"
        await self.agent_activate(
            "planner",
            f"Pick next task for iteration {it.number}",
            prompt=f"plan: {plan_data.get('total_tasks', 0)} tasks, "
                   f"{plan_data.get('tasks_completed', 0)} done",
        )
        await self.agent_complete(
            "planner",
            decision=f"Next: {task_text[:160]}",
            success=bool(next_task),
        )

        repo_snap = self.repo.snapshot()
        specs_snap = self.specs.map()
        await self.agent_activate("researcher", f"Scan {self.repo.repo_path.name}")
        await self.agent_complete(
            "researcher",
            output=f"branch={repo_snap.get('branch','—')} · "
                   f"specs={specs_snap.get('total', 0)} · "
                   f"dirty={'yes' if repo_snap.get('dirty') else 'no'}",
            decision=f"Context ready for {task_text[:80]}",
        )

        if not cmd:
            await self.agent_complete(
                "builder",
                error="no runner_command configured",
                success=False,
            )
            self.finish_iteration(it.id, "failed", failure_reason="no runner_command configured")
            return {"passed": False, "status": "failed", "commit_sha": None, "exit_code": None,
                    "failure_reason": "no runner_command", "files_changed": []}

        await self.agent_activate(
            "builder",
            f"Run: {cmd[:120]}",
            prompt=cmd[:600],
        )

        result = {"passed": False, "status": "failed", "commit_sha": None,
                  "exit_code": None, "failure_reason": None, "files_changed": []}
        try:
            self._proc = await asyncio.create_subprocess_shell(
                cmd,
                cwd=str(self.repo.repo_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            self.ram_board.update(pid=self._proc.pid, command=cmd, next_action="Runner process active.")
            await self.ram_event(
                "process_started",
                f"Runner process started with PID {self._proc.pid}",
                iteration_id=it.id,
                data={"pid": self._proc.pid, "command": cmd},
            )
            collected: list[str] = []
            assert self._proc.stdout is not None
            async for raw in self._proc.stdout:
                line = raw.decode("utf-8", errors="replace").rstrip()
                collected.append(line)
                if len(collected) > 1000:
                    collected = collected[-1000:]
                lower = line.lower()
                if "error" in lower or "failed" in lower or "traceback" in lower:
                    self.ram_board.update(last_error=line, next_action="Inspect runner output.")
                    level = "error"
                elif "test" in lower:
                    self.ram_board.update(test_output=line)
                    level = "info"
                else:
                    level = "debug"
                event = self.ram_events.append(
                    "process_output",
                    line[:500],
                    level=level,
                    iteration_id=it.id,
                )
                await self.broadcast("ram_event", event)
                await self.broadcast(
                    "log",
                    {"iteration_id": it.id, "level": "stdout", "message": line},
                )
            rc = await self._proc.wait()
            output = "\n".join(collected[-400:])
            passed = rc == 0 and not self._panic_requested and not self._stop_requested
            status = ("stopped" if (self._panic_requested or self._stop_requested)
                      else ("passed" if rc == 0 else "failed"))
            commit_sha = None
            if passed:
                commits = self.repo.recent_commits(1)
                commit_sha = commits[0]["sha"] if commits else None
            files = self.repo.commit_files(commit_sha) if commit_sha else []
            self.finish_iteration(
                it.id,
                status,
                command_output=output,
                commit_sha=commit_sha,
                files_changed=files,
                failure_reason=None if passed else (
                    "user stopped" if self._stop_requested else
                    "panic stop" if self._panic_requested else
                    f"exit code {rc}"
                ),
            )
            self.ram_board.update(
                pid=None,
                last_error=None if passed else f"exit code {rc}",
                next_action="Ready for next iteration." if passed else "Review failure before continuing.",
            )
            await self.ram_event(
                "process_finished",
                f"Runner process exited with code {rc}",
                level="info" if passed else "error",
                iteration_id=it.id,
                data={"exit_code": rc},
            )
            result.update({
                "passed": passed, "status": status, "commit_sha": commit_sha,
                "exit_code": rc, "files_changed": files,
                "failure_reason": None if passed else f"exit code {rc}",
            })

            # ── Post-flight agent phase ──────────────────────────
            await self.agent_complete(
                "builder",
                output=output[-600:] if output else None,
                decision=("commit " + commit_sha[:8]) if commit_sha else (
                    "no commit produced" if passed else f"exit {rc}"
                ),
                success=passed,
                error=None if passed else f"exit {rc}",
            )

            # Reviewer + Debugger run validation post-iteration
            try:
                bp_snap = self.bp.snapshot()
            except Exception:
                bp_snap = {"checks": []}
            checks = bp_snap.get("checks", []) or []
            if checks:
                failed_checks = [c for c in checks if c.get("status") == "fail"]
                await self.agent_activate(
                    "reviewer",
                    f"Validate: {len(checks)} check{'s' if len(checks) != 1 else ''}",
                )
                await self.agent_complete(
                    "reviewer",
                    decision=(
                        f"{len(failed_checks)} failure"
                        f"{'s' if len(failed_checks) != 1 else ''}"
                        if failed_checks else "all checks clean"
                    ),
                    success=not failed_checks,
                    error=", ".join(c.get("name", "?") for c in failed_checks) or None,
                )
                if failed_checks:
                    first = failed_checks[0]
                    await self.agent_activate("debugger", f"Classify {first.get('name','?')}")
                    await self.agent_complete(
                        "debugger",
                        decision=f"{first.get('name','?')} failed: see runner output",
                        success=False,
                        error=(first.get("output", "") or "")[:240] or None,
                    )

            # Magpie + Tagger run on a successful commit
            if passed and commit_sha:
                await self.agent_activate(
                    "magpie",
                    f"Collect artifacts from {commit_sha[:8]}",
                )
                await self.agent_complete(
                    "magpie",
                    output=f"{len(files)} file{'s' if len(files) != 1 else ''} changed · sha={commit_sha[:8]}",
                    decision=f"Commit {commit_sha[:8]} captured",
                )

                tag = "feature"
                lower_files = [f.lower() for f in files]
                if any("test" in f for f in lower_files):
                    tag = "test"
                elif any(f.endswith(".md") or "readme" in f for f in lower_files):
                    tag = "docs"
                elif any("fix" in (it.summary or "").lower() for _ in [0]):
                    tag = "fix"
                await self.agent_activate("tagger", "Classify iteration")
                await self.agent_complete(
                    "tagger",
                    decision=f"Tagged as: {tag}",
                    output=f"{len(files)} files",
                )
        except Exception as exc:
            self.finish_iteration(it.id, "failed", failure_reason=str(exc))
            self.ram_board.update(pid=None, last_error=str(exc), next_action="Fix runner/backend error.")
            await self.ram_event("process_error", str(exc), level="error", iteration_id=it.id)
            await self.agent_complete("builder", error=str(exc), success=False)
            result["failure_reason"] = str(exc)
        finally:
            self._proc = None
            finished = self.store.get(it.id)
            if finished:
                await self.broadcast("iteration_finished", finished.to_dict())
        return result

    async def pause(self) -> dict:
        """Pause between iterations. The current subprocess (if any) keeps running."""
        if self.mode != "running":
            return {"ok": False, "reason": "not running"}
        self.mode = "paused"
        self._resume_event.clear()
        self.ram_board.update(loop_mode=self.mode, next_action="Resume or stop the loop.")
        await self.ram_event("loop_paused", "Loop paused (between iterations)")
        await self.broadcast("status", self.status())
        return {"ok": True}

    async def resume(self) -> dict:
        if self.mode != "paused":
            return {"ok": False, "reason": "not paused"}
        self.mode = "running"
        self._resume_event.set()
        self.ram_board.update(loop_mode=self.mode, next_action="Loop resumed.")
        await self.ram_event("loop_resumed", "Loop resumed")
        await self.broadcast("status", self.status())
        return {"ok": True}

    async def stop(self) -> dict:
        """Graceful stop: signal loop to exit + terminate current subprocess gently."""
        self._stop_requested = True
        self._resume_event.set()
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
        if self._loop_task and not self._loop_task.done():
            # Loop will exit at the next checkpoint.
            pass
        else:
            # No continuous loop — finalize any in-flight start_once iteration.
            if self.current_iter_id:
                self.finish_iteration(self.current_iter_id, "stopped", failure_reason="user stopped")
            self.mode = "stopped"
            self.stop_reason = self.stop_reason or "user_stop"
            self.ram_board.update(loop_mode=self.mode, pid=None, next_action="Stopped by user.")
            await self.ram_event("loop_stopped", "Loop stopped by user")
            await self.broadcast("status", self.status())
        return {"ok": True}

    async def panic(self) -> dict:
        """Hard stop: kill subprocess immediately and bail out of the loop."""
        self._panic_requested = True
        self._stop_requested = True
        self._resume_event.set()
        if self._proc:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        if self._loop_task and not self._loop_task.done():
            pass
        else:
            if self.current_iter_id:
                self.finish_iteration(self.current_iter_id, "stopped", failure_reason="panic stop")
            self.mode = "stopped"
            self.stop_reason = self.stop_reason or "panic"
            self.ram_board.update(loop_mode=self.mode, pid=None, last_error="panic stop",
                                  next_action="Inspect repo before restarting.")
            await self.ram_event("panic", "Panic stop triggered", level="error")
            await self.broadcast("status", self.status())
        return {"ok": True}

    def set_runner(self, runner: str, command: Optional[str] = None) -> dict:
        if runner not in RUNNERS:
            return {"ok": False, "reason": f"runner must be one of {RUNNERS}"}
        self.config.runner = runner
        if command is not None:
            self.config.runner_command = command or None
        self.ram_board.update(runner=self.config.runner, command=self.config.runner_command)
        self.ram_events.append(
            "runner_configured",
            f"Runner set to {self.config.runner}",
            data={"runner": self.config.runner, "command": self.config.runner_command},
        )
        return {"ok": True, "runner": self.config.runner, "runner_command": self.config.runner_command}

    def update_config(self, patch: dict) -> dict:
        self.config.apply(patch or {})
        self.ram_board.update(runner=self.config.runner, command=self.config.runner_command)
        self.ram_events.append(
            "loop_config_updated",
            "Loop config updated",
            data={"config": self.config.to_dict()},
        )
        return self.config.to_dict()

    def set_repo_path(self, new_path: str) -> dict:
        """Switch the watched repo at runtime.

        Refuses while a loop is mid-flight (mode != idle/stopped). Recreates
        every disk-bound inspector so the dashboard panels read from the new
        repo immediately.
        """
        if self.mode not in ("idle", "stopped"):
            return {"ok": False, "reason": f"loop is {self.mode}; stop it before switching repos"}
        if not isinstance(new_path, str) or not new_path.strip():
            return {"ok": False, "reason": "path is required"}
        try:
            resolved = Path(new_path).expanduser().resolve()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": f"could not resolve path: {exc}"}
        if not resolved.exists():
            return {"ok": False, "reason": f"path does not exist: {resolved}"}
        if not resolved.is_dir():
            return {"ok": False, "reason": f"path is not a directory: {resolved}"}

        self.repo = RepoInspector(resolved)
        self.plan = PlanParser(self.repo)
        self.specs = SpecCoverage(self.repo, self.plan)
        self.bp = Backpressure(self.repo)
        self.store = IterationStore(resolved / ".ralph" / "iterations.jsonl")
        self.guards = Guardrails(self.repo, self.store)

        self.ram_board.update(
            repo_path=str(self.repo.repo_path),
            next_action=f"Watching {self.repo.repo_path.name}. Configure runner or start an iteration.",
        )
        self.ram_events.append(
            "repo_changed",
            f"Repo path switched to {self.repo.repo_path}",
            data={"repo_path": str(self.repo.repo_path)},
        )
        return {"ok": True, "repo_path": str(self.repo.repo_path)}

    @staticmethod
    def runner_presets() -> list[dict]:
        """Return runner presets with availability/path/install hints."""
        out: list[dict] = []
        for pid in RUNNERS:
            exe = _runner_executable(pid)
            path = _which(exe)
            out.append({
                "id": pid,
                "name": {
                    "codex":      "Codex",
                    "claude":     "Claude Code",
                    "aider":      "Aider",
                    "openrouter": "OpenRouter (via aider)",
                    "custom":     "Custom",
                }[pid],
                "executable": exe,
                "command": _runner_preset_command(pid),
                "command_exists": bool(path) if exe else False,
                "command_path": path,
                "recommended_install": _runner_install_hint(pid),
            })
        return out

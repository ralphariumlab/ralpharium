"""
Ralpharium — backend smoke test.

Imports the controller directly (no HTTP, no FastAPI app), exercises every
RAM-side primitive plus repo-path resolution and aggregate composition, and
asserts the JSON shape the frontend depends on.

Usage:
    python backend/smoke_test.py
    py backend/smoke_test.py

Exit code 0 = OK, 1 = a check failed, 2 = unexpected error.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

# Make the backend package importable when run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ralph import RalphController, _process_memory  # noqa: E402


REQUIRED_RAM_KEYS = {
    "blackboard",
    "events",
    "event_stats",
    "scratchpad",
    "checkpoints",
    "memory_pressure",
    "process",
    "shared_segment",
}
REQUIRED_BLACKBOARD_SLOTS = {
    "loop_mode",
    "runner",
    "repo_path",
    "current_task",
    "next_action",
    "last_error",
    "last_commit",
    "test_output",
    "files_changed",
    "command",
    "pid",
}
REQUIRED_PRESSURE_KEYS = {
    "prompt_bytes",
    "plan_bytes",
    "agents_bytes",
    "specs_bytes",
    "prompt_context_bytes",
    "estimated_context_tokens",
    "repo_scan",
    "event_buffer_bytes",
    "process",
}
REQUIRED_PROCESS_KEYS = {"running", "pid", "command", "memory"}
REQUIRED_SEGMENT_KEYS = {
    "available",
    "name",
    "size",
    "used_bytes",
    "preview",
    "hex_preview",
    "updated_at",
    "error",
}


class SmokeError(AssertionError):
    pass


def must(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def must_have_keys(name: str, payload: dict, required: set[str]) -> None:
    missing = required - set(payload or {})
    if missing:
        raise SmokeError(f"{name} missing keys: {sorted(missing)}")


def banner(title: str) -> None:
    # ASCII only — Windows cp1252 console can't render box-drawing chars by default.
    print(f"\n-- {title} {'-' * max(0, 50 - len(title))}")


def main() -> int:
    repo = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="ralph_smoke_") as tmp:
        data_dir = Path(tmp)
        controller = RalphController(repo_path=repo, data_dir=data_dir)

        banner("ram_snapshot()")
        snap = controller.ram_snapshot()
        must_have_keys("ram_snapshot", snap, REQUIRED_RAM_KEYS)
        print("  keys ok:", ", ".join(sorted(snap)))

        banner("blackboard slots")
        slots = (snap.get("blackboard") or {}).get("slots") or {}
        must_have_keys("blackboard.slots", slots, REQUIRED_BLACKBOARD_SLOTS)
        print(f"  {len(slots)} slots present")

        banner("memory_pressure")
        mp = snap.get("memory_pressure") or {}
        must_have_keys("memory_pressure", mp, REQUIRED_PRESSURE_KEYS)
        scan = mp.get("repo_scan") or {}
        must_have_keys("memory_pressure.repo_scan", scan, {"bytes", "files_scanned", "truncated"})
        print(
            f"  prompt_context={mp['prompt_context_bytes']}B  "
            f"tokens~{mp['estimated_context_tokens']}  "
            f"scanned={scan.get('files_scanned')} files / "
            f"{scan.get('bytes')}B"
        )

        banner("process snapshot")
        proc = snap.get("process") or {}
        must_have_keys("process", proc, REQUIRED_PROCESS_KEYS)
        must(proc["running"] is False, "expected process.running == False before any loop")
        print(f"  running={proc['running']} pid={proc['pid']} cmd={proc['command']}")

        banner("shared memory segment")
        seg = snap.get("shared_segment") or {}
        must_have_keys("shared_segment", seg, REQUIRED_SEGMENT_KEYS)
        if seg.get("available"):
            must(seg.get("name") == "ralph_studio_blackboard", "unexpected segment name")
            must(seg.get("size", 0) > 0, "segment size must be > 0")
            print(
                f"  available=True name={seg['name']} size={seg['size']} "
                f"used={seg['used_bytes']} updated_at={seg['updated_at']}"
            )
        else:
            print(f"  segment unavailable on this platform (error={seg.get('error')!r})")

        banner("scratchpad add -> list -> clear")
        controller.ram_scratchpad.add("smoke note A", source="smoke", tags=["smoke"])
        controller.ram_scratchpad.add("smoke note B", source="smoke")
        notes = controller.ram_scratchpad.latest(10)
        must(len(notes) >= 2, "scratchpad should have 2 notes")
        must(notes[0]["text"].startswith("smoke note"), "first note shape unexpected")
        controller.ram_scratchpad.clear()
        must(controller.ram_scratchpad.latest() == [], "scratchpad clear failed")
        print("  add/list/clear ok")

        banner("checkpoint create -> list -> get")
        cp = controller.ram_checkpoints.create(controller.repo, controller.plan, label="smoke")
        must("id" in cp and "ts" in cp, "checkpoint missing id/ts")
        must("repo" in cp and "plan" in cp, "checkpoint missing repo/plan")
        must(cp["volatile"] is True, "checkpoint should be marked volatile")
        listed = controller.ram_checkpoints.latest()
        must(any(c["id"] == cp["id"] for c in listed), "checkpoint not in list")
        fetched = controller.ram_checkpoints.get(cp["id"])
        must(fetched is not None and fetched["id"] == cp["id"], "checkpoint get failed")
        print(f"  created/listed/fetched ok ({cp['id']})")

        banner("ram event ring buffer")
        before = controller.ram_events.stats()["count"]
        asyncio.run(controller.ram_event("smoke_test", "smoke event", level="debug"))
        after = controller.ram_events.stats()["count"]
        must(after == before + 1, "event ring did not record append")
        latest = controller.ram_events.latest(1)
        must(latest and latest[0]["kind"] == "smoke_test", "latest event kind mismatch")
        print(f"  ring count {before} -> {after}")

        banner("process_memory(unknown pid)")
        result = _process_memory(999_999_999)
        must(result["available"] is False, "_process_memory must report unavailable for bogus PID")
        print(f"  unavailable as expected ({result.get('error')!r})")

        banner("process_memory(0/None)")
        result0 = _process_memory(0)
        must(result0["available"] is False, "_process_memory(0) must be unavailable")
        result_none = _process_memory(None)  # type: ignore[arg-type]
        must(result_none["available"] is False, "_process_memory(None) must be unavailable")
        print("  None and 0 handled gracefully")

        banner("aggregate() composite")
        agg = controller.aggregate()
        must_have_keys(
            "aggregate",
            agg,
            {"status", "repo", "plan", "specs", "backpressure", "guardrails", "iterations", "ram"},
        )
        print(f"  routes covered: {', '.join(sorted(agg))}")

        banner("status payload contract")
        status = controller.status()
        must_have_keys(
            "status",
            status,
            {"mode", "runner", "runner_command", "repo_path", "branch", "dirty",
             "started_at", "uptime_seconds", "iteration_count", "current_iteration", "process"},
        )
        must(status["repo_path"] == str(repo), "status.repo_path must match controller repo_path")
        print(f"  mode={status['mode']}  repo_path={status['repo_path']}")

        banner("repo snapshot contract")
        repo_snap = controller.repo.snapshot()
        must_have_keys("repo", repo_snap, {"path", "exists", "is_git", "branch", "dirty", "commits", "files"})
        must_have_keys("repo.files", repo_snap["files"], {"prompt", "agents", "plan", "specs"})
        print(f"  is_git={repo_snap['is_git']}  files keys ok")

        banner("backpressure contract + git-clean gating")
        bp = controller.bp.snapshot()
        must_have_keys("backpressure", bp, {"checks", "all_clean", "last_run"})
        ids = {c["id"] for c in bp["checks"]}
        if not controller.repo.is_git():
            must("git-clean" not in ids,
                 "git-clean must NOT be exposed when repo is not a git repo")
            print(f"  non-git repo -> {len(ids)} checks (git-clean correctly hidden)")
        else:
            print(f"  git repo -> {len(ids)} checks: {sorted(ids)}")

        banner("scratchpad input validation")
        # Empty/whitespace text should not crash; just produces an empty-text note.
        # Add returns a dict regardless; the API layer is what enforces non-empty.
        nempty = controller.ram_scratchpad.add("", source="smoke")
        must("id" in nempty, "scratchpad.add returns a dict even for empty text")
        controller.ram_scratchpad.clear()
        print("  empty add did not crash (API layer enforces non-empty)")

        banner("cleanup")
        try:
            controller.ram_segment.close(unlink=True)
            print("  shared segment closed/unlinked")
        except Exception as exc:
            print(f"  segment close warning: {exc}")

    # ── Repo-path resolution: simulate launch from backend/ subdir ──
    banner("repo-path resolution (backend/ -> parent)")
    here = Path(__file__).resolve().parent  # backend/
    project_root = here.parent
    must((project_root / "frontend").is_dir(), "project root must contain frontend/")

    # Replicate main.py's _default_repo_path() logic from a backend/ cwd.
    saved_cwd = os.getcwd()
    try:
        os.chdir(here)
        cwd = Path(os.getcwd()).resolve()
        if cwd.name == "backend" and (cwd.parent / "frontend").is_dir():
            resolved = cwd.parent
        else:
            resolved = cwd
        must(resolved == project_root.resolve(),
             f"cwd=backend/ should resolve to project root, got {resolved}")
        print(f"  cwd=backend/ -> resolved={resolved}")
    finally:
        os.chdir(saved_cwd)

    # Run from project root
    saved_cwd = os.getcwd()
    try:
        os.chdir(project_root)
        cwd = Path(os.getcwd()).resolve()
        if cwd.name == "backend" and (cwd.parent / "frontend").is_dir():
            resolved = cwd.parent
        else:
            resolved = cwd
        must(resolved == project_root.resolve(),
             f"cwd=root/ should resolve to project root, got {resolved}")
        print(f"  cwd=root/    -> resolved={resolved}")
    finally:
        os.chdir(saved_cwd)

    banner("RALPH_REPO_PATH override wins")
    with tempfile.TemporaryDirectory() as tmp:
        env_path = Path(tmp).resolve()
        env_value = os.environ.get("RALPH_REPO_PATH")
        os.environ["RALPH_REPO_PATH"] = str(env_path)
        try:
            # Mirror main.py logic
            cwd = Path(os.getcwd()).resolve()
            default = cwd.parent if cwd.name == "backend" and (cwd.parent / "frontend").is_dir() else cwd
            resolved = Path(os.environ.get("RALPH_REPO_PATH", str(default))).resolve()
            must(resolved == env_path,
                 f"RALPH_REPO_PATH must override default; got {resolved}, expected {env_path}")
            print(f"  override -> {resolved}")
        finally:
            if env_value is None:
                os.environ.pop("RALPH_REPO_PATH", None)
            else:
                os.environ["RALPH_REPO_PATH"] = env_value

    print("\nSMOKE: OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeError as exc:
        print(f"\nSMOKE: FAIL — {exc}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:  # pragma: no cover
        import traceback
        traceback.print_exc()
        print(f"\nSMOKE: ERROR — {exc!r}", file=sys.stderr)
        raise SystemExit(2)

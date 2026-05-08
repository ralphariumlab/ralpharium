"""
Ralpharium — FastAPI server.

Serves the static frontend, exposes a control-plane REST API, and broadcasts
loop state over a single WebSocket. The actual logic lives in `ralph.py`.

Environment:
    RALPH_REPO_PATH    — repo to inspect (default: current working directory)
    RALPH_DATA_DIR     — where iterations.jsonl lives (default: <repo>/.ralph)
    RALPH_RUNNER       — codex | claude | aider | custom (default: claude)
    RALPH_RUNNER_CMD   — shell command Ralph runs each iteration (optional)
    PORT               — default 3000
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import uvicorn

sys.path.insert(0, str(Path(__file__).parent))
from ralph import RalphController  # noqa: E402

app = FastAPI(title="Ralpharium", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _default_repo_path() -> Path:
    """Resolve the repo being inspected.

    Default to the user's current directory, but handle the common dev mistake of
    launching from this backend folder by stepping up to the project root.
    """
    cwd = Path(os.getcwd()).resolve()
    if cwd.name == "backend" and (cwd.parent / "frontend").is_dir():
        return cwd.parent
    return cwd


REPO_PATH = Path(os.environ.get("RALPH_REPO_PATH", str(_default_repo_path()))).resolve()
DEFAULT_DATA_DIR = REPO_PATH / ".ralph"
DATA_DIR = Path(os.environ.get("RALPH_DATA_DIR", str(DEFAULT_DATA_DIR))).resolve()
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

controller = RalphController(REPO_PATH, DATA_DIR)


# ── WebSocket ─────────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    controller.register_ws(ws)
    client = getattr(ws, "client", None)
    client_label = f"{client.host}:{client.port}" if client else "unknown"
    try:
        await controller.ram_event(
            "ws_connect",
            f"WebSocket client connected ({client_label})",
            level="debug",
            data={"clients": len(controller._ws_clients)},
        )
        await ws.send_text(json.dumps({"type": "snapshot", "data": controller.aggregate()}))
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            action = msg.get("action", "")

            if action == "start":
                r = await controller.start()
                await ws.send_text(json.dumps({"type": "ack", "action": "start", "data": r}))
            elif action == "start_once":
                r = await controller.start_once()
                await ws.send_text(json.dumps({"type": "ack", "action": "start_once", "data": r}))
            elif action == "loop_config":
                patch = msg.get("config") or {}
                updated = controller.update_config(patch)
                await controller.broadcast("status", controller.status())
                await ws.send_text(json.dumps({"type": "ack", "action": "loop_config", "data": updated}))
            elif action == "pause":
                r = await controller.pause()
                await ws.send_text(json.dumps({"type": "ack", "action": "pause", "data": r}))
            elif action == "resume":
                r = await controller.resume()
                await ws.send_text(json.dumps({"type": "ack", "action": "resume", "data": r}))
            elif action == "stop":
                r = await controller.stop()
                await ws.send_text(json.dumps({"type": "ack", "action": "stop", "data": r}))
            elif action == "panic":
                r = await controller.panic()
                await ws.send_text(json.dumps({"type": "ack", "action": "panic", "data": r}))
            elif action == "run_check":
                check_id = msg.get("check", "")
                if check_id:
                    asyncio.create_task(_run_check_and_broadcast(check_id))
                    await ws.send_text(json.dumps({"type": "ack", "action": "run_check", "data": {"id": check_id}}))
            elif action == "refresh":
                await ws.send_text(json.dumps({"type": "snapshot", "data": controller.aggregate()}))
            elif action == "ram_snapshot":
                await ws.send_text(json.dumps({"type": "ram", "data": controller.ram_snapshot()}))
            elif action == "ram_checkpoint":
                label = msg.get("label", "websocket")
                checkpoint = controller.ram_checkpoints.create(controller.repo, controller.plan, label)
                await controller.ram_event("checkpoint", f"RAM checkpoint created: {label}", data={"id": checkpoint["id"]})
                await ws.send_text(json.dumps({"type": "ram_checkpoint", "data": checkpoint}))
            elif action == "set_runner":
                runner = msg.get("runner", controller.runner)
                command = msg.get("command")
                r = controller.set_runner(runner, command)
                await ws.send_text(json.dumps({"type": "ack", "action": "set_runner", "data": r}))
                await controller.broadcast("status", controller.status())
            elif action == "set_repo":
                path = msg.get("path", "")
                r = controller.set_repo_path(str(path))
                await ws.send_text(json.dumps({"type": "ack", "action": "set_repo", "data": r}))
                if r.get("ok"):
                    await controller.broadcast("snapshot", controller.aggregate())
            elif action == "scratchpad_add":
                text = msg.get("text", "")
                if isinstance(text, str) and text.strip():
                    note = controller.ram_scratchpad.add(text.strip(), source=msg.get("source", "user"))
                    await controller.ram_event("scratchpad", f"note added: {text[:80]}", data={"id": note["id"]})
                    await controller.broadcast("ram", controller.ram_snapshot())
    except WebSocketDisconnect:
        pass
    except Exception:
        # swallow; client may have died mid-message
        pass
    finally:
        controller.remove_ws(ws)
        try:
            await controller.ram_event(
                "ws_disconnect",
                f"WebSocket client disconnected ({client_label})",
                level="debug",
                data={"clients": len(controller._ws_clients)},
            )
        except Exception:
            pass


async def _run_check_and_broadcast(check_id: str) -> None:
    res = await controller.bp.run_check(check_id)
    controller.ram_board.update(
        test_output=(res.get("output") or "")[-1200:],
        last_error=(res.get("output") or "")[-500:] if res.get("status") == "failed" else None,
        next_action="Fix failing check before continuing." if res.get("status") == "failed" else "Validation check completed.",
    )
    await controller.ram_event(
        "validation",
        f"{check_id} {res.get('status', 'unknown')}",
        level="error" if res.get("status") == "failed" else "info",
        data=res,
    )
    await controller.broadcast("backpressure", controller.bp.snapshot())
    await controller.broadcast("check_result", res)


# ── REST: read endpoints ──────────────────────────────────────────────
@app.get("/api/status")
async def api_status():
    return controller.status()


@app.get("/api/repo-state")
async def api_repo():
    return controller.repo.snapshot()


@app.get("/api/plan-health")
async def api_plan():
    return controller.plan.parse()


@app.get("/api/spec-coverage")
async def api_specs():
    return controller.specs.map()


@app.get("/api/backpressure")
async def api_bp():
    return controller.bp.snapshot()


@app.get("/api/guardrails")
async def api_guards():
    return controller.guards.snapshot()


@app.get("/api/iterations")
async def api_iters(limit: int = 50):
    n = max(1, min(500, int(limit)))
    return {"iterations": [it.to_dict() for it in controller.store.latest(n)]}


@app.get("/api/iterations/{iter_id}")
async def api_iter_detail(iter_id: str):
    it = controller.store.get(iter_id)
    if not it:
        raise HTTPException(status_code=404, detail="iteration not found")
    return it.to_dict()


@app.get("/api/state")
async def api_state():
    """Aggregate snapshot used by the dashboard's first paint."""
    return controller.aggregate()


@app.get("/api/ram")
async def api_ram():
    """Full volatile RAM observability snapshot."""
    return controller.ram_snapshot()


@app.get("/api/ram/events")
async def api_ram_events(limit: int = 100, since: float | None = None):
    n = max(1, min(500, int(limit)))
    return {
        "events": controller.ram_events.latest(n, since),
        "stats": controller.ram_events.stats(),
    }


@app.get("/api/ram/blackboard")
async def api_ram_blackboard():
    return controller.ram_board.snapshot()


@app.get("/api/agents")
async def api_agents():
    """Live snapshot of all 8 specialized Ralpharium agents."""
    return controller.agents.snapshot()


@app.get("/api/agents/{agent_id}")
async def api_agent_detail(agent_id: str):
    snap = controller.agents.snapshot_agent(agent_id)
    if not snap:
        raise HTTPException(status_code=404, detail=f"unknown agent: {agent_id}")
    return snap


@app.get("/api/thrash")
async def api_thrash():
    """Detect repeat-failure patterns across recent iterations."""
    return controller.detect_thrash()


@app.get("/api/ram/pressure")
async def api_ram_pressure():
    return controller.memory_pressure()


@app.get("/api/ram/memory")
async def api_ram_memory_alias():
    return controller.memory_pressure()


@app.get("/api/ram/process")
async def api_ram_process():
    return controller.process_snapshot()


@app.get("/api/ram/shared-segment")
async def api_ram_shared_segment():
    controller.ram_segment.write(
        {
            "blackboard": controller.ram_board.snapshot(),
            "process": controller.process_snapshot(),
            "event_stats": controller.ram_events.stats(),
        }
    )
    return controller.ram_segment.snapshot()


@app.get("/api/ram/scratchpad")
async def api_ram_scratchpad(limit: int = 50):
    return {"notes": controller.ram_scratchpad.latest(limit)}


@app.post("/api/ram/scratchpad")
async def api_ram_scratchpad_add(data: dict):
    text = str(data.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    tags = data.get("tags")
    note = controller.ram_scratchpad.add(
        text,
        source=str(data.get("source", "api")),
        tags=tags if isinstance(tags, list) else [],
    )
    await controller.ram_event("scratchpad", "Scratchpad note added", data={"id": note["id"]})
    await controller.broadcast("ram", controller.ram_snapshot())
    return note


@app.delete("/api/ram/scratchpad")
async def api_ram_scratchpad_clear():
    controller.ram_scratchpad.clear()
    await controller.ram_event("scratchpad", "Scratchpad cleared")
    await controller.broadcast("ram", controller.ram_snapshot())
    return {"ok": True}


@app.get("/api/ram/checkpoints")
async def api_ram_checkpoints(limit: int = 20):
    return {"checkpoints": controller.ram_checkpoints.latest(limit)}


@app.get("/api/ram/checkpoints/{checkpoint_id}")
async def api_ram_checkpoint_detail(checkpoint_id: str):
    checkpoint = controller.ram_checkpoints.get(checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=404, detail="checkpoint not found")
    return checkpoint


@app.post("/api/ram/checkpoints")
async def api_ram_checkpoint_create(data: dict | None = None):
    label = "manual"
    if data:
        label = str(data.get("label", label))
    checkpoint = controller.ram_checkpoints.create(controller.repo, controller.plan, label)
    await controller.ram_event(
        "checkpoint",
        f"RAM checkpoint created: {label}",
        data={"id": checkpoint["id"]},
    )
    await controller.broadcast("ram", controller.ram_snapshot())
    return checkpoint


# ── REST: write endpoints ─────────────────────────────────────────────
@app.get("/api/loop/config")
async def api_loop_config_get():
    return controller.config.to_dict()


@app.patch("/api/loop/config")
async def api_loop_config_patch(data: dict):
    updated = controller.update_config(data or {})
    await controller.broadcast("status", controller.status())
    return updated


@app.post("/api/repo-path")
async def api_set_repo_path(data: dict):
    """Switch which directory Ralpharium watches at runtime."""
    res = controller.set_repo_path(str(data.get("path", "")))
    if res.get("ok"):
        await controller.broadcast("snapshot", controller.aggregate())
    return res


@app.get("/api/runners")
async def api_runners():
    return {
        "runners": controller.runner_presets(),
        "selected": controller.config.runner,
        "runner_command": controller.config.runner_command,
    }


@app.post("/api/loop/start")
async def loop_start():
    return await controller.start()


@app.post("/api/loop/start-once")
async def loop_start_once():
    return await controller.start_once()


@app.post("/api/loop/pause")
async def loop_pause():
    return await controller.pause()


@app.post("/api/loop/resume")
async def loop_resume():
    return await controller.resume()


@app.post("/api/loop/stop")
async def loop_stop():
    return await controller.stop()


@app.post("/api/loop/panic")
async def loop_panic():
    return await controller.panic()


@app.post("/api/check/{check_id}")
async def run_check(check_id: str):
    res = await controller.bp.run_check(check_id)
    controller.ram_board.update(
        test_output=(res.get("output") or "")[-1200:],
        last_error=(res.get("output") or "")[-500:] if res.get("status") == "failed" else None,
        next_action="Fix failing check before continuing." if res.get("status") == "failed" else "Validation check completed.",
    )
    await controller.ram_event(
        "validation",
        f"{check_id} {res.get('status', 'unknown')}",
        level="error" if res.get("status") == "failed" else "info",
        data=res,
    )
    await controller.broadcast("backpressure", controller.bp.snapshot())
    return res


@app.post("/api/iterations")
async def post_iter(data: dict):
    """External CLI hook — start an iteration. Returns the new iteration."""
    it = controller.begin_iteration(
        mode=data.get("mode", "build"),
        prompt_mode=data.get("prompt_mode"),
        runner=data.get("runner"),
    )
    if data.get("summary"):
        it.summary = str(data["summary"])
        controller.ram_board.update(current_task=it.summary)
    await controller.broadcast("iteration_started", it.to_dict())
    await controller.broadcast("ram", controller.ram_snapshot())
    return it.to_dict()


@app.patch("/api/iterations/{iter_id}")
async def patch_iter(iter_id: str, data: dict):
    """External CLI hook — update or finish an iteration."""
    fields = {
        k: v
        for k, v in data.items()
        if k
        in {
            "summary",
            "files_changed",
            "commit_sha",
            "test_status",
            "command_output",
            "validation",
            "failure_reason",
            "plan_diff",
        }
    }
    status = data.get("status")
    if status:
        it = controller.finish_iteration(iter_id, status, **fields)
    else:
        # partial update without finishing
        existing = controller.store.get(iter_id)
        if not existing:
            raise HTTPException(status_code=404, detail="iteration not found")
        for k, v in fields.items():
            if v is not None:
                setattr(existing, k, v)
        controller.store.update(existing)
        it = existing
    if not it:
        raise HTTPException(status_code=404, detail="iteration not found")
    controller.ram_board.update(
        files_changed=it.files_changed,
        last_commit=it.commit_sha,
        test_output=(it.command_output or "")[-1200:] or None,
        last_error=it.failure_reason,
    )
    await controller.broadcast("iteration_updated", it.to_dict())
    await controller.broadcast("ram", controller.ram_snapshot())
    return it.to_dict()


@app.post("/api/runner")
async def set_runner(data: dict):
    runner = data.get("runner", controller.runner)
    command = data.get("command")
    res = controller.set_runner(runner, command)
    await controller.broadcast("status", controller.status())
    return res


# ── Static / pages ────────────────────────────────────────────────────
@app.get("/")
async def page_index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/dashboard")
async def page_dash():
    return FileResponse(FRONTEND_DIR / "dashboard.html")


@app.get("/tech")
async def page_tech():
    return FileResponse(FRONTEND_DIR / "tech.html")


@app.get("/ram")
async def page_ram():
    return FileResponse(FRONTEND_DIR / "ram.html")


@app.get("/{path:path}")
async def serve_static(path: str):
    fp = FRONTEND_DIR / path
    if fp.is_file():
        return FileResponse(fp)
    raise HTTPException(status_code=404, detail="not found")


# ── Lifecycle ─────────────────────────────────────────────────────────
@app.on_event("shutdown")
async def shutdown():
    if controller._proc:
        try:
            controller._proc.kill()
        except ProcessLookupError:
            pass
    controller.ram_segment.close(unlink=True)


def main() -> None:
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False, log_level="info")


if __name__ == "__main__":
    main()

import argparse
import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import websockets
from cloud_agent_contracts import AgentRun


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _session_path() -> Path:
    return Path("var/.agent_cli_session.json")


def _load_session() -> dict[str, Any]:
    session_file = _session_path()
    if not session_file.exists():
        return {}
    try:
        return json.loads(session_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _save_session(data: dict[str, Any]) -> None:
    session_file = _session_path()
    session_file.parent.mkdir(parents=True, exist_ok=True)
    session_file.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _resolve_run_id(explicit_run_id: str | None) -> UUID:
    if explicit_run_id:
        return UUID(explicit_run_id)
    session = _load_session()
    last_run_id = session.get("last_run_id")
    if not isinstance(last_run_id, str):
        raise ValueError("no run_id provided and no prior session run_id found")
    return UUID(last_run_id)


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, sort_keys=True))


async def _create_run(base_url: str, prompt: str) -> AgentRun:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        response = await client.post("/v1/runs", json={"prompt": prompt})
        response.raise_for_status()
        payload = response.json()
        return AgentRun.model_validate(payload)


async def _submit_follow_up(base_url: str, run_id: UUID, prompt: str) -> AgentRun:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        response = await client.post(
            f"/v1/runs/{run_id}/follow-up",
            json={"prompt": prompt},
        )
        response.raise_for_status()
        payload = response.json()
        return AgentRun.model_validate(payload)


async def _request_cancel(base_url: str, run_id: UUID, reason: str | None) -> AgentRun:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        response = await client.post(
            f"/v1/runs/{run_id}/cancel",
            json={"reason": reason},
        )
        response.raise_for_status()
        payload = response.json()
        return AgentRun.model_validate(payload)


async def _list_events(base_url: str, run_id: UUID) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        response = await client.get(f"/v1/runs/{run_id}/events")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("events endpoint returned non-list payload")
        return payload


async def _get_run(base_url: str, run_id: UUID) -> AgentRun:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        response = await client.get(f"/v1/runs/{run_id}")
        response.raise_for_status()
        payload = response.json()
        return AgentRun.model_validate(payload)


async def _watch_stream(base_url: str, run_id: UUID, from_sequence: int) -> int:
    ws_url = base_url.replace("http://", "ws://").replace("https://", "wss://")
    ws_url = f"{ws_url}/v1/runs/{run_id}/stream?from_sequence={from_sequence}"
    last_sequence = from_sequence - 1
    async with websockets.connect(ws_url) as websocket:
        async for raw_message in websocket:
            message = json.loads(raw_message)
            message_type = message.get("type")
            if message_type == "event":
                event = message.get("event", {})
                sequence = event.get("sequence")
                event_type = event.get("type")
                payload = event.get("payload")
                print(f"[event #{sequence}] {event_type} payload={payload}")
                if isinstance(sequence, int):
                    last_sequence = max(last_sequence, sequence)
            elif message_type == "progress":
                progress = message.get("progress", {})
                state = progress.get("state")
                turn = progress.get("turn")
                queue_depth = progress.get("queue_depth")
                waiting = progress.get("waiting_for_follow_up")
                cancel_requested = progress.get("cancellation_requested")
                print(
                    "[progress] "
                    f"state={state} turn={turn} queue_depth={queue_depth} "
                    f"waiting_for_follow_up={waiting} cancel_requested={cancel_requested}"
                )
            elif message_type == "run":
                run_payload = message.get("run", {})
                status = run_payload.get("status")
                print(f"[run] status={status}")
                if status in {"succeeded", "failed", "cancelled"}:
                    break
            else:
                print(f"[{message_type}] {message}")
    return last_sequence


def _append_history(session: dict[str, Any], entry: dict[str, Any]) -> None:
    history = session.get("history")
    if not isinstance(history, list):
        history = []
    history.append(entry)
    session["history"] = history[-50:]


def _update_session_run(session: dict[str, Any], run: AgentRun) -> None:
    session["last_run_id"] = str(run.id)
    session["last_status"] = run.status.value
    session["last_updated_at"] = _utc_now_iso()


async def _interactive_loop(base_url: str, initial_run: AgentRun, watch_from: int) -> None:
    current_run = initial_run
    next_sequence = watch_from
    session = _load_session()
    _update_session_run(session, current_run)
    _append_history(
        session,
        {
            "at": _utc_now_iso(),
            "action": "start",
            "run_id": str(current_run.id),
            "status": current_run.status.value,
        },
    )
    _save_session(session)

    while True:
        next_sequence = (await _watch_stream(base_url, current_run.id, next_sequence)) + 1
        current_run = await _get_run(base_url, current_run.id)
        _update_session_run(session, current_run)
        _save_session(session)
        events = await _list_events(base_url, current_run.id)
        _print_json({"run_id": str(current_run.id), "events": events[-5:]})
        if current_run.status.value in {"succeeded", "failed", "cancelled"}:
            print("run is terminal; exiting interactive loop")
            return

        action = input("Action? [f=follow-up, c=cancel, r=refresh, q=quit] ").strip().lower()
        if action == "q":
            return
        if action == "r":
            continue
        if action == "f":
            prompt = input("Follow-up prompt: ").strip()
            if not prompt:
                print("skipping empty follow-up")
                continue
            current_run = await _submit_follow_up(base_url, current_run.id, prompt)
            _update_session_run(session, current_run)
            _append_history(
                session,
                {
                    "at": _utc_now_iso(),
                    "action": "follow_up",
                    "run_id": str(current_run.id),
                    "prompt": prompt,
                },
            )
            _save_session(session)
            continue
        if action == "c":
            reason = input("Cancel reason (optional): ").strip() or None
            current_run = await _request_cancel(base_url, current_run.id, reason)
            _update_session_run(session, current_run)
            _append_history(
                session,
                {
                    "at": _utc_now_iso(),
                    "action": "cancel",
                    "run_id": str(current_run.id),
                    "reason": reason,
                },
            )
            _save_session(session)
            continue
        print(f"unknown action: {action}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Cloud agent run CLI")
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000",
        help="API base URL",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="start a new run")
    start.add_argument("prompt", help="initial run prompt")
    start.add_argument(
        "--watch",
        action="store_true",
        help="watch stream and open interactive follow-up/cancel loop",
    )

    watch = subparsers.add_parser("watch", help="watch a run stream")
    watch.add_argument("--run-id", help="run ID (defaults to last session run)")
    watch.add_argument("--from-sequence", type=int, default=1, help="starting event sequence")

    follow_up = subparsers.add_parser("follow-up", help="submit follow-up prompt")
    follow_up.add_argument("--run-id", help="run ID (defaults to last session run)")
    follow_up.add_argument("prompt", help="follow-up prompt text")

    cancel = subparsers.add_parser("cancel", help="request run cancellation")
    cancel.add_argument("--run-id", help="run ID (defaults to last session run)")
    cancel.add_argument("--reason", help="optional cancel reason")

    events = subparsers.add_parser("events", help="list run events")
    events.add_argument("--run-id", help="run ID (defaults to last session run)")

    return parser


async def _run(args: argparse.Namespace) -> None:
    base_url = args.base_url.rstrip("/")
    session = _load_session()

    if args.command == "start":
        run = await _create_run(base_url, args.prompt)
        _update_session_run(session, run)
        _append_history(
            session,
            {"at": _utc_now_iso(), "action": "start", "run_id": str(run.id), "prompt": args.prompt},
        )
        _save_session(session)
        _print_json(run.model_dump(mode="json"))
        if args.watch:
            await _interactive_loop(base_url, run, watch_from=1)
        return

    if args.command == "watch":
        run_id = _resolve_run_id(args.run_id)
        await _watch_stream(base_url, run_id, args.from_sequence)
        return

    if args.command == "follow-up":
        run_id = _resolve_run_id(args.run_id)
        run = await _submit_follow_up(base_url, run_id, args.prompt)
        _update_session_run(session, run)
        _append_history(
            session,
            {
                "at": _utc_now_iso(),
                "action": "follow_up",
                "run_id": str(run.id),
                "prompt": args.prompt,
            },
        )
        _save_session(session)
        _print_json(run.model_dump(mode="json"))
        return

    if args.command == "cancel":
        run_id = _resolve_run_id(args.run_id)
        run = await _request_cancel(base_url, run_id, args.reason)
        _update_session_run(session, run)
        _append_history(
            session,
            {
                "at": _utc_now_iso(),
                "action": "cancel",
                "run_id": str(run.id),
                "reason": args.reason,
            },
        )
        _save_session(session)
        _print_json(run.model_dump(mode="json"))
        return

    if args.command == "events":
        run_id = _resolve_run_id(args.run_id)
        events = await _list_events(base_url, run_id)
        _print_json(events)
        return

    raise ValueError(f"unsupported command: {args.command}")


def main(argv: Sequence[str] | None = None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()

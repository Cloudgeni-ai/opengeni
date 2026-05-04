import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from infra_agent_api import create_app
from infra_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    RunEvent,
)
from infra_agent_platform.config import Settings
from infra_agent_platform.errors import DispatchError, RunNotFoundError
from infra_agent_platform.temporal.contracts import WorkflowRunProgress


@dataclass
class _StubDispatcher:
    should_error: bool = False
    last_follow_up: tuple[str, str] | None = None
    last_cancel: tuple[str, str | None] | None = None

    async def dispatch(self, run: AgentRun) -> str:
        return f"workflow-{run.id}"

    async def submit_follow_up(self, workflow_id: str, prompt: str) -> None:
        if self.should_error:
            raise DispatchError("follow-up failed")
        self.last_follow_up = (workflow_id, prompt)

    async def request_cancel(self, workflow_id: str, reason: str | None = None) -> None:
        if self.should_error:
            raise DispatchError("cancel failed")
        self.last_cancel = (workflow_id, reason)

    async def query_progress(self, workflow_id: str) -> WorkflowRunProgress:
        return WorkflowRunProgress(
            run_id=workflow_id,
            state="waiting",
            turn=1,
            queue_depth=0,
            cancellation_requested=False,
            waiting_for_follow_up=True,
            last_output="ok",
        )


class _StreamingRepo:
    def __init__(self) -> None:
        self._runs: dict[UUID, AgentRun] = {}
        self._events: dict[UUID, list[RunEvent]] = {}

    async def create_run(self, request: AgentRunCreate) -> AgentRun:
        raise NotImplementedError

    async def mark_dispatched(self, run_id: UUID, workflow_id: str) -> AgentRun:
        raise NotImplementedError

    async def get_run(self, run_id: UUID) -> AgentRun:
        run = self._runs.get(run_id)
        if run is None:
            raise RunNotFoundError(str(run_id))
        return run

    async def set_run_status(self, run_id: UUID, status: AgentRunStatus) -> AgentRun:
        run = await self.get_run(run_id)
        updated = run.model_copy(update={"status": status})
        self._runs[run_id] = updated
        return updated

    async def append_event(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent:
        run = await self.get_run(run_id)
        events = self._events.setdefault(run.id, [])
        event = RunEvent(
            id=UUID(int=len(events) + 1),
            run_id=run.id,
            sequence=len(events) + 1,
            type=event_type,
            payload=payload or {},
            created_at=run.created_at,
        )
        events.append(event)
        return event

    async def list_events(self, run_id: UUID) -> tuple[RunEvent, ...]:
        await self.get_run(run_id)
        return tuple(self._events.get(run_id, ()))

    def seed_run(self, run: AgentRun, events: list[RunEvent]) -> None:
        self._runs[run.id] = run
        self._events[run.id] = list(events)


def _seed_waiting_run(repository: _StreamingRepo) -> tuple[UUID, AgentRun]:
    run_id = uuid4()
    run = AgentRun(
        id=run_id,
        status=AgentRunStatus.WAITING,
        prompt="initial",
        resources=[],
        metadata={},
        temporal_workflow_id=f"workflow-{run_id}",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    repository.seed_run(
        run,
        [
            RunEvent(
                id=uuid4(),
                run_id=run_id,
                sequence=1,
                type=EventType.RUN_CREATED,
                payload={"status": "queued"},
                created_at=datetime.now(UTC),
            )
        ],
    )
    return run_id, run


def test_follow_up_and_cancel_routes_to_dispatcher() -> None:
    repository = _StreamingRepo()
    run_id, run = _seed_waiting_run(repository)
    dispatcher = _StubDispatcher()
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=repository,
        dispatcher=dispatcher,
    )

    with TestClient(app) as client:
        follow_up = client.post(f"/v1/runs/{run_id}/follow-up", json={"prompt": "continue"})
        assert follow_up.status_code == 200
        assert dispatcher.last_follow_up == (f"workflow-{run_id}", "continue")

        cancel = client.post(f"/v1/runs/{run_id}/cancel", json={"reason": "stop"})
        assert cancel.status_code == 200
        assert dispatcher.last_cancel == (f"workflow-{run_id}", "stop")


def test_websocket_stream_replays_events_and_progress() -> None:
    repository = _StreamingRepo()
    dispatcher = _StubDispatcher()
    run_id = uuid4()
    run = AgentRun(
        id=run_id,
        status=AgentRunStatus.WAITING,
        prompt="initial",
        resources=[],
        metadata={},
        temporal_workflow_id=f"workflow-{run_id}",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    repository.seed_run(
        run,
        [
            RunEvent(
                id=uuid4(),
                run_id=run_id,
                sequence=1,
                type=EventType.RUN_CREATED,
                payload={"status": "queued"},
                created_at=datetime.now(UTC),
            ),
            RunEvent(
                id=uuid4(),
                run_id=run_id,
                sequence=2,
                type=EventType.RUN_FOLLOW_UP,
                payload={"status": "waiting"},
                created_at=datetime.now(UTC),
            ),
        ],
    )
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            api_event_poll_seconds=0.1,
        ),
        repository=repository,
        dispatcher=dispatcher,
    )

    with TestClient(app) as client:
        def _set_terminal() -> None:
            # Ensure stream loop runs at least one iteration before terminal status.
            import time

            time.sleep(0.15)
            repository._runs[run_id] = run.model_copy(update={"status": AgentRunStatus.SUCCEEDED})

        timer = threading.Thread(target=_set_terminal)
        timer.start()
        with client.websocket_connect(f"/v1/runs/{run_id}/stream?from_sequence=2") as websocket:
            first = websocket.receive_json()
            second = websocket.receive_json()
            third = websocket.receive_json()
            assert first["type"] == "run"
            assert second["type"] == "event"
            assert second["event"]["sequence"] == 2
            assert third["type"] == "progress"
        timer.join()

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from cloud_agent_contracts import AgentRun, AgentRunCreate, AgentRunStatus, EventType, RunEvent

from cloud_agent_platform.errors import RunNotFoundError


def _utcnow() -> datetime:
    return datetime.now(UTC)


class InMemoryRunRepository:
    def __init__(self) -> None:
        self._runs: dict[UUID, AgentRun] = {}
        self._events: dict[UUID, list[RunEvent]] = {}

    async def create_run(self, request: AgentRunCreate) -> AgentRun:
        now = _utcnow()
        run = AgentRun(
            id=uuid4(),
            status=AgentRunStatus.QUEUED,
            prompt=request.prompt,
            resource=request.resource,
            metadata=request.metadata,
            created_at=now,
            updated_at=now,
        )
        self._runs[run.id] = run
        self._events[run.id] = [
            RunEvent(
                id=uuid4(),
                run_id=run.id,
                sequence=1,
                type=EventType.RUN_CREATED,
                payload={"status": run.status.value},
                created_at=now,
            )
        ]
        return run

    async def get_run(self, run_id: UUID) -> AgentRun:
        try:
            return self._runs[run_id]
        except KeyError as exc:
            raise RunNotFoundError(str(run_id)) from exc

    async def mark_dispatched(self, run_id: UUID, workflow_id: str) -> AgentRun:
        run = await self.get_run(run_id)
        updated = run.model_copy(
            update={
                "status": AgentRunStatus.DISPATCHED,
                "temporal_workflow_id": workflow_id,
                "updated_at": _utcnow(),
            }
        )
        self._runs[run_id] = updated
        await self.append_event(
            run_id,
            EventType.RUN_DISPATCHED,
            {"workflow_id": workflow_id, "status": AgentRunStatus.DISPATCHED.value},
        )
        return updated

    async def append_event(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent:
        await self.get_run(run_id)
        events = self._events.setdefault(run_id, [])
        event = RunEvent(
            id=uuid4(),
            run_id=run_id,
            sequence=len(events) + 1,
            type=event_type,
            payload=payload or {},
            created_at=_utcnow(),
        )
        events.append(event)
        return event

    async def list_events(self, run_id: UUID) -> tuple[RunEvent, ...]:
        await self.get_run(run_id)
        return tuple(self._events.get(run_id, ()))

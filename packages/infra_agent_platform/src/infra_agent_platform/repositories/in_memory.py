from typing import Any
from uuid import UUID, uuid4

from infra_agent_contracts import AgentRun, AgentRunCreate, AgentRunStatus, EventType, RunEvent

from infra_agent_platform.errors import RunNotFoundError
from infra_agent_platform.repositories.lifecycle import (
    dispatched_run_lifecycle,
    queued_run_lifecycle,
    utcnow,
)


class InMemoryRunRepository:
    def __init__(self) -> None:
        self._runs: dict[UUID, AgentRun] = {}
        self._events: dict[UUID, list[RunEvent]] = {}

    async def create_run(self, request: AgentRunCreate) -> AgentRun:
        lifecycle = queued_run_lifecycle()
        run = AgentRun(
            id=uuid4(),
            status=lifecycle.status,
            prompt=request.prompt,
            resources=request.resources,
            metadata=request.metadata,
            created_at=lifecycle.updated_at,
            updated_at=lifecycle.updated_at,
        )
        self._runs[run.id] = run
        self._events[run.id] = [
            RunEvent(
                id=uuid4(),
                run_id=run.id,
                sequence=1,
                type=lifecycle.event_type,
                payload=lifecycle.event_payload,
                created_at=lifecycle.updated_at,
            )
        ]
        return run

    async def get_run(self, run_id: UUID) -> AgentRun:
        try:
            return self._runs[run_id]
        except KeyError as exc:
            raise RunNotFoundError(str(run_id)) from exc

    async def mark_dispatched(self, run_id: UUID, workflow_id: str) -> AgentRun:
        lifecycle = dispatched_run_lifecycle(workflow_id)
        run = await self.get_run(run_id)
        updated = run.model_copy(
            update={
                "status": lifecycle.status,
                "temporal_workflow_id": lifecycle.temporal_workflow_id,
                "updated_at": lifecycle.updated_at,
            }
        )
        self._runs[run_id] = updated
        await self.append_event(
            run_id,
            lifecycle.event_type,
            lifecycle.event_payload,
        )
        return updated

    async def set_run_status(self, run_id: UUID, status: AgentRunStatus) -> AgentRun:
        run = await self.get_run(run_id)
        updated = run.model_copy(update={"status": status, "updated_at": utcnow()})
        self._runs[run_id] = updated
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
            created_at=utcnow(),
        )
        events.append(event)
        return event

    async def save_run(self, run: AgentRun) -> AgentRun:
        await self.get_run(run.id)
        self._runs[run.id] = run
        return run

    async def list_events(self, run_id: UUID) -> tuple[RunEvent, ...]:
        await self.get_run(run_id)
        return tuple(self._events.get(run_id, ()))

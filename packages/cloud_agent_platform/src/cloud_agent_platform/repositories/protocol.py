from collections.abc import Sequence
from typing import Any, Protocol
from uuid import UUID

from cloud_agent_contracts import AgentRun, AgentRunCreate, AgentRunStatus, EventType, RunEvent


class RunRepository(Protocol):
    async def create_run(self, request: AgentRunCreate) -> AgentRun: ...

    async def get_run(self, run_id: UUID) -> AgentRun: ...

    async def mark_dispatched(self, run_id: UUID, workflow_id: str) -> AgentRun: ...

    async def set_run_status(self, run_id: UUID, status: AgentRunStatus) -> AgentRun: ...

    async def append_event(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent: ...

    async def list_events(self, run_id: UUID) -> Sequence[RunEvent]: ...

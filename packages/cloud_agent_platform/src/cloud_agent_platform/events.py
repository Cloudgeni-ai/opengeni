from typing import Any, Protocol
from uuid import UUID

from cloud_agent_contracts import EventType, RunEvent

from cloud_agent_platform.repositories import RunRepository


class EventPublisher(Protocol):
    async def publish(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent: ...


class RepositoryEventPublisher:
    def __init__(self, repository: RunRepository) -> None:
        self._repository = repository

    async def publish(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent:
        return await self._repository.append_event(run_id, event_type, payload)

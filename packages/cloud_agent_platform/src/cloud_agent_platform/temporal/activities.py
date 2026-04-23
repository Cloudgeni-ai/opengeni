from dataclasses import dataclass
from typing import Any
from uuid import UUID

from cloud_agent_contracts import AgentRunStatus, EventType
from temporalio import activity

from cloud_agent_platform.db import create_engine, create_session_factory
from cloud_agent_platform.db.models import Base
from cloud_agent_platform.errors import RunNotFoundError
from cloud_agent_platform.repositories import SqlAlchemyRunRepository


@dataclass(frozen=True)
class EventActivityInput:
    run_id: str
    event_type: str
    payload: dict[str, Any]
    status: AgentRunStatus | None = None


class RunEventActivity:
    def __init__(self, database_url: str) -> None:
        self._engine = create_engine(database_url)
        Base.metadata.create_all(self._engine)
        self._repository = SqlAlchemyRunRepository(create_session_factory(self._engine))

    async def close(self) -> None:
        self._engine.dispose()

    @activity.defn
    async def publish_event(self, request: EventActivityInput) -> None:
        run_id = UUID(request.run_id)
        event_type = EventType(request.event_type)
        await self._repository.append_event(run_id, event_type, request.payload)
        if request.status is not None:
            await self._repository.set_run_status(run_id, request.status)

    @activity.defn
    async def ensure_run_exists(self, run_id: str) -> None:
        try:
            await self._repository.get_run(UUID(run_id))
        except RunNotFoundError:
            raise

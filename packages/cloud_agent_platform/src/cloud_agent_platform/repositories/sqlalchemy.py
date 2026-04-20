import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from cloud_agent_contracts import AgentRun, AgentRunCreate, AgentRunStatus, EventType, RunEvent
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from cloud_agent_platform.db.models import EventRecord, RunRecord
from cloud_agent_platform.errors import RunNotFoundError
from cloud_agent_platform.repositories.mappers import event_from_record, run_from_record


def _utcnow() -> datetime:
    return datetime.now(UTC)


class SqlAlchemyRunRepository:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    async def create_run(self, request: AgentRunCreate) -> AgentRun:
        return await asyncio.to_thread(self._create_run, request)

    def _create_run(self, request: AgentRunCreate) -> AgentRun:
        now = _utcnow()
        run_id = uuid4()
        resource = request.resource
        record = RunRecord(
            id=str(run_id),
            status=AgentRunStatus.QUEUED.value,
            prompt=request.prompt,
            resource_kind=resource.kind.value if resource else None,
            resource_uri=resource.uri if resource else None,
            resource_metadata=resource.metadata if resource else None,
            metadata_=request.metadata,
            created_at=now,
            updated_at=now,
        )
        event = EventRecord(
            id=str(uuid4()),
            run_id=str(run_id),
            sequence=1,
            type=EventType.RUN_CREATED.value,
            payload={"status": AgentRunStatus.QUEUED.value},
            created_at=now,
        )
        with self._session_factory() as session:
            session.add(record)
            session.add(event)
            session.commit()
            session.refresh(record)
            return run_from_record(record)

    async def get_run(self, run_id: UUID) -> AgentRun:
        return await asyncio.to_thread(self._get_run, run_id)

    def _get_run(self, run_id: UUID) -> AgentRun:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run_id))
            if record is None:
                raise RunNotFoundError(str(run_id))
            return run_from_record(record)

    async def mark_dispatched(self, run_id: UUID, workflow_id: str) -> AgentRun:
        await asyncio.to_thread(self._mark_dispatched, run_id, workflow_id)
        await self.append_event(
            run_id,
            EventType.RUN_DISPATCHED,
            {"workflow_id": workflow_id, "status": AgentRunStatus.DISPATCHED.value},
        )
        return await self.get_run(run_id)

    def _mark_dispatched(self, run_id: UUID, workflow_id: str) -> None:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run_id))
            if record is None:
                raise RunNotFoundError(str(run_id))
            record.status = AgentRunStatus.DISPATCHED.value
            record.temporal_workflow_id = workflow_id
            record.updated_at = _utcnow()
            session.commit()

    async def append_event(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent:
        return await asyncio.to_thread(self._append_event, run_id, event_type, payload)

    def _append_event(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run_id))
            if record is None:
                raise RunNotFoundError(str(run_id))
            next_sequence_query = select(
                func.coalesce(func.max(EventRecord.sequence), 0) + 1
            ).where(EventRecord.run_id == str(run_id))
            sequence = int(session.execute(next_sequence_query).scalar_one())
            event = EventRecord(
                id=str(uuid4()),
                run_id=str(run_id),
                sequence=sequence,
                type=event_type.value,
                payload=payload or {},
                created_at=_utcnow(),
            )
            session.add(event)
            session.commit()
            session.refresh(event)
            return event_from_record(event)

    async def list_events(self, run_id: UUID) -> tuple[RunEvent, ...]:
        return await asyncio.to_thread(self._list_events, run_id)

    def _list_events(self, run_id: UUID) -> tuple[RunEvent, ...]:
        with self._session_factory() as session:
            run = session.get(RunRecord, str(run_id))
            if run is None:
                raise RunNotFoundError(str(run_id))
            rows = session.scalars(
                select(EventRecord)
                .where(EventRecord.run_id == str(run_id))
                .order_by(EventRecord.sequence)
            ).all()
            return tuple(event_from_record(row) for row in rows)

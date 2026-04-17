import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

from cloud_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    ResourceKind,
    ResourceRef,
    RunEvent,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from cloud_agent_platform.db.models import EventRecord, RunRecord
from cloud_agent_platform.errors import RunNotFoundError


class RunRepository(Protocol):
    async def create_run(self, request: AgentRunCreate) -> AgentRun: ...

    async def get_run(self, run_id: UUID) -> AgentRun: ...

    async def mark_dispatched(self, run_id: UUID, workflow_id: str) -> AgentRun: ...

    async def append_event(
        self,
        run_id: UUID,
        event_type: EventType,
        payload: dict[str, Any] | None = None,
    ) -> RunEvent: ...

    async def list_events(self, run_id: UUID) -> Sequence[RunEvent]: ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _resource_from_record(record: RunRecord) -> ResourceRef | None:
    if record.resource_kind is None or record.resource_uri is None:
        return None
    return ResourceRef(
        kind=ResourceKind(record.resource_kind),
        uri=record.resource_uri,
        metadata=record.resource_metadata or {},
    )


def _run_from_record(record: RunRecord) -> AgentRun:
    return AgentRun(
        id=UUID(record.id),
        status=AgentRunStatus(record.status),
        prompt=record.prompt,
        resource=_resource_from_record(record),
        metadata=record.metadata_ or {},
        temporal_workflow_id=record.temporal_workflow_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _event_from_record(record: EventRecord) -> RunEvent:
    return RunEvent(
        id=UUID(record.id),
        run_id=UUID(record.run_id),
        sequence=record.sequence,
        type=EventType(record.type),
        payload=record.payload or {},
        created_at=record.created_at,
    )


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
            return _run_from_record(record)

    async def get_run(self, run_id: UUID) -> AgentRun:
        return await asyncio.to_thread(self._get_run, run_id)

    def _get_run(self, run_id: UUID) -> AgentRun:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run_id))
            if record is None:
                raise RunNotFoundError(str(run_id))
            return _run_from_record(record)

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
            return _event_from_record(event)

    async def list_events(self, run_id: UUID) -> Sequence[RunEvent]:
        return await asyncio.to_thread(self._list_events, run_id)

    def _list_events(self, run_id: UUID) -> Sequence[RunEvent]:
        with self._session_factory() as session:
            run = session.get(RunRecord, str(run_id))
            if run is None:
                raise RunNotFoundError(str(run_id))
            rows = session.scalars(
                select(EventRecord)
                .where(EventRecord.run_id == str(run_id))
                .order_by(EventRecord.sequence)
            ).all()
            return [_event_from_record(row) for row in rows]


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

    async def list_events(self, run_id: UUID) -> Sequence[RunEvent]:
        await self.get_run(run_id)
        return tuple(self._events.get(run_id, ()))

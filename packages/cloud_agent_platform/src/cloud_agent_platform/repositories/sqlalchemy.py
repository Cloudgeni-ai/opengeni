import asyncio
from typing import Any
from uuid import UUID, uuid4

from cloud_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    RunEvent,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from cloud_agent_platform.db.models import EventRecord, RunRecord
from cloud_agent_platform.errors import RunNotFoundError
from cloud_agent_platform.repositories.lifecycle import (
    RunLifecycleUpdate,
    dispatched_run_lifecycle,
    queued_run_lifecycle,
    utcnow,
)
from cloud_agent_platform.repositories.mappers import event_from_record, run_from_record


class SqlAlchemyRunRepository:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    async def create_run(self, request: AgentRunCreate) -> AgentRun:
        return await asyncio.to_thread(self._create_run, request)

    def _create_run(self, request: AgentRunCreate) -> AgentRun:
        lifecycle = queued_run_lifecycle()
        run_id = uuid4()
        resource = request.resource
        record = RunRecord(
            id=str(run_id),
            status=lifecycle.status.value,
            prompt=request.prompt,
            resource_kind=resource.kind.value if resource else None,
            resource_uri=resource.uri if resource else None,
            resource_metadata=resource.metadata if resource else None,
            metadata_=request.metadata,
            created_at=lifecycle.updated_at,
            updated_at=lifecycle.updated_at,
        )
        event = EventRecord(
            id=str(uuid4()),
            run_id=str(run_id),
            sequence=1,
            type=lifecycle.event_type.value,
            payload=lifecycle.event_payload,
            created_at=lifecycle.updated_at,
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
        lifecycle = dispatched_run_lifecycle(workflow_id)
        await asyncio.to_thread(self._mark_dispatched, run_id, lifecycle)
        await self.append_event(
            run_id,
            lifecycle.event_type,
            lifecycle.event_payload,
        )
        return await self.get_run(run_id)

    async def set_run_status(self, run_id: UUID, status: AgentRunStatus) -> AgentRun:
        return await asyncio.to_thread(self._set_run_status, run_id, status)

    def _set_run_status(self, run_id: UUID, status: AgentRunStatus) -> AgentRun:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run_id))
            if record is None:
                raise RunNotFoundError(str(run_id))
            record.status = status.value
            record.updated_at = utcnow()
            session.commit()
            session.refresh(record)
            return run_from_record(record)

    async def save_run(self, run: AgentRun) -> AgentRun:
        return await asyncio.to_thread(self._save_run, run)

    def _save_run(self, run: AgentRun) -> AgentRun:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run.id))
            if record is None:
                raise RunNotFoundError(str(run.id))
            record.status = run.status.value
            record.prompt = run.prompt
            resource = run.resource
            record.resource_kind = resource.kind.value if resource else None
            record.resource_uri = resource.uri if resource else None
            record.resource_metadata = resource.metadata if resource else None
            record.metadata_ = run.metadata
            record.temporal_workflow_id = run.temporal_workflow_id
            record.updated_at = run.updated_at
            session.commit()
            session.refresh(record)
            return run_from_record(record)

    def _mark_dispatched(self, run_id: UUID, lifecycle: RunLifecycleUpdate) -> None:
        with self._session_factory() as session:
            record = session.get(RunRecord, str(run_id))
            if record is None:
                raise RunNotFoundError(str(run_id))
            record.status = lifecycle.status.value
            record.temporal_workflow_id = lifecycle.temporal_workflow_id
            record.updated_at = lifecycle.updated_at
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
                created_at=utcnow(),
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

from uuid import UUID

from cloud_agent_contracts import (
    AgentRun,
    AgentRunStatus,
    EventType,
    ResourceKind,
    ResourceRef,
    RunEvent,
)

from cloud_agent_platform.db.models import EventRecord, RunRecord


def resource_from_record(record: RunRecord) -> ResourceRef | None:
    if record.resource_kind is None or record.resource_uri is None:
        return None
    return ResourceRef(
        kind=ResourceKind(record.resource_kind),
        uri=record.resource_uri,
        metadata=record.resource_metadata or {},
    )


def run_from_record(record: RunRecord) -> AgentRun:
    return AgentRun(
        id=UUID(record.id),
        status=AgentRunStatus(record.status),
        prompt=record.prompt,
        resource=resource_from_record(record),
        metadata=record.metadata_ or {},
        temporal_workflow_id=record.temporal_workflow_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def event_from_record(record: EventRecord) -> RunEvent:
    return RunEvent(
        id=UUID(record.id),
        run_id=UUID(record.run_id),
        sequence=record.sequence,
        type=EventType(record.type),
        payload=record.payload or {},
        created_at=record.created_at,
    )

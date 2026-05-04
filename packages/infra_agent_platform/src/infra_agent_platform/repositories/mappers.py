from uuid import UUID

from infra_agent_contracts import (
    AgentRun,
    AgentRunStatus,
    EventType,
    ResourceKind,
    ResourceRef,
    RunEvent,
)

from infra_agent_platform.db.models import EventRecord, RunRecord


def resources_from_record(record: RunRecord) -> list[ResourceRef]:
    return [
        ResourceRef(
            kind=ResourceKind(row.kind),
            uri=row.uri,
            metadata=row.metadata_ or {},
        )
        for row in record.resources
    ]


def run_from_record(record: RunRecord) -> AgentRun:
    resources = resources_from_record(record)
    return AgentRun(
        id=UUID(record.id),
        status=AgentRunStatus(record.status),
        prompt=record.prompt,
        resources=resources,
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

from dataclasses import dataclass
from datetime import UTC, datetime

from cloud_agent_contracts import AgentRunStatus, EventType


def utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class RunLifecycleUpdate:
    status: AgentRunStatus
    event_type: EventType
    event_payload: dict[str, str]
    updated_at: datetime
    temporal_workflow_id: str | None = None


def queued_run_lifecycle(*, now: datetime | None = None) -> RunLifecycleUpdate:
    timestamp = now or utcnow()
    return RunLifecycleUpdate(
        status=AgentRunStatus.QUEUED,
        event_type=EventType.RUN_CREATED,
        event_payload={"status": AgentRunStatus.QUEUED.value},
        updated_at=timestamp,
    )


def dispatched_run_lifecycle(
    workflow_id: str,
    *,
    now: datetime | None = None,
) -> RunLifecycleUpdate:
    timestamp = now or utcnow()
    return RunLifecycleUpdate(
        status=AgentRunStatus.DISPATCHED,
        event_type=EventType.RUN_DISPATCHED,
        event_payload={
            "workflow_id": workflow_id,
            "status": AgentRunStatus.DISPATCHED.value,
        },
        updated_at=timestamp,
        temporal_workflow_id=workflow_id,
    )

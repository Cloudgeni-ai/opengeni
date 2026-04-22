from uuid import uuid4

from cloud_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    ResourceKind,
    ResourceRef,
    RunEvent,
    RunStreamEnvelope,
)


def test_run_create_contract_accepts_resource_metadata() -> None:
    request = AgentRunCreate(
        prompt="Prepare a release note",
        resource=ResourceRef(
            kind=ResourceKind.REPOSITORY,
            uri=f"https://example.test/repos/{uuid4()}",
            metadata={"branch": "main"},
        ),
    )

    assert request.resource is not None
    assert request.resource.metadata["branch"] == "main"


def test_run_stream_envelope_accepts_run_and_event_payloads() -> None:
    run_id = uuid4()
    run = AgentRun(
        id=run_id,
        status=AgentRunStatus.RUNNING,
        prompt="Inspect this repository",
        resource=None,
        metadata={},
        temporal_workflow_id="workflow-1",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    event = RunEvent(
        id=uuid4(),
        run_id=run_id,
        sequence=1,
        type=EventType.RUN_STARTED,
        payload={"status": "running"},
        created_at="2026-01-01T00:00:00Z",
    )

    envelope = RunStreamEnvelope(type="event", run=run, event=event)
    assert envelope.type == "event"
    assert envelope.run is not None
    assert envelope.event is not None

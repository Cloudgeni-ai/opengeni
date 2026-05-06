from uuid import uuid4

import pytest
from infra_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    ResourceKind,
    ResourceRef,
    RunEvent,
    RunStreamEnvelope,
)
from pydantic import ValidationError


def test_run_create_contract_normalizes_repository_resources() -> None:
    request = AgentRunCreate(
        prompt="Inspect repos",
        resources=[
            ResourceRef(
                kind=ResourceKind.REPOSITORY,
                uri="https://github.com/cloudgeni-ai/infra-agents",
                metadata={"ref": "main"},
            ),
            ResourceRef(
                kind=ResourceKind.REPOSITORY,
                uri="https://git.example.com/platform/modules.git",
                metadata={"ref": "v1.2.3"},
            ),
        ],
    )

    assert request.resources[0].uri == "https://github.com/cloudgeni-ai/infra-agents.git"
    assert request.resources[0].metadata == {
        "host": "github.com",
        "repo": "cloudgeni-ai/infra-agents",
        "ref": "main",
        "subpath": None,
        "mount_path": "repos/cloudgeni-ai/infra-agents",
    }
    assert request.resources[1].metadata["mount_path"] == "repos/platform/modules"


def test_run_create_contract_rejects_bad_repository_resources() -> None:
    with pytest.raises(ValidationError, match="HTTPS Git URL"):
        AgentRunCreate(
            prompt="Inspect repos",
            resources=[
                ResourceRef(
                    kind=ResourceKind.REPOSITORY,
                    uri="git@github.com:cloudgeni-ai/infra-agents.git",
                    metadata={"ref": "main"},
                )
            ],
        )

    with pytest.raises(ValidationError, match="metadata.ref"):
        AgentRunCreate(
            prompt="Inspect repos",
            resources=[
                ResourceRef(
                    kind=ResourceKind.REPOSITORY,
                    uri="https://github.com/cloudgeni-ai/infra-agents",
                    metadata={},
                )
            ],
        )


def test_run_create_contract_rejects_duplicate_mount_paths() -> None:
    with pytest.raises(ValidationError, match="duplicate repository mount path"):
        AgentRunCreate(
            prompt="Inspect repos",
            resources=[
                ResourceRef(
                    kind=ResourceKind.REPOSITORY,
                    uri="https://github.com/cloudgeni-ai/infra-agents",
                    metadata={"ref": "main"},
                ),
                ResourceRef(
                    kind=ResourceKind.REPOSITORY,
                    uri="https://github.com/cloudgeni-ai/infra-agents.git",
                    metadata={"ref": "feature"},
                ),
            ],
        )


def test_run_create_contract_accepts_reasoning_effort() -> None:
    request = AgentRunCreate(prompt="Inspect repos", reasoning_effort="high")

    assert request.reasoning_effort == "high"


def test_run_create_contract_rejects_invalid_reasoning_effort() -> None:
    with pytest.raises(ValidationError, match="reasoning_effort"):
        AgentRunCreate(prompt="Inspect repos", reasoning_effort="extreme")


def test_run_stream_envelope_accepts_run_and_event_payloads() -> None:
    run_id = uuid4()
    run = AgentRun(
        id=run_id,
        status=AgentRunStatus.RUNNING,
        prompt="Inspect this repository",
        resources=[],
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

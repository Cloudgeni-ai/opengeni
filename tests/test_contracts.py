from uuid import uuid4

from cloud_agent_contracts import AgentRunCreate, ResourceKind, ResourceRef


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

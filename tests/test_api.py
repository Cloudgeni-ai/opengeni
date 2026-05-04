import infra_agent_api.app as api_app
from fastapi.testclient import TestClient
from infra_agent_api import create_app
from infra_agent_contracts import AgentRun
from infra_agent_platform.config import Settings
from infra_agent_platform.repositories import InMemoryRunRepository


class _DispatchingStub:
    async def dispatch(self, run: AgentRun) -> str:
        return f"workflow-{run.id}"

    async def submit_follow_up(self, workflow_id: str, prompt: str) -> None:
        del workflow_id, prompt

    async def request_cancel(self, workflow_id: str, reason: str | None = None) -> None:
        del workflow_id, reason

    async def query_progress(self, workflow_id: str) -> object:
        return {"workflow_id": workflow_id}


def test_api_creates_and_reads_run() -> None:
    repository = InMemoryRunRepository()
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=repository,
    )

    with TestClient(app) as client:
        created = client.post("/v1/runs", json={"prompt": "Inspect this repository"})
        assert created.status_code == 202
        body = created.json()
        assert body["status"] == "queued"

        fetched = client.get(f"/v1/runs/{body['id']}")
        assert fetched.status_code == 200
        assert fetched.json()["prompt"] == "Inspect this repository"

        events = client.get(f"/v1/runs/{body['id']}/events")
        assert events.status_code == 200
        assert events.json()[0]["type"] == "run.created"


def test_api_creates_run_with_repository_resources() -> None:
    repository = InMemoryRunRepository()
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=repository,
    )

    with TestClient(app) as client:
        created = client.post(
            "/v1/runs",
            json={
                "prompt": "Inspect these repositories",
                "resources": [
                    {
                        "kind": "repository",
                        "uri": "https://github.com/cloudgeni-ai/infra-agents",
                        "metadata": {"ref": "main"},
                    }
                ],
            },
        )

    assert created.status_code == 202
    body = created.json()
    assert "resource" not in body
    assert body["resources"][0]["metadata"]["mount_path"] == "repos/cloudgeni-ai/infra-agents"


def test_api_rejects_missing_repository_ref_before_dispatch(
    monkeypatch,
) -> None:
    async def ref_exists(uri: str, ref: str) -> bool:
        assert uri == "https://github.com/langchain-ai/langchain.git"
        assert ref == "main"
        return False

    monkeypatch.setattr(api_app, "_repository_ref_exists", ref_exists)
    repository = InMemoryRunRepository()
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=True),
        repository=repository,
        dispatcher=_DispatchingStub(),
    )

    with TestClient(app) as client:
        created = client.post(
            "/v1/runs",
            json={
                "prompt": "Inspect this repository",
                "resources": [
                    {
                        "kind": "repository",
                        "uri": "https://github.com/langchain-ai/langchain",
                        "metadata": {"ref": "main"},
                    }
                ],
            },
        )

    assert created.status_code == 422
    assert "repository ref not found" in created.json()["detail"]


def test_api_returns_404_for_missing_run() -> None:
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/runs/00000000-0000-0000-0000-000000000000")

    assert response.status_code == 404

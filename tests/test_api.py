from cloud_agent_api import create_app
from cloud_agent_platform.config import Settings
from cloud_agent_platform.repositories import InMemoryRunRepository
from fastapi.testclient import TestClient


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


def test_api_returns_404_for_missing_run() -> None:
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/runs/00000000-0000-0000-0000-000000000000")

    assert response.status_code == 404

from pathlib import Path

import infra_agent_api.app as api_app
import pytest
from fastapi.testclient import TestClient
from infra_agent_api import create_app
from infra_agent_platform.config import Settings
from infra_agent_platform.github_app import (
    GitHubAppAPIError,
    _bot_identity_from_payload,
    _create_installation_token,
)
from infra_agent_platform.github_app_manifest import (
    build_github_app_manifest,
    create_signed_state,
    verify_signed_state,
)
from infra_agent_platform.repositories import InMemoryRunRepository


@pytest.fixture(autouse=True)
def _clear_github_app_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    for name in (
        "INFRA_AGENT_GITHUB_APP_ID",
        "INFRA_AGENT_GITHUB_CLIENT_ID",
        "INFRA_AGENT_GITHUB_CLIENT_SECRET",
        "INFRA_AGENT_GITHUB_APP_SLUG",
        "INFRA_AGENT_GITHUB_WEBHOOK_SECRET",
        "INFRA_AGENT_GITHUB_APP_PRIVATE_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


def test_github_app_manifest_contains_repo_pr_permissions() -> None:
    manifest = build_github_app_manifest(
        app_name="Infra Agents",
        base_url="https://agents.example.com/",
        public=False,
        include_ci_permissions=False,
    )

    assert manifest["url"] == "https://agents.example.com"
    assert manifest["redirect_url"] == (
        "https://agents.example.com/v1/github/app-manifest/callback"
    )
    assert manifest["request_oauth_on_install"] is False
    assert "callback_urls" not in manifest
    assert "setup_url" not in manifest
    assert manifest["default_permissions"] == {
        "metadata": "read",
        "contents": "write",
        "pull_requests": "write",
    }
    assert manifest["hook_attributes"] == {
        "url": "https://agents.example.com/v1/github/webhook",
        "active": True,
    }
    assert manifest["default_events"] == ["pull_request", "push"]


def test_github_app_manifest_omits_webhook_for_localhost() -> None:
    manifest = build_github_app_manifest(
        app_name="Infra Agents",
        base_url="http://127.0.0.1:8000",
        public=False,
        include_ci_permissions=True,
    )

    assert "hook_attributes" not in manifest
    assert "default_events" not in manifest
    assert manifest["redirect_url"] == "http://127.0.0.1:8000/v1/github/app-manifest/callback"


def test_github_app_manifest_does_not_request_installation_events() -> None:
    manifest = build_github_app_manifest(
        app_name="Infra Agents",
        base_url="https://agents.example.com",
        public=False,
        include_ci_permissions=True,
    )

    assert "installation" not in manifest["default_events"]
    assert "installation_repositories" not in manifest["default_events"]


def test_github_app_manifest_state_is_signed_and_expires() -> None:
    state = create_signed_state("secret", now=100)

    assert verify_signed_state(state, "secret", now=120)
    assert not verify_signed_state(state, "wrong", now=120)
    assert not verify_signed_state(state, "secret", now=4000)


def test_api_starts_github_app_manifest_flow_for_org() -> None:
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_manifest_base_url="https://agents.example.com",
            github_app_manifest_state_secret="secret",
        ),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/v1/github/app-manifest",
            json={"organization": "cloudgeni-ai"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["action_url"].startswith(
        "https://github.com/organizations/cloudgeni-ai/settings/apps/new?state="
    )
    assert body["manifest"]["hook_attributes"]["url"] == (
        "https://agents.example.com/v1/github/webhook"
    )
    assert body["manifest"]["default_permissions"]["actions"] == "read"
    assert body["manifest"]["default_events"] == [
        "pull_request",
        "push",
        "check_run",
        "workflow_run",
    ]


def test_api_starts_github_app_manifest_flow_from_localhost_without_webhook() -> None:
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_manifest_state_secret="secret",
        ),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/v1/github/app-manifest",
            json={},
        )

    assert response.status_code == 200
    manifest = response.json()["manifest"]
    assert manifest["url"] == "http://testserver"
    assert "hook_attributes" not in manifest
    assert "default_events" not in manifest


def test_api_callback_exchanges_manifest_code(monkeypatch) -> None:
    async def convert(code: str) -> dict[str, object]:
        assert code == "abc"
        return {
            "id": 123,
            "client_id": "Iv1.client",
            "client_secret": "secret",
            "slug": "infra-agents",
            "webhook_secret": "hook",
            "pem": "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
        }

    monkeypatch.setattr(api_app, "_convert_github_app_manifest", convert)
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_manifest_state_secret="secret",
        ),
        repository=InMemoryRunRepository(),
    )
    state = create_signed_state("secret")

    with TestClient(app) as client:
        response = client.get(f"/v1/github/app-manifest/callback?code=abc&state={state}")

    assert response.status_code == 200
    assert "INFRA_AGENT_GITHUB_APP_ID=123" in response.text
    assert 'id="copy-env"' in response.text
    assert "navigator.clipboard" in response.text
    assert "https://github.com/apps/infra-agents/installations/new" in response.text


def test_api_reports_github_app_status_without_secrets() -> None:
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_id="123",
            github_client_id="Iv1.client",
            github_client_secret="client-secret",
            github_app_slug="infra-agents",
            github_webhook_secret="webhook-secret",
            github_app_private_key="private-key",
        ),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/github/app")

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "configured": True,
        "app_id": "123",
        "client_id": "Iv1.client",
        "app_slug": "infra-agents",
        "install_url": "https://github.com/apps/infra-agents/installations/new",
        "missing": [],
    }
    assert "secret" not in response.text
    assert "private-key" not in response.text


def test_github_app_status_does_not_require_webhook_secret() -> None:
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_id="123",
            github_client_id="Iv1.client",
            github_client_secret="client-secret",
            github_app_slug="infra-agents",
            github_app_private_key="private-key",
        ),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/github/app")

    assert response.status_code == 200
    assert response.json()["configured"] is True
    assert response.json()["missing"] == []


def test_api_lists_github_repositories(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    async def list_repositories(settings: Settings):
        assert settings.github_app_id == "123"
        return [
            {
                "id": 42,
                "installation_id": 7,
                "full_name": "cloudgeni-ai/infra",
                "name": "infra",
                "private": True,
                "html_url": "https://github.com/cloudgeni-ai/infra",
                "clone_url": "https://github.com/cloudgeni-ai/infra.git",
                "default_branch": "main",
                "account_login": "cloudgeni-ai",
                "account_type": "Organization",
            }
        ]

    monkeypatch.setattr(api_app, "list_github_app_repositories", list_repositories)
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_id="123",
            github_client_id="Iv1.client",
            github_client_secret="client-secret",
            github_app_slug="infra-agents",
            github_app_private_key="private-key",
        ),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.post("/v1/github/repositories/sync")

    assert response.status_code == 200
    assert response.json() == {
        "repositories": [
            {
                "id": 42,
                "installation_id": 7,
                "full_name": "cloudgeni-ai/infra",
                "name": "infra",
                "private": True,
                "html_url": "https://github.com/cloudgeni-ai/infra",
                "clone_url": "https://github.com/cloudgeni-ai/infra.git",
                "default_branch": "main",
                "account_login": "cloudgeni-ai",
                "account_type": "Organization",
            }
        ]
    }


def test_api_rejects_repository_sync_when_github_app_is_missing() -> None:
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/github/repositories")

    assert response.status_code == 409
    assert response.json()["detail"]["message"] == "GitHub App is not configured"


def test_api_reports_github_repository_sync_errors(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    async def list_repositories(settings: Settings):
        raise GitHubAppAPIError("GitHub API 401: Bad credentials")

    monkeypatch.setattr(api_app, "list_github_app_repositories", list_repositories)
    app = create_app(
        settings=Settings(
            environment="test",
            enable_temporal_dispatch=False,
            github_app_id="123",
            github_client_id="Iv1.client",
            github_client_secret="client-secret",
            github_app_slug="infra-agents",
            github_app_private_key="private-key",
        ),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/github/repositories")

    assert response.status_code == 502
    assert response.json()["detail"] == "GitHub API 401: Bad credentials"


def test_api_reports_missing_github_app_config() -> None:
    app = create_app(
        settings=Settings(environment="test", enable_temporal_dispatch=False),
        repository=InMemoryRunRepository(),
    )

    with TestClient(app) as client:
        response = client.get("/v1/github/app")

    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is False
    assert "INFRA_AGENT_GITHUB_APP_PRIVATE_KEY" in body["missing"]


@pytest.mark.asyncio
async def test_github_installation_token_request_scopes_repository_ids() -> None:
    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"token": "installation-token"}

    class Client:
        json: dict[str, list[int]] | None = None

        async def post(self, url, *, headers, json=None):  # type: ignore[no-untyped-def]
            assert url.endswith("/app/installations/7/access_tokens")
            assert headers["Authorization"] == "Bearer app-jwt"
            self.json = json
            return Response()

    client = Client()

    token = await _create_installation_token(
        client,  # type: ignore[arg-type]
        "app-jwt",
        7,
        repository_ids=[102, 101, 101],
    )

    assert token == "installation-token"
    assert client.json == {"repository_ids": [101, 102]}


def test_github_app_bot_identity_uses_noreply_email_format() -> None:
    identity = _bot_identity_from_payload(
        "infra-agents-test-app[bot]",
        {"login": "infra-agents-test-app[bot]", "id": 123456},
    )

    assert identity.name == "infra-agents-test-app[bot]"
    assert (
        identity.email
        == "123456+infra-agents-test-app[bot]@users.noreply.github.com"
    )

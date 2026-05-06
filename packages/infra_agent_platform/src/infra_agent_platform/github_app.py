import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import quote

import httpx
import jwt
from infra_agent_contracts import GitHubRepository

from infra_agent_platform.config import Settings

GITHUB_API_BASE_URL = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"


@dataclass(frozen=True)
class GitHubBotIdentity:
    name: str
    email: str


class GitHubAppConfigurationError(RuntimeError):
    def __init__(self, missing: list[str]) -> None:
        super().__init__("GitHub App is not configured")
        self.missing = missing


class GitHubAppAPIError(RuntimeError):
    pass


def github_app_missing_settings(settings: Settings) -> list[str]:
    required = {
        "INFRA_AGENT_GITHUB_APP_ID": settings.github_app_id,
        "INFRA_AGENT_GITHUB_CLIENT_ID": settings.github_client_id,
        "INFRA_AGENT_GITHUB_CLIENT_SECRET": settings.github_client_secret,
        "INFRA_AGENT_GITHUB_APP_SLUG": settings.github_app_slug,
        "INFRA_AGENT_GITHUB_APP_PRIVATE_KEY": settings.github_app_private_key,
    }
    return [name for name, value in required.items() if not _has_value(value)]


async def list_github_app_repositories(settings: Settings) -> list[GitHubRepository]:
    missing = github_app_missing_settings(settings)
    if missing:
        raise GitHubAppConfigurationError(missing)

    app_jwt = create_github_app_jwt(settings)
    async with httpx.AsyncClient(timeout=30) as client:
        installations = await _list_installations(client, app_jwt)
        repositories: list[GitHubRepository] = []
        for installation in installations:
            if installation.get("suspended_at"):
                continue
            installation_id = _coerce_int(installation.get("id"))
            if installation_id is None:
                continue
            account = installation.get("account")
            if not isinstance(account, dict):
                account = {}
            token = await _create_installation_token(client, app_jwt, installation_id)
            repositories.extend(
                await _list_installation_repositories(
                    client,
                    token,
                    installation_id=installation_id,
                    account=account,
                )
            )
    repositories.sort(key=lambda repo: repo.full_name.lower())
    return repositories


async def create_github_app_installation_token(
    settings: Settings,
    *,
    installation_id: int,
    repository_ids: Sequence[int] | None = None,
) -> str:
    missing = github_app_missing_settings(settings)
    if missing:
        raise GitHubAppConfigurationError(missing)

    app_jwt = create_github_app_jwt(settings)
    async with httpx.AsyncClient(timeout=30) as client:
        return await _create_installation_token(
            client,
            app_jwt,
            installation_id,
            repository_ids=repository_ids,
        )


async def get_github_app_bot_identity(settings: Settings) -> GitHubBotIdentity:
    missing = github_app_missing_settings(settings)
    if missing:
        raise GitHubAppConfigurationError(missing)

    bot_login = f"{(settings.github_app_slug or '').strip()}[bot]"
    if bot_login == "[bot]":
        raise GitHubAppConfigurationError(["INFRA_AGENT_GITHUB_APP_SLUG"])
    async with httpx.AsyncClient(timeout=30) as client:
        bot_path = f"/users/{quote(bot_login, safe='')}"
        try:
            payload = await _github_get(client, bot_path, token=None, params={})
        except GitHubAppAPIError:
            app_jwt = create_github_app_jwt(settings)
            installations = await _list_installations(client, app_jwt)
            installation_id = next(
                (
                    current
                    for installation in installations
                    if (current := _coerce_int(installation.get("id"))) is not None
                ),
                None,
            )
            if installation_id is None:
                raise
            token = await _create_installation_token(client, app_jwt, installation_id)
            payload = await _github_get(client, bot_path, token=token, params={})
    if not isinstance(payload, dict):
        raise GitHubAppAPIError("GitHub returned an invalid bot user payload")
    return _bot_identity_from_payload(bot_login, payload)


def create_github_app_jwt(settings: Settings, *, now: int | None = None) -> str:
    app_id = (settings.github_app_id or "").strip()
    private_key = _normalize_private_key(settings.github_app_private_key or "")
    if not app_id or not private_key:
        raise GitHubAppConfigurationError(github_app_missing_settings(settings))
    current_time = int(time.time() if now is None else now)
    payload = {
        "iat": current_time - 60,
        "exp": current_time + 9 * 60,
        "iss": app_id,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


async def _list_installations(client: httpx.AsyncClient, app_jwt: str) -> list[dict[str, Any]]:
    installations: list[dict[str, Any]] = []
    page = 1
    while True:
        payload = await _github_get(
            client,
            "/app/installations",
            token=app_jwt,
            params={"per_page": "100", "page": str(page)},
        )
        if not isinstance(payload, list):
            raise GitHubAppAPIError("GitHub returned an invalid installations payload")
        installations.extend(item for item in payload if isinstance(item, dict))
        if len(payload) < 100:
            return installations
        page += 1


async def _create_installation_token(
    client: httpx.AsyncClient,
    app_jwt: str,
    installation_id: int,
    *,
    repository_ids: Sequence[int] | None = None,
) -> str:
    payload: dict[str, list[int]] | None = None
    if repository_ids is not None:
        scoped_ids = sorted({repo_id for repo_id in repository_ids if repo_id > 0})
        payload = {"repository_ids": scoped_ids}
    request_kwargs: dict[str, Any] = {"headers": _github_headers(app_jwt)}
    if payload is not None:
        request_kwargs["json"] = payload
    response = await client.post(
        f"{GITHUB_API_BASE_URL}/app/installations/{installation_id}/access_tokens",
        **request_kwargs,
    )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise GitHubAppAPIError(_github_error_message(response)) from exc
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("token"), str):
        raise GitHubAppAPIError("GitHub returned an invalid installation token payload")
    return cast(str, payload["token"])


async def _list_installation_repositories(
    client: httpx.AsyncClient,
    installation_token: str,
    *,
    installation_id: int,
    account: dict[str, Any],
) -> list[GitHubRepository]:
    repositories: list[GitHubRepository] = []
    page = 1
    while True:
        payload = await _github_get(
            client,
            "/installation/repositories",
            token=installation_token,
            params={"per_page": "100", "page": str(page)},
        )
        if not isinstance(payload, dict):
            raise GitHubAppAPIError("GitHub returned an invalid repositories payload")
        raw_repositories = payload.get("repositories")
        if not isinstance(raw_repositories, list):
            raise GitHubAppAPIError("GitHub returned an invalid repositories list")
        for raw in raw_repositories:
            if isinstance(raw, dict):
                repositories.append(
                    _repository_from_payload(
                        raw,
                        installation_id=installation_id,
                        account=account,
                    )
                )
        if len(raw_repositories) < 100:
            return repositories
        page += 1


def _repository_from_payload(
    payload: dict[str, Any],
    *,
    installation_id: int,
    account: dict[str, Any],
) -> GitHubRepository:
    repo_id = _coerce_int(payload.get("id"))
    full_name = str(payload.get("full_name") or "")
    name = str(payload.get("name") or full_name.rsplit("/", 1)[-1])
    if repo_id is None or not full_name:
        raise GitHubAppAPIError("GitHub returned a repository without id/full_name")
    return GitHubRepository(
        id=repo_id,
        installation_id=installation_id,
        full_name=full_name,
        name=name,
        private=bool(payload.get("private")),
        html_url=str(payload.get("html_url") or f"https://github.com/{full_name}"),
        clone_url=str(payload.get("clone_url") or f"https://github.com/{full_name}.git"),
        default_branch=str(payload.get("default_branch") or "main"),
        account_login=str(account.get("login") or full_name.split("/", 1)[0]),
        account_type=str(account.get("type")) if account.get("type") else None,
    )


def _bot_identity_from_payload(expected_login: str, payload: dict[str, Any]) -> GitHubBotIdentity:
    login = str(payload.get("login") or expected_login).strip()
    bot_id = _coerce_int(payload.get("id"))
    if not login or bot_id is None:
        raise GitHubAppAPIError("GitHub returned a bot user without login/id")
    return GitHubBotIdentity(
        name=login,
        email=f"{bot_id}+{login}@users.noreply.github.com",
    )


async def _github_get(
    client: httpx.AsyncClient,
    path: str,
    *,
    token: str | None,
    params: dict[str, str],
) -> Any:
    response = await client.get(
        f"{GITHUB_API_BASE_URL}{path}",
        headers=_github_headers(token),
        params=params,
    )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise GitHubAppAPIError(_github_error_message(response)) from exc
    return response.json()


def _github_headers(token: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _github_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"GitHub API {response.status_code}: {response.text}"
    if isinstance(payload, dict) and payload.get("message"):
        return f"GitHub API {response.status_code}: {payload['message']}"
    return f"GitHub API {response.status_code}"


def _normalize_private_key(value: str) -> str:
    return value.strip().replace("\\n", "\n")


def _has_value(value: str | None) -> bool:
    return bool(value and value.strip())


def _coerce_int(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None

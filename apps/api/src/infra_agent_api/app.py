import asyncio
import base64
import os
import re
import secrets
import subprocess
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager, suppress
from html import escape
from typing import Any, Protocol, cast
from uuid import UUID

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from infra_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    GitHubAppManifestCreate,
    GitHubAppManifestStart,
    GitHubAppStatus,
    GitHubRepositoryList,
    HealthResponse,
    RunCancelRequest,
    RunEvent,
    RunFollowUpCreate,
)
from infra_agent_platform.config import Settings, get_settings
from infra_agent_platform.db import create_engine, create_session_factory
from infra_agent_platform.errors import DispatchError, RepositoryError, RunNotFoundError
from infra_agent_platform.github_app import (
    GitHubAppAPIError,
    GitHubAppConfigurationError,
    create_github_app_installation_token,
    github_app_missing_settings,
    list_github_app_repositories,
)
from infra_agent_platform.github_app_manifest import (
    build_github_app_manifest,
    create_signed_state,
    env_lines_from_github_manifest_conversion,
    organization_app_manifest_url,
    personal_app_manifest_url,
    verify_signed_state,
)
from infra_agent_platform.repositories import RunRepository, SqlAlchemyRunRepository
from infra_agent_platform.temporal.dispatcher import TemporalRunDispatcher
from sqlalchemy import Engine


class RunDispatcher(Protocol):
    async def dispatch(self, run: AgentRun) -> str: ...

    async def submit_follow_up(self, workflow_id: str, prompt: str) -> None: ...

    async def request_cancel(self, workflow_id: str, reason: str | None = None) -> None: ...

    async def query_progress(self, workflow_id: str) -> object: ...


TERMINAL_STATUSES = {
    AgentRunStatus.SUCCEEDED,
    AgentRunStatus.FAILED,
    AgentRunStatus.CANCELLED,
}
_FULL_HEX_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")


def create_app(
    *,
    settings: Settings | None = None,
    repository: RunRepository | None = None,
    dispatcher: RunDispatcher | None = None,
) -> FastAPI:
    resolved_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine: Engine | None = None
        if repository is None:
            engine = create_engine(resolved_settings.database_url)
            session_factory = create_session_factory(engine)
            app.state.repository = SqlAlchemyRunRepository(session_factory)
        else:
            app.state.repository = repository

        app.state.settings = resolved_settings
        app.state.dispatcher = dispatcher
        app.state.github_app_manifest_state_secret = (
            resolved_settings.github_app_manifest_state_secret or secrets.token_urlsafe(32)
        )
        if app.state.dispatcher is None and resolved_settings.enable_temporal_dispatch:
            app.state.dispatcher = TemporalRunDispatcher(resolved_settings)

        try:
            yield
        finally:
            if engine is not None:
                engine.dispose()

    app = FastAPI(title="Infra Agents API", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=resolved_settings.cors_allow_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz", response_model=HealthResponse)
    async def health(request: Request) -> HealthResponse:
        current_settings: Settings = request.app.state.settings
        return HealthResponse(
            service=current_settings.service_name,
            environment=current_settings.environment,
            ok=True,
        )

    @app.get("/v1/github/app", response_model=GitHubAppStatus)
    async def github_app_status(request: Request) -> GitHubAppStatus:
        return _github_app_status(request.app.state.settings)

    @app.get("/v1/github/repositories", response_model=GitHubRepositoryList)
    async def github_repositories(request: Request) -> GitHubRepositoryList:
        return await _github_repositories(request.app.state.settings)

    @app.post("/v1/github/repositories/sync", response_model=GitHubRepositoryList)
    async def sync_github_repositories(request: Request) -> GitHubRepositoryList:
        return await _github_repositories(request.app.state.settings)

    @app.post("/v1/github/app-manifest", response_model=GitHubAppManifestStart)
    async def create_github_app_manifest(
        request: Request,
        payload: GitHubAppManifestCreate,
    ) -> GitHubAppManifestStart:
        current_settings: Settings = request.app.state.settings
        base_url = _github_manifest_base_url(request, current_settings)
        state = create_signed_state(_github_manifest_state_secret(request))
        app_name = (payload.app_name or "Infra Agents").strip() or "Infra Agents"
        manifest = build_github_app_manifest(
            app_name=app_name,
            base_url=base_url,
            public=payload.public,
            include_ci_permissions=True,
        )
        organization = (payload.organization or "").strip()
        action_url = (
            organization_app_manifest_url(organization=organization, state=state)
            if organization
            else personal_app_manifest_url(state)
        )
        return GitHubAppManifestStart(action_url=action_url, state=state, manifest=manifest)

    @app.get("/v1/github/app-manifest/callback", response_class=HTMLResponse)
    async def github_app_manifest_callback(request: Request) -> HTMLResponse:
        code = request.query_params.get("code")
        state = request.query_params.get("state")
        if not code:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="missing GitHub manifest code",
            )
        if not state or not verify_signed_state(state, _github_manifest_state_secret(request)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid or expired GitHub manifest state",
            )

        try:
            conversion = await _convert_github_app_manifest(code)
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"failed to convert GitHub App manifest: {exc}",
            ) from exc
        env_lines = env_lines_from_github_manifest_conversion(conversion)
        slug = str(conversion.get("slug") or "")
        install_url = f"https://github.com/apps/{slug}/installations/new" if slug else ""
        return HTMLResponse(_github_manifest_success_html(env_lines, install_url))

    @app.post(
        "/v1/runs",
        response_model=AgentRun,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_run(request: Request, payload: AgentRunCreate) -> AgentRun:
        repo = _repo(request)
        current_dispatcher = _dispatcher(request)
        try:
            _github_app_repository_selection(payload)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(exc),
            ) from exc
        if current_dispatcher is not None:
            try:
                await _validate_repository_refs(payload, request.app.state.settings)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=str(exc),
                ) from exc

        try:
            run = await repo.create_run(payload)
        except RepositoryError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

        if current_dispatcher is None:
            return run

        try:
            workflow_id = await current_dispatcher.dispatch(run)
            return await repo.mark_dispatched(run.id, workflow_id)
        except DispatchError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        except RepositoryError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

    @app.get("/v1/runs/{run_id}", response_model=AgentRun)
    async def get_run(request: Request, run_id: UUID) -> AgentRun:
        try:
            return await _repo(request).get_run(run_id)
        except RunNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    @app.get("/v1/runs/{run_id}/events", response_model=list[RunEvent])
    async def list_events(request: Request, run_id: UUID) -> Sequence[RunEvent]:
        try:
            return await _repo(request).list_events(run_id)
        except RunNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    @app.post("/v1/runs/{run_id}/follow-up", response_model=AgentRun)
    async def submit_follow_up(
        request: Request,
        run_id: UUID,
        payload: RunFollowUpCreate,
    ) -> AgentRun:
        repo = _repo(request)
        try:
            run = await repo.get_run(run_id)
        except RunNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

        if run.status in TERMINAL_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"run {run_id} is already terminal ({run.status.value})",
            )

        if not run.temporal_workflow_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"run {run_id} has not been dispatched",
            )

        current_dispatcher = _dispatcher(request)
        if current_dispatcher is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="temporal dispatch is disabled",
            )

        try:
            await current_dispatcher.submit_follow_up(run.temporal_workflow_id, payload.prompt)
            await repo.append_event(
                run_id,
                event_type=EventType.RUN_FOLLOW_UP_REQUESTED,
                payload={"prompt": payload.prompt, "status": AgentRunStatus.RUNNING.value},
            )
            return await repo.set_run_status(run_id, AgentRunStatus.RUNNING)
        except DispatchError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        except RepositoryError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

    @app.post("/v1/runs/{run_id}/cancel", response_model=AgentRun)
    async def cancel_run(request: Request, run_id: UUID, payload: RunCancelRequest) -> AgentRun:
        repo = _repo(request)
        try:
            run = await repo.get_run(run_id)
        except RunNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

        if run.status in TERMINAL_STATUSES:
            return run

        if not run.temporal_workflow_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"run {run_id} has not been dispatched",
            )

        current_dispatcher = _dispatcher(request)
        if current_dispatcher is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="temporal dispatch is disabled",
            )

        try:
            await current_dispatcher.request_cancel(run.temporal_workflow_id, payload.reason)
            await repo.append_event(
                run_id,
                event_type=EventType.RUN_CANCEL_REQUESTED,
                payload={
                    "status": run.status.value,
                    "reason": payload.reason or "",
                },
            )
            return run
        except DispatchError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        except RepositoryError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

    @app.websocket("/v1/runs/{run_id}/stream")
    async def stream_run(websocket: WebSocket, run_id: UUID) -> None:
        await websocket.accept()
        repo = _repo_from_ws(websocket)
        dispatcher = _dispatcher_from_ws(websocket)
        settings = _settings_from_ws(websocket)
        raw_cursor = websocket.query_params.get("from_sequence", "1")
        cursor = max(1, int(raw_cursor))
        try:
            run = await repo.get_run(run_id)
            await websocket.send_json({"type": "run", "run": run.model_dump(mode="json")})
            while True:
                events = await repo.list_events(run_id)
                sent_any = False
                for event in events:
                    if event.sequence < cursor:
                        continue
                    sent_any = True
                    cursor = event.sequence + 1
                    await websocket.send_json(
                        {"type": "event", "event": event.model_dump(mode="json")}
                    )

                if run.temporal_workflow_id and dispatcher is not None:
                    try:
                        progress = await dispatcher.query_progress(run.temporal_workflow_id)
                    except DispatchError as exc:
                        await websocket.send_json({"type": "progress.error", "error": str(exc)})
                    else:
                        payload = getattr(progress, "__dict__", None)
                        if payload is None:
                            payload = progress
                        await websocket.send_json({"type": "progress", "progress": payload})

                run = await repo.get_run(run_id)
                if run.status in TERMINAL_STATUSES and not sent_any:
                    await websocket.send_json({"type": "run", "run": run.model_dump(mode="json")})
                    break
                await asyncio.sleep(max(0.2, settings.api_event_poll_seconds))
        except RunNotFoundError:
            await websocket.send_json(
                {
                    "type": "error",
                    "error": f"run not found: {run_id}",
                    "code": status.HTTP_404_NOT_FOUND,
                }
            )
        except WebSocketDisconnect:
            return
        finally:
            with suppress(RuntimeError):
                await websocket.close()

    return app


def _github_manifest_base_url(request: Request, settings: Settings) -> str:
    configured = (settings.github_app_manifest_base_url or "").strip()
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/")


def _github_app_status(settings: Settings) -> GitHubAppStatus:
    missing = github_app_missing_settings(settings)
    slug = settings.github_app_slug if _has_value(settings.github_app_slug) else None
    return GitHubAppStatus(
        configured=not missing,
        app_id=settings.github_app_id if _has_value(settings.github_app_id) else None,
        client_id=settings.github_client_id if _has_value(settings.github_client_id) else None,
        app_slug=slug,
        install_url=f"https://github.com/apps/{slug}/installations/new" if slug else None,
        missing=missing,
    )


async def _github_repositories(settings: Settings) -> GitHubRepositoryList:
    try:
        repositories = await list_github_app_repositories(settings)
    except GitHubAppConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "GitHub App is not configured",
                "missing": exc.missing,
            },
        ) from exc
    except GitHubAppAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return GitHubRepositoryList(repositories=repositories)


def _has_value(value: str | None) -> bool:
    return bool(value and value.strip())


def _github_manifest_state_secret(request: Request) -> str:
    secret: Any = request.app.state.github_app_manifest_state_secret
    return cast(str, secret)


async def _convert_github_app_manifest(code: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"https://api.github.com/app-manifests/{code}/conversions",
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise httpx.HTTPError("GitHub returned a non-object manifest conversion payload")
        return payload


def _github_manifest_success_html(env_lines: list[str], install_url: str) -> str:
    env_text = "\n".join(env_lines)
    escaped_env = escape(env_text)
    escaped_install_url = escape(install_url)
    install_link = (
        f'<a class="button secondary" href="{escaped_install_url}">Install on repositories</a>'
        if install_url
        else ""
    )
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GitHub App Created</title>
    <style>
      :root {{
        color-scheme: dark;
        --bg: #09090b;
        --panel: #111114;
        --text: #f4f4f5;
        --muted: #a1a1aa;
        --border: #27272a;
        --accent: #fafafa;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }}
      main {{
        width: min(720px, calc(100vw - 32px));
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--panel);
        padding: 28px;
      }}
      h1 {{
        margin: 0 0 8px;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: 0;
      }}
      p {{
        color: var(--muted);
        line-height: 1.5;
      }}
      pre {{
        white-space: pre-wrap;
        word-break: break-word;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        background: #09090b;
        color: #e4e4e7;
        font-size: 13px;
        line-height: 1.5;
      }}
      .env-header {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-top: 20px;
        margin-bottom: 8px;
      }}
      .env-label {{
        color: var(--muted);
        font-size: 13px;
      }}
      .actions {{
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }}
      .button,
      button {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        padding: 0 14px;
        border-radius: 6px;
        border: 1px solid var(--accent);
        color: #09090b;
        background: var(--accent);
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        font: inherit;
      }}
      .button.secondary,
      button.secondary {{
        border-color: var(--border);
        background: transparent;
        color: var(--text);
      }}
      .status {{
        min-height: 18px;
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>GitHub App created</h1>
      <p>
        GitHub generated the app credentials. Add these values to the repository root
        <code>.env</code>, then restart the API and worker so the platform can use the app.
      </p>
      <div class="env-header">
        <div class="env-label">Environment values</div>
        <button class="secondary" type="button" id="copy-env">Copy</button>
      </div>
      <pre id="env-lines">{escaped_env}</pre>
      <div class="status" id="copy-status" role="status" aria-live="polite"></div>
      <div class="actions">{install_link}</div>
    </main>
    <script>
      const button = document.getElementById("copy-env");
      const status = document.getElementById("copy-status");
      const envText = {env_text!r};

      async function copyEnv() {{
        try {{
          if (navigator.clipboard && window.isSecureContext) {{
            await navigator.clipboard.writeText(envText);
          }} else {{
            const textarea = document.createElement("textarea");
            textarea.value = envText;
            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
          }}
          status.textContent = "Copied";
          button.textContent = "Copied";
          window.setTimeout(() => {{
            status.textContent = "";
            button.textContent = "Copy";
          }}, 1800);
        }} catch (_error) {{
          status.textContent = "Copy failed. Select the values and copy manually.";
        }}
      }}

      button.addEventListener("click", copyEnv);
    </script>
  </body>
</html>"""


def _repo(request: Request) -> RunRepository:
    repository: Any = request.app.state.repository
    return cast(RunRepository, repository)


def _dispatcher(request: Request) -> RunDispatcher | None:
    dispatcher: Any = request.app.state.dispatcher
    return cast(RunDispatcher | None, dispatcher)


def _coerce_positive_int(value: object) -> int | None:
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _github_app_repository_selection(
    payload: AgentRunCreate,
) -> tuple[int, tuple[int, ...]] | None:
    installation_id: int | None = None
    repository_ids: set[int] = set()
    for resource in payload.resources:
        if resource.kind.value != "repository":
            continue
        raw_installation_id = resource.metadata.get("github_installation_id")
        raw_repository_id = resource.metadata.get("github_repository_id")
        if raw_installation_id is None and raw_repository_id is None:
            continue
        current_installation_id = _coerce_positive_int(raw_installation_id)
        current_repository_id = _coerce_positive_int(raw_repository_id)
        if current_installation_id is None or current_repository_id is None:
            raise ValueError(
                "GitHub App repository resources require github_installation_id "
                "and github_repository_id"
            )
        if installation_id is None:
            installation_id = current_installation_id
        elif installation_id != current_installation_id:
            raise ValueError("selected GitHub App repositories must belong to one installation")
        repository_ids.add(current_repository_id)
    if installation_id is None:
        return None
    return installation_id, tuple(sorted(repository_ids))


async def _github_app_token_for_repository_refs(
    payload: AgentRunCreate,
    settings: Settings,
) -> str | None:
    selection = _github_app_repository_selection(payload)
    if selection is None:
        return None
    installation_id, repository_ids = selection
    try:
        return await create_github_app_installation_token(
            settings,
            installation_id=installation_id,
            repository_ids=repository_ids,
        )
    except GitHubAppConfigurationError as exc:
        raise ValueError(
            f"GitHub App is not configured for selected repositories: {', '.join(exc.missing)}"
        ) from exc
    except GitHubAppAPIError as exc:
        raise ValueError(f"failed to create GitHub App installation token: {exc}") from exc


async def _validate_repository_refs(payload: AgentRunCreate, settings: Settings) -> None:
    github_app_token = await _github_app_token_for_repository_refs(payload, settings)
    for resource in payload.resources:
        if resource.kind.value != "repository":
            continue
        uri = resource.uri
        ref = str(resource.metadata.get("ref") or "").strip()
        repo = str(resource.metadata.get("repo") or uri)
        token = github_app_token if resource.metadata.get("github_installation_id") else None
        if _FULL_HEX_SHA_RE.fullmatch(ref):
            continue
        if not await _repository_ref_exists(uri, ref, token=token):
            raise ValueError(
                f"repository ref not found for {repo}: {ref!r}. "
                "Use an existing branch, tag, or full 40-character commit SHA."
            )


async def _repository_ref_exists(uri: str, ref: str, *, token: str | None = None) -> bool:
    return await asyncio.to_thread(_repository_ref_exists_sync, uri, ref, token=token)


def _repository_ref_exists_sync(uri: str, ref: str, *, token: str | None = None) -> bool:
    if not ref:
        return False
    env = None
    if token:
        encoded = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env = {
            **os.environ,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {encoded}",
        }
    result = subprocess.run(
        [
            "git",
            "ls-remote",
            "--exit-code",
            uri,
            ref,
            f"refs/heads/{ref}",
            f"refs/tags/{ref}",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    if result.returncode == 0:
        return True
    if result.returncode == 2:
        return False
    details = (result.stderr or result.stdout).strip()
    raise ValueError(f"failed to validate repository ref {ref!r} for {uri}: {details}")


def _repo_from_ws(websocket: WebSocket) -> RunRepository:
    repository: Any = websocket.app.state.repository
    return cast(RunRepository, repository)


def _dispatcher_from_ws(websocket: WebSocket) -> RunDispatcher | None:
    dispatcher: Any = websocket.app.state.dispatcher
    return cast(RunDispatcher | None, dispatcher)


def _settings_from_ws(websocket: WebSocket) -> Settings:
    current_settings: Any = websocket.app.state.settings
    return cast(Settings, current_settings)

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager, suppress
from typing import Any, Protocol, cast
from uuid import UUID

from cloud_agent_contracts import (
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    EventType,
    HealthResponse,
    RunCancelRequest,
    RunEvent,
    RunFollowUpCreate,
)
from cloud_agent_platform.config import Settings, get_settings
from cloud_agent_platform.db import create_engine, create_session_factory
from cloud_agent_platform.errors import DispatchError, RepositoryError, RunNotFoundError
from cloud_agent_platform.repositories import RunRepository, SqlAlchemyRunRepository
from cloud_agent_platform.temporal.dispatcher import TemporalRunDispatcher
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
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

    @app.post(
        "/v1/runs",
        response_model=AgentRun,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_run(request: Request, payload: AgentRunCreate) -> AgentRun:
        repo = _repo(request)
        try:
            run = await repo.create_run(payload)
        except RepositoryError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

        current_dispatcher = _dispatcher(request)
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


def _repo(request: Request) -> RunRepository:
    repository: Any = request.app.state.repository
    return cast(RunRepository, repository)


def _dispatcher(request: Request) -> RunDispatcher | None:
    dispatcher: Any = request.app.state.dispatcher
    return cast(RunDispatcher | None, dispatcher)


def _repo_from_ws(websocket: WebSocket) -> RunRepository:
    repository: Any = websocket.app.state.repository
    return cast(RunRepository, repository)


def _dispatcher_from_ws(websocket: WebSocket) -> RunDispatcher | None:
    dispatcher: Any = websocket.app.state.dispatcher
    return cast(RunDispatcher | None, dispatcher)


def _settings_from_ws(websocket: WebSocket) -> Settings:
    current_settings: Any = websocket.app.state.settings
    return cast(Settings, current_settings)

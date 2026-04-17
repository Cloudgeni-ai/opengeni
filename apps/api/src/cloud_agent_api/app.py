from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Any, Protocol, cast
from uuid import UUID

from cloud_agent_contracts import AgentRun, AgentRunCreate, HealthResponse, RunEvent
from cloud_agent_platform.config import Settings, get_settings
from cloud_agent_platform.db import create_engine, create_session_factory
from cloud_agent_platform.errors import DispatchError, RepositoryError, RunNotFoundError
from cloud_agent_platform.repositories import RunRepository, SqlAlchemyRunRepository
from cloud_agent_platform.temporal.dispatcher import TemporalRunDispatcher
from fastapi import FastAPI, HTTPException, Request, status
from sqlalchemy import Engine


class RunDispatcher(Protocol):
    async def dispatch(self, run: AgentRun) -> str: ...


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

    return app


def _repo(request: Request) -> RunRepository:
    repository: Any = request.app.state.repository
    return cast(RunRepository, repository)


def _dispatcher(request: Request) -> RunDispatcher | None:
    dispatcher: Any = request.app.state.dispatcher
    return cast(RunDispatcher | None, dispatcher)

from infra_agent_contracts import AgentRunCreate, EventType, ResourceKind, ResourceRef
from infra_agent_platform.db import Base, create_engine, create_session_factory
from infra_agent_platform.repositories import InMemoryRunRepository, SqlAlchemyRunRepository


async def test_sqlalchemy_repository_persists_runs_and_events(tmp_path) -> None:  # type: ignore[no-untyped-def]
    engine = create_engine(f"sqlite:///{tmp_path / 'runs.db'}")
    with engine.begin() as connection:
        Base.metadata.create_all(connection)

    repository = SqlAlchemyRunRepository(create_session_factory(engine))

    run = await repository.create_run(AgentRunCreate(prompt="Run the smoke check"))
    await repository.append_event(run.id, EventType.RUN_STARTED, {"worker": "test"})
    events = await repository.list_events(run.id)

    engine.dispose()

    assert run.status == "queued"
    assert [event.type for event in events] == [EventType.RUN_CREATED, EventType.RUN_STARTED]


async def test_sqlalchemy_repository_marks_run_dispatched(tmp_path) -> None:  # type: ignore[no-untyped-def]
    engine = create_engine(f"sqlite:///{tmp_path / 'dispatch.db'}")
    with engine.begin() as connection:
        Base.metadata.create_all(connection)

    repository = SqlAlchemyRunRepository(create_session_factory(engine))

    run = await repository.create_run(AgentRunCreate(prompt="Dispatch this run"))
    updated = await repository.mark_dispatched(run.id, "workflow-123")
    events = await repository.list_events(run.id)

    engine.dispose()

    assert updated.status == "dispatched"
    assert updated.temporal_workflow_id == "workflow-123"
    assert [event.type for event in events] == [EventType.RUN_CREATED, EventType.RUN_DISPATCHED]
    assert events[-1].payload == {"workflow_id": "workflow-123", "status": "dispatched"}


async def test_sqlalchemy_repository_persists_multiple_resources(tmp_path) -> None:  # type: ignore[no-untyped-def]
    engine = create_engine(f"sqlite:///{tmp_path / 'resources.db'}")
    with engine.begin() as connection:
        Base.metadata.create_all(connection)

    repository = SqlAlchemyRunRepository(create_session_factory(engine))
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
                metadata={"ref": "v1"},
            ),
        ],
    )

    run = await repository.create_run(request)
    loaded = await repository.get_run(run.id)

    engine.dispose()

    assert [resource.metadata["mount_path"] for resource in loaded.resources] == [
        "repos/cloudgeni-ai/infra-agents",
        "repos/platform/modules",
    ]


async def test_in_memory_repository_marks_run_dispatched() -> None:
    repository = InMemoryRunRepository()

    run = await repository.create_run(AgentRunCreate(prompt="Dispatch this run"))
    updated = await repository.mark_dispatched(run.id, "workflow-123")
    events = await repository.list_events(run.id)

    assert updated.status == "dispatched"
    assert updated.temporal_workflow_id == "workflow-123"
    assert [event.type for event in events] == [EventType.RUN_CREATED, EventType.RUN_DISPATCHED]
    assert events[-1].payload == {"workflow_id": "workflow-123", "status": "dispatched"}


async def test_in_memory_repository_persists_multiple_resources() -> None:
    repository = InMemoryRunRepository()
    request = AgentRunCreate(
        prompt="Inspect repos",
        resources=[
            ResourceRef(
                kind=ResourceKind.REPOSITORY,
                uri="https://github.com/cloudgeni-ai/infra-agents",
                metadata={"ref": "main"},
            )
        ],
    )

    run = await repository.create_run(request)

    assert run.resources[0].metadata["mount_path"] == "repos/cloudgeni-ai/infra-agents"

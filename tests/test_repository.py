from cloud_agent_contracts import AgentRunCreate, EventType
from cloud_agent_platform.db import Base, create_engine, create_session_factory
from cloud_agent_platform.repositories import SqlAlchemyRunRepository


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

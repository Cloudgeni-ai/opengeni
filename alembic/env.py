from logging.config import fileConfig
from pathlib import Path

from infra_agent_platform.config import get_settings
from infra_agent_platform.db.models import Base
from sqlalchemy import engine_from_config, pool
from sqlalchemy.engine import Connection

from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _ensure_sqlite_parent(database_url: str) -> None:
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        return
    path = database_url.removeprefix(prefix)
    if path in {":memory:", ""}:
        return
    Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)


def _configuration() -> dict[str, str]:
    section = config.get_section(config.config_ini_section, {})
    database_url = get_settings().database_url
    _ensure_sqlite_parent(database_url)
    section["sqlalchemy.url"] = database_url
    return section


def run_migrations_offline() -> None:
    url = get_settings().database_url
    _ensure_sqlite_parent(url)
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        _configuration(),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        do_run_migrations(connection)


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

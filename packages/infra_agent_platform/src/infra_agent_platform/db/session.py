from pathlib import Path

from sqlalchemy import Engine
from sqlalchemy import create_engine as sqlalchemy_create_engine
from sqlalchemy.orm import Session, sessionmaker


def _ensure_sqlite_parent(database_url: str) -> None:
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        return
    path = database_url.removeprefix(prefix)
    if path in {":memory:", ""}:
        return
    Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)


def create_engine(database_url: str) -> Engine:
    _ensure_sqlite_parent(database_url)
    return sqlalchemy_create_engine(database_url, pool_pre_ping=True)


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)

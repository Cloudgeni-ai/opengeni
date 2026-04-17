from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AgentRunStatus(StrEnum):
    QUEUED = "queued"
    DISPATCHED = "dispatched"
    RUNNING = "running"
    WAITING = "waiting"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EventType(StrEnum):
    RUN_CREATED = "run.created"
    RUN_DISPATCHED = "run.dispatched"
    RUN_STARTED = "run.started"
    RUN_WAITING = "run.waiting"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    ARTIFACT_CREATED = "artifact.created"


class ResourceKind(StrEnum):
    REPOSITORY = "repository"
    OBJECT = "object"
    URL = "url"


class ArtifactKind(StrEnum):
    FILE = "file"
    DIRECTORY = "directory"
    LOG = "log"
    SNAPSHOT = "snapshot"


class ResourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ResourceKind
    uri: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ArtifactRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    run_id: UUID
    kind: ArtifactKind
    uri: str = Field(min_length=1)
    name: str | None = None
    media_type: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class AgentRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1)
    resource: ResourceRef | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentRun(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: AgentRunStatus
    prompt: str
    resource: ResourceRef | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    temporal_workflow_id: str | None = None
    created_at: datetime
    updated_at: datetime


class RunEvent(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    run_id: UUID
    sequence: int = Field(ge=1)
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class HealthResponse(BaseModel):
    service: str
    environment: str
    ok: bool

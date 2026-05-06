from datetime import datetime
from enum import StrEnum
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AgentRunStatus(StrEnum):
    QUEUED = "queued"
    DISPATCHED = "dispatched"
    RUNNING = "running"
    WAITING = "waiting"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ReasoningEffort(StrEnum):
    NONE = "none"
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    XHIGH = "xhigh"


class EventType(StrEnum):
    RUN_CREATED = "run.created"
    RUN_DISPATCHED = "run.dispatched"
    RUN_STARTED = "run.started"
    RUN_WAITING = "run.waiting"
    RUN_FOLLOW_UP_REQUESTED = "run.follow_up_requested"
    RUN_FOLLOW_UP = "run.follow_up"
    RUN_CANCEL_REQUESTED = "run.cancel_requested"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
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

    @model_validator(mode="after")
    def _normalize_repository_metadata(self) -> "ResourceRef":
        if self.kind != ResourceKind.REPOSITORY:
            return self

        parsed = urlparse(self.uri)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError("repository resources must use an HTTPS Git URL")

        raw_path = parsed.path.strip("/")
        if raw_path.endswith(".git"):
            raw_path = raw_path[: -len(".git")]
        parts = [part for part in raw_path.split("/") if part]
        if len(parts) < 2:
            raise ValueError("repository URL must include an owner/path and repository name")

        repo = "/".join(parts)
        metadata = dict(self.metadata)
        ref = str(metadata.get("ref") or "").strip()
        if not ref:
            raise ValueError("repository resources require metadata.ref")

        subpath = metadata.get("subpath")
        if subpath is not None:
            subpath = str(subpath).strip().strip("/") or None

        metadata.update(
            {
                "host": parsed.netloc.lower(),
                "repo": repo,
                "ref": ref,
                "subpath": subpath,
                "mount_path": "repos/" + repo,
            }
        )
        self.uri = f"https://{metadata['host']}/{repo}.git"
        self.metadata = metadata
        return self


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
    reasoning_effort: ReasoningEffort | None = None
    resources: list[ResourceRef] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _reject_duplicate_mount_paths(self) -> "AgentRunCreate":
        seen_mount_paths: set[str] = set()
        for resource in self.resources:
            mount_path = resource.metadata.get("mount_path")
            if isinstance(mount_path, str):
                if mount_path in seen_mount_paths:
                    raise ValueError(f"duplicate repository mount path: {mount_path}")
                seen_mount_paths.add(mount_path)
        return self


class RunFollowUpCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1)


class RunCancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = None


class AgentRun(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: AgentRunStatus
    prompt: str
    resources: list[ResourceRef] = Field(default_factory=list)
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


class GitHubAppManifestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_name: str | None = None
    organization: str | None = None
    public: bool = False
    include_ci_permissions: bool = True


class GitHubAppManifestStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_url: str
    state: str
    manifest: dict[str, Any]


class GitHubAppStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    configured: bool
    app_id: str | None = None
    client_id: str | None = None
    app_slug: str | None = None
    install_url: str | None = None
    missing: list[str] = Field(default_factory=list)


class GitHubRepository(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    installation_id: int
    full_name: str
    name: str
    private: bool
    html_url: str
    clone_url: str
    default_branch: str
    account_login: str
    account_type: str | None = None


class GitHubRepositoryList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repositories: list[GitHubRepository] = Field(default_factory=list)


class RunStreamEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    run: AgentRun | None = None
    event: RunEvent | None = None
    progress: dict[str, Any] | None = None
    error: str | None = None
    code: int | None = None

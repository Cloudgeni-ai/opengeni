from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class WorkflowRunInput:
    run_id: str
    prompt: str
    model: str
    sandbox_provider: str
    sandbox_app_name: str = ""
    sandbox_timeout: int = 300
    sandbox_image_ref: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class WorkflowRunProgress:
    run_id: str
    state: str
    turn: int
    queue_depth: int
    cancellation_requested: bool
    waiting_for_follow_up: bool
    last_output: str | None = None


@dataclass(frozen=True)
class WorkflowRunResult:
    run_id: str
    final_output: str

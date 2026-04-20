from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from agents.sandbox.session.sandbox_session_state import SandboxSessionState
from pydantic import Field


@dataclass(frozen=True)
class ModalSandboxClientOptions:
    timeout_seconds: int = 900
    idle_timeout_seconds: int | None = 300
    image_ref: str | None = None
    env: Mapping[str, str | None] = field(default_factory=dict)


class ModalSandboxSessionState(SandboxSessionState):
    type: Literal["modal"] = "modal"
    sandbox_id: str | None = None
    app_name: str = Field(min_length=1)

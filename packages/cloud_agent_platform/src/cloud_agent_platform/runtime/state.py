from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RuntimeRunState:
    run_id: str
    prompt: str
    model: str
    sandbox_provider: str
    metadata: dict[str, Any] = field(default_factory=dict)

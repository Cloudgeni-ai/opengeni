"""Typed configuration for scenario-owned smoke sandboxes."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

DEFAULT_SANDBOX_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class SandboxConfig:
    """How the fixture creates its scenario-owned sandbox.

    `timeout` is E2B's sandbox timeout: how long the sandbox may sit idle
    before it pauses. It is saved to disk as soon as it pauses, so an idle
    timeout always ends with its state durable, like SPACE's pause-on-timeout
    default. `sleep` replaces those settings with the host agent's own sleep
    fields, such as `{"pause_after_ms": 1000, "save_after_ms": 1000}`.
    """

    timeout: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS
    vcpus: int = 1
    memory_mib: int = 512
    sleep: Mapping[str, int | bool] | None = None

    def __post_init__(self) -> None:
        if self.timeout <= 0:
            raise ValueError("sandbox timeout must be positive")
        if not 1 <= self.vcpus <= 32:
            raise ValueError("sandbox vcpus must be between 1 and 32")
        if not 128 <= self.memory_mib <= 65_536:
            raise ValueError("sandbox memory must be between 128 and 65536 MiB")

    def host_config(self) -> dict[str, Any]:
        """The `config` of the host agent's `create` request."""

        if self.sleep is not None:
            sleep = dict(self.sleep)
        else:
            idle_ms = self.timeout * 1000
            sleep = {"pause_after_ms": idle_ms, "save_after_ms": idle_ms}
        return {"vcpus": self.vcpus, "memory_mib": self.memory_mib, "sleep": sleep}

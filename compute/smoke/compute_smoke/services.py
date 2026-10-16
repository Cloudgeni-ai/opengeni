"""What scenarios run against: one host agent and its sandboxes.

SPACE's smoke runner reaches several backends through many service
adapters; Opengeni compute has one, the host agent's local API, so this is
the whole adapter.
"""

from __future__ import annotations

import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, TypeVar
from uuid import uuid4

from compute_smoke.client import HostAgent, HostAgentError, Sandbox
from compute_smoke.config import SandboxConfig
from compute_smoke.runtime import ScenarioContext, SmokeConfigurationError

Fixture = TypeVar("Fixture")

# How long a new sandbox may take to boot and answer its first request.
READY_TIMEOUT_SECONDS = 120.0
# How long a restarted host agent may take to answer again.
RESTART_TIMEOUT_SECONDS = 60.0


class MissingToolError(SmokeConfigurationError):
    """A tool a scenario requires is not installed."""


@dataclass(frozen=True)
class SmokeServices:
    """The host agent under test and how to reach the guest service."""

    host: HostAgent
    guest_port: int = 53
    # Restarts the host agent, for scenarios that prove sandboxes survive it.
    restart_command: Sequence[str] | None = None

    def fixture(
        self,
        fixture_type: type[Fixture],
        context: ScenarioContext,
        *,
        scenario_id: str,
        sandbox: SandboxConfig,
        sandbox_count: int,
    ) -> Fixture:
        """Create the scenario's sandboxes, wait until each answers, and
        register their removal with the scenario's cleanup."""

        context.record("scenario_id", scenario_id)
        sandboxes: list[Sandbox] = []
        for _ in range(sandbox_count):
            sandbox_id = uuid4().hex
            self.host.create(sandbox_id, sandbox.host_config())
            context.scope.defer(
                f"remove sandbox {sandbox_id}",
                lambda sandbox_id=sandbox_id: self._remove(sandbox_id),
                critical=True,
            )
            sandboxes.append(
                Sandbox(
                    self.host,
                    sandbox_id,
                    guest_port=self.guest_port,
                    timeout=sandbox.timeout,
                )
            )
        context.record("sandbox_ids", [handle.sandbox_id for handle in sandboxes])
        started = time.monotonic()
        for handle in sandboxes:
            handle.ping(timeout=READY_TIMEOUT_SECONDS)
        context.record("sandbox_ready_seconds", time.monotonic() - started)
        build: Any = fixture_type
        return build(
            context,
            sandboxes[0],
            self,
            tuple(sandboxes),
            sandbox.timeout,
        )

    def _remove(self, sandbox_id: str) -> None:
        try:
            self.host.remove(sandbox_id)
        except HostAgentError as error:
            # A scenario may have deleted it already.
            if "no sandbox" not in str(error):
                raise

    def restart_host_agent(self, context: ScenarioContext) -> None:
        """Restart the host agent and wait until it answers again."""

        if not self.restart_command:
            raise SmokeConfigurationError(
                "restarting the host agent needs COMPUTE_SMOKE_RESTART_AGENT, "
                "a command that restarts it"
            )
        started = time.monotonic()
        subprocess.run(  # the operator's own command
            list(self.restart_command),
            check=True,
            timeout=RESTART_TIMEOUT_SECONDS,
        )
        deadline = time.monotonic() + RESTART_TIMEOUT_SECONDS
        while True:
            try:
                self.host.status()
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        context.record("host_agent_restart_seconds", time.monotonic() - started)

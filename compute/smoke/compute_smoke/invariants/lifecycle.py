# Derived from SPACE's space_smoke/invariants/lifecycle.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""Reusable lifecycle invariant proofs."""

from __future__ import annotations

from collections.abc import Callable
from typing import NoReturn

from compute_smoke.client import Sandbox, SandboxState
from compute_smoke.runtime import (
    InvariantViolation,
    ScenarioContext,
    ScenarioTimedOut,
    SmokeConfigurationError,
)

_MARKER = "space-smoke-idle-deadline-reset-ok"
_MIN_COMPLETION_HEADROOM_SECONDS = 10


def prove_idle_deadline_reset(
    context: ScenarioContext,
    sandbox: Sandbox,
    *,
    sandbox_timeout: int,
    reset_after: float,
    verify_after_reset: float,
    reset: Callable[[], None],
) -> None:
    """Prove that one action moves a sandbox's idle deadline forward."""

    _validate_window(
        sandbox_timeout=sandbox_timeout,
        reset_after=reset_after,
        verify_after_reset=verify_after_reset,
    )
    context.record("timeout_seconds", sandbox_timeout)
    context.record("reset_after_seconds", reset_after)
    context.record("verify_after_reset_seconds", verify_after_reset)
    context.record(
        "original_deadline_exceeded_by_seconds",
        reset_after + verify_after_reset - sandbox_timeout,
    )
    context.record(
        "renewed_deadline_remaining_seconds",
        sandbox_timeout - verify_after_reset,
    )

    with context.phase("wait before resetting sandbox idle deadline"):
        context.wait(reset_after)

    with context.phase("reset sandbox idle deadline"):
        try:
            reset()
        except (InvariantViolation, ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:  # noqa: BLE001 - public rejection fails invariant
            _fail_operation(
                context,
                sandbox,
                "sandbox idle deadline reset failed",
                operation="reset idle deadline",
                error=error,
            )

    with context.phase("wait beyond original sandbox deadline"):
        context.wait(verify_after_reset)

    with context.phase("observe sandbox after original deadline"):
        try:
            observed = sandbox.get_info()
        except (InvariantViolation, ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:  # noqa: BLE001 - public rejection fails invariant
            _fail_operation(
                context,
                sandbox,
                "sandbox state was unavailable after its idle deadline was reset",
                operation="read sandbox state",
                error=error,
            )
        context.verify(
            observed.state is SandboxState.RUNNING,
            "sandbox was not running after its idle deadline was reset",
            expected_state=SandboxState.RUNNING.value,
            observed_state=(observed.state.value if observed.state is not None else "unknown"),
        )

    with context.phase("verify sandbox remains usable after idle deadline reset"):
        try:
            result = sandbox.run(f"printf %s {_MARKER}")
        except (InvariantViolation, ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:  # noqa: BLE001 - public rejection fails invariant
            _fail_operation(
                context,
                sandbox,
                "sandbox was not usable after its idle deadline was reset",
                operation="run marker command",
                error=error,
            )
        context.verify(
            (result.exit_code, result.stdout) == (0, _MARKER),
            "sandbox was not usable after its idle deadline was reset",
            expected=(0, _MARKER),
            actual=(result.exit_code, result.stdout),
            command_stderr=result.stderr,
        )


def _validate_window(
    *,
    sandbox_timeout: int,
    reset_after: float,
    verify_after_reset: float,
) -> None:
    if sandbox_timeout <= 0:
        raise SmokeConfigurationError("sandbox timeout must be positive")
    if reset_after <= 0:
        raise SmokeConfigurationError("idle deadline reset delay must be positive")
    if verify_after_reset <= 0:
        raise SmokeConfigurationError("idle deadline verification delay must be positive")
    if reset_after + verify_after_reset <= sandbox_timeout:
        raise SmokeConfigurationError("idle deadline proof must finish after the original timeout")
    if sandbox_timeout - verify_after_reset < _MIN_COMPLETION_HEADROOM_SECONDS:
        raise SmokeConfigurationError(
            "idle deadline proof must reserve at least "
            f"{_MIN_COMPLETION_HEADROOM_SECONDS} seconds before the renewed timeout"
        )


def _fail_operation(
    context: ScenarioContext,
    sandbox: Sandbox,
    message: str,
    *,
    operation: str,
    error: Exception,
) -> NoReturn:
    context.verify(
        False,
        message,
        operation=operation,
        operation_error_type=type(error).__name__,
        operation_error=str(error),
        **_public_state_evidence(sandbox),
    )
    raise AssertionError("unreachable lifecycle invariant failure") from error


def _public_state_evidence(sandbox: Sandbox) -> dict[str, object]:
    try:
        observed = sandbox.get_info()
    except Exception as error:  # noqa: BLE001 - diagnostics never mask failure
        return {
            "observed_state": "unavailable",
            "state_error_type": type(error).__name__,
            "state_error": str(error),
        }
    return {"observed_state": observed.state.value if observed.state is not None else "unknown"}

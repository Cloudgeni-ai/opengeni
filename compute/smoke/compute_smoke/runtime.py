# Derived from SPACE's space_smoke/runtime.py (https://github.com/perplexityai/SPACE, Apache-2.0,
# Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
"""Execution, evidence, subprocess, and cleanup primitives."""

from __future__ import annotations

import signal
import subprocess
import threading
import time
import traceback
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Protocol

from compute_smoke.model import ScenarioResult, Verdict

REPO_ROOT = Path(__file__).resolve().parents[1]


class SmokeConfigurationError(RuntimeError):
    """The scenario cannot safely run with the supplied configuration."""


class InvariantViolation(AssertionError):
    """A completed observation disproved the scenario invariant."""


class InconclusiveSmoke(RuntimeError):
    """The scenario did not collect enough evidence for a verdict."""


class QuarantinedSmoke(RuntimeError):
    """A known, narrowly classified failure occurred and remains visible."""


class ScenarioTimedOut(RuntimeError):
    """The scenario exceeded its declared wall-clock budget."""


@dataclass(frozen=True)
class CommandResult:
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    def detail(self) -> str:
        return (self.stderr or self.stdout).strip()


class CommandExecutor(Protocol):
    def run(
        self,
        command: Sequence[str],
        *,
        input_text: str | None = None,
        timeout: float | None = None,
        env: Mapping[str, str | None] | None = None,
    ) -> CommandResult: ...


class SubprocessExecutor:
    def __init__(
        self,
        *,
        cwd: Path = REPO_ROOT,
        base_env: Mapping[str, str] | None = None,
    ) -> None:
        self.cwd = cwd
        self.base_env = dict(base_env or {})

    def run(
        self,
        command: Sequence[str],
        *,
        input_text: str | None = None,
        timeout: float | None = None,
        env: Mapping[str, str | None] | None = None,
    ) -> CommandResult:
        command_env = dict(self.base_env)
        if env is not None:
            for name, value in env.items():
                if value is None:
                    command_env.pop(name, None)
                else:
                    command_env[name] = value
        try:
            completed = subprocess.run(
                list(command),
                cwd=self.cwd,
                env=command_env if command_env or env is not None else None,
                input=input_text,
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
            return CommandResult(
                tuple(command),
                completed.returncode,
                completed.stdout,
                completed.stderr,
            )
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout or ""
            stderr = error.stderr or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode(errors="replace")
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors="replace")
            return CommandResult(
                tuple(command),
                124,
                stdout,
                f"{stderr}\ncommand timed out after {timeout}s".lstrip(),
            )
        except OSError as error:
            return CommandResult(tuple(command), 127, "", str(error))


@dataclass(frozen=True)
class CleanupFailure:
    name: str
    detail: str
    critical: bool


class Compensation:
    def __init__(
        self,
        name: str,
        callback: Callable[[], None],
        *,
        critical: bool,
    ) -> None:
        self.name = name
        self.callback = callback
        self.critical = critical
        self.armed = True

    def release(self) -> None:
        if not self.armed:
            return
        self.callback()
        self.armed = False

    def disarm(self) -> None:
        self.armed = False


class BackgroundWork:
    """Run a callable on its own thread and make its join a verdict.

    A scenario puts work on a thread to hold a window open — callers firing,
    a cap lifter waiting for the first refusal, a pod watch — while the
    scenario acts on the main thread. Its evidence counts only if the work
    finished (a timed `Thread.join` returns whether or not it did), did not die
    (a dead thread leaves an empty holder that satisfies any subset check), and
    surfaced its exception where the scenario can see it. `join` states all
    three, so a scenario never infers them from a short outcome list.
    """

    def __init__(self, name: str, target: Callable[[], None]) -> None:
        self.name = name
        self._target = target
        self._failure: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)

    def _run(self) -> None:
        try:
            self._target()
        except BaseException as error:  # noqa: BLE001 - re-raised on the scenario thread by join
            self._failure = error

    def start(self) -> BackgroundWork:
        self._thread.start()
        return self

    @property
    def running(self) -> bool:
        return self._thread.is_alive()

    def join(self, *, timeout: float) -> None:
        """Wait up to `timeout` seconds; fail if the work is still running, re-raise if it died."""

        self._thread.join(timeout)
        if self._thread.is_alive():
            raise InvariantViolation(
                f"{self.name} was still running {timeout:g} s after its join deadline"
            )
        if self._failure is not None:
            raise self._failure


def background(name: str, target: Callable[[], None]) -> BackgroundWork:
    """Start `target` on a named thread whose `join` is a verdict (see [`BackgroundWork`])."""

    return BackgroundWork(name, target).start()


class ResourceScope:
    """Run cleanup in reverse registration order and report every failure."""

    def __init__(self) -> None:
        self._compensations: list[Compensation] = []

    def defer(
        self,
        name: str,
        callback: Callable[[], None],
        *,
        critical: bool = False,
    ) -> Compensation:
        compensation = Compensation(name, callback, critical=critical)
        self._compensations.append(compensation)
        return compensation

    def close(
        self,
        *,
        timeout_seconds: float | None = None,
    ) -> tuple[CleanupFailure, ...]:
        failures: list[CleanupFailure] = []
        deadline = time.monotonic() + timeout_seconds if timeout_seconds is not None else None
        for compensation in reversed(self._compensations):
            if not compensation.armed:
                continue
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                failures.append(
                    CleanupFailure(
                        compensation.name,
                        "cleanup deadline exhausted before compensation ran",
                        compensation.critical,
                    )
                )
                continue
            try:
                with _scenario_deadline(remaining, label="cleanup"):
                    compensation.release()
            except Exception as error:  # noqa: BLE001 - cleanup must continue
                failures.append(
                    CleanupFailure(
                        compensation.name,
                        f"{type(error).__name__}: {error}",
                        compensation.critical,
                    )
                )
        return tuple(failures)


@dataclass
class ScenarioContext:
    scope: ResourceScope
    evidence: dict[str, object]

    def record(self, name: str, value: object) -> None:
        self.evidence[name] = value

    def verify(
        self,
        condition: bool,
        message: str,
        **evidence: object,
    ) -> None:
        self.evidence.update(evidence)
        if not condition:
            raise InvariantViolation(message)

    def warn(self, message: str, **evidence: object) -> None:
        self.evidence.update(evidence)
        raise QuarantinedSmoke(message)

    def wait(self, seconds: float) -> None:
        if seconds <= 0:
            raise ValueError("wait duration must be positive")
        time.sleep(seconds)

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        started = time.monotonic()
        print(f"--- {name}", flush=True)
        try:
            yield
        finally:
            self.evidence.setdefault("phases", [])
            phases = self.evidence["phases"]
            assert isinstance(phases, list)
            phases.append({"name": name, "duration_seconds": time.monotonic() - started})


Body = Callable[[ScenarioContext], None]


@contextmanager
def _scenario_deadline(
    timeout_seconds: float | None,
    *,
    label: str,
) -> Iterator[None]:
    if timeout_seconds is None:
        yield
        return
    if timeout_seconds <= 0:
        raise ValueError("scenario timeout must be positive")
    if threading.current_thread() is not threading.main_thread():
        raise SmokeConfigurationError("scenario timeout enforcement requires the main thread")
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise SmokeConfigurationError(
            "scenario timeout enforcement cannot replace an existing alarm"
        )

    previous_handler = signal.getsignal(signal.SIGALRM)

    def timeout(_signal_number: int, _frame: FrameType | None) -> None:
        raise ScenarioTimedOut(f"{label} timed out after {timeout_seconds:g}s")

    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, timeout_seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def execute_scenario(
    *,
    title: str,
    body: Body,
    timeout_seconds: float | None = None,
) -> ScenarioResult:
    scope = ResourceScope()
    context = ScenarioContext(scope, {})
    cleanup_timeout = min(120.0, timeout_seconds * 0.1) if timeout_seconds is not None else None
    execution_timeout = (
        timeout_seconds - cleanup_timeout
        if timeout_seconds is not None and cleanup_timeout is not None
        else None
    )
    try:
        with _scenario_deadline(execution_timeout, label="scenario execution"):
            body(context)
        result = ScenarioResult(Verdict.PASS, f"{title} passed", dict(context.evidence))
    except InvariantViolation as error:
        result = ScenarioResult(Verdict.FAIL, str(error), dict(context.evidence))
    except QuarantinedSmoke as error:
        result = ScenarioResult(Verdict.WARN, str(error), dict(context.evidence))
    except ScenarioTimedOut as error:
        result = ScenarioResult(Verdict.INFRA_ERROR, str(error), dict(context.evidence))
    except (InconclusiveSmoke, SmokeConfigurationError) as error:
        result = ScenarioResult(Verdict.INCONCLUSIVE, str(error), dict(context.evidence))
    except Exception as error:  # noqa: BLE001 - scenario boundary classifies infra
        result = ScenarioResult(
            Verdict.INFRA_ERROR,
            f"{type(error).__name__}: {error}",
            dict(context.evidence),
            diagnostics=(traceback.format_exc(),),
        )

    cleanup_failures = scope.close(timeout_seconds=cleanup_timeout)
    if not cleanup_failures:
        return result

    details = tuple(f"{failure.name}: {failure.detail}" for failure in cleanup_failures)
    if any(failure.critical for failure in cleanup_failures) and result.verdict in (
        Verdict.PASS,
        Verdict.WARN,
        Verdict.INCONCLUSIVE,
    ):
        return ScenarioResult(
            Verdict.INFRA_ERROR,
            f"{result.summary}; critical cleanup failed",
            result.evidence,
            details,
            result.diagnostics,
        )
    return ScenarioResult(
        result.verdict,
        result.summary,
        result.evidence,
        details,
        result.diagnostics,
    )

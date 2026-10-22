# Derived from SPACE's space_smoke/fixtures.py (https://github.com/perplexityai/SPACE, Apache-2.0,
# Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
"""The fixtures scenarios are written against.

`CommandSandboxFixture` and `Ecw` keep SPACE's method names and failure
messages so its scenarios run unchanged. Underneath, every operation goes to
the host agent's local API and to the reference guest service inside the
sandbox; see `compute_smoke.client`. A few helpers name Opengeni compute's own
sleep levels and are marked as such.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, ClassVar

from compute_smoke.client import (
    LEVELS,
    CommandResult,
    FilesystemEvent,
    ProcessHandle,
    ProcessInfo,
    Sandbox,
    SandboxInfo,
    SandboxState,
    SandboxUnavailable,
    WatchHandle,
)
from compute_smoke.config import DEFAULT_SANDBOX_TIMEOUT_SECONDS
from compute_smoke.invariants.lifecycle import prove_idle_deadline_reset
from compute_smoke.runtime import (
    InvariantViolation,
    ScenarioContext,
    ScenarioTimedOut,
    SmokeConfigurationError,
)

if TYPE_CHECKING:
    from compute_smoke.services import SmokeServices

SIGKILL = 9

# Every level at which a sandbox sleeps.
ASLEEP_LEVELS = tuple(level for level in LEVELS if level != "running")
# Where a copy of an asleep sandbox's state survives its VM process ending.
DURABLE = ("local", "remote")
# How long a woken sandbox may take to show as running with no step in the
# host agent's status, observed without touching it.
WOKEN_SETTLE_SECONDS = 5


def levels_from(level: str) -> tuple[str, ...]:
    """`level` and every deeper level."""

    if level not in LEVELS:
        raise SmokeConfigurationError(f"unknown sleep level {level!r}")
    return LEVELS[LEVELS.index(level) :]


@dataclass(frozen=True)
class EcwDirectoryWatcher:
    """A scenario-owned watcher with bounded event polling."""

    _context: ScenarioContext
    _handle: WatchHandle
    _root: PurePosixPath

    def expect_change(
        self,
        path: str,
        *,
        timeout_seconds: float = 5,
        every_seconds: float = 0.2,
    ) -> None:
        """Require an event for one exact path relative to the watched root."""

        if timeout_seconds <= 0:
            raise ValueError("watcher timeout must be positive")
        if every_seconds <= 0:
            raise ValueError("watcher interval must be positive")
        try:
            expected_name = PurePosixPath(path).relative_to(self._root).as_posix()
        except ValueError as error:
            raise ValueError(
                f"expected watcher path {path!r} must be inside {self._root}"
            ) from error
        if expected_name == ".":
            raise ValueError("expected watcher path must name an entry")

        deadline = time.monotonic() + timeout_seconds
        observed: list[FilesystemEvent] = []
        while True:
            try:
                observed.extend(self._handle.get_new_events())
            except (ScenarioTimedOut, SmokeConfigurationError):
                raise
            except Exception as error:
                self._context.verify(
                    False,
                    "filesystem watcher events could not be read",
                    expected_watcher_path=expected_name,
                    watcher_events=_watcher_event_evidence(observed),
                    watcher_poll_error_type=type(error).__name__,
                    watcher_poll_error=str(error),
                )
                raise AssertionError("unreachable watcher poll failure") from error

            if any(event.name.removeprefix("./") == expected_name for event in observed):
                self._context.record("watcher_events", _watcher_event_evidence(observed))
                return
            if time.monotonic() >= deadline:
                self._context.verify(
                    False,
                    "filesystem watcher did not observe the file",
                    expected_watcher_path=expected_name,
                    watcher_events=_watcher_event_evidence(observed),
                )
            self._context.wait(min(every_seconds, max(0.001, deadline - time.monotonic())))


def _watcher_event_evidence(
    events: Sequence[FilesystemEvent],
) -> list[dict[str, str]]:
    return [{"name": event.name, "type": event.type} for event in events]


@dataclass(frozen=True)
class CommandSandboxFixture:
    """Shared scenario behavior over a command-capable sandbox."""

    _context: ScenarioContext
    sandbox: Sandbox
    _services: SmokeServices
    sandboxes: tuple[Sandbox, ...] = ()
    _sandbox_timeout: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS

    fixture_name: ClassVar[str] = "command_sandbox"
    timeout_minutes: ClassVar[int] = 30
    lifecycle_transition_timeout: ClassVar[int] = 60
    lifecycle_poll_interval: ClassVar[float] = 1
    process_transition_timeout: ClassVar[float] = 60
    sandbox_delete_failure_message: ClassVar[str] = "sandbox deletion did not complete"

    def phase(self, name: str) -> AbstractContextManager[None]:
        return self._context.phase(name)

    def record(self, name: str, value: object) -> None:
        """Attach a named fact to the scenario's evidence without asserting it."""
        self._context.record(name, value)

    def verify(
        self,
        condition: bool,
        message: str,
        *,
        failure_evidence: Callable[[], Mapping[str, object]] | None = None,
        **evidence: object,
    ) -> None:
        if not condition and failure_evidence is not None:
            evidence.update(failure_evidence())
        self._context.verify(condition, message, **evidence)

    def warn(self, message: str, **evidence: object) -> None:
        """End the scenario QUARANTINED: a known, narrowly classified failure.

        Callers must classify before calling; an unclassified failure is a
        `verify` failure, never a warning.
        """

        self._context.warn(message, **evidence)

    def delete_sandbox(self, sandbox: Sandbox | None = None) -> int:
        """Delete a run-owned sandbox; returns how many were deleted."""

        target = sandbox or self.sandbox
        try:
            target.kill()
        except (ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:
            self.verify(
                False,
                self.sandbox_delete_failure_message,
                deleted_sandbox_id=target.sandbox_id,
                delete_error_type=type(error).__name__,
                delete_error=str(error),
            )
            raise AssertionError("unreachable sandbox deletion failure") from error
        return 1

    def wait_until_deleted(self, sandbox: Sandbox | None = None) -> None:
        """Wait for the host agent to stop reporting the sandbox."""

        target = sandbox or self.sandbox
        deadline = time.monotonic() + self.lifecycle_transition_timeout
        while True:
            observed = target.try_get_info()
            if observed is None or time.monotonic() >= deadline:
                break
            self._context.wait(self.lifecycle_poll_interval)
        self.verify(
            observed is None,
            "sandbox remained visible through the public API after deletion",
            deleted_sandbox_id=target.sandbox_id,
            observed_state="deleted" if observed is None else "present",
        )

    def run_command(
        self,
        command: str,
        *,
        timeout: int = 60,
        envs: Mapping[str, str] | None = None,
        failure_message: str = "sandbox command did not complete",
        failure_evidence: Callable[[], Mapping[str, object]] | None = None,
    ) -> CommandResult:
        """Run a command and classify client failures as failed invariants."""

        started_at = time.monotonic()
        try:
            return self.sandbox.run(command, timeout=timeout, envs=envs)
        except (ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:
            self.verify(
                False,
                failure_message,
                failure_evidence=failure_evidence,
                command_elapsed_seconds=time.monotonic() - started_at,
                command_error_type=type(error).__name__,
                command_error=str(error),
            )
            raise AssertionError("unreachable command failure") from error

    def run_command_when_ready(
        self,
        command: str,
        *,
        timeout: int = 60,
        envs: Mapping[str, str] | None = None,
        failure_message: str = "sandbox command data plane did not become ready",
    ) -> CommandResult:
        """Run a command. The host agent wakes the sandbox and holds the
        connection until the guest answers, so no readiness retry is needed."""

        return self.run_command(
            command,
            timeout=timeout,
            envs=envs,
            failure_message=failure_message,
        )

    def wait_until_command_matches(
        self,
        command: str,
        *,
        stdout: str,
        exit_code: int = 0,
        timeout: int = 10,
        failure_message: str = "sandbox command result did not become ready",
    ) -> CommandResult:
        """Poll a command until its exact result proves the requested readiness."""

        started_at = time.monotonic()
        deadline = started_at + timeout
        attempts = 0
        while True:
            remaining = deadline - time.monotonic()
            attempts += 1
            result = self.run_command(
                command,
                timeout=max(1, int(remaining) + 1),
                failure_message=failure_message,
            )
            if (result.exit_code, result.stdout) == (exit_code, stdout):
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.verify(
                    False,
                    failure_message,
                    readiness_attempts=attempts,
                    readiness_elapsed_seconds=time.monotonic() - started_at,
                    command_exit_code=result.exit_code,
                    command_stdout=result.stdout,
                    command_stderr=result.stderr,
                )
            self._context.wait(min(self.lifecycle_poll_interval, remaining))

    def suspend_durably(self) -> None:
        """Put the sandbox to sleep with its memory saved to disk and its VM
        process ended, then wait until it got there."""

        self.sleep_to("saved")

    def wake_from_durable_suspend(self) -> None:
        """Wake the sandbox through the host agent, then observe it running
        without touching it again."""

        try:
            self.sandbox.connect(timeout=self.lifecycle_transition_timeout)
        except (ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:  # noqa: BLE001 - client outcome is the invariant
            self.verify(
                False,
                "sandbox wake did not complete",
                sandbox_id=self.sandbox.sandbox_id,
                wake_error_type=type(error).__name__,
                wake_error=str(error),
            )
        self.wait_until_woken()

    def wait_until_woken(self, *, sandbox: Sandbox | None = None) -> SandboxInfo:
        """Passively wait until a sandbox the host agent reported woken shows
        as running with no step in progress."""

        return self.wait_until_level(
            ("running",),
            sandbox=sandbox,
            timeout=min(WOKEN_SETTLE_SECONDS, self.lifecycle_transition_timeout),
        )

    # Opengeni compute: its sleep levels, by name.

    def sleep_to(self, level: str, *, sandbox: Sandbox | None = None) -> SandboxInfo:
        """Ask the host agent to put the sandbox at least as deep as `level`
        and wait until it is there with no step running."""

        target = sandbox or self.sandbox
        wanted = levels_from(level)
        try:
            target.sleep(level)
        except (ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:  # noqa: BLE001 - client outcome is the invariant
            self.verify(
                False,
                f"sandbox did not accept a request to sleep to {level}",
                sandbox_id=target.sandbox_id,
                sleep_error_type=type(error).__name__,
                sleep_error=str(error),
            )
        return self.wait_until_level(wanted, sandbox=target)

    def wait_until_level(
        self,
        levels: Iterable[str],
        *,
        sandbox: Sandbox | None = None,
        timeout: float | None = None,
    ) -> SandboxInfo:
        """Wait until the sandbox is at one of `levels` with no step running."""

        target = sandbox or self.sandbox
        wanted = tuple(levels)
        deadline = time.monotonic() + (
            self.lifecycle_transition_timeout if timeout is None else timeout
        )
        while True:
            observed = target.try_get_info()
            if observed is not None and observed.level in wanted and observed.step is None:
                return observed
            if time.monotonic() >= deadline:
                break
            self._context.wait(min(0.1, self.lifecycle_poll_interval))
        self.verify(
            False,
            f"sandbox did not reach {' or '.join(wanted)} in time",
            sandbox_id=target.sandbox_id,
            expected_levels=list(wanted),
            observed=_info_evidence(observed),
        )
        raise AssertionError("unreachable level wait")

    def wait_until_durable(self, *, sandbox: Sandbox | None = None) -> SandboxInfo:
        """Wait until the sandbox sleeps with a saved copy of its memory and
        files, so nothing is lost if its VM process ends."""

        target = sandbox or self.sandbox
        deadline = time.monotonic() + self.lifecycle_transition_timeout
        while True:
            observed = target.try_get_info()
            if (
                observed is not None
                and observed.level in ASLEEP_LEVELS
                and observed.durability in DURABLE
                and observed.memory_saved
                and observed.step is None
            ):
                return observed
            if time.monotonic() >= deadline:
                break
            self._context.wait(min(0.1, self.lifecycle_poll_interval))
        self.verify(
            False,
            "sandbox did not sleep with a saved copy in time",
            sandbox_id=target.sandbox_id,
            observed=_info_evidence(observed),
        )
        raise AssertionError("unreachable durability wait")

    def restart_host_agent(self) -> None:
        """Stop and start the host agent, then wait until it answers."""

        self._services.restart_host_agent(self._context)

    def start_background_process(self, command: str, *, timeout: int = 60) -> ProcessHandle:
        return self.sandbox.start_background(command, timeout=timeout)

    def list_processes(self) -> tuple[ProcessInfo, ...]:
        return self.sandbox.list_processes()

    def get_process(self, process_id: str) -> ProcessInfo | None:
        return self.sandbox.get_process(process_id)

    def signal_process(self, process_id: str, signal: int) -> bool:
        return self.sandbox.signal_process(process_id, signal)

    def kill_process(self, process_id: str) -> bool:
        return self.sandbox.signal_process(process_id, SIGKILL)

    def wait_until_process_stopped(
        self, process_id: str
    ) -> tuple[tuple[ProcessInfo, ...], ProcessInfo | None]:
        deadline = time.monotonic() + self.process_transition_timeout
        while True:
            processes = self.list_processes()
            process = self.get_process(process_id)
            if not any(item.process_id == process_id for item in processes) and process is None:
                return processes, process
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return processes, process
            self._context.wait(min(self.lifecycle_poll_interval, remaining))

    def expect_command(
        self,
        result: CommandResult,
        *,
        exit_code: int = 0,
        stdout: str,
    ) -> None:
        """Require one command's exit code and exact standard output."""

        actual = (result.exit_code, result.stdout)
        expected = (exit_code, stdout)
        self.verify(
            actual == expected,
            "sandbox command result did not match",
            expected=expected,
            actual=actual,
            command_exit_code=result.exit_code,
            command_stdout=result.stdout,
            command_stderr=result.stderr,
        )


@dataclass(frozen=True)
class Ecw(CommandSandboxFixture):
    """A scenario-owned sandbox reached the way an E2B-style client would."""

    fixture_name: ClassVar[str] = "ecw"
    timeout_minutes: ClassVar[int] = 30
    process_connect_retry_delays: ClassVar[tuple[float, ...]] = (0.5, 1, 2)
    sandbox_delete_failure_message: ClassVar[str] = "ECW sandbox deletion did not complete"

    def wait(self, seconds: float, *, reason: str | None = None) -> None:
        if reason is None:
            self._context.wait(seconds)
            return
        with self.phase(f"wait {reason}"):
            self._context.wait(seconds)

    @contextmanager
    def watch_directory(
        self,
        path: str,
        *,
        recursive: bool = False,
    ) -> Iterator[EcwDirectoryWatcher]:
        """Create a watcher and require it to stop after its invariant."""

        try:
            handle = self.sandbox.watch_dir(path, recursive=recursive)
        except (ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:
            self.verify(
                False,
                "filesystem watcher could not be created",
                watcher_path=path,
                watcher_recursive=recursive,
                watcher_create_error_type=type(error).__name__,
                watcher_create_error=str(error),
            )
            raise AssertionError("unreachable watcher creation failure") from error

        cleanup = self._context.scope.defer(
            f"stop filesystem watcher for {path}",
            handle.stop,
        )
        watcher = EcwDirectoryWatcher(self._context, handle, PurePosixPath(path))
        body_completed = False
        try:
            yield watcher
            body_completed = True
        finally:
            # On a body failure, leave cleanup armed for the scenario scope.
            if body_completed:
                try:
                    cleanup.release()
                except Exception as error:  # noqa: BLE001 - stop is the invariant
                    self.verify(
                        False,
                        "filesystem watcher did not stop",
                        watcher_path=path,
                        watcher_stop_error_type=type(error).__name__,
                        watcher_stop_error=str(error),
                    )
                finally:
                    cleanup.disarm()

    def pause(self) -> None:
        """Pause the sandbox and wait until it is paused or deeper. The host
        agent's sleep request returns at once, so waiting is what makes the
        next step race against a settled pause."""

        self.sleep_to("paused")
        self._context.record("pause_attempts", 1)

    def verify_equal(
        self,
        *,
        actual: object,
        expected: object,
        message: str,
        **evidence: object,
    ) -> None:
        """Verify equality while always recording both sides of the invariant."""

        self._context.verify(
            actual == expected,
            message,
            expected=expected,
            actual=actual,
            **evidence,
        )

    def expect_file(self, path: str, expected: str | bytes) -> None:
        """Read one file and require its exact content."""

        if isinstance(expected, bytes):
            actual = self.sandbox.files.read_bytes(path)
            self.verify(
                actual == expected,
                "ECW binary file content did not match",
                file_path=path,
                expected_size=len(expected),
                actual_size=len(actual),
                expected_sha256=hashlib.sha256(expected).hexdigest(),
                actual_sha256=hashlib.sha256(actual).hexdigest(),
            )
            return
        actual_text = self.sandbox.files.read(path)
        self.verify_equal(
            actual=actual_text,
            expected=expected,
            message="ECW text file content did not match",
            file_path=path,
        )

    def reconnect_by_id(self, *, timeout: int | None = None) -> str | None:
        """Wake the sandbox by its id and wait until it runs. Returns the
        step the host agent was taking when the wake arrived, if any."""

        if timeout is not None and timeout <= 0:
            raise ValueError("reconnect timeout must be positive")
        reconnect_timeout = (
            timeout
            if timeout is not None
            else max(self._sandbox_timeout, self.lifecycle_transition_timeout)
        )
        during = None
        try:
            during = self.sandbox.connect(timeout=reconnect_timeout)
        except (ScenarioTimedOut, SmokeConfigurationError):
            raise
        except Exception as error:  # noqa: BLE001 - client outcome is the invariant
            self.verify(
                False,
                "explicit connect did not resume the paused sandbox",
                sandbox_id=self.sandbox.sandbox_id,
                connect_error_type=type(error).__name__,
                connect_error=str(error),
            )
        self.wait_until_woken()
        return during

    def wait_until_paused(self) -> None:
        """Wait until the sandbox is asleep at any level."""

        self._wait_until_present_state(SandboxState.PAUSED)

    def wait_until_running(self) -> None:
        """Wait until the sandbox runs."""

        self._wait_until_present_state(SandboxState.RUNNING)

    def expect_asleep(self, levels: Iterable[str] = ASLEEP_LEVELS) -> SandboxInfo:
        """Require the sandbox to be asleep at one of `levels` right now,
        without touching it. Opengeni compute."""

        wanted = tuple(levels)
        observed = self.sandbox.try_get_info()
        self.verify(
            observed is not None and observed.level in wanted,
            "sandbox was not asleep at the expected level",
            expected_levels=list(wanted),
            observed=_info_evidence(observed),
        )
        assert observed is not None
        return observed

    def prove_idle_deadline_reset(
        self,
        *,
        reset_after: float,
        verify_after_reset: float,
        reset: Callable[[], None],
    ) -> None:
        """Prove one action resets the configured sandbox idle deadline."""

        prove_idle_deadline_reset(
            self._context,
            self.sandbox,
            sandbox_timeout=self._sandbox_timeout,
            reset_after=reset_after,
            verify_after_reset=verify_after_reset,
            reset=reset,
        )

    def reattach_process(self, pid: int, *, timeout: int = 60) -> ProcessHandle:
        """Reconnect to a process by id, retrying briefly while it shows up."""

        last_error: SandboxUnavailable | None = None
        attempts = len(self.process_connect_retry_delays) + 1
        for attempt in range(attempts):
            try:
                return self.sandbox.connect_process(pid, timeout=timeout)
            except SandboxUnavailable as error:
                last_error = error
            if attempt + 1 == attempts:
                raise InvariantViolation(
                    f"ECW process {pid} was unavailable after {attempts} attempts: {last_error}"
                ) from last_error
            self.wait(self.process_connect_retry_delays[attempt])
        raise AssertionError("unreachable process reattachment state")

    def _wait_until_present_state(self, expected: SandboxState) -> None:
        observed = self._wait_for_state(expected)
        self.verify(
            observed is not None and observed.state is expected,
            f"sandbox did not reach {expected.value} after its lifecycle timeout",
            expected_state=expected.value,
            observed_state=(observed.state.value if observed is not None else "deleted"),
        )

    def _wait_for_state(self, expected: SandboxState) -> SandboxInfo | None:
        deadline = time.monotonic() + self.lifecycle_transition_timeout
        while True:
            last = self.sandbox.try_get_info()
            if last is not None and last.state is expected and last.step is None:
                return last
            if time.monotonic() >= deadline:
                return last
            self.wait(min(0.2, self.lifecycle_poll_interval))


def _info_evidence(info: SandboxInfo | None) -> object:
    if info is None:
        return "deleted"
    return {
        "level": info.level,
        "durability": info.durability,
        "memory_saved": info.memory_saved,
        "step": info.step,
        "holds": info.holds,
        "broken": info.broken,
    }

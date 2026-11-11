# Derived from SPACE's space_smoke/scenarios/ecw_background_process_control.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""Shared background-process control happy path."""

import compute_smoke as smoke

PROCESS_READY_PREFIX = "/tmp/space-smoke-term-ready-"
PROCESS_READY_MARKER = "term-handler-installed"
PROCESS_COMMAND = (
    f"trap '' TERM; printf %s {PROCESS_READY_MARKER} > {PROCESS_READY_PREFIX}$$; sleep 60"
)
PROCESS_SIGNAL = 15


@smoke.scenario("ecw.background_process_control", api_surfaces=("ecw", "native"))
def background_process_control(test: smoke.CommandSandboxFixture) -> None:
    """A background command is discoverable and controllable by process ID."""

    with test.phase("start and terminate background process"):
        process = test.start_background_process(PROCESS_COMMAND)
        test.verify(
            process.pid > 0,
            "ECW background command did not return a process ID",
            observed_pid=process.pid,
        )

        matches = tuple(
            candidate
            for candidate in test.list_processes()
            if candidate.process_id == process.process_id
        )
        test.verify(
            len(matches) == 1,
            "process list did not contain the background command exactly once",
            expected_process_id=process.process_id,
            observed_process_ids=[candidate.process_id for candidate in matches],
        )

        details = test.get_process(process.process_id)
        test.verify(
            details is not None
            and details.process_id == process.process_id
            and details.pid == process.pid
            and bool(details.command),
            "process details did not match the background command",
            expected_process_id=process.process_id,
            expected_pid=process.pid,
            observed_process_id=None if details is None else details.process_id,
            observed_pid=None if details is None else details.pid,
        )

        ready_path = f"{PROCESS_READY_PREFIX}{process.pid}"
        test.wait_until_command_matches(
            f"cat {ready_path}",
            stdout=PROCESS_READY_MARKER,
            timeout=10,
            failure_message="background process TERM handler did not become ready",
        )

        signaled = test.signal_process(process.process_id, PROCESS_SIGNAL)
        test.verify(
            signaled,
            "process API did not signal the background command",
            observed_process_id=process.process_id,
            signal=PROCESS_SIGNAL,
        )

        after_term = test.get_process(process.process_id)
        test.verify(
            after_term is not None and after_term.process_id == process.process_id,
            "background process exited after TERM despite installed handler",
            observed_process_id=process.process_id,
            signal=PROCESS_SIGNAL,
        )

        killed = test.kill_process(process.process_id)
        test.verify(
            killed,
            "background process exited before expected SIGKILL",
            observed_pid=process.pid,
            signal_sequence=[PROCESS_SIGNAL, "KILL"],
        )

        remaining, final = test.wait_until_process_stopped(process.process_id)
        test.verify(
            final is None
            and not any(candidate.process_id == process.process_id for candidate in remaining),
            "terminated background command remained visible as running",
            observed_process_id=process.process_id,
            observed_list_process_ids=[candidate.process_id for candidate in remaining],
            observed_get_process_id=None if final is None else final.process_id,
        )

# Derived from SPACE's space_smoke/scenarios/ecw_process_reattach.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW process reattachment happy path.

Extended: also reattaches to a process that already ended, whose result no
one has collected yet.
"""

import compute_smoke as smoke

MARKER = "space-smoke-process-reattach"
ENDED_MARKER = "space-smoke-process-reattach-after-exit"


@smoke.scenario("ecw.process_reattach")
def process_reattach(test: smoke.Ecw) -> None:
    """A client can disconnect from a running ECW process, reattach by its
    process ID, and receive its final output and exit status, also when the
    process ended before the client came back.
    """

    with test.phase("start and disconnect from background process"):
        process = test.sandbox.start_background(
            f"sleep 10 && printf %s {MARKER}",
            timeout=20,
        )
        pid = process.pid
        process.disconnect()

    with test.phase("reattach and verify process result"):
        result = test.reattach_process(pid, timeout=20).wait()
        test.verify(
            result.exit_code == 0 and result.stdout == MARKER,
            "reattached ECW process did not return its final result",
            observed_pid=pid,
            command_exit_code=result.exit_code,
            command_stdout=result.stdout,
            command_stderr=result.stderr,
        )

    with test.phase("start a short process and let it end unobserved"):
        ended = test.sandbox.start_background(f"printf %s {ENDED_MARKER}; exit 7", timeout=20)
        ended_pid = ended.pid
        ended.disconnect()
        _, still_listed = test.wait_until_process_stopped(str(ended_pid))
        test.verify(
            still_listed is None,
            "a short background process was still running",
            observed_pid=ended_pid,
        )

    with test.phase("reattach after it ended and verify its result"):
        result = test.reattach_process(ended_pid, timeout=20).wait()
        test.verify(
            (result.exit_code, result.stdout) == (7, ENDED_MARKER),
            "reattaching to an ended ECW process did not return its result",
            observed_pid=ended_pid,
            command_exit_code=result.exit_code,
            command_stdout=result.stdout,
            command_stderr=result.stderr,
        )

# Derived from SPACE's space_smoke/scenarios/ecw_process_reattach.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW process reattachment happy path."""

import compute_smoke as smoke

MARKER = "space-smoke-process-reattach"


@smoke.scenario("ecw.process_reattach")
def process_reattach(test: smoke.Ecw) -> None:
    """A client can disconnect from a running ECW process, reattach by its
    process ID, and receive its final output and exit status.
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

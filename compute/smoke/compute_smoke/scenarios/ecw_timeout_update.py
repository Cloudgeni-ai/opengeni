# Derived from SPACE's space_smoke/scenarios/ecw_timeout_update.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW timeout-update happy path.

Adapted: a timeout here is a hold that keeps the sandbox awake for that long,
and a hold always wakes a sleeping sandbox. So the second half no longer
updates a suspended sandbox's timeout without waking it. It proves instead
that a lapsed extension lets the sandbox sleep on its own, and that a new
timeout wakes it and keeps it awake past its idle time.
"""

import compute_smoke as smoke

MARKER = "space-smoke-timeout-update-ok"
INITIAL_TIMEOUT_SECONDS = 10
EXTENDED_TIMEOUT_SECONDS = 30
WAIT_SECONDS = 12
RENEWED_TIMEOUT_SECONDS = 60
WAIT_AFTER_RENEWAL_SECONDS = INITIAL_TIMEOUT_SECONDS * 3 + 2


@smoke.scenario(
    "ecw.timeout_update",
    sandbox=smoke.SandboxConfig(timeout=INITIAL_TIMEOUT_SECONDS),
)
def timeout_update(test: smoke.Ecw) -> None:
    """An ECW sandbox remains usable after its original deadline when its timeout
    is extended through the API.
    """

    with test.phase("extend sandbox timeout"):
        test.sandbox.set_timeout(EXTENDED_TIMEOUT_SECONDS)

    with test.phase("wait beyond original sandbox deadline"):
        test.wait(WAIT_SECONDS)

    with test.phase("verify sandbox remains usable past original deadline"):
        result = test.sandbox.run(f"printf %s {MARKER}")
        test.verify(
            result.exit_code == 0 and result.stdout == MARKER,
            "sandbox was not usable after its original timeout elapsed",
            initial_timeout_seconds=INITIAL_TIMEOUT_SECONDS,
            extended_timeout_seconds=EXTENDED_TIMEOUT_SECONDS,
            waited_seconds=WAIT_SECONDS,
            command_exit_code=result.exit_code,
            command_stdout=result.stdout,
            command_stderr=result.stderr,
        )

    with test.phase("sleep on its own once the extension lapses"):
        test.wait_until_paused()

    with test.phase("a new timeout wakes it and outlasts its idle time"):
        test.sandbox.set_timeout(RENEWED_TIMEOUT_SECONDS)
        test.wait(WAIT_AFTER_RENEWAL_SECONDS)
        observed = test.sandbox.try_get_info()
        test.verify(
            observed is not None and observed.state is smoke.SandboxState.RUNNING,
            "a renewed timeout did not keep the sandbox awake",
            idle_timeout_seconds=INITIAL_TIMEOUT_SECONDS,
            requested_timeout_seconds=RENEWED_TIMEOUT_SECONDS,
            waited_seconds=WAIT_AFTER_RENEWAL_SECONDS,
            observed_level=None if observed is None else observed.level,
        )
        # Check the state before any guest command that would wake it.
        test.expect_command(test.sandbox.run(f"printf %s {MARKER}"), stdout=MARKER)

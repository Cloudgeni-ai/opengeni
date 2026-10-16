# Derived from SPACE's space_smoke/scenarios/ecw_timeout_rearm.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW same-value timeout re-arm invariant.

Adapted: a timeout here is a hold that keeps the sandbox awake for that
long, after which it pauses once idle for its own short idle time. Setting
the same timeout again must restart the hold rather than be ignored as a
repeat, so the sandbox outlives the first hold's deadline.
"""

import time

import compute_smoke as smoke

MARKER = "space-smoke-timeout-rearm-ok"
IDLE_SECONDS = 5
TIMEOUT_SECONDS = 30
REARM_AFTER_SECONDS = 20
# Past the first hold plus the idle time (30 + 5 = 35 seconds), and well
# before the re-armed one ends (20 + 30 + 5 = 55 seconds).
OBSERVE_AT_SECONDS = 45


@smoke.scenario(
    "ecw.timeout_rearm",
    sandbox=smoke.SandboxConfig(timeout=IDLE_SECONDS),
)
def timeout_rearm(test: smoke.Ecw) -> None:
    """Setting a sandbox timeout to the value it already has restarts it and
    keeps the sandbox awake and usable beyond the original deadline.
    """

    test.record("idle_seconds", IDLE_SECONDS)
    test.record("timeout_seconds", TIMEOUT_SECONDS)
    test.record("rearm_after_seconds", REARM_AFTER_SECONDS)
    test.record("observe_at_seconds", OBSERVE_AT_SECONDS)

    with test.phase("set the timeout"):
        test.sandbox.set_timeout(TIMEOUT_SECONDS)
        started = time.monotonic()

    with test.phase("set the same timeout again before it ends"):
        test.wait(REARM_AFTER_SECONDS)
        test.sandbox.set_timeout(TIMEOUT_SECONDS)

    with test.phase("observe it still running past the original deadline"):
        test.wait(max(0.0, OBSERVE_AT_SECONDS - (time.monotonic() - started)))
        # Any guest command would wake a sandbox that slept, so the state is
        # read from the host agent first.
        observed = test.sandbox.try_get_info()
        test.verify(
            observed is not None and observed.state is smoke.SandboxState.RUNNING,
            "setting the same timeout again did not restart it",
            observed_after_seconds=time.monotonic() - started,
            observed_level=None if observed is None else observed.level,
        )

    with test.phase("verify it is usable"):
        test.expect_command(test.sandbox.run(f"printf %s {MARKER}"), stdout=MARKER)

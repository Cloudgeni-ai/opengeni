# Derived from SPACE's space_smoke/scenarios/ecw_pause_connect_race.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""Repeated ECW pause/connect boundary coverage."""

import compute_smoke as smoke

ITERATIONS = 10
SANDBOX_TIMEOUT_SECONDS = 120
MARKER_PATH = "/tmp/space-smoke-pause-connect-race.txt"


@smoke.scenario(
    "ecw.pause_connect_race",
    sandbox=smoke.SandboxConfig(timeout=SANDBOX_TIMEOUT_SECONDS),
)
def pause_connect_race(test: smoke.Ecw) -> None:
    """Ten consecutive pause and immediate reconnect cycles each restore the
    same sandbox's data plane and preserve that cycle's exact marker.
    """

    for iteration in range(1, ITERATIONS + 1):
        marker = f"space-smoke-pause-connect:{test.sandbox.sandbox_id}:{iteration}"

        with test.phase(f"cycle {iteration}/{ITERATIONS}: write marker"):
            written = test.run_command_when_ready(
                f"printf %s {marker} > {MARKER_PATH}",
                timeout=10,
            )
            test.expect_command(written, stdout="")

        with test.phase(f"cycle {iteration}/{ITERATIONS}: pause, reconnect, and read marker"):
            test.pause()
            test.reconnect_by_id()
            observed = test.run_command_when_ready(
                f"cat {MARKER_PATH}",
                timeout=10,
            )
            test.expect_command(observed, stdout=marker)

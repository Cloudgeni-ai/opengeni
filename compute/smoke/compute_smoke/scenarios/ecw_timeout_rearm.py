# Derived from SPACE's space_smoke/scenarios/ecw_timeout_rearm.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW same-value timeout re-arm invariant."""

import compute_smoke as smoke

TIMEOUT_SECONDS = 30
RESET_AFTER_SECONDS = 20
VERIFY_AFTER_RESET_SECONDS = 17


@smoke.scenario(
    "ecw.timeout_rearm",
    sandbox=smoke.SandboxConfig(timeout=TIMEOUT_SECONDS),
)
def timeout_rearm(test: smoke.Ecw) -> None:
    """Setting a sandbox timeout to its current value resets the idle deadline
    and keeps the sandbox usable beyond its original deadline.
    """

    test.prove_idle_deadline_reset(
        reset_after=RESET_AFTER_SECONDS,
        verify_after_reset=VERIFY_AFTER_RESET_SECONDS,
        reset=lambda: test.sandbox.set_timeout(TIMEOUT_SECONDS),
    )

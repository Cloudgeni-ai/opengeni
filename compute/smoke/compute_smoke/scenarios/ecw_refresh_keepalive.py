# Derived from SPACE's space_smoke/scenarios/ecw_refresh_keepalive.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW refresh keepalive invariant."""

import compute_smoke as smoke

TIMEOUT_SECONDS = 30
REFRESH_AFTER_SECONDS = 20
VERIFY_AFTER_REFRESH_SECONDS = 17


@smoke.scenario(
    "ecw.refresh_keepalive",
    sandbox=smoke.SandboxConfig(timeout=TIMEOUT_SECONDS),
)
def refresh_keepalive(test: smoke.Ecw) -> None:
    """Refreshing a sandbox resets its idle deadline and keeps the sandbox usable
    beyond its original deadline.
    """

    test.prove_idle_deadline_reset(
        reset_after=REFRESH_AFTER_SECONDS,
        verify_after_reset=VERIFY_AFTER_REFRESH_SECONDS,
        reset=test.sandbox.refresh,
    )

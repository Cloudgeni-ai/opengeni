# Derived from SPACE's space_smoke/scenarios/ecw_sandbox_info.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""Sandbox information happy path."""

import compute_smoke as smoke


@smoke.scenario("ecw.sandbox_info", api_surfaces=("ecw", "native"))
def sandbox_info(test: smoke.CommandSandboxFixture) -> None:
    """A created sandbox can be read back by ID through the selected API."""

    with test.phase("read sandbox information"):
        info = test.sandbox.get_info()
        test.verify(
            info.sandbox_id == test.sandbox.sandbox_id,
            "sandbox information returned a different ID",
            expected_sandbox_id=test.sandbox.sandbox_id,
            observed_sandbox_id=info.sandbox_id,
        )

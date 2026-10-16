# Derived from SPACE's space_smoke/scenarios/ecw_sandbox_delete.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW sandbox deletion happy path."""

import compute_smoke as smoke


@smoke.scenario("ecw.sandbox_delete", api_surfaces=("ecw", "native"))
def sandbox_delete(test: smoke.CommandSandboxFixture) -> None:
    """Deleting a sandbox makes it absent from the selected public API."""

    with test.phase("delete sandbox"):
        test.delete_sandbox()

    with test.phase("verify sandbox is absent"):
        test.wait_until_deleted()

# Derived from SPACE's space_smoke/scenarios/ecw_command_round_trip.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""The smallest useful public-client smoke scenario."""

import compute_smoke as smoke

MARKER = "space-smoke-command-ok"


@smoke.scenario("ecw.command_round_trip", api_surfaces=("ecw", "native"))
def command_round_trip(test: smoke.CommandSandboxFixture) -> None:
    """A sandbox can execute a command through the selected public data plane
    and return its exact output.
    """

    with test.phase("run marker command"):
        result = test.run_command(f"printf %s {MARKER}")

    test.expect_command(result, stdout=MARKER)

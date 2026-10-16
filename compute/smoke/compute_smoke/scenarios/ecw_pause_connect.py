# Derived from SPACE's space_smoke/scenarios/ecw_pause_connect.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW pause/connect happy path."""

import shlex

import compute_smoke as smoke

PATH = "/tmp/space-smoke-pause-connect.txt"
MARKER = "space-smoke-pause-connect-ok"


@smoke.scenario("ecw.pause_connect", api_surfaces=("ecw", "native"))
def pause_connect(test: smoke.CommandSandboxFixture) -> None:
    """A durable lifecycle round trip preserves sandbox filesystem state."""

    marker = f"{MARKER}-{test.sandbox.sandbox_id}"

    with test.phase("write state before pause"):
        written = test.run_command_when_ready(
            f"printf %s {shlex.quote(marker)} > {shlex.quote(PATH)}"
        )
        test.verify(
            written.exit_code == 0,
            "failed to write state before pausing the sandbox",
            command_stderr=written.stderr,
        )

    with test.phase("pause and reconnect sandbox"):
        test.suspend_durably()
        test.wake_from_durable_suspend()

    with test.phase("read state after reconnect"):
        observed = test.run_command_when_ready(f"cat {shlex.quote(PATH)}")
        test.expect_command(observed, stdout=marker)

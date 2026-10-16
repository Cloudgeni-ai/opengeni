# Derived from SPACE's space_smoke/scenarios/ecw_access_idle_reconnect_preserves_workspace.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW access-idle reconnect state preservation.

Adapted: a sandbox here wakes on any access, so instead of proving that a
file read fails while it sleeps, the scenario proves it stays asleep, with
its state saved to disk, until it is reconnected.
"""

import compute_smoke as smoke

WORKSPACE_PATH = "/home/user/workspace"
MARKER_PATH = f"{WORKSPACE_PATH}/space-smoke-access-idle.txt"
BINARY_PATH = f"{WORKSPACE_PATH}/space-smoke-access-idle.bin"
SETTLE_SECONDS = 10


@smoke.scenario(
    "ecw.access_idle_reconnect_preserves_workspace",
    sandbox=smoke.SandboxConfig(timeout=3),
)
def access_idle_reconnect_preserves_workspace(test: smoke.Ecw) -> None:
    """After access-idle pause has durably settled, reconnecting by the stored
    sandbox ID restores exact text and binary workspace files.
    """

    marker = f"space-smoke-access-idle:{test.sandbox.sandbox_id}"
    binary = b"\x00\x89SPACE\xff" + marker.encode()

    with test.phase("write and verify unique workspace state"):
        test.sandbox.files.make_dir(WORKSPACE_PATH)
        test.sandbox.files.write(MARKER_PATH, marker)
        test.sandbox.files.write(BINARY_PATH, binary)
        test.expect_file(MARKER_PATH, marker)
        test.expect_file(BINARY_PATH, binary)

    with test.phase("wait for access-idle pause and durable finalization"):
        test.wait_until_paused()
        # The idle timeout pauses the sandbox and saves it; wait for the save.
        test.wait_until_durable()
        test.wait(SETTLE_SECONDS)

    with test.phase("verify it stays asleep until reconnected"):
        test.expect_asleep()

    with test.phase("reconnect by stored sandbox ID"):
        test.reconnect_by_id()

    with test.phase("verify workspace state after reconnect"):
        test.expect_file(MARKER_PATH, marker)
        test.expect_file(BINARY_PATH, binary)

"""A hold keeps an idle sandbox awake; releasing it lets the sandbox sleep."""

import compute_smoke as smoke

IDLE_SECONDS = 3
HOLD = "compute-smoke"


@smoke.scenario(
    "compute.hold_keeps_awake",
    sandbox=smoke.SandboxConfig(timeout=IDLE_SECONDS),
)
def hold_keeps_awake(test: smoke.Ecw) -> None:
    """A sandbox that would pause after three idle seconds stays running while
    something holds it, and pauses on its own soon after the hold is released.
    """

    with test.phase("hold it and stay idle well past its idle time"):
        test.sandbox.host.hold(test.sandbox.sandbox_id, HOLD, ttl_seconds=None)
        test.wait(IDLE_SECONDS * 3)
        observed = test.sandbox.get_info()
        test.verify(
            observed.state is smoke.SandboxState.RUNNING and observed.holds >= 1,
            "a held sandbox went to sleep",
            observed_level=observed.level,
            observed_holds=observed.holds,
        )

    with test.phase("release it and watch it sleep"):
        test.sandbox.host.release(test.sandbox.sandbox_id, HOLD)
        test.wait_until_paused()

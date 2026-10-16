"""Waking a sandbox while it is on its way to sleep gives back the same
sandbox, with its files and its running programs."""

import time

import compute_smoke as smoke

CYCLES = 6
# Each cycle wakes the sandbox during one step of going to sleep on disk:
# pausing the VM, then saving its memory and files.
TARGET_STEPS = ("pause", "save")
MARKER_PATH = "/root/compute-smoke-wake-during-sleep.txt"
# How long to watch for the step.
STEP_WATCH_SECONDS = 10


def _wait_for_step(test: smoke.Ecw, wanted: str) -> str | None:
    """Watches the host agent's status, without touching the sandbox, until
    the step `wanted` is in progress; returns it, or None if the sandbox
    settled asleep first."""

    deadline = time.monotonic() + STEP_WATCH_SECONDS
    while time.monotonic() < deadline:
        info = test.sandbox.try_get_info()
        if info is None:
            return None
        if info.step == wanted:
            return wanted
        if info.step is None and info.level != "running":
            return None
    return None


@smoke.scenario("compute.wake_during_sleep")
def wake_during_sleep(test: smoke.Ecw) -> None:
    """A wake sent while the sandbox is being paused, or while its memory is
    being saved to disk, returns it running with the same files and the same
    guest process; each of those steps is caught in progress at least once.
    """

    service_pid = test.sandbox.ping()
    caught: list[str] = []
    for cycle in range(1, CYCLES + 1):
        target = TARGET_STEPS[(cycle - 1) % len(TARGET_STEPS)]
        marker = f"{test.sandbox.sandbox_id}:wake-during-sleep:{cycle}"
        with test.phase(f"cycle {cycle}/{CYCLES}: write marker"):
            test.sandbox.files.write(MARKER_PATH, marker)

        with test.phase(f"cycle {cycle}/{CYCLES}: wake during {target}"):
            test.sandbox.sleep("saved")
            step = _wait_for_step(test, target)
            test.reconnect_by_id()
            test.record(f"cycle_{cycle}_caught", step)
            if step is not None:
                caught.append(step)

        with test.phase(f"cycle {cycle}/{CYCLES}: verify the same sandbox"):
            test.expect_file(MARKER_PATH, marker)
            test.verify_equal(
                actual=test.sandbox.ping(),
                expected=service_pid,
                message="a wake during sleep did not return the same guest process",
                cycle=cycle,
            )

    test.verify(
        set(TARGET_STEPS) <= set(caught),
        "a wake did not arrive during every targeted sleep step",
        cycles=CYCLES,
        targeted_steps=list(TARGET_STEPS),
        steps_caught=caught,
    )

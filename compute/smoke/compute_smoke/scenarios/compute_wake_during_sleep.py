"""Waking a sandbox while it is on its way to sleep gives back the same
sandbox, with its files and its running programs."""

import time

import compute_smoke as smoke

CYCLES = 5
MARKER_PATH = "/root/compute-smoke-wake-during-sleep.txt"
# How long to watch for the host agent to start putting it to sleep.
STEP_WATCH_SECONDS = 5


def _step_in_flight(test: smoke.Ecw) -> str | None:
    """Watches the host agent's status, without touching the sandbox, until
    a sleep step is in progress; returns that step, or None if the sandbox
    reached its level before a step was seen."""

    deadline = time.monotonic() + STEP_WATCH_SECONDS
    while time.monotonic() < deadline:
        info = test.sandbox.try_get_info()
        if info is None:
            return None
        if info.step is not None:
            return info.step
        if info.level != "running":
            return None
    return None


@smoke.scenario("compute.wake_during_sleep")
def wake_during_sleep(test: smoke.Ecw) -> None:
    """Five times over, a wake sent while the sandbox is being saved to disk
    returns it running with the same files and the same guest process, and at
    least one of those wakes arrives while a sleep step is in progress.
    """

    service_pid = test.sandbox.ping()
    caught: list[str] = []
    for cycle in range(1, CYCLES + 1):
        marker = f"{test.sandbox.sandbox_id}:wake-during-sleep:{cycle}"
        with test.phase(f"cycle {cycle}/{CYCLES}: write marker"):
            test.sandbox.files.write(MARKER_PATH, marker)

        with test.phase(f"cycle {cycle}/{CYCLES}: wake while it goes to sleep"):
            test.sandbox.sleep("saved")
            step = _step_in_flight(test)
            test.reconnect_by_id()
            test.record(f"cycle_{cycle}_step_in_flight", step)
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
        bool(caught),
        "no wake arrived while a sleep step was in progress",
        cycles=CYCLES,
        steps_caught=caught,
    )

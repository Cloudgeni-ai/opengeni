"""Waking a sandbox while it is on its way to sleep gives back the same
sandbox, with its files and its running programs."""

import time

import compute_smoke as smoke

# The steps of going to sleep on disk that a wake can meet: pausing the VM,
# then saving its memory and files.
TARGET_STEPS = ("pause", "save")
# Tries per step. A wake that misses a step's window proves nothing about
# that step, so it is tried again.
ATTEMPTS = 8
MARKER_PATH = "/root/compute-smoke-wake-during-sleep.txt"
# How long to watch for a step to start.
STEP_WATCH_SECONDS = 10


def _wait_for_step(test: smoke.Ecw, wanted: str) -> None:
    """Watches the host agent's status, without touching the sandbox, until
    the step `wanted` is in progress or the sandbox settled asleep."""

    deadline = time.monotonic() + STEP_WATCH_SECONDS
    while time.monotonic() < deadline:
        info = test.sandbox.try_get_info()
        if info is None or info.step == wanted:
            return
        if info.step is None and info.level != "running":
            return


@smoke.scenario("compute.wake_during_sleep")
def wake_during_sleep(test: smoke.Ecw) -> None:
    """A wake that arrives while the sandbox is being paused, or while its
    memory is being saved to disk, returns it running with the same files
    and the same guest process. The host agent's wake reply names the step
    the wake met, so a step counts as covered only when a wake provably
    arrived during it.
    """

    service_pid = test.sandbox.ping()
    met: dict[str, int] = {}
    cycle = 0
    for target in TARGET_STEPS:
        for attempt in range(1, ATTEMPTS + 1):
            cycle += 1
            label = f"{target}, attempt {attempt}/{ATTEMPTS}"
            marker = f"{test.sandbox.sandbox_id}:wake-during-sleep:{cycle}"
            with test.phase(f"{label}: write marker"):
                test.sandbox.files.write(MARKER_PATH, marker)

            with test.phase(f"{label}: wake during {target}"):
                test.sandbox.sleep("saved")
                # Pausing takes milliseconds, so that wake follows the
                # request at once; saving takes longer and is watched for.
                if target != "pause":
                    _wait_for_step(test, target)
                during = test.reconnect_by_id()
                test.record(f"cycle_{cycle}", {"target": target, "met": during})
                if during is not None:
                    met[during] = met.get(during, 0) + 1

            with test.phase(f"{label}: verify the same sandbox"):
                test.expect_file(MARKER_PATH, marker)
                test.verify_equal(
                    actual=test.sandbox.ping(),
                    expected=service_pid,
                    message="a wake during sleep did not return the same guest process",
                    cycle=cycle,
                    met=during,
                )
            if during == target:
                break

    test.record("steps_met", met)
    test.verify(
        set(TARGET_STEPS) <= set(met),
        "no wake provably arrived during every targeted sleep step",
        attempts_per_step=ATTEMPTS,
        targeted_steps=list(TARGET_STEPS),
        steps_met=met,
    )

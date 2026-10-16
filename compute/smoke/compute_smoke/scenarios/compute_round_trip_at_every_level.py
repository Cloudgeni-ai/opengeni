"""Sleeping at each level and waking keeps files and running programs."""

import compute_smoke as smoke
from compute_smoke.client import HostAgentError

LEVELS = ("paused", "compressed", "saved", "archived", "remote")
# Levels without a VM process, where running programs live in a memory image.
IMAGE_LEVELS = ("saved", "archived", "remote")
# How a host says it cannot offer a level: no memory compression, or no store.
UNSUPPORTED = ("cannot compress", "no store")
MARKER_PATH = "/root/compute-smoke-levels.txt"


@smoke.scenario("compute.round_trip_at_every_level")
def round_trip_at_every_level(test: smoke.Ecw) -> None:
    """A sandbox put to sleep at each level reaches exactly that level, and
    woken again still has its files and the same running programs: its guest
    service keeps its process and a background command keeps running. A level
    the host cannot offer is recorded as unsupported, not counted as covered.
    """

    with test.phase("start a background program"):
        service_pid = test.sandbox.ping()
        program = test.start_background_process("sleep 100000")

    exercised: list[str] = []
    unsupported: list[str] = []
    for level in LEVELS:
        marker = f"{test.sandbox.sandbox_id}:{level}"
        with test.phase(f"{level}: write, sleep and wake"):
            test.sandbox.files.write(MARKER_PATH, marker)
            try:
                test.sandbox.sleep(level)
            except HostAgentError as error:
                if not any(reason in str(error) for reason in UNSUPPORTED):
                    raise
                unsupported.append(level)
                test.record(f"{level}_unsupported", str(error))
                continue
            # Exactly the level asked for: a host that sent every request
            # straight to a deeper level would pass a looser check.
            observed = test.wait_until_level((level,))
            test.verify(
                level not in IMAGE_LEVELS or observed.memory_saved,
                f"no memory image at {level}, so running programs would be lost",
                level=level,
                durability=observed.durability,
            )
            exercised.append(level)
            test.reconnect_by_id()

        with test.phase(f"{level}: verify files and programs"):
            test.expect_file(MARKER_PATH, marker)
            test.verify_equal(
                actual=test.sandbox.ping(),
                expected=service_pid,
                message=f"the guest service restarted across {level}",
                level=level,
            )
            test.verify(
                test.get_process(program.process_id) is not None,
                f"the background program did not survive {level}",
                level=level,
                program_pid=program.pid,
            )

    test.record("levels_exercised", exercised)
    test.record("levels_unsupported", unsupported)

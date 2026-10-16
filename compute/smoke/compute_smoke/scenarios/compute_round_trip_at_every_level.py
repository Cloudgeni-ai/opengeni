"""Sleeping at each level and waking keeps files and running programs."""

import compute_smoke as smoke
from compute_smoke.client import HostAgentError

LEVELS = ("paused", "compressed", "saved")
MARKER_PATH = "/root/compute-smoke-levels.txt"


@smoke.scenario("compute.round_trip_at_every_level")
def round_trip_at_every_level(test: smoke.Ecw) -> None:
    """A sandbox put to sleep at each level and woken again still has its
    files and the same running programs: its guest service keeps its process
    and a background command keeps running.
    """

    with test.phase("start a background program"):
        service_pid = test.sandbox.ping()
        program = test.start_background_process("sleep 100000")

    for level in LEVELS:
        marker = f"{test.sandbox.sandbox_id}:{level}"
        with test.phase(f"{level}: write, sleep and wake"):
            test.sandbox.files.write(MARKER_PATH, marker)
            try:
                test.sandbox.sleep(level)
            except HostAgentError as error:
                if level == "compressed" and "compress" in str(error):
                    test.record("compressed", f"not available on this host: {error}")
                    continue
                raise
            observed = test.wait_until_level((level, *_deeper(level)))
            test.record(f"{level}_reached", observed.level)
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


def _deeper(level: str) -> tuple[str, ...]:
    order = ("running", "paused", "compressed", "saved", "archived", "remote")
    return order[order.index(level) + 1 :]

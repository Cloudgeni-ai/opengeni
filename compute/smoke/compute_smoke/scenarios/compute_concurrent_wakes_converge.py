"""Many clients waking one saved sandbox at once share one restored VM."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import compute_smoke as smoke
from compute_smoke.client import CommandResult

CLIENTS = 16
MARKER_PATH = "/root/compute-smoke-concurrent.txt"


@smoke.scenario("compute.concurrent_wakes_converge")
def concurrent_wakes_converge(test: smoke.Ecw) -> None:
    """Sixteen commands sent at the same moment to a sandbox saved to disk
    are all in flight together, all succeed, see the same files and the same
    guest process, and the host agent starts exactly one VM for them.

    The VM count is the host agent's own, kept per sandbox outside the
    memory image: a count inside the guest could not tell one restore from
    several, since each restored copy starts from the same saved count. The
    guest's count still shows that the restored guest was told of its
    restore (at least once: the host repeats a notice whose answer it lost).
    """

    marker = f"{test.sandbox.sandbox_id}:concurrent"
    with test.phase("save the sandbox to disk"):
        test.sandbox.files.write(MARKER_PATH, marker)
        service_pid = test.sandbox.ping()
        restores_before = test.sandbox.restore_count()
        test.suspend_durably()
        launches_before = test.sandbox.get_info().launches

    barrier = threading.Barrier(CLIENTS)

    def wake_with_command(_: int) -> tuple[float, float, CommandResult]:
        barrier.wait(timeout=30)
        started = time.monotonic()
        result = test.sandbox.run(f"cat {MARKER_PATH}", timeout=60)
        return started, time.monotonic(), result

    with (
        test.phase(f"wake it from {CLIENTS} clients at once"),
        ThreadPoolExecutor(CLIENTS) as pool,
    ):
        calls = list(pool.map(wake_with_command, range(CLIENTS)))
    # Read at once, before anything else could put it to sleep and wake it.
    launches = test.sandbox.get_info().launches - launches_before

    with test.phase("verify one VM served them all"):
        starts = [started for started, _, _ in calls]
        ends = [ended for _, ended, _ in calls]
        test.verify(
            max(starts) < min(ends),
            "the commands were not all in flight at the same time",
            start_spread_seconds=max(starts) - min(starts),
            first_end_after_last_start_seconds=min(ends) - max(starts),
        )
        results = [result for _, _, result in calls]
        test.verify(
            all((r.exit_code, r.stdout) == (0, marker) for r in results),
            "a concurrent command did not see the saved files",
            outputs=sorted({(r.exit_code, r.stdout, r.stderr) for r in results}),
        )
        test.verify_equal(
            actual=test.sandbox.ping(),
            expected=service_pid,
            message="the woken sandbox runs a different guest process",
        )
        test.verify_equal(
            actual=launches,
            expected=1,
            message="concurrent wakes did not share exactly one restored VM",
        )
        notices = test.sandbox.restore_count() - restores_before
        test.verify(
            notices >= 1,
            "the restored guest was not told of its restore",
            notices=notices,
        )

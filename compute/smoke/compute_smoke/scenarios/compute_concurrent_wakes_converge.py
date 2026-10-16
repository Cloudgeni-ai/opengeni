"""Many clients waking one saved sandbox at once share one restored VM."""

from concurrent.futures import ThreadPoolExecutor

import compute_smoke as smoke

CLIENTS = 16
MARKER_PATH = "/root/compute-smoke-concurrent.txt"


def _restores(test: smoke.Ecw) -> int:
    steps = dict((name, stats) for name, stats in test.sandbox.host.status().get("steps", []))
    return int(steps.get("restore", {}).get("started", 0))


@smoke.scenario("compute.concurrent_wakes_converge")
def concurrent_wakes_converge(test: smoke.Ecw) -> None:
    """Sixteen commands sent at once to a sandbox saved to disk all succeed,
    see the same files and the same guest process, and wake it with exactly
    one restore.
    """

    marker = f"{test.sandbox.sandbox_id}:concurrent"
    with test.phase("save the sandbox to disk"):
        test.sandbox.files.write(MARKER_PATH, marker)
        service_pid = test.sandbox.ping()
        test.suspend_durably()
        restores_before = _restores(test)

    with (
        test.phase(f"wake it from {CLIENTS} clients at once"),
        ThreadPoolExecutor(CLIENTS) as pool,
    ):
        results = list(
            pool.map(
                lambda _: test.sandbox.run(f"cat {MARKER_PATH}", timeout=60),
                range(CLIENTS),
            )
        )
        pids = list(pool.map(lambda _: test.sandbox.ping(), range(CLIENTS)))

    with test.phase("verify one VM served them all"):
        test.verify(
            all((r.exit_code, r.stdout) == (0, marker) for r in results),
            "a concurrent command did not see the saved files",
            outputs=sorted({(r.exit_code, r.stdout, r.stderr) for r in results}),
        )
        test.verify(
            set(pids) == {service_pid},
            "concurrent wakes reached more than one guest process",
            expected_pid=service_pid,
            observed_pids=sorted(set(pids)),
        )
        test.verify_equal(
            actual=_restores(test) - restores_before,
            expected=1,
            message="concurrent wakes did not share one restore",
        )

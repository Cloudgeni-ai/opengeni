"""Across a host agent restart, command output resumes from its cursor and
live connections end rather than hang."""

import time

import compute_smoke as smoke

LINES = 60
WATCHED = "/root/compute-smoke-restart-watch"
# How long a live connection may outlast the agent that carried it.
DROP_LIMIT = 30.0


@smoke.scenario(
    "compute.agent_restart_resumes_output",
    sandbox=smoke.SandboxConfig(timeout=600),
    rerun_environment=("COMPUTE_SMOKE_RESTART_AGENT",),
)
def agent_restart_resumes_output(test: smoke.Ecw) -> None:
    """A client reading a running command's output by cursor gets every
    byte exactly once across a host agent restart; a live watch connection
    the old agent carried ends instead of hanging, and a new one works.
    """

    expected = "".join(f"{n}\n" for n in range(1, LINES + 1))
    with test.phase("start a command and read part of its output"):
        test.sandbox.files.make_dir(WATCHED)
        process = test.sandbox.start_background(
            f"for n in $(seq 1 {LINES}); do echo $n; sleep 0.1; done", timeout=120
        )
        seen, offset, _ = process.read_output()
        watch = test.sandbox.watch_dir(WATCHED)

    with test.phase("restart the host agent"):
        test.restart_host_agent()

    with test.phase("the live watch connection ended"):
        deadline = time.monotonic() + DROP_LIMIT
        while watch.alive() and time.monotonic() < deadline:
            time.sleep(0.1)
        test.verify(
            not watch.alive(),
            "a live connection outlasted the host agent that carried it",
            limit_seconds=DROP_LIMIT,
        )
        watch.stop()
        again = test.sandbox.watch_dir(WATCHED)
        test.sandbox.files.write(f"{WATCHED}/after", "x")
        deadline = time.monotonic() + DROP_LIMIT
        events = []
        while not events and time.monotonic() < deadline:
            events = again.get_new_events()
            time.sleep(0.1)
        again.stop()
        test.verify(bool(events), "a new watch after the restart saw no change")

    with test.phase("the output resumes from the cursor"):
        running = True
        deadline = time.monotonic() + 120
        while running and time.monotonic() < deadline:
            data, offset, running = process.read_output(offset)
            seen += data
            if running:
                time.sleep(0.2)
        test.verify_equal(
            actual=seen.decode(),
            expected=expected,
            message="output read by cursor across a host agent restart lost or repeated bytes",
        )
        process.wait()

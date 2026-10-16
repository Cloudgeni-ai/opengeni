"""Restarting the host agent loses no sandbox and no running program."""

import compute_smoke as smoke

LEVELS = ("running", "paused", "saved")
MARKER_PATH = "/root/compute-smoke-restart.txt"


@smoke.scenario(
    "compute.agent_restart_keeps_sandboxes",
    sandboxes=len(LEVELS),
    sandbox=smoke.SandboxConfig(timeout=600),
    rerun_environment=("COMPUTE_SMOKE_RESTART_AGENT",),
    quarantined=(
        "needs VM re-adoption from feat/compute-host-robust; until it merges, "
        "a restart ends every VM and only saved sandboxes keep their programs"
    ),
)
def agent_restart_keeps_sandboxes(test: smoke.Ecw) -> None:
    """After the host agent restarts, a running, a paused and a saved sandbox
    are each still at their level with their files, the same guest process
    and their background program.
    """

    before = {}
    with test.phase("prepare one sandbox per level"):
        for sandbox, level in zip(test.sandboxes, LEVELS, strict=True):
            marker = f"{sandbox.sandbox_id}:{level}"
            sandbox.files.write(MARKER_PATH, marker)
            program = sandbox.start_background("sleep 100000")
            before[sandbox.sandbox_id] = (marker, sandbox.ping(), program.process_id)
            if level != "running":
                test.sleep_to(level, sandbox=sandbox)

    with test.phase("restart the host agent"):
        test.restart_host_agent()

    with test.phase("every sandbox kept its level"):
        for sandbox, level in zip(test.sandboxes, LEVELS, strict=True):
            observed = sandbox.try_get_info()
            test.verify(
                observed is not None and observed.level == level,
                "a sandbox changed level across a host agent restart",
                sandbox_id=sandbox.sandbox_id,
                expected_level=level,
                observed_level=None if observed is None else observed.level,
            )

    with test.phase("every sandbox kept its files and programs"):
        for sandbox in test.sandboxes:
            marker, service_pid, program = before[sandbox.sandbox_id]
            test.verify_equal(
                actual=sandbox.files.read(MARKER_PATH),
                expected=marker,
                message="a sandbox lost a file across a host agent restart",
            )
            test.verify_equal(
                actual=sandbox.ping(),
                expected=service_pid,
                message="a sandbox's guest restarted with the host agent",
                sandbox_id=sandbox.sandbox_id,
            )
            test.verify(
                sandbox.get_process(program) is not None,
                "a background program did not survive a host agent restart",
                sandbox_id=sandbox.sandbox_id,
            )

# Derived from SPACE's space_smoke/suite.py (https://github.com/perplexityai/SPACE, Apache-2.0,
# Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
"""Sequential process runner for discovered smoke scenarios."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from compute_smoke.model import Verdict
from compute_smoke.registry import Scenario

ProcessRunner = Callable[..., subprocess.CompletedProcess[str]]
LineSink = Callable[[str], None]
ScenarioStarted = Callable[[str], None]
RESULT_PREFIX = "RESULT: "
# Any outcome the suite cannot vouch for counts as an infrastructure error.
INFRA_EXIT_CODE = Verdict.INFRA_ERROR.exit_code


@dataclass(frozen=True)
class ScenarioProcessResult:
    scenario_id: str
    returncode: int
    stdout: str
    stderr: str
    report: Mapping[str, Any] | None = None

    @property
    def exit_code(self) -> int:
        """The scenario's exit status, trusted only when its process printed
        a RESULT line for this scenario whose verdict that status reports.

        Anything else is an infrastructure error: a crash, a scenario that
        called `sys.exit(0)` before its verdict, a report for another
        scenario, or a status that contradicts the reported verdict.
        """

        if self.report is None or self.report.get("scenario_id") != self.scenario_id:
            return INFRA_EXIT_CODE
        try:
            verdict = Verdict(self.report.get("verdict"))
        except ValueError:
            return INFRA_EXIT_CODE
        if verdict.exit_code != self.returncode:
            return INFRA_EXIT_CODE
        return self.returncode


def run_scenarios(
    scenarios: Sequence[Scenario[Any]],
    *,
    environment: Mapping[str, str] | None = None,
    executable: str = sys.executable,
    process_runner: ProcessRunner | None = None,
    on_start: ScenarioStarted | None = None,
    line_sink: LineSink | None = None,
    on_result: Callable[[ScenarioProcessResult], None] | None = None,
) -> tuple[ScenarioProcessResult, ...]:
    """Run each scenario in its own process, one scenario at a time."""

    values = dict(os.environ if environment is None else environment)
    results: list[ScenarioProcessResult] = []
    for registered in scenarios:
        if on_start is not None:
            on_start(registered.id)
        result = _run_one(
            registered.id,
            environment=values,
            executable=executable,
            process_runner=process_runner,
            line_sink=line_sink,
        )
        results.append(result)
        if on_result is not None:
            on_result(result)
    return tuple(results)


def suite_exit_code(results: Sequence[ScenarioProcessResult]) -> int:
    """Return one stable exit status for a complete suite."""

    if any(result.exit_code == 1 for result in results):
        return 1
    if any(result.exit_code not in {0, 42} for result in results):
        return 2
    if any(result.exit_code == 42 for result in results):
        return 42
    return 0


def _run_one(
    scenario_id: str,
    *,
    environment: Mapping[str, str],
    executable: str,
    process_runner: ProcessRunner | None,
    line_sink: LineSink | None,
) -> ScenarioProcessResult:
    command = [executable, "-m", "compute_smoke", "run", scenario_id]
    if process_runner is None and line_sink is not None:
        return _run_one_streamed(
            scenario_id,
            command=command,
            environment=environment,
            line_sink=line_sink,
        )

    runner = process_runner or subprocess.run
    try:
        completed = runner(
            command,
            env=dict(environment),
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        return ScenarioProcessResult(scenario_id, 2, "", f"{type(error).__name__}: {error}")
    if line_sink is not None:
        if completed.stdout:
            line_sink(completed.stdout)
        if completed.stderr:
            line_sink(completed.stderr)
    return ScenarioProcessResult(
        scenario_id,
        completed.returncode,
        completed.stdout,
        completed.stderr,
        _parse_report(completed.stdout),
    )


def _run_one_streamed(
    scenario_id: str,
    *,
    command: list[str],
    environment: Mapping[str, str],
    line_sink: LineSink,
) -> ScenarioProcessResult:
    """Tee one scenario's merged output while retaining its structured result."""

    try:
        process = subprocess.Popen(
            command,
            env=dict(environment),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
    except OSError as error:
        detail = f"{type(error).__name__}: {error}"
        line_sink(f"{detail}\n")
        return ScenarioProcessResult(scenario_id, 2, "", detail)

    assert process.stdout is not None
    lines: list[str] = []
    with process.stdout:
        for line in process.stdout:
            lines.append(line)
            line_sink(line)
    returncode = process.wait()
    stdout = "".join(lines)
    return ScenarioProcessResult(
        scenario_id,
        returncode,
        stdout,
        "",
        _parse_report(stdout),
    )


def _parse_report(stdout: str) -> Mapping[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        if not line.startswith(RESULT_PREFIX):
            continue
        try:
            payload = json.loads(line.removeprefix(RESULT_PREFIX))
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None
    return None

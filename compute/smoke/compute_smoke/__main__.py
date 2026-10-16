# Derived from SPACE's space_smoke/__main__.py (https://github.com/perplexityai/SPACE, Apache-2.0,
# Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
"""Discover and run Opengeni compute smoke scenarios against a host agent.

Environment:
  COMPUTE_SMOKE_SOCKET           the host agent's API socket (/run/compute-host.sock)
  COMPUTE_SMOKE_GUEST_PORT       the guest service's vsock port (53)
  COMPUTE_SMOKE_RESTART_AGENT    a command that restarts the host agent, for
                                 scenarios that prove sandboxes survive it
  COMPUTE_SMOKE_SCENARIO_PACKAGES  extra scenario packages, comma separated
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import sys
from collections.abc import Iterable
from typing import Any

from compute_smoke.client import HostAgent
from compute_smoke.registry import Scenario
from compute_smoke.runtime import (
    ScenarioTerminated,
    SmokeConfigurationError,
    execute_scenario,
)
from compute_smoke.scenarios import REGISTRY
from compute_smoke.services import MissingToolError, SmokeServices
from compute_smoke.sharding import select_shard
from compute_smoke.suite import (
    RESULT_PREFIX,
    ScenarioProcessResult,
    run_scenarios,
    suite_exit_code,
)

SOCKET_ENV = "COMPUTE_SMOKE_SOCKET"
GUEST_PORT_ENV = "COMPUTE_SMOKE_GUEST_PORT"
RESTART_ENV = "COMPUTE_SMOKE_RESTART_AGENT"
DEFAULT_SOCKET = "/run/compute-host.sock"
DEFAULT_GUEST_PORT = 53
API_SURFACE = "ecw"
# The conventional status of a process ended by SIGTERM.
TERMINATED_EXIT_CODE = 128 + 15


def services_from_environment(required_tools: Iterable[str] = ()) -> SmokeServices:
    missing = [tool for tool in required_tools if shutil.which(tool) is None]
    if missing:
        raise MissingToolError(f"required tools are not installed: {', '.join(missing)}")
    port_text = os.environ.get(GUEST_PORT_ENV, str(DEFAULT_GUEST_PORT))
    try:
        port = int(port_text)
    except ValueError as error:
        raise SmokeConfigurationError(f"{GUEST_PORT_ENV} must be a port number") from error
    restart = os.environ.get(RESTART_ENV, "").strip()
    return SmokeServices(
        host=HostAgent(os.environ.get(SOCKET_ENV, DEFAULT_SOCKET)),
        guest_port=port,
        restart_command=tuple(shlex.split(restart)) if restart else None,
    )


def _describe(scenario_id: str) -> int:
    scenario = REGISTRY.get(scenario_id)
    payload = {
        "id": scenario.id,
        "category": scenario.category,
        "title": scenario.title,
        "invariant": scenario.invariant,
        "fixture": scenario.fixture_name,
        "quarantined": scenario.quarantined,
        "ignored": scenario.ignored,
        "sandbox": {
            "count": scenario.sandbox_count,
            "timeout_seconds": scenario.sandbox.timeout,
            "host_config": scenario.sandbox.host_config(),
        },
        "timeout_minutes": scenario.timeout_minutes,
        "required_tools": list(scenario.required_tools),
        "rerun_environment": list(scenario.rerun_environment),
    }
    print(json.dumps(payload, indent=2))
    return 0


def _run(scenario_id: str) -> int:
    scenario = REGISTRY.get(scenario_id)
    try:
        services = services_from_environment(scenario.required_tools)
    except MissingToolError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except SmokeConfigurationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    try:
        result = execute_scenario(
            title=scenario.title,
            body=lambda context: scenario.run(context, services),
            timeout_seconds=scenario.timeout_minutes * 60,
        )
    except ScenarioTerminated:
        # Cleanup already ran; there is no verdict to report.
        print(f"TERMINATED: {scenario_id} stopped by SIGTERM after cleanup", flush=True)
        return TERMINATED_EXIT_CODE
    print(f"{result.verdict.value.upper()}: {result.summary}", flush=True)
    for diagnostic in result.diagnostics:
        print("TRACEBACK:", file=sys.stderr, flush=True)
        print(diagnostic, file=sys.stderr, end="", flush=True)
    if result.exit_code != 0:
        print(f"RERUN: {_rerun_command(scenario)}", flush=True)
    print(
        RESULT_PREFIX
        + json.dumps(
            {
                "scenario_id": scenario_id,
                "verdict": result.verdict.value,
                "summary": result.summary,
                "evidence": result.evidence,
                "cleanup_failures": result.cleanup_failures,
            },
            sort_keys=True,
            default=str,
        ),
        flush=True,
    )
    return result.exit_code


def _rerun_command(scenario: Scenario[Any]) -> str:
    names = dict.fromkeys(
        (
            SOCKET_ENV,
            GUEST_PORT_ENV,
            RESTART_ENV,
            "COMPUTE_SMOKE_SCENARIO_PACKAGES",
            *scenario.rerun_environment,
        )
    )
    assignments = [
        f"{name}={shlex.quote(value)}"
        for name in names
        if (value := os.environ.get(name)) is not None
    ]
    return " ".join([*assignments, "python3", "-m", "compute_smoke", "run", scenario.id])


def _print_started(scenario_id: str) -> None:
    print(f"RUN {scenario_id}", flush=True)


def _print_line(line: str) -> None:
    print(line, end="" if line.endswith("\n") else "\n", flush=True)


def _print_finished(result: ScenarioProcessResult) -> None:
    verdict = (
        str(result.report.get("verdict", "unknown")).upper()
        if result.report is not None
        else f"EXIT {result.exit_code}"
    )
    print(f"END {result.scenario_id}: {verdict}", flush=True)


def _run_all(*, category: str | None = None, shard: tuple[int, int] | None = None) -> int:
    scenarios = REGISTRY.select(category=category)
    # A held-back scenario is a visible hole in coverage, never a pass: name
    # each one and its reason so the run log shows what the suite did not prove.
    for held in REGISTRY.select(category=category, include_quarantined=True, include_ignored=True):
        if held.quarantined is not None:
            print(f"QUARANTINED {held.id}: {held.quarantined}")
        if held.ignored is not None:
            print(f"IGNORED {held.id}: {held.ignored}")
    if shard is not None:
        index, count = shard
        # Partition the eligible inventory, not execution: scenarios share
        # one host agent and run one at a time within a shard.
        scenarios = select_shard(scenarios, index=index, count=count, api_surface=API_SURFACE)
        print(f"SHARD {index}/{count}: {len(scenarios)} scenarios")
    selection = f"category {category!r}" if category is not None else "this run"
    if not scenarios:
        print(f"ERROR: no smoke scenarios apply to {selection}.", file=sys.stderr)
        return 2

    try:
        services = services_from_environment(
            dict.fromkeys(tool for scenario in scenarios for tool in scenario.required_tools)
        )
        services.host.status()
    except MissingToolError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except SmokeConfigurationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - suite bootstrap boundary
        print(f"ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        return 2

    label = f" {category}" if category is not None else ""
    print(f"Running {len(scenarios)}{label} smoke scenarios sequentially.")
    results = run_scenarios(
        scenarios,
        on_start=_print_started,
        line_sink=_print_line,
        on_result=_print_finished,
    )
    passed = sum(result.exit_code == 0 for result in results)
    warned = sum(result.exit_code == 42 for result in results)
    failed = sum(result.exit_code == 1 for result in results)
    incomplete = len(results) - passed - warned - failed
    print(
        f"SUITE: {passed} passed, {warned} warned, {failed} failed, "
        f"{incomplete} inconclusive or infrastructure errors"
    )
    for result in results:
        if result.exit_code != 0:
            summary = result.report.get("summary") if result.report is not None else None
            print(f"NOT PASSED {result.scenario_id}: {summary or result.stderr[-500:]}")
    return suite_exit_code(results)


def _parse_shard(value: str) -> tuple[int, int]:
    try:
        index, count = (int(part) for part in value.split("/"))
        if 1 <= index <= count:
            return index, count
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("shard must be INDEX/COUNT with 1 <= INDEX <= COUNT")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list")
    describe = subparsers.add_parser("describe")
    describe.add_argument("scenario")
    run = subparsers.add_parser("run")
    run.add_argument("scenario", nargs="?")
    run.add_argument("--all", action="store_true", dest="run_all")
    run.add_argument("--category", choices=REGISTRY.categories)
    run.add_argument(
        "--shard",
        type=_parse_shard,
        metavar="INDEX/COUNT",
        help="run one duration-balanced partition (1-based)",
    )
    args = parser.parse_args()

    if args.command == "list":
        for scenario in REGISTRY:
            print(f"{scenario.id}\t{scenario.invariant}")
        return 0
    if args.command == "describe":
        return _describe(args.scenario)
    selectors = sum(
        (
            args.scenario is not None,
            args.run_all,
            args.category is not None,
        )
    )
    if selectors != 1:
        parser.error("run requires exactly one scenario, --all, or --category")
    if args.shard is not None and args.scenario is not None:
        parser.error("--shard requires --all or --category")
    if args.run_all:
        return _run_all(shard=args.shard)
    if args.category is not None:
        return _run_all(category=args.category, shard=args.shard)
    assert args.scenario is not None
    return _run(args.scenario)


if __name__ == "__main__":
    raise SystemExit(main())

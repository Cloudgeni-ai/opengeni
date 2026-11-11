# Derived from SPACE's space_smoke/sharding.py (https://github.com/perplexityai/SPACE, Apache-2.0,
# Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
"""Deterministic duration-balanced partitions of an already eligible inventory."""

from typing import Any

from compute_smoke.registry import Scenario

# Rounded wall-clock seconds, including scenario setup and cleanup. These are
# scheduling hints, not timeouts or an allowlist. New or renamed scenarios get
# a conservative default and always participate. Refresh from successful runs'
# RUN/END timestamps.
_DURATION_SECONDS = {
    "ecw": {
        # Measured against a host agent on a nested-virtualization host,
        # rounded up with a second for cleanup.
        "ecw.access_idle_reconnect_preserves_workspace": 17,
        "ecw.background_process_control": 3,
        "ecw.binary_file_round_trip": 3,
        "ecw.command_round_trip": 3,
        "ecw.filesystem_mutations": 3,
        "ecw.filesystem_round_trip": 3,
        "ecw.filesystem_watcher": 4,
        "ecw.large_stdout_integrity": 4,
        "ecw.pause_connect": 4,
        "ecw.pause_connect_race": 5,
        "ecw.process_reattach": 14,
        "ecw.refresh_keepalive": 40,
        "ecw.sandbox_delete": 3,
        "ecw.sandbox_info": 3,
        "ecw.timeout_rearm": 40,
        "ecw.timeout_update": 76,
        "compute.concurrent_wakes_converge": 4,
        "compute.hold_keeps_awake": 16,
        "compute.round_trip_at_every_level": 6,
        # Estimate until a run refreshes it.
        "compute.agent_restart_keeps_sandboxes": 40,
    },
}


def select_shard(
    scenarios: tuple[Scenario[Any], ...],
    *,
    index: int,
    count: int,
    api_surface: str,
) -> tuple[Scenario[Any], ...]:
    """Place expensive scenarios first on the lightest shard, then run by ID."""
    durations = _DURATION_SECONDS.get(api_surface, {})
    loads = [0] * count
    partitions: list[list[Scenario[Any]]] = [[] for _ in range(count)]
    for scenario in sorted(
        scenarios, key=lambda scenario: (-durations.get(scenario.id, 30), scenario.id)
    ):
        # Equal loads choose the lower shard index. Neither discovery order nor
        # process-local hash randomization may change the partition assignment.
        target = min(range(count), key=loads.__getitem__)
        partitions[target].append(scenario)
        loads[target] += durations.get(scenario.id, 30)
    return tuple(sorted(partitions[index - 1], key=lambda scenario: scenario.id))

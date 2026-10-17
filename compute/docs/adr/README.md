# Architecture decisions

Short records of the choices that shape compute: what we decided, why, and
what it costs. A decision changes through a new record that supersedes the
old one; old records stay as history.

| # | Decision | Status |
| --- | --- | --- |
| 1 | [Our own fabric: one agent per host, Firecracker microVMs](0001-own-fabric-one-agent-per-host.md) | Accepted |
| 2 | [A pure decision core](0002-pure-decision-core.md) | Accepted |
| 3 | [Idle means no activity; a ladder of sleep levels](0003-activity-idle-and-sleep-levels.md) | Accepted |
| 4 | [Memory pressure, not timers, evicts from RAM](0004-memory-pressure-evicts.md) | Accepted |
| 5 | [One memory profile per host: bare metal or nested](0005-host-memory-profiles.md) | Accepted |
| 6 | [A memory image is valid only with its disk; images are self-contained](0006-memory-images-and-disks.md) | Accepted |
| 7 | [Never delete the only good copy](0007-never-delete-the-only-good-copy.md) | Accepted |
| 8 | [Wake from object storage lazily, working set first](0008-lazy-wake-with-a-working-set.md) | Accepted |
| 9 | [VMs outlive the agent](0009-vms-outlive-the-agent.md) | Accepted |
| 10 | [The crash-safety bar](0010-crash-safety-bar.md) | Accepted |
| 11 | [The same guest network everywhere, firewalled per sandbox](0011-fixed-guest-network.md) | Accepted |
| 12 | [Templates and a ready pool for new sandboxes](0012-templates-and-ready-pool.md) | Accepted, in progress |
| 13 | [Structure rules checked on every change](0013-structure-rules.md) | Accepted |
| 14 | [Requests, limits and admission](0014-requests-limits-and-admission.md) | Accepted |
| 15 | [Placement and moving sandboxes between hosts](0015-placement-and-moves-between-hosts.md) | Accepted, built by 18 |
| 16 | [Observability: wide events, small metrics, zero alarms](0016-observability.md) | Proposed |
| 17 | [Sweeping the chunks no copy names](0017-sweeping-unnamed-chunks.md) | Accepted |
| 18 | [The fleet: one service, leases in Postgres, fences on every write](0018-the-fleet-service-leases-and-fences.md) | Accepted, in progress |
| 19 | [An E2B-compatible front door and our own guest init](0019-e2b-compatible-front-door-and-guest-init.md) | Accepted, in progress |

## Format

Each record has a title, a status line with a date, and three parts:
**Context** (the forces at play), **Decision** (what we do) and
**Consequences** (what follows, good and bad, including what we gave up).
Keep it to one screen.

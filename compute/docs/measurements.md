# Measurements

Observations from lab runs, not bounds. Firecracker v1.17.0 under its jailer,
one host agent per host, synthetic data only. "First response" is the time
from the wake request until a command in the guest answers; "done" is until
that command finishes.

Workload (the "realistic" set): each sandbox copies a repository, runs its
tests and commits; each wake reads the repository and loads it in Node.

## Nested host, GCP n2-standard-32, nested profile, directory store

| Case | Result |
| --- | --- |
| Paused, 1 | first response 8.5 ms; 388 MiB resident, 320 MiB of it huge pages |
| Paused, 100 at once | first response p50/p90 47/69 ms |
| Saved, 1 (image in host file cache) | first response 108 ms |
| Saved, 100 at once | first response 1.1/1.6 s, done 1.9/2.3 s |
| Compressed, 1 (bare-metal profile on the same host) | first response 139 ms; 60 MiB resident plus 52 MiB compressed |
| Compressed, 100 at once | first response 2.2/2.5 s, done 8.8 s |
| Agent memory | about 11 MiB, plus about 3 MiB per Firecracker process |

## Nested host, GCP n2-highmem-32, nested profile, same-region GCS

| Case | Result |
| --- | --- |
| Remote, 1, working set learned | first response 0.90 s, done 1.0 s (fetch 0.60 s, restore 0.22 s) |
| Remote, 100 at once | first response p50 about 30 s; limited by a shared step in fetch and publish, being profiled |

## Nested host, Azure D32ds_v5, agent restart

| Case | Result |
| --- | --- |
| kill -9 with 100 sandboxes at mixed levels | serving again in 509 ms; none lost |
| Wake after restart, p50/p90 | running 0.7/88 ms, paused 68/107 ms, saved 377/394 ms |
| Create from a template, 1 / 100 at once | 265 ms / p50 7.2 s, p90 9.6 s |

Bare-metal results (GCP z3 metal) and the final runs on merged code will
replace these tables.

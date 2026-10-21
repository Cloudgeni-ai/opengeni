---
"@opengeni/db": patch
---

Every scheduled run now either runs or tells the schedule's owner. An occurrence aimed at a paused chat is skipped under every overlap policy, so the schedule pauses itself and says so instead of queueing runs that never settle; a paused workspace skips runs with its own reason and keeps the schedule. A daily, weekly or one-time schedule tells its owner on its first failed run, only schedules running at least hourly wait for three in a row, and a schedule's failed last run is reported before the schedule retires.

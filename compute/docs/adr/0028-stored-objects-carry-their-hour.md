# 28. Stored objects carry their hour, and the sweep runs hourly

Status: Accepted, 2026-11-02. Amends
[25](0025-pointers-in-the-control-service-and-objects-by-day.md): what a
name's period is, and how long after it a sweep may delete.

## Context

ADR 25 names every chunk and manifest with the UTC day it was written in,
and lets a daily sweep delete one no pointer names once its day ended a
whole day before the sweep began. A replaced copy therefore stays stored
for one to two days, and a store holds what its copies name plus about two
days of everything archived.

Checkpoints made that the larger part. A busy sandbox checkpoints every
ten minutes, each a few hundred MB of new chunks that the next one
replaces. In a fleet of three storage nodes holding three copies (every
node holds everything), the archive grew from 136 GB to 195 GB in a day
while what the copies named stayed about the same, and the smallest node
came within hours of full.

The margin was wider than the rule needs. An archive that began after a
sweep's fence writes, and reuses by its bytes, only names of its own
current period, which by any clock within `CLOCK_SKEW` of the sweep's is
no earlier than the period the sweep began in less that margin. A sweep
may delete any unnamed object whose period ended at least `CLOCK_SKEW`
before it began, whatever the period's length.

## Decision

- **A name's period is its hour**: UTC hours since 1970, written where a
  day was (`chunks/v2/<period>/...`, `manifests/v2/<period>/<digest>.json`,
  a copy's `<period>/<digest>` and a chunk reference's `day`). Numbers below
  100,000 are days, as every name written before is; hours have been above
  it since 1981 and days stay below it until 2243. The layout and the copy
  format (4) are unchanged.
- **A sweep deletes an unnamed object once its period ended at least
  `CLOCK_SKEW` (an hour) before the sweep began**, for hours and days
  alike.
- **The sweep runs hourly** (the chart's `computeControl.sweep.schedule`
  defaults to `17 * * * *`). One at a time, as before.

## Consequences

- What only a replaced copy named goes within about two to three hours,
  not one to two days: a store holds about what its copies name.
- Mixed releases need no ordering. A host of an earlier release reads hour
  names, which it builds keys from as it would a day's, and writes days,
  which this release sweeps by the same rule. A sweep of an earlier release
  reads an hour as a day far ahead and never deletes it, so rolling the
  control image back only keeps garbage longer.
- The same new bytes written in different hours are stored once per hour,
  where they were once per day. What an archive reuses of the copy before
  it, or of its image, is unaffected.
- Each sweep fences every pointer, so an archive in flight across a sweep
  starts again once an hour instead of once a day; it reuses what it
  already stored that hour.
- A sweep lists the whole store each hour: about eight minutes and a few
  thousand list requests for 2.5 million objects.

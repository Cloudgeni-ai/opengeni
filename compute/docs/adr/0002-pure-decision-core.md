# 2. A pure decision core

Status: Accepted, 2026-10-15

## Context

Sleep and wake logic has many interleavings: requests arrive while a save is
running, steps fail, the agent crashes half way, memory runs low. Bugs there
lose data, and real VMs make such cases slow and hard to reproduce.

## Decision

`compute-core` decides and does nothing else. It holds each sandbox's state
machine, the sleep policy and memory pressure, and turns events into steps.
It has no I/O, clock or randomness; time comes in as an argument.
`compute-host` carries out the steps and reports their results back. `cargo
arch` enforces the purity.

## Consequences

- A seeded simulation runs 400 random histories of 600 events (delays,
  failures, crashes, memory pressure) in seconds and checks the core against
  an independent model after every input. A failing seed replays exactly.
- Every behavior question has one place to look.
- The host layer must report each step's real outcome, including "unknown",
  so the core never assumes success.

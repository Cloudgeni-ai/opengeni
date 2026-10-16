# 4. Memory pressure, not timers, evicts from RAM

Status: Accepted, 2026-10-16

## Context

A paused sandbox whose state is already saved costs only memory. Taking it
out of memory on a timer makes its next wake slower and saves nothing while
the host has room to spare.

## Decision

Sandboxes leave memory only when the host needs it. When available memory
falls below a low watermark, the host pushes idle sandboxes one step deeper,
least recently used first (compress where the profile allows, then end the
VM process), until the expected available memory reaches a high watermark.
Busy sandboxes are never pushed.

## Consequences

- Idle sandboxes stay in the fastest level for as long as memory allows.
- Eviction removes the sandboxes a timer would have picked, but only as many
  as are needed.
- When the safety save already exists, eviction is just ending a process. A
  sandbox hit by pressure before its save is saved first, which takes seconds.
- If every sandbox is busy, eviction cannot help; admission must refuse new
  work instead ([14](0014-requests-limits-and-admission.md)).

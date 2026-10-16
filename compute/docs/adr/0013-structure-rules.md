# 13. Structure rules checked on every change

Status: Accepted, 2026-10-15

## Context

Small, plain code is a goal in its own right: less to review, less to
attack. Code drifts unless the rules are checked by a machine.

## Decision

`cargo arch` (archcheck, from SPACE) checks `ARCHITECTURE.toml` on every
change:

- no production file over 1,000 code lines;
- no I/O, clocks, randomness or printing in `compute-core`;
- `unsafe` only in a short list of files.

Existing exceptions sit in `architecture-baseline.toml`, which may only
shrink. The workspace also builds with Clippy's pedantic lints and rustfmt.

## Consequences

- New exceptions need a visible change to the baseline.
- Large modules get split early.

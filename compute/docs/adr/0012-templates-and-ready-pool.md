# 12. Templates and a ready pool for new sandboxes

Status: Accepted, 2026-10-16. Templates in review; the ready pool is being
built.

## Context

A cold boot runs the guest's whole startup before the first command. Many
sandboxes created at once all pay it at the same time.

## Decision

- For each shape (processors and memory) the host keeps a template: a guest
  booted once, left until it accepts connections, then paused and saved.
- A new sandbox gets a copy-on-write copy of the template's disk and the
  template's memory image by hard link, so all clones read one file through
  one page cache. Its first wake is an ordinary restore.
- After restore the host sends the guest its identity. The guest stores it
  before acknowledging, and no command runs until it has.
- A ready pool keeps a configured number of clones per shape already restored
  and paused. A create takes one with a single record write. Ready clones are
  disposable: never saved, and removed first when memory runs low.

## Consequences

- Creating from a template is a restore, not a boot. From the ready pool it
  is a resume.
- Ready clones cost memory while unused; the pool size is a per-host setting.
- When the base image changes, the template and its ready clones are rebuilt.
  Sandboxes already created keep their own copy.

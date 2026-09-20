# Session attachments

Human initial prompts, Send, Steer and realtime human delegation accept explicitly
attached private uploads into the session transaction. Realtime creation only stages
resources; the first authenticated human prompt establishes grants, using immutable
creation provenance. Merely inheriting a human identity does not publish attachments.

`packages/db/src/session-file-attachments.ts` and migration 0499 own the exact
session/file grants. Only completed uploads owned by the accepting human qualify.
The migration backfills explicit accepted human-message attachments, never inferred
ownership from session creators or arbitrary history references.

A grant changes access through that session, not the original file's visibility.
Sharing permits authorized session readers to read those attachments; making the
session private removes that session access. Generic Files/Knowledge queries retain
original ownership. Provider originals, including Google Drive resources, retain
independent provider ACLs. Session sharing does not choose an executing human.

Browser history retains file IDs. Metadata and download requests include `sessionId`;
core proves session access, then the database fences its visibility epoch. Only then
does the existing storage provider mint a short-lived download URL. That URL remains
a bearer capability until expiration; later unsharing cannot revoke an already-issued
URL retroactively. Browser URLs are not reused for model input.

Workers supply their current session, exact live attempt and execution generation
through server-owned context. An isolated transaction-scoped database capability
permits only granted file reads. It is removed before return and never enables file
mutation. A service continuation needs no invented human to read its own accepted
attachments; unrelated personal files remain inaccessible.

Forking copies accepted grants with destination-local event provenance. A message
fork includes only grants at or before its selected boundary. Copied grants remain
independent of subsequent source visibility changes.

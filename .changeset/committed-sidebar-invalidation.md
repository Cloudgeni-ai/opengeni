---
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/config": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Keep idle session sidebars quiet using authorized commit-level invalidations on
the existing workspace live stream. Web and desktop refresh dirty loaded scopes
within the existing 15-second cadence and reconcile on reconnect/focus. Private
session IDs are filtered with the same RLS and membership fence as list reads.

Database hosts using a transaction pooler may configure a separate direct/session
notification URL. Older servers, external host ACLs, injected database handles
without a listener, and finite HTTP/1 streams keep their polling fallback. The new
SDK workspace event is transient and does not advance either durable stream cursor.

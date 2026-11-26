---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/contracts": patch
---

Removing a repository from a chat with many sub-sessions answers quickly: the sub-sessions that hold the repository are changed a few at a time, and the rest get their removal record in batches. The Remove button in the confirmation works right away instead of waiting for the unsaved-changes check.

The settings rail has a fixed, collapsed Advanced section at the end for everyone, holding the rarely used pages (Agent learning, API keys, Developer, Shared, Organization identity, Security & data). It replaces the personal More: pages someone had moved under More show at the top again unless they are now under Advanced. The sidebar layout option `settingsMore` is still accepted and returned for older clients, but ignored.

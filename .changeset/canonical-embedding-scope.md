---
"@opengeni/contracts": major
"@opengeni/sdk": major
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Use authenticated canonical users instead of session end-user labels. Session
creation rejects caller-supplied identity scope; list filters use scopeSubjectId.
Chat user mode uses asUser and explicit workspace membership, while collaborators
address the same session ID. Reopen legacy user-namespaced chats by session ID.

Retire active session Memory in favor of task notes. Historical session Memory
remains stored and old selectors hydrate as off, never workspace. User Memory
uses the verified active-turn user. Preserve frozen scheduled agent-reach policy.
Migration 0457 requires the documented maintenance cutover and matching writers.
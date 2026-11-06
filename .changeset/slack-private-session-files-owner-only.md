---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Files from a private Slack session now belong only to the person it belongs to. A bot DM or private handoff session was already visible only to its owner, but the images they attached to it and the files and screenshots its agent produced were ordinary workspace files that other members could list and download. Images imported from a private Slack interaction and files produced by agents in a session whose root a private Slack interaction owns now get that person as their private owner, as in an Only-me session; the Knowledge learning destination is unchanged. The session screenshot routes (`/sessions/:sessionId/artifacts/:artifactId` and its `/content`) now apply session read authorization to every caller, not only agent attempts, and answer a session the caller may not read like a missing artifact. Files created before this change keep their existing audience.

---
"@opengeni/api-router": patch
---

An ordinary `git push` as the person (a new branch or a fast-forward) from a shallow clone, the way managed sandboxes clone, no longer asks for approval as "Push to <repository>". Git sends a shallow clone's `shallow` lines before the first command, and the push reader now finds the capabilities on that first command, as Git's own receive-pack does. A fast-forward larger than the inspection limit is checked from the commits read before the cut instead of being asked about as a force push. Force pushes and ref deletions still ask.

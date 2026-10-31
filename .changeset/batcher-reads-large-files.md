---
---

Merge batcher: moving a queued PR's migration off a number main already uses no longer stops at a large changed file. GitHub's GraphQL API truncates the text of big blobs (a 3.7 MB source file came back truncated), so the batcher used to call the file unreadable and eject the PR for manual renumbering. It now reads truncated text files in full through the blob API, which means it can skip big files that never mention the migration and still rewrite the ones that do. Binary files are still never read.

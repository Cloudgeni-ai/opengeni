---
"@opengeni/runtime": patch
"@opengeni/storage": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Docker sandbox: draining an idle box to cold no longer leaves its whole host workspace directory (`openai-agents-docker-sandbox-*`) behind. After the workspace archive is published and the exact container is removed, the drain re-checks its ownership evidence and deletes the directory, including read-only Go module caches. A retry after a crash finishes without recapturing, and `bun run dev:clean` also removes the workspace directories of the sandbox containers it removes. Object-storage restore downloads now use owner-marked temporary directories as well, so a process killed mid-download leaves nothing behind once the next process starts.

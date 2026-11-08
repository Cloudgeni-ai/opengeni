---
"@opengeni/runtime": patch
---

Repository setup no longer fails with "could not lock config file .gitconfig" when several preparations run on one sandbox at once, such as chats created together that share a box, each cloning several repositories. Every write to the global Git config during preparation (the credential helper, the Git HTTP broker include, the default commit identity and safe.directory) now runs as one unit under a per-sandbox lock, and each write retries for a bounded time while another writer holds Git's own lock. Where `flock` is unavailable (macOS machines) the bounded retry still applies. Concurrent preparations also stop adding duplicate credential helper and safe.directory entries.

---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/github": patch
"@opengeni/react": patch
---

A workspace's GitHub App repositories now follow GitHub. A repository added to a bound installation, including a new repository of an "All repositories" installation, appears for the whole workspace without reconnecting, and one removed from it stops being usable at once. The App's `installation_repositories`, `installation` and `repository` webhooks update every bound workspace (even with event triggers off), and every repository listing applies the list GitHub just returned, so a missed webhook repairs itself. Opening the new-chat repository menu re-reads the list. Bindings still need the original owner proof; following GitHub's later selection is the delegated behaviour, documented in `docs/github-app.md`. New Apps also subscribe to `repository` events.

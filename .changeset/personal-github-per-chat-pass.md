---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Chats that share one sandbox (a parent and its workers) now each keep their own personal GitHub pass, broker routes and `gh` setup, so Git and `gh` in one chat no longer fail with "authorization is no longer current" after another chat on the box ran. The repository remote stays `https://github.com/<owner>/<repo>`, no token enters the sandbox, renewal updates only its own chat, and chat directories unused for a day are removed.

A personal repository resource that also carries stray GitHub App fields is accepted with those fields ignored (access is still checked as the person), and a request without a running agent attempt now says so instead of asking to reconnect GitHub.

Repairing an uninstalled GitHub App installation while GitHub can't be reached now says "GitHub couldn't be reached" with **Check again** (the API answers 503 `provider_unreachable`) instead of opening the account chooser. When a reinstall replaces the old installation, its approval choices move to the new one with their original setter, and the old installation's rows are removed.

---
"@opengeni/runtime": patch
"@opengeni/core": patch
---

Chats that share one sandbox (a parent and its workers) now each keep their own personal GitHub pass, broker routes and `gh` setup, so Git and `gh` in one chat no longer fail with "authorization is no longer current" after another chat on the box ran. The repository remote stays `https://github.com/<owner>/<repo>`, no token enters the sandbox, renewal updates only its own chat, and chat directories unused for a day are removed.

A personal repository resource that also carries stray GitHub App fields is accepted with those fields ignored (access is still checked as the person), and a request without a running agent attempt now says so instead of asking to reconnect GitHub.

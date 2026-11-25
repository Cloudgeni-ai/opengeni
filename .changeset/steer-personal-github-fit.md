---
"@opengeni/db": patch
---

A turn started by another agent's message or steer no longer fails at start with "Personal GitHub repository does not match the accepted selection". It carried the sender's Your GitHub repository list, which named the sender's repositories rather than the receiving chat's. That list is now fitted to the receiving chat's repositories, within what the sender held. When a repository falls outside that, the turn keeps the Your GitHub the same person already gave this chat, and runs without it only if none fits.

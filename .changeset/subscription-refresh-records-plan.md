---
"@opengeni/db": patch
---

A subscription connection's recorded plan now follows its token on every refresh. Refreshes outside a chat turn (live voice and other operations, usage reads, administered connections) used to store the new token but drop the plan it reports, so a connection whose provider plan changed kept showing the old one. Every refresh path now runs one shared rotation and persists through the same database writer, which records the plan (a token that reports none keeps the recorded plan) and clears the connection's model cooldowns when the plan changed. Migration 1361 lets that writer accept a refresh outside a chat turn.

---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

Send each distinct session goal context to the model once per request. Every accepted turn still freezes its goal onto its input, but a context identical to the most recent one earlier in the request now becomes a one-line "unchanged" stand-in; a changed revision, state or text is rendered in full. The projection depends only on earlier items, so request prefixes stay cache-stable. Compaction charges its retention budget on the collapsed form, keeps the goal in full on the oldest retained message, and no longer retains answered status-only machine updates (command results, wait timeouts, child progress, goal nudges) verbatim, since the summary already carries them. The newest input is always retained.

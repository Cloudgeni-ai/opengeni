---
"@opengeni/runtime": patch
---

Never serialize the internal resume-message marker (`opengeni_internal_resume` in item providerData) to any model provider. The @openai/agents SDK spreads providerData keys verbatim into the wire item and strict Responses backends reject unknown per-item fields — in production every turn whose input contained a marked resume message failed deterministically with `400 Unknown parameter: 'input[N].opengeni_internal_resume'`, and because the marker is durable in replayed conversation history, retries could never succeed (sessions stayed dead). The sanitizer now strips the key from every history item and from the fresh trailing resume message before ANY model request; unrelated providerData keys are preserved and untouched items keep reference identity. Resume-notice detection (isInternalResumeMessage) reads stored history and keeps its text-prefix fallback, so compaction housekeeping degrades gracefully instead of ever failing a turn.

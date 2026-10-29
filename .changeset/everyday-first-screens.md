---
"@opengeni/react": minor
---

The new-chat page now asks "What can I help with?" for everyone, with "Ask anything, or describe what you need…" in the text box. It used to say "What should the agent do?" to everyone who didn't choose everyday help at sign-up. The suggestions under the composer still follow that answer, but only people who chose to build or run agents get the developer suggestions; people who skipped the question or signed up before it existed now get the everyday ones. The project picker and model stay where they were. `SessionApp` takes a new `starters` prop: a host's own new-chat suggestions in place of Opengeni's (each an `id`, a `title`, an optional `description` and the `prompt` that choosing it puts in the composer). Passing them turns the `starters` feature on unless `features.starters` says otherwise.

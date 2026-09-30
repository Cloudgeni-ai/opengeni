---
"@opengeni/sdk": minor
---

Fix `Chat.stream()` / `Chat.send()` hanging after the `done` chunk on fetch
implementations that settle a body `cancel()` only after the request aborts
(Next.js on Node): the chat now aborts the event stream before unwinding, and
the SSE parser and heartbeat wrapper never await `cancel()`.

The chat facade accepts per-message `model`, `reasoningEffort`, `latencyMode`,
and `modelContext` on `send`, `stream`, and `steer`, and exports
`formatImportedHistory`. The Vercel UI message stream (AI SDK 5, 6, and 7)
no longer emits OpenGeni's own tool activity unless `toolParts: true`; opted-in
and approval tool parts are marked `dynamic` and `providerExecuted`, and
`uiMessageStreamParts(chunks, { framing: false })` writes into an existing AI
SDK `createUIMessageStream` route.

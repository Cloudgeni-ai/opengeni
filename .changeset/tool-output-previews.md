---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Opening a turn's steps now reads large tool outputs as bounded previews instead of whole payloads, so a long turn's steps load in a fraction of the bytes. A row reads its full output once, when it is expanded or when its renderer needs the exact result (screenshots, images, receipts, search results, and custom renderers). Until then its body says the full output is loading, and if that read fails it says the body is a preview and offers Retry. Presented results such as images, published files and Skill or Knowledge writes are still read in full. `listEventPage` and `listEvents` accept `toolOutputs: "preview"`; servers that predate it return exact outputs. `ToolCallItem.outputPreview` and the `ToolOutputPreview` type are new and additive.

`useSessionEvents().events` now carries those previews for opened turns until a row's exact output is read. A previewed `agent.toolCall.output` payload is marked with `outputPreview` (`truncated: true`, `shape`, `originalBytes`, `previewBytes`); with `shape: "text"` its `output` is the head and tail of the output's text rather than the original value. Code that reads tool outputs from `events` should treat a payload with `outputPreview` as partial, and read the exact event with `listEventPage` when it needs it.

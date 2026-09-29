---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

`@opengeni/react` no longer names the optional `@pierre/diffs` peer in any
`import()` reachable from the conversation, so a Next.js (Turbopack) or Vite
host that imports only `OpenGeniProvider` and `SessionConversation` builds
without it. Hosts that install `@pierre/diffs` opt in once with
`enablePierreDiffs()` from the new `@opengeni/react/diffs` entry (or
`registerPierreDiffs(loader)`); otherwise diffs and file views are plain text.
`SessionConversation` hides its model picker when the client config reports
`modelSelection: false`, with a `modelPicker` prop to override.

`createSessionProxyHandler` adds `beforeForwardMessage`, which returns
server-owned `modelContext` and MCP credential rotations
(`mcpCredentialUpdates`) for every forwarded message, steer, composer submit,
and browser-started create, or a `Response` to refuse it. With
`modelSelection: false` the proxy reports it in the client config.
`ClientConfig` gains the optional `modelSelection` field.

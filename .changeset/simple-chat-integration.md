---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": patch
"@opengeni/codemode": patch
---

Add the `@opengeni/sdk/chat` facade (`OpenGeni`, `Chat`, `createChatHandler`, Vercel AI SDK and OpenAI adapters) and the `@opengeni/react/chat` drop-in component. Sessions gain `agentAccess`, an opaque `endUser` label, and `memoryScope`, enforced in the session-authorization seam so one workspace per customer can hold isolated, per-user, or shared chats. Organization API keys gain `access: "read"` and `GET /v1/organizations/:id/sessions`. Close the tool-widening paths: child tool selection, agent tool-policy updates, scheduled-task sessions, and the Codemode SDK proxy can no longer exceed the creating session.

Private-memory identities use bounded hashes of exact source/user tuples. Correction, archival, and replacement enforce the private writable scope. Chat reload restores unresolved approvals and questions, and the chat component uses the complete human-input form with multiple selections and Other answers.

Session-scoped discovery preserves the embedding host's allowlist. Responses streams emit the complete message/content lifecycle with stable per-response IDs, including incomplete settlement for human waits and cancellation. Streaming text preserves the same paragraph separators as the final reply.

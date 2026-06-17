---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Initial public release of the OpenGeni client packages.

- `@opengeni/contracts`: shared zod wire-contract schemas and types.
- `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
- `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.

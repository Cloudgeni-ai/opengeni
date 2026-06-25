# @opengeni/contracts

## 0.3.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.

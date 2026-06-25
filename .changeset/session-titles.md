---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

- `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
- `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
- `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

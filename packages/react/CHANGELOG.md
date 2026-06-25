# @opengeni/react

## 0.5.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

### Patch Changes

- Updated dependencies [48c0d2e]
  - @opengeni/sdk@0.5.0

## 0.4.0

### Minor Changes

- a1c82c5: Add the world-class timeline tool-call renderer module and the sandbox-surfacing client surface to `@opengeni/react`.

  - **Timeline renderers**: per-tool disclosure cards (full-row toggle, keyboard-accessible), screenshots → lightbox, theme-aware Pierre diffs, turn-collapse summary chips, sub-agent worker/goal landmarks, a consumer-extensible tool registry, and complete state handling (running / complete / failed / cancelled), each with its own affordance.
  - **Sandbox surfacing**: file/terminal/git/desktop hooks and components (`useSandboxFiles`, `useSandboxTerminal`, `useSandboxGit`, `useDesktopStream`, `useTerminalStream`, `useSessionCapabilities`, `SandboxFiles`, `SandboxTerminal`, `DesktopViewer`, `WorkspaceDock`, Pierre diff/file views, `CodeEditor`).

  All additive; `MessageTimeline`'s `items` contract is unchanged. The internal `compactPayloadPreview` helper was removed from the public surface.

### Patch Changes

- Updated dependencies [2989163]
- Updated dependencies [a1c82c5]
  - @opengeni/sdk@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [a78a09b]
  - @opengeni/sdk@0.3.1

## 0.3.0

### Minor Changes

- daaffd7: Chat `MessageTimeline` now renders message bodies as **markdown by default** (react-markdown + remark-gfm, themed to the `og-*` design tokens — headings, lists, GFM task lists, inline/fenced code, blockquotes, tables, links). The `renderMessageText` prop still overrides the default renderer.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.

### Patch Changes

- Updated dependencies [21c1535]
  - @opengeni/sdk@0.2.0

# @opengeni/react

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

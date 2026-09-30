# Product shapes and UI

## Default to the full conversation

| Need | Surface | Product owns |
| --- | --- | --- |
| Agent conversation in a React product (default) | `OpenGeniChat` (or `SessionConversation` for one record) + `compiled.css` behind `createSessionProxyHandler` | Shell, placement, and `--og-*` theme |
| Materially different interaction model in React | Headless `@opengeni/react/session` hooks and projections | Components, layout, and styling |
| Non-React frontend, mobile app, CLI, or automation | OpenGeni SDK or public API behind the product backend | All user-facing presentation |
| Product exposes files, changes, terminal, or desktop compute | Workbench surfaces beside the conversation | Product shell and selected tabs |
| Existing Vercel `useChat` or OpenAI-shaped chat UI to keep | `@opengeni/sdk/chat` fallback (text-only) | Its existing chat UI |

Default to the full conversation component. Deviate only when the product needs a materially different interaction model, a non-React frontend, or compute surfaces, and record why. Styling differences alone are not a reason: theme with `--og-*` tokens and density props. Do not mount the workbench for an ordinary analytics chat, and do not rebuild session streaming, replay, queueing, approval, or timeline projection that a package already supplies.

## When deviating in React

Inspect the installed OpenGeni React package before creating replacement components. Its subpaths are composable, and the styled surfaces use scoped compiled CSS plus runtime theme and density tokens. Prefer, in order: `SessionConversation` customized through `composerProps` and `renderMessageText`; `MessageTimeline`, `ChatComposer`, and the session hooks composed into product layout; then a fully custom SDK-driven UI. Do not force a packaged component when the product needs a materially different interaction model.

For Svelte, SvelteKit, Vue, native mobile, or another non-React frontend, use the product's native component system. Keep the privileged OpenGeni client on a compatible backend boundary. A SvelteKit server route may use the TypeScript SDK directly; a non-JavaScript backend may use the public HTTP contract or a small compatible adapter. The browser still speaks to authenticated product routes.

## Links, downloads, artifacts, and Sites

Agent replies link OpenGeni objects as `artifact:<file uuid>`,
`sandbox:<path>[:line]`, `/workspaces/<ws>/artifacts/editable/<id>` (live
document, workbook, or presentation), and `/workspaces/<ws>/artifacts/<uuid>`
(Site). None is navigable inside the product: the `/workspaces/...` forms are
console routes and 404 on the product origin. Never pass them to a raw `<a>`.

- `SessionConversation`/`OpenGeniChat` behind `createSessionProxyHandler`
  download `artifact:` files by default. `sandbox:` reads require deliberate
  proxy `sandboxFiles: true` (default off) plus `files:read`; they are confined
  to the selected working directory, including on Connected Machines, and
  refuse symlinked paths. Disabled sandbox links render unavailable.
- Artifacts and Sites: reuse the OpenGeni surfaces, do not rebuild them.
  `opengeni-site` fences render the inline Site preview automatically. Mount
  `SessionArtifactViewer` (`@opengeni/react/artifacts`) in a host container
  (for example the main area beside an assistant panel, a full-screen sheet on
  phones) and pass `onOpenArtifact` to `SessionConversation` (or
  `viewerLinkResolver` to `MessageTimeline`). Enable the proxy's
  `artifacts: true`; editors also need the document, spreadsheet, and
  presentation runtimes (`@opengeni/artifact-kernel-wasm-document`,
  `@opengeni/artifact-kernel-wasm-spreadsheet`,
  `@opengeni/artifact-kernel-wasm-presentation`) plus the SDK Worker URL
  (`editableRuntimes`). A custom host proxy reports the viewer capability with
  `artifactViewerCapability` from `@opengeni/sdk`. Close the viewer when the session changes.
  Translate its copy with `labels` (partial `ArtifactLabels`) or
  `ArtifactLabelsProvider`.
- Other routing: `resolveLink={(target) => ... ({ href } | { open } | null)}`
  on `SessionConversation` or `MessageTimeline`, or `OpenGeniLinkProvider` for a
  subtree; it also covers `Markdown` inside a custom `renderMessageText`.
  Unresolved targets render as unavailable text, not broken links.
- `MessageTimeline` alone has no defaults; add
  `sessionLinkResolver({ client, workspaceId, sessionId })` for downloads.
- Non-React or custom renderers: classify each href with
  `parseOpenGeniLink(href)` from `@opengeni/sdk`, then use
  `createFileDownloadUrl` / `fsRead`, or the product's artifact page.
- Editable artifact export serves only the formats the export tool lists
  (today spreadsheet XLSX). Do not build a "Download PDF" flow on it; open the
  live artifact instead.

## Optional workbench peers

The React root keeps all existing exports and builds in Next.js/Vite without
optional workbench peers. Do not install compute packages for an ordinary chat.
When mounting compute surfaces, install only their peers and call
`enableSandboxTerminal()` from `@opengeni/react/terminal`, `enableDesktopViewer()`
from `@opengeni/react/desktop`, or `enableCodeEditor()` from
`@opengeni/react/editor` once in the corresponding client route. Libraries load
on mount, not at registration or SSR. Root component imports still work after
setup. Supply only installed grammars to `enableCodeEditor`, for example
`{ javascript: async () => (await import("@codemirror/lang-javascript")).javascript() }`.
For optional WebGL, pass `{ webgl: () => import("@xterm/addon-webgl") }` to
`enableSandboxTerminal`; otherwise the DOM renderer is used. Highlighted diffs
still use `enablePierreDiffs()` from `@opengeni/react/diffs`. Never hide optional
imports behind bare runtime strings or `@vite-ignore`; use bundler-resolvable
loaders. Test the packed root with optional peers absent, and the enabled
surface's mount path with its peers installed.

## Optional artifact library

Use `client.listArtifactCatalog(workspaceId, options)` for a workspace output
library; supply `sourceSessionId` for a session panel. It returns bounded native
artifact summaries and `nextCursor`, with `q`, `kind`, `status`, and `sort` filters.
Use `kind:id` as a UI key, preserve existing type-specific open/edit APIs, and
never reconstruct a library by scanning chat history or a sandbox filesystem.
The catalog is discovery, not new content access authority: preserve the current
viewer's file/artifact permissions and authorize the host's workspace mapping.

Render retained images with the existing artifact loader and lightbox rather
than compute file links. `@opengeni/react/artifacts` exports
`isRetainedImageContentType` and `useRetainedImageObjectUrl`; the host supplies
authenticated loading and presentation. Keep image bytes and signed download
URLs out of durable Markdown. Standard image references use `artifact:<id>`.
Use static tiles with a useful fallback for types without a preview; do not
execute every Site or invoke tools just to display a library grid. Inline HTML
and saved Sites keep the existing explicit Markdown host callbacks and isolated
frame; ordinary HTML file downloads do not become executable previews.

## Optional conversation search

Check the installed SDK/React exports before offering full-history Find. With
compatible versions, `client.searchSessionMessages(workspaceId, { query,
sessionId, limit, cursor }, { signal })` searches literal, case-insensitive text
in saved user and completed assistant messages. Omit `sessionId` and set
`groupBy: "session"` for one representative hit per session in workspace search;
do not combine those two options. Preserve authenticated host/workspace scope.
Tools, reasoning, model context, and assistant output with only unfinished
deltas are not searched. Do not silently fall back to title-only or loaded-DOM
search when this endpoint is unavailable.

Each request is bounded. An empty page with `hasMore: true` is still searching,
not “no matches”: follow `nextCursor`, cancel obsolete requests, and expose
provisional counts until `countIsExact`. Counts describe the live traversal,
not a snapshot; grouped counts represent sessions, not per-session message
totals. Retain a bounded hit batch and cursor history rather than downloading
every message into the browser.

Use a result's durable `sequence` and original-text UTF-16
`messageMatchOffset` to navigate. React's `useSessionEvents().jumpToSequence`
loads a bounded target window; pass `{ sequence, eventId, query,
offset: messageMatchOffset }` as `MessageTimeline.searchTarget` after a
successful jump. Preserve query and selection in host state, and clear the
target without scrolling when Find closes. A custom virtualized message
renderer must consume its search-target render context to reveal the selected
text. For contextual previews, read bounded events before/after the target,
render only `payload.text` for user/completed-assistant messages, and keep the
returned snippet for a large target. Never stringify forensic payloads: they
may include fields deliberately omitted from the visible conversation.

## Browser/backend split

The product browser talks to its own same-origin backend: `createSessionProxyHandler` for the conversation, or product-shaped routes for a custom UI. The backend authenticates, resolves the allowed mapping, and calls OpenGeni as that user. Never bundle an organization key into frontend code, and never replace the packaged proxy with a raw passthrough that forwards arbitrary paths under the organization key.

For live sessions, preserve event sequence, reconnect, replay, and duplicate suppression. The SDK's stream and proxy helpers are preferred where compatible. Treat unknown additive event types as forward-compatible data rather than crashing the UI.

Uploads may send bytes directly to a short-lived signed storage URL returned by the trusted flow. That URL is narrow transfer authority, not the OpenGeni API key. Verify storage CORS for every intended browser origin.

## Decide what the user sees

OpenGeni's durable event stream can support different product projections:

- final answer only;
- assistant messages plus progress and status;
- selected tool-call summaries;
- approvals and structured human-input cards; or
- a detailed operational timeline.

The customer frontend chooses which event types and fields to render. Hiding an event from the chat view does not remove it from OpenGeni's durable history or from authorized audit readers. Do not promise data erasure or secrecy from presentation filtering.

Each `session.requiresAction` event replaces the pending approval set. Read only `payload.approvals[].id`, `.name`, and `.arguments` (SDK type `SessionApprovalRequest`); other fields differ between a turn's first pause and later ones and exist for compatibility. Send `sendApprovalDecision({ approvalId: approval.id, decision })`: `id` is the pending tool call id, not the event id. `approvalsFromRequiresAction` / `projectPendingApprovals` from `@opengeni/react` already normalize older events.

Even a final-answer-only UI should surface states the user must act on: failure, cancellation, credit or policy denial, approval requests, human-input requests, reconnect status, and a way to retry safely. Avoid presenting tool failures as ordinary assistant prose when product state can represent them more clearly.

## Opening host-owned workbench tabs

Use `SandboxWorkspace.openTabRequest={{ tab, requestId }}` to open a built-in or
host-injected tab from the host's UI. Increment `requestId` for each intentional
open, including repeated clicks on the same item. Keep artifact selection and
internal-link recognition in the host; the workbench only selects an available
tab and expands the dock. Preserve modified clicks and external navigation.
When handing off to a full-page artifact route, retain an explicit originating
session return path rather than relying on browser history.

## Fit the host product

Follow existing navigation, accessibility, responsive, loading, error, observability, localization, and design-system conventions. Keep OpenGeni IDs behind product-native identifiers. Make the smallest dependency addition that improves correctness.

The integration should feel native to the customer product while retaining OpenGeni's session semantics. Framework adaptation is expected; protocol reimplementation is not a goal.

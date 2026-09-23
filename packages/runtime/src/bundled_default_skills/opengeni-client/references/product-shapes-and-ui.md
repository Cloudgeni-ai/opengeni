# Opening host-owned workbench tabs

Use `SandboxWorkspace.openTabRequest={{ tab, requestId }}` to open a built-in or
host-injected tab from the host's UI. Increment `requestId` for each intentional
open, including repeated clicks on the same item. Keep artifact selection and
internal-link recognition in the host; the workbench only selects an available
tab and expands the dock. Preserve modified clicks and external navigation.
When handing off to a full-page artifact route, retain an explicit originating
session return path rather than relying on browser history.

# Product shapes and UI

## Choose the smallest suitable surface

OpenGeni supports several product shapes. Select from the product experience and host stack rather than assuming every integration needs a custom chat:

| Need | Likely surface | Product owns |
| --- | --- | --- |
| The complete OpenGeni experience is acceptable | Link or deep-link to stock OpenGeni | Entry point and product navigation |
| Custom UI in any framework, mobile app, CLI, or automation | OpenGeni SDK or public API behind product backend | All user-facing presentation |
| React product wants canonical session state without packaged visuals | Headless React session hooks and projections | Components, layout, and styling |
| React product wants packaged chat/session controls | Focused styled React subpaths | Shell, domain UI, and theming |
| Product exposes files, changes, terminal, or desktop compute | Optional workbench surfaces | Product shell and selected tabs |

Start with the narrowest surface that preserves the desired experience. Do not mount the full workbench for an ordinary analytics chat. Do not rebuild session streaming, replay, queueing, approval, or timeline projection when a compatible package already supplies the needed behavior.

## Evaluate reuse before writing chat UI

For React hosts, inspect the installed OpenGeni React package before creating replacement components. Its subpaths are composable, and the styled surfaces use scoped compiled CSS plus runtime theme and density tokens. Compare:

- packaged components with customer theme tokens;
- headless hooks with customer-native components; and
- a fully custom SDK-driven UI.

Choose based on UX requirements and dependency compatibility, then record why. Styling differences alone are not a reason to skip reusable components if their structure fits. Conversely, do not force a packaged component when the product needs a materially different interaction model.

For Svelte, SvelteKit, Vue, native mobile, or another non-React frontend, use the product's native component system. Keep the privileged OpenGeni client on a compatible backend boundary. A SvelteKit server route may use the TypeScript SDK directly; a non-JavaScript backend may use the public HTTP contract or a small compatible adapter. The browser still speaks to authenticated product routes.

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

The product browser normally sends product-shaped requests to its own same-origin backend. The backend authenticates, resolves the allowed mapping, and calls OpenGeni. Never bundle an organization key into frontend code.

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

Even a final-answer-only UI should surface states the user must act on: failure, cancellation, credit or policy denial, approval requests, human-input requests, reconnect status, and a way to retry safely. Avoid presenting tool failures as ordinary assistant prose when product state can represent them more clearly.

## Fit the host product

Follow existing navigation, accessibility, responsive, loading, error, observability, localization, and design-system conventions. Keep OpenGeni IDs behind product-native identifiers. Make the smallest dependency addition that improves correctness.

The integration should feel native to the customer product while retaining OpenGeni's session semantics. Framework adaptation is expected; protocol reimplementation is not a goal.

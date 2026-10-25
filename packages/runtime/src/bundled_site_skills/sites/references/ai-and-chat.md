# AI, conversations and Opengeni UI in a Site

## Prefer Opengeni's UI and typed client

- Prefer `@opengeni/react` components and compiled CSS for Opengeni-native
  session, timeline, composer, queue, approval, and human-input experiences.
- Use custom React only where the Site has a genuinely different product need.
- Inside the published opaque-origin iframe, create the workspace-bound client
  with `@opengeni/sdk/site`. The parent host owns credentials and workspace
  identity; Site code receives neither.

Published Sites have no browser localStorage/sessionStorage. Do not rely on
them for startup or session selection; use React state, Site Data for anything
that must persist, and the SDK's durable session/draft APIs. A sandbox-local
page having storage does not prove the published iframe does.

```ts
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";

const client = createOpenGeniSiteClient();
const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

### Inline AI: the app chooses the interaction

Use `site.ai.run({ initialMessage: appDefinedPrompt, idempotencyKey: actionId })`
to return AI output inside the app without mounting chat or displaying history.
Prompts, context, controls and results are app-designed; Draft, Summarize or
Classify are merely possible examples, never required buttons or templates.
Use `onText` for incremental text and `onSession` to retain a native handle before
waiting. A result has `text`, `sessionId`, `turnId`, `after` and `status`:
`completed`, `pending` (approval/input needed), or `cancelled`; failures reject.
Validate any app-defined structured output before using it.

This is ordinary native execution with the same model access, subscriptions,
permissions, tool selection, approvals, metering and outsider caps. Aborting the
observation does not cancel the task. `site.ai.result(id, { turnId })` replays
without creating more work. Supplying `after` returns subsequent text only;
retain earlier text or omit it for a full replay. Keep retry keys stable per
action and handles in viewer-private state/storage, not shared Site Data.

Site AI is private per viewer by default and does not clutter the workspace
sidebar or ordinary search. Signed-in members use their real human identity;
guests use existing cookie/visitor continuity, not a shared anonymous chat.
If organization policy disallows private execution, surface its explicit
refusal; never fall back to shared sessions. Privacy does not automatically
extend to separately published artifacts or shared Site Data.

### Optional conversation UI

For embedded conversations, `site.client` is the ordinary Opengeni SDK client;
`site.workspaceId` is a host-resolved routing alias. Use the normal React
complete conversation surface—do not implement session REST or SSE yourself:

```tsx
import { SessionConversation } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

const site = createOpenGeniSiteClient();
// Match the theme to your chat panel; omit this wrapper for the dark default.
<div data-og-theme="light" style={{ height: "100%", minHeight: 0 }}>
<SessionConversation
  client={site.client}
  workspaceId={site.workspaceId}
  sessionId={sessionId}
/>
</div>
```

`sessionId` is the existing session or the id returned by `site.client.createSession`.
For a normal chat app, a conversation selector and “New conversation” are optional.
Create on first Send rather than mounting the page; keep the selected id in React
state and reopen existing conversations through the SDK.
Keep first-send creation single-flight; reuse its `idempotencyKey` when retrying,
then mount `SessionConversation` with the returned id. Do not send that first
message a second time after creation. A useful default list is
`site.client.listSessionPage(site.workspaceId, { originSiteId: "current" })`;
render returned `pinned` and `sessions` (deduplicated by id) and use `nextCursor`
for older results. Published calls automatically record their Site origin—do not
write origin metadata yourself. The local preview has no published identity, so
this filter returns no Site history there; test newly created/current conversations
locally and the selector after publication.

Do not automatically create a project just to group Site chats. Site execution
does not appear in ordinary workspace discovery, even for its owner. The host
Site page provides a viewer-scoped Conversations panel independently of app
navigation. Opening existing sessions never changes their origin or audience.
Page code cannot widen the Site boundary by supplying project, visibility,
tools or credential fields; use ordinary authoring tools for project management.

Per-Site AI costs are in Insights: actual credit charges are distinct from
API-equivalent subscription/own-key estimates and unbilled platform counters.
Usage is for limits. Do not build private transcript or viewer analytics into
shared dashboards just because aggregate costs are visible there.

`SessionConversation` connects timeline/history, durable composer drafts,
queue display/edit/delete/steer, pause/resume, and human-input forms. Prefer it
for a normal embedded chat. `ChatComposer` alone is only the input surface;
pairing it with a timeline does not create the queue UI.
Use the lower-level hooks/components only for intentionally custom behavior.

The host owns the chat's available space; `SessionConversation` fills it.
The SDK defaults to dark colors. On a light panel, set `data-og-theme="light"`
on its wrapper; changing the Site's body background does not select the SDK
theme, and the outer app's theme does not cross the iframe. Keep
foreground and background on the same SDK tokens rather than overriding
message/button colors individually. Check a real assistant reply, expanded
steps, composer and menus for readable contrast in the chosen theme.
For a full-height page, use a `height: 100dvh` flex-column layout with the
chat panel `flex: 1; min-height: 0` below its header. Keep intervening
flex/grid children shrinkable (`min-height: 0; min-width: 0`). The SDK owns
timeline scrolling and the bottom composer—do not add fixed/sticky positioning
or another timeline scroller. Expand steps, stream messages, and resize the
preview: history should scroll without pushing the composer down the page.

Use the narrow `@opengeni/react/session-ui` entry for chat, not the broad root
entry that pulls unrelated editor/terminal peers. Import compiled CSS once.
Session creation, history, live events,
composer drafts, Send/Steer and queue/control use this client. The same local
Bun handler above forwards them using the agent's current Codemode token;
published Sites use the viewing user's host auth. Agent authority remains
agent authority: testing cannot approve on a human's behalf. Where preview access
permits, test a real Send
and streamed reply, not just a successful page load. Also pause, queue two
messages, edit/delete a queued message, and resume; verify pending messages
remain visible and are not duplicated in the timeline.

The optional `@pierre/diffs` peer brings a large syntax-language bundle. For
a small self-contained Site that does not need highlighted diffs, exclude
`@pierre/diffs` and `@pierre/diffs/react` with Bun's `--external` build flags;
the React renderer already provides a plain-diff fallback. Do not externalize
the Opengeni SDK, React, or other required runtime imports.

The generated tool declarations make exact tool paths typed during authoring.
The runtime proxy resolves those paths to opaque `{serverId, toolName}`
identities. Friendly names are never authority.


# Shared connection presentation

The console and embedding hosts consume the same React connection surfaces.
The SDK owns presentation and native connection orchestration; the server owns
authorization. See [product integration](product-integration.md) and
[MCP connection cutover](remote-mcp-credentials.md).

## Discovery and management

`ConnectPanel` composes native account inventory, acquisition and setup recovery.
Account management precedes discovery. Terminal attempts leave setup rather than
showing reconnect actions after success. Its optional SDK client resolves names
and authenticated marks by exact catalogue connection ID. Connected accounts are
directly expandable rows without a separate Manage step; disconnect retains
versioned confirmation.

`ConnectionDiscovery` lists native OAuth MCP services and exact active-account
status. Other provider adapters use the native Connect chooser. Unavailable
providers and providers without supported ownership are excluded from chooser
inventory, search and select options. Deployment diagnostics are not a customer
discovery surface. Generic MCP/API acquisition lives in a secondary custom picker.

Hosts may disable custom acquisition with `showCustomConnections` and include
ready native provider adapters with `showProviderConnections`. These are only
presentation switches: the backend must admit its chosen acquisition surface and
supply the matching filtered catalogue. The SDK contains no product-specific
service list. Hosts may compose other capability categories without adopting the
console's entire capabilities page.

## OAuth details and conversation use

`McpConnectionCard` without a session ID configures only a connection: it never
reads a session or selects tools.
`SessionMcpCapabilityCard` supplies a session target to that same implementation.
Console OAuth setup and embedded service discovery share it; existing console
management and non-OAuth adapters remain distinct surfaces. Initial detail reads
use an effect-lifetime fence independent of the action lock, so development
remounts cannot suppress replacement initialization.

`SessionCapabilityFrame` owns the in-chat recommendation shell and protected
dialog focus. Recommendations resolve against the live catalogue, use the native
Connect controller and exact host return URL, and require backend-verified
completion. An isolated provider window is reserved before discovery; successful
authorization attaches the capability while preserving existing selections.
An agent-proposed remote MCP endpoint uses this frame for a human-editable URL
review form; submitting it adds a catalog entry only after the authenticated
human's ordinary Capabilities permission check. The existing catalog card then
owns credentials, enablement and conversation tool attachment.
Personal accounts belong to the authenticated sender; sharing a conversation
does not delegate account access. No separate conversation consent is required.
Completion derives from live credentials and tool selection, never a browser
success flag.

Tool selection lives in `packages/react/src/session-capability-policy.ts`.
`sessionAuthRecommendation` matches recovery notices by exact native server or
connection identity; `SessionConnectionRequest` exposes it to embeds. Missing or
ambiguous matches never choose another account by provider domain.

Account choices narrow the authenticated sender's own accounts; they never grant
access. Multiple matching accounts require an explicit choice. Background work
inherits captured initiating-user authority. Authenticated catalogue marks use
`client.downloadCatalogAsset`; passive downloads are bounded and reject arbitrary
URLs.

## Shared conversation controls

`conversationTimeline` owns queue and optimistic-message reconciliation.
`SessionChrome` presents queue and goal signals with grouped activity.
`ChatComposer.footer` replaces normal controls inside the native controller;
annotations, draft recovery, attachments, keyboard delivery and confirmation stay
shared. Host translations are message overrides, not a separate locale subsystem.

`SessionCommands` supplies the shared background-command controller and panel.
Mount it only in the open activity drawer. It accepts the hook's explicit
client/workspace override and does not fetch history. Keep command and connection
setup implementations outside the initial session bundle.
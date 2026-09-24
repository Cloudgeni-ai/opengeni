# Reveal — truth ledger

Every product claim in the film, and where it was verified. Source revision:
`Cloudgeni-ai/opengeni` main at `3fef45618` (2026-09-24).

## What is real, what is dramatized

- **Dramatized:** the salon booking app, Lena, her clients, every screen and
  every agent action shown in the product. No live run was recorded; the film
  labels these screens "Fictional app. Simulated screens."
- **Real:** the code on the code page, the brand wordmark, colours and fonts,
  and the mechanics the dramatization depicts.

## Code page (exact current SDK surface)

| Claim in code | Verified in |
| --- | --- |
| `import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat"` | `packages/sdk/package.json` export `./chat`; `packages/sdk/src/chat/index.ts` |
| `new OpenGeni({ apiKey, organizationId })` | `packages/sdk/src/chat/types.ts` `OpenGeniOptions` |
| `createChatHandler(og, { resolve })`, `resolve` returns tenant/user or a `Response` | `packages/sdk/src/chat/handler.ts`, `http.ts` `ChatResolve` / `ChatResolution` |
| `tenant` → one organization workspace per customer, created on first use | `opengeni.ts` `workspaceId()` → `ensureWorkspace` |
| `user` → server-side `asUser()` authority | `opengeni.ts` `chat()`; README: user mode needs explicit workspace membership (onboarding) |
| `tools: [{ kind: "mcp", id }]` plus `create: { mcpServers: [...] }` | `types.ts` `ChatOptions.tools` / `create`; `packages/core/src/domain/sessions.ts` — session MCP servers are only model-visible when selected through `tools` |
| MCP server `{ id, url, headers, requireApproval: [toolName] }` | `docs/session-mcp-servers.md` contract |
| One handler serves `GET` (restore history + unresolved approvals) and `POST` (send / respond) | `packages/sdk/README.md` chat quick start; `handler.ts` |

## Dramatized mechanics (true of this integration)

| Depicted | Why it is true |
| --- | --- |
| The agent moves appointments in the app's own calendar | The agent calls the product's tools over MCP; product data changes, so the product's own UI shows it (same pattern as `examples/northstar-support`) |
| She closes the app and the work continues | `stream()` submits the turn first; aborting the request only aborts the event watcher (`opengeni.ts` `streamTurn`). The turn runs server-side |
| On reopen the approval is waiting | `snapshot()` restores messages and unresolved approvals; exposed via the handler's `GET` |
| Sending waits for her OK | `requireApproval: ["send_messages"]` pauses that tool until a human approves; the chat protocol returns `pending` and `respond` continues |
| Only her studio's data is touched | `tenant` maps to that customer's workspace; the product's tool endpoint must still enforce its own tenant/user checks (docs/product-integration.md) |

## What a real integration also needs (not shown, disclosed here)

- The product's actions exposed as tools (an MCP endpoint, or an OpenAPI/GraphQL
  API Integration), enforcing the product's own auth.
- Product UI that posts to the handler and renders replies and the approval.
- Onboarding each product user as a workspace member for `user` mode.
- A model connected to the OpenGeni organization.

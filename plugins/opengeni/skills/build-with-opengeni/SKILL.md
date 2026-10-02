---
name: build-with-opengeni
description: >-
  Integrate OpenGeni agents into the user's own product, backend, website, CLI,
  or automation with the @opengeni/sdk and @opengeni/react packages: server-side
  API keys, per-user isolation with asUser, the packaged session proxy, the
  embedded chat UI, and a minimal hello-world. Also spins up a small local demo
  web app with an OpenGeni agent chat whose chats appear as sessions in an
  OpenGeni workspace. Use when the user wants to add AI agents, an assistant, or
  OpenGeni to an app they are building, or asks for a local OpenGeni chat app or
  demo. Not for offloading the current coding task (use offload-to-opengeni) or
  for changing OpenGeni itself.
---

# Build with OpenGeni

The user's product keeps its own users and UI. A separate OpenGeni deployment
(OpenGeni Cloud at `https://app.opengeni.ai`, or self-hosted) runs agent
sessions, tools, and sandboxes. The browser talks only to the product's
backend; the backend talks to OpenGeni with an organization API key that never
leaves the server.

This is a condensed entry point. The complete, canonical guide ships beside it
in [`opengeni-client/SKILL.md`](opengeni-client/SKILL.md) with its
[`references/`](opengeni-client/references/). Read it before going beyond the
hello world below. Without these files, fetch
https://docs.opengeni.ai/llms.txt and the canonical guide at
https://github.com/Cloudgeni-ai/opengeni/tree/main/.agents/skills/opengeni-client.

## Quick local demo app

If the user asks for a small, local, or demo web app with an OpenGeni agent
chat (rather than adding OpenGeni to an existing product), follow
[`local-demo-app.md`](local-demo-app.md) exactly. It is a tested recipe: a Vite +
React page with `OpenGeniChat` and one Node server holding the API key, where
every chat becomes a session in the given workspace. It needs
`OPENGENI_API_KEY`, `OPENGENI_BASE_URL`, `OPENGENI_ORGANIZATION_ID`, and
`OPENGENI_WORKSPACE_ID`, and skips the questions below.

## Work adaptively

- Inspect the product first: framework, auth, tenancy model, data routes,
  package manager, tests, and deployment. Never ask what the repository
  answers.
- Four choices belong to the user. If the request or repository does not
  settle them, ask once, in one bundled question with a recommended answer for
  each: who shares agents and chats (per user or shared per tenant), when work
  runs (on demand, schedules, events), where outputs land, and whether the
  agent may write or act.
- Trust the installed package types, `GET /v1/config/client`, and
  `GET /v1/access/me` over memory. Pin `@opengeni/sdk` and `@opengeni/react` to
  the same release.
- Do not deploy, publish, or change production without the user's permission.

## Credentials

- **Organization API key** (full access) for a product backend that serves many
  tenants. Store it in the product's secret manager as `OPENGENI_API_KEY`, with
  `OPENGENI_BASE_URL` (the deployment origin; the longer guide calls it
  `OPENGENI_API_BASE_URL`) and `OPENGENI_ORGANIZATION_ID`. The user creates it
  in OpenGeni organization settings; never ask them to paste it into chat or
  commit it.
- **Workspace API key** for an integration deliberately limited to one
  workspace.
- Never ship an API key to a browser bundle or mobile app.

## Hello world: prove the connection

Run once on the server (or as a script) before building UI. It creates a
throwaway tenant workspace and returns one reply.

```ts
import { OpenGeni } from "@opengeni/sdk/chat";

const og = new OpenGeni({
  baseUrl: process.env.OPENGENI_BASE_URL!, // always set it explicitly
  apiKey: process.env.OPENGENI_API_KEY!, // organization API key, server only
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
  source: "hello-opengeni",
});

const chat = await og.chat({
  tenant: "hello-tenant",
  conversation: "hello-1",
  create: { sandboxBackend: "none" }, // pure chat: no sandbox, starts in seconds
});
console.log(String(await chat.send("Reply with one short sentence.")));
```

A reply proves the key, organization, deployment URL, and model access. The
chat facade is a text-only fallback; do not build the product on it unless the
product already has an OpenAI- or Vercel-shaped chat UI.

## Default product shape: full conversation behind a proxy

1. **Onboard once per tenant and user** (server): map each tenant to an
   organization workspace with `og.ensureWorkspace(...)`, persist the returned
   `workspace.id`, and add each admitted user with
   `og.addExternalWorkspaceMember(workspaceId, { identity: { externalId, source }, permissions, operationId })`.
2. **Mount the session proxy** (server): `createSessionProxyRoute` from
   `@opengeni/sdk/next` (or `createSessionProxyHandler` with the Express/Hono
   adapters). Its `resolve` callback authenticates the request with the
   product's own session and returns `{ workspaceId, user, source }`; every call
   then runs as that user through `asUser`. Use `createSession` to choose
   Skills, tools, MCP servers, and `sandboxBackend` server-side, and
   `authorizeMutation` for CSRF.
3. **Render the chat** (browser): `new OpenGeniClient({ baseUrl: "/api/opengeni" })`
   inside `<OpenGeniProvider client workspaceId>` with `<OpenGeniChat />`, and
   import `@opengeni/react/compiled.css`. Brand with `--og-*` CSS tokens.
4. **Give the agent the product's tools**: expose product data and actions
   through an authenticated MCP server (per-session `mcpServers` plus a matching
   `tools: [{ kind: "mcp", id }]` entry) or a reviewed OpenAPI integration.
   Pass explicit `tools` and `firstPartyMcpTools`; omitting them inherits broad
   workspace defaults.

The full proxy and React example, options table, and per-record assistant
pattern are in [`opengeni-client/SKILL.md`](opengeni-client/SKILL.md).

## Guardrails

- Never replace the proxy with a raw passthrough of arbitrary paths under the
  organization key, and never take tenant, workspace, or user identity from the
  request body.
- Product Skills are product data passed inline per session; never attach this
  implementation guide to the product's runtime agent.
- `pauseSession` is Stop (resumable); `cancelSession` is terminal. Do not wire
  Cancel to a Stop button.
- Verify with representative product questions that exercise real tool calls,
  not just a successful connection. Report local commit, passing tests, verified
  integration, and deployment as separate outcomes.

## Where to read next

- Small local demo app with a chat: `local-demo-app.md`
- Product shapes, headless hooks, workbench: `opengeni-client/references/product-shapes-and-ui.md`
- REST/SDK workflows: `opengeni-client/references/api-workflows.md`
- Isolation, visibility, `agentAccess`: `opengeni-client/references/isolation-and-authorization.md`
- Tools, MCP, credentials: `opengeni-client/references/data-tools-and-credentials.md`
- External users and embedded connection setup: `opengeni-client/references/external-users-and-connect.md`
- Verification: `opengeni-client/references/runtime-profile-and-verification.md`
- Troubleshooting and cost: `opengeni-client/references/compatibility-and-troubleshooting.md`

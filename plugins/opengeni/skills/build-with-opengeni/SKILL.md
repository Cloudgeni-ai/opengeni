---
name: build-with-opengeni
description: >-
  Add Opengeni agents to the user's own product, backend, website, or app with
  @opengeni/sdk and @opengeni/react: the packaged chat UI behind one server
  route, per-tenant workspaces, and the product's own tools. Also builds a
  small local demo web app with an Opengeni chat. Use when the user wants AI
  agents or an assistant in an app they are building, or asks for a local
  Opengeni chat demo. Not for offloading the current coding task (use
  offload-to-opengeni) or for changing Opengeni itself.
---

# Build with Opengeni

The user's product keeps its own users and UI. Opengeni (Opengeni Cloud at
`https://app.opengeni.ai`, or self-hosted) runs the agent sessions and tools.
The browser talks only to the product's server, which holds the organization
API key.

Follow the complete guide beside this file:
[`opengeni-client/SKILL.md`](opengeni-client/SKILL.md). Without it, read
https://docs.opengeni.ai/llms.txt and
https://github.com/Cloudgeni-ai/opengeni/tree/main/.agents/skills/opengeni-client.

## Opengeni MCP tools

When the `opengeni` MCP tools are available (this plugin connects them), use
them to inspect and act on the user's Opengeni organization while you build:
find an action with `opengeni_actions_search`, read it with
`opengeni_action_describe`, and run it with `opengeni_action_call`. The first
use opens a browser sign-in where the user chooses what the agent may access.
The product's own code still uses its server-side API key.

## Quick local demo app

If the user asks for a small, local, or demo web app with an Opengeni chat
(rather than adding Opengeni to an existing product), follow
[`local-demo-app.md`](local-demo-app.md) exactly. It is a tested recipe: a Vite
and React page with `OpenGeniChat` and one Node server holding the API key.

## Credentials

- The user creates an organization API key in Opengeni under Organization
  settings > Developer and stores it in the product's server-only env as
  `OPENGENI_API_KEY`. Never ask them to paste it into chat, and never commit,
  log, or ship it to a browser or mobile app.
- Self-hosted deployments also set `OPENGENI_API_BASE_URL`.
- Do not deploy, publish, or change production without the user's permission.

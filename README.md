<p align="center">
  <a href="https://opengeni.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs-site/logo/dark.svg">
      <img src="docs-site/logo/light.svg" alt="Opengeni" width="320">
    </picture>
  </a>
</p>

<h3 align="center">Agents in your product. Infrastructure out of the box.</h3>

<p align="center">
  Durable streaming sessions · sandboxes · tools and MCP · per-user credentials · memory · multi-tenant workspaces · React components you restyle · managed cloud or self-host
</p>

<p align="center">
  <a href="https://app.opengeni.ai"><strong>Start free at app.opengeni.ai →</strong></a>
</p>

<p align="center">
  <a href="https://docs.opengeni.ai/embed-manually">Add it to your product</a> ·
  <a href="https://docs.opengeni.ai/why-opengeni">Why Opengeni</a> ·
  <a href="https://docs.opengeni.ai">Docs</a> ·
  <a href="https://docs.opengeni.ai/guides/self-host">Self-host</a> ·
  <a href="https://github.com/Cloudgeni-ai/opengeni/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/Cloudgeni-ai/opengeni/actions/workflows/ci.yml"><img src="https://github.com/Cloudgeni-ai/opengeni/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@opengeni/sdk"><img src="https://img.shields.io/npm/v/@opengeni/sdk?label=%40opengeni%2Fsdk" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

---

**Opengeni is open-source infrastructure for adding AI agents to your product.** Your product keeps its users, data, and UI. Opengeni runs the agent behind them: streaming sessions that survive reloads and restarts, a sandbox to run code in, your APIs and MCP servers called as the signed-in user, memory across conversations, and a separate workspace for every customer. Drop the React conversation into your app and restyle it with CSS variables, or drive everything from the TypeScript SDK and HTTP API. Use the managed cloud at [app.opengeni.ai](https://app.opengeni.ai) or self-host the same Apache-2.0 code.

**Who it's for:** teams shipping an agent inside a SaaS or internal product, such as a support agent, an analyst, or an operations or coding agent, who would rather configure that agent than build and run the platform underneath it. The same platform is also a ready-to-use agent workspace for your own team in the browser. It grew out of two years of running agents against production cloud infrastructure at [Cloudgeni](https://cloudgeni.ai).

## How it fits into your product

1. **Your server** mounts one route with `createSessionProxyHandler` from `@opengeni/sdk`. It runs your existing auth, maps each customer to an Opengeni workspace, and keeps your API key on the server.
2. **Your frontend** renders `OpenGeniChat` from `@opengeni/react`: the user's chats and a conversation with streaming replies, tool activity, attachments, and questions, styled with your colors, fonts, and corner radii.
3. **Opengeni** runs every session: the model loop, calls to your MCP server or OpenAPI-described API with a short-lived token for that user, code in a sandbox, files, and memory. Every event is stored in Postgres, so any client can reconnect mid-stream and continue where it left off.

The fastest way to wire it up is to give your coding agent (Claude Code, Codex, or Cursor) the [`opengeni-client` skill](https://docs.opengeni.ai/embed-with-a-coding-agent) and one prompt. To do it by hand, follow [Embed manually](https://docs.opengeni.ai/embed-manually), or see the code [below](#use-it-from-your-code-and-product).

**Opengeni and agent frameworks.** LangGraph, Mastra, CrewAI, the OpenAI Agents SDK, and the Vercel AI SDK help you write an agent loop in your own code. Opengeni ships the loop and runs it as a service, together with what a product agent needs in production: sessions, streaming, sandboxes, tools, credentials, memory, tenancy, and UI. If you want to hand-code the agent's control flow, a framework is the right tool. If you want an agent feature in your product without building that platform, use Opengeni. See [Why Opengeni](https://docs.opengeni.ai/why-opengeni) and the [framework comparison](https://docs.opengeni.ai/compare-agent-frameworks).

## Get started

**The fastest way is the managed cloud.** Sign up at [app.opengeni.ai](https://app.opengeni.ai), name your organization, connect a model (a ChatGPT/Codex or SuperGrok subscription, a provider key, or prepaid credits), and start your first session. Nothing to deploy. The [quickstart](https://docs.opengeni.ai/quickstart) walks through it. Usage billed through Opengeni costs the model price plus 5%, with no seat or platform fees; a subscription or key you connect is billed by its provider.

Prefer to run it yourself? Everything is open source under Apache-2.0. Jump to [Run it locally](#run-it-locally) for a one-command dev stack, or to [Self-host](https://docs.opengeni.ai/guides/self-host) for production with the Helm chart and reference Terraform for AWS, Azure, and GCP.

## Features

- **Embed in your product.** `OpenGeniChat` and `SessionConversation` from `@opengeni/react` render the complete conversation, and every visual decision is a `--og-*` CSS variable, so it matches your brand. Your server mounts a packaged, tenant- and user-scoped proxy, and your organization API key stays there. Already have a Vercel AI SDK `useChat` UI? A text-only chat facade can serve it.
- **Durable streaming sessions.** Replies stream over SSE with automatic reconnect and resume. Every event lands in Postgres, so a reload, a new client, or a worker restart continues the same session instead of losing it.
- **Sandboxes and your own machines.** A session runs code in a managed sandbox (Docker, Modal, or a cloud sandbox provider), on a **Connected Machine** you enroll (a laptop, build server, or GPU box that only dials out), or with no compute at all.
- **Tools and MCP.** Give the agent your product's actions through an MCP server or an OpenAPI description, plus built-in connections. You choose exactly which tools each session gets.
- **Credentials, handled.** Per-user OAuth connections, short-lived tokens you mint per session, and encrypted secrets that stay out of prompts.
- **Memory.** Agent Knowledge keeps files, sources, and findings in one searchable library with personal and workspace scope, so agents remember what matters across sessions.
- **Multi-tenant workspaces.** Map each customer to a workspace with `ensureWorkspace`. Sessions, files, knowledge, and connections stay inside it, enforced by the API and Postgres row-level security.
- **Swap models freely.** OpenAI, Azure OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, any OpenAI-compatible endpoint, or a ChatGPT/Codex or SuperGrok subscription.
- **Background agents and goals.** Start agents on a schedule or from webhooks, and give a session a goal with success criteria so it keeps working until the job is done.
- **Approvals and questions when you need them.** Require approval for sensitive tools, and let the agent ask the user structured questions mid-task.
- **Managed or self-hosted.** Use [app.opengeni.ai](https://app.opengeni.ai) with nothing to run, or deploy the same API, web app, workers, Helm chart, and reference Terraform yourself. All of it is Apache-2.0.

## Run it locally

For development, or to evaluate Opengeni before self-hosting. You need [Bun at the exact version in `.bun-version`](.bun-version), Git, curl, Docker, [rustup](https://rustup.rs), a C compiler (Xcode Command Line Tools on macOS or `build-essential` on Debian/Ubuntu), and an OpenAI or Azure OpenAI key.

```bash
git clone https://github.com/Cloudgeni-ai/opengeni.git
cd opengeni
cp .env.example .env   # add your model credentials
bun run dev
```

Open http://127.0.0.1:3000, describe a task, and watch the session run.

`bun run dev` installs dependencies, starts Postgres, NATS, Temporal, and object storage, runs migrations, and starts the API, workers, and web app. By default the agent runs commands directly on your machine (the `local` sandbox), not in an isolated container, so the API and web app listen only on 127.0.0.1. Set `OPENGENI_SANDBOX_BACKEND=docker` to run the agent in the local sandbox image instead. See [Local development](docs/local-development.md) for manual startup, configuration, network exposure, and the native (no Docker) path.

## Use it from your code and product

The default integration embeds the full OpenGeni conversation in your product: `SessionConversation` in the browser, backed by the session SDK through `createSessionProxyHandler` on your server. Verify your installed SDK and target deployment support it, set the API URL explicitly, and follow the [product integration guide](https://docs.opengeni.ai/embed-manually) for authentication and explicit user onboarding.

```ts
// Server, mounted at /api/opengeni/*. The organization API key stays here.
import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";

const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

export const handleOpenGeni = createSessionProxyHandler(og, {
  resolve: async (request) => {
    const me = await authenticate(request); // your product's own auth
    if (!me) return new Response("Unauthorized", { status: 401 });
    return { workspaceId: me.openGeniWorkspaceId, user: me.userId, source: "acme" };
  },
});
```

```tsx
// Browser
import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniProvider, SessionConversation } from "@opengeni/react";
import "@opengeni/react/compiled.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });
<OpenGeniProvider client={client} workspaceId={workspaceId}>
  <SessionConversation sessionId={sessionId} />
</OpenGeniProvider>;
```

Your server maps tenants with `ensureWorkspace`, onboards users with `addExternalWorkspaceMember`, and creates sessions with explicit tools. If your product already has a Vercel `useChat` or OpenAI-shaped chat UI, `createChatHandler` from `@opengeni/sdk/chat` is a text-only fallback backend for it.

Start with the [product integration guide](docs/product-integration.md), then the [TypeScript SDK](packages/sdk/README.md) and [React components](packages/react/README.md). The [chat quickstart](examples/chat-quickstart) is a runnable server example of the chat fallback, and [Northstar support](examples/northstar-support) is a runnable SaaS embed of the default path with a product MCP server.

## How it works

"Agent" is one word for at least ten different jobs. A model is a function from tokens to tokens: it forgets everything between calls, has no idea what it is allowed to do, and has no obligation to keep working until the job is done. Everything above it exists to turn that into work that finishes, can be trusted with real systems, and can be explained afterwards.

Opengeni is built as those layers.

```text
  ┌───────────────┐   ┌───────────────────────────────────────────────────────┐
  │               │   │  10 SURFACES        console · embedded UI · Slack ·   │
  │ 8  GOVERNANCE │   │                     voice · SDK · API                 │
  │               │   ├───────────────────────────────────────────────────────┤
  │ identity      │   │   9 KNOWLEDGE       scoped retrieval · reviewed       │
  │ tenancy       │   │                     learning · never mixed with chat  │
  │ permissions   │   ├───────────────────────────────────────────────────────┤
  │ secrets       │   │   7 DURABLE STATE   sessions · turns · goals ·        │
  │ approvals     │   │     & ORCHESTRATION recovery · human-in-the-loop      │
  │ audit         │   ├───────────────────────────────────────────────────────┤
  │               │   │   6 COMPUTE         sandboxes · browsers ·            │
  │ +             │   │                     your own machines                 │
  │               │   ├───────────────────────────────────────────────────────┤
  │ OBSERVABILITY │   │   5 TOOLS           one gateway · MCP · connections · │
  │ & COST        │   │                     credentials outside the prompt    │
  │               │   ├───────────────────────────────────────────────────────┤
  │ every call    │   │   4 AGENT LOOP      cache-stable prompt · gradual     │
  │ records what  │   │                     tool disclosure · exact history   │
  │ it cost and   │   ├───────────────────────────────────────────────────────┤
  │ who pays      │   │   3 MODEL ROUTING   allowed models · fallback ·       │
  │               │   │                     capacity waits · billing          │
  │               │   ├───────────────────────────────────────────────────────┤
  │               │   │ 1-2 INFERENCE       any provider · any wire format ·  │
  │               │   │                     swappable mid-conversation        │
  └───────────────┘   └───────────────────────────────────────────────────────┘
```

**Rent the edges, own the middle.** Models, provider APIs, and the raw compute box change too fast to own, so every one of them is a swappable boundary. Durable state, governance, and knowledge are where your workflows, permissions, audit record, and institutional memory actually live, so they sit in a Postgres database you operate, export, and can leave with.

## Documentation

| I want to...                          | Read                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Start on the managed service          | [Quickstart](https://docs.opengeni.ai/quickstart)                                                           |
| Run it locally                        | [Local development](docs/local-development.md)                                                              |
| Deploy to production                  | [Self-host](https://docs.opengeni.ai/guides/self-host) · [Deployment guide](docs/deployment.md)             |
| Add agents to my product              | [Product integration](docs/product-integration.md) · [SDK reference](https://docs.opengeni.ai/reference/sdk) |
| Run sessions on my own hardware       | [Connect a machine](https://docs.opengeni.ai/guides/connect-a-machine) · [Connected Machines](docs/connected-machines.md) |
| Call the HTTP API directly            | [HTTP API overview](docs/http-api.md)                                                                       |
| Configure models and providers        | [Model providers](docs/model-providers.md)                                                                  |
| Give agents repository access         | [GitHub App](docs/github-app.md)                                                                            |
| Understand goals, approvals, memory   | [Goals](docs/goals.md) · [Human input](docs/human-input.md) · [Knowledge](docs/knowledge.md)                |
| Understand the internals              | [Architecture](docs/architecture.md) · [Run lifecycle](docs/run-lifecycle.md) · [Docs map](docs/README.md)  |
| See what is planned                   | [Roadmap](docs/roadmap.md)                                                                                  |

The public product docs live at [docs.opengeni.ai](https://docs.opengeni.ai), and the thinking behind the layers above is on the [Opengeni blog](https://opengeni.substack.com/). The [Cloudgeni Infrastructure Agents Guide](https://github.com/Cloudgeni-ai/infrastructure-agents-guide) covers patterns for infrastructure-focused agents.

## Built with

Bun · Hono · React and Vite · Temporal · Postgres with pgvector · NATS · OpenAI Agents SDK · a Rust agent and relay for Connected Machines

## Security

Do not expose a production deployment without a deliberate access mode, tested database role posture, rate limits, and a reviewed sandbox credential policy. See the [security boundary](docs/deployment.md#security-boundary) and report vulnerabilities through [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull request workflow, and [AGENTS.md](AGENTS.md) if you work on Opengeni itself.

```bash
bun run typecheck
bun test
```

## License

[Apache-2.0](LICENSE). Optional curated Skills under `packages/runtime/src/curated_skill_library` carry their own provenance and license metadata; HashiCorp-derived Terraform guidance is MPL-2.0 and is never mounted by default.

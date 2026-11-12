<p align="center">
  <a href="https://opengeni.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs-site/logo/dark.svg">
      <img src="docs-site/logo/light.svg" alt="Opengeni" width="320">
    </picture>
  </a>
</p>

<h3 align="center">The open-source agent harness your team runs on its own infrastructure.</h3>

<p align="center">
  AI agents your whole team shares · approvals on every tool · your models, your cloud, your data
</p>

<p align="center">
  <a href="https://docs.opengeni.ai/guides/self-host"><strong>Self-host Opengeni →</strong></a>
</p>

<p align="center">
  <a href="#try-it-locally">Try it locally</a> ·
  <a href="https://docs.opengeni.ai">Docs</a> ·
  <a href="https://app.opengeni.ai">Hosted version</a> ·
  <a href="https://github.com/Cloudgeni-ai/opengeni/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/Cloudgeni-ai/opengeni/actions/workflows/ci.yml"><img src="https://github.com/Cloudgeni-ai/opengeni/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@opengeni/sdk"><img src="https://img.shields.io/npm/v/@opengeni/sdk?label=%40opengeni%2Fsdk" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

---

Opengeni gives your team AI agents that do real work in the tools you already use: meeting follow-ups, weekly reports, research, pull request reviews, invoices from the inbox. Agents ask a person before anything risky, stay inside the budget you set, and keep working for hours or days until the job is done.

Opengeni is the harness around the agent, and you run all of it. One deployment on your own Kubernetes, in the region you choose, serves your whole organization: a workspace per team or client, sign-in for your people, your own model accounts, and every conversation, approval, and piece of team knowledge in a Postgres database you operate. It grew out of two years of running agents against production cloud infrastructure at [Cloudgeni](https://cloudgeni.ai), which still runs every agent session on it.

## What your team gets

- **A workspace per team, or per client.** Each workspace has its own people and roles, tools connected once for everyone, its own instructions, knowledge, and budget. Chats stay private until someone shares them.
- **Agents where your team already works.** The web app, a desktop app for macOS, Windows, and Linux, and Slack: mention it in a thread and it does the work there. Microsoft Teams is in early access.
- **Approvals built into every tool.** Each connected action is Allow, Ask first, or Block. Only a person can approve; agents never approve for you. Approvals arrive in the chat, the inbox, or a desktop notification.
- **No surprise bills.** A monthly budget per workspace, a limit per member, and a limit per task. Insights show usage by person and project.
- **What one person teaches it, the whole team gets.** Agent Knowledge keeps facts, files, and house rules in the workspace, versioned and searchable, with optional review before anything is published.
- **Work that finishes.** Give a session a goal and the agent keeps going until it completes it with evidence or pauses with a reason. Work splits across sub-agents that report back to one session. Sessions run on the server, so closing the laptop does not stop them.
- **Recurring and event-driven work.** Schedule a job ("post last week's sales in #sales every Monday at 8") or start one when something happens in GitHub, Sentry, Linear, or any signed webhook.
- **Secrets the agent never reads.** Keys and passwords live in an encrypted vault and are used by reference at the moment of the call; the value never reaches the model or the logs.
- **Your choice of compute.** Each session gets its own sandbox (Docker, Modal, or a cloud sandbox provider) with your repositories and tools, or runs directly on a **Connected Machine**: a laptop, build server, or GPU box you enroll once. Machines only dial out.

## Your infrastructure, your data

Everything is Apache-2.0: the API, web app, workers, desktop app, Helm chart, and reference Terraform.

- **Deploy where you want.** A version-pinned Helm chart plus reference Terraform for Azure, AWS, and GCP. Use your managed Postgres, Temporal, NATS, and object storage (Azure Blob, S3, or GCS). See [Self-host](https://docs.opengeni.ai/guides/self-host) and the [deployment guide](docs/deployment.md).
- **Bring your own models.** OpenAI, Azure OpenAI, Anthropic Claude, OpenRouter, or any OpenAI-compatible server, set per deployment, organization, or workspace. Organizations can turn on [EU-only inference](docs/eu-only-inference.md), which refuses any model route that does not process data in the EU instead of rerouting it. See [model providers](docs/model-providers.md).
- **Your people, your sign-in.** Email and password, Google, GitHub, and passkeys. Close public sign-up and invite teammates into your organization, with owners, admins, and members. See [organization tenancy](docs/organization-tenancy.md).
- **You own the record.** Every session event, approval, and tool call is stored in Postgres and replays exactly, so an audit sees what the agent saw and did. Back it up with the [backup runner](docs/backups.md), export it, or leave with it.

Don't want to operate it? The same product runs as a hosted service, on Azure in the EU, at [app.opengeni.ai](https://app.opengeni.ai).

## Try it locally

Run the whole stack on one machine before you deploy it. You need [Bun at the exact version in `.bun-version`](.bun-version), Git, curl, Docker, [rustup](https://rustup.rs), a C compiler (Xcode Command Line Tools on macOS or `build-essential` on Debian/Ubuntu), and an OpenAI or Azure OpenAI key.

```bash
git clone https://github.com/Cloudgeni-ai/opengeni.git
cd opengeni
cp .env.example .env   # add your model credentials
bun run dev
```

Open http://127.0.0.1:3000, describe a task, and watch the session run.

`bun run dev` installs dependencies, starts Postgres, NATS, Temporal, and object storage, runs migrations, and starts the API, workers, and web app. By default the agent runs commands directly on your machine (the `local` sandbox), not in an isolated container, so the API and web app listen only on 127.0.0.1. Set `OPENGENI_SANDBOX_BACKEND=docker` to run the agent in the local sandbox image instead. To try the multi-user team setup (sign-in, organizations, invitations), set `OPENGENI_PRODUCT_ACCESS_MODE=managed`. See [Local development](docs/local-development.md) for manual startup, configuration, network exposure, and the native (no Docker) path.

## Desktop app

Your team's sessions, chat, and inbox in a native window, with notifications for approvals and one click to let agents use the computer you're on. It works with any Opengeni server, including yours.

```bash
# macOS
brew install --cask cloudgeni-ai/tap/opengeni

# macOS or Linux (deb, rpm or AppImage, picked for your system)
curl -fsSL https://<your-opengeni-server>/desktop/install.sh | sh
```

On Windows, download `Opengeni-<version>-windows.exe` from the newest [`desktop-v` release](https://github.com/Cloudgeni-ai/opengeni/releases?q=desktop-v&expanded=true). The web app's account menu has the same downloads under **Desktop app**. Every install updates itself afterwards.

## Build on it

The same deployment that serves your team can put agents inside your own product. Each of your customers gets its own sessions, data, files, and credentials, behind one server route and one React component (`@opengeni/sdk` and `@opengeni/react`).

The fastest way is to let your coding agent wire it up. Install the Opengeni plugin, then ask your agent to add Opengeni to your product:

```bash
# Claude Code
claude plugin marketplace add Cloudgeni-ai/opengeni
claude plugin install opengeni@opengeni --scope user

# Codex (CLI, IDE, and the Codex app)
codex plugin marketplace add Cloudgeni-ai/opengeni
codex plugin add opengeni@opengeni
```

In Cursor, use **Customize → From GitHub Repository** with this repository. See the [plugin guide](https://docs.opengeni.ai/guides/developer-plugin), or wire it yourself with [Embed manually](https://docs.opengeni.ai/embed-manually), the [TypeScript SDK](packages/sdk/README.md), and the [React components](packages/react/README.md). [Northstar support](examples/northstar-support) is a runnable SaaS embed with a product MCP server.

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

**Rent the edges, own the middle.** Models, provider APIs, and the raw compute box change too fast to own, so every one of them is a swappable boundary. Durable state, governance, and knowledge are where your team's workflows, permissions, audit record, and institutional memory actually live, so they sit in a Postgres database you operate, export, and can leave with.

## Documentation

| I want to...                          | Read                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Deploy Opengeni for my team           | [Self-host](https://docs.opengeni.ai/guides/self-host) · [Deployment guide](docs/deployment.md)             |
| Try it on my machine first            | [Local development](docs/local-development.md)                                                              |
| Set up people, workspaces, and roles  | [Organization tenancy](docs/organization-tenancy.md)                                                        |
| Configure models and providers        | [Model providers](docs/model-providers.md) · [EU-only inference](docs/eu-only-inference.md)                 |
| Bring agents into Slack               | [Slack](docs/slack-bot.md)                                                                                  |
| Control what agents may do and spend  | [Tool approvals](docs/tool-approvals.md) · [Usage allowances](docs/usage-allowances.md) · [Secrets](docs/secrets.md) |
| Give agents repository access         | [GitHub App](docs/github-app.md)                                                                            |
| Run sessions on my own hardware       | [Connect a machine](https://docs.opengeni.ai/guides/connect-a-machine) · [Connected Machines](docs/connected-machines.md) |
| Understand goals, approvals, knowledge | [Goals](docs/goals.md) · [Human input](docs/human-input.md) · [Knowledge](docs/knowledge.md)               |
| Add agents to my product              | [Product integration](docs/product-integration.md) · [SDK reference](https://docs.opengeni.ai/reference/sdk) |
| Call the HTTP API directly            | [HTTP API overview](docs/http-api.md)                                                                       |
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

Changes land through the [merge batcher](docs/merge-batcher.md): queued PRs are tested together on the combined tree and each lands as one squash commit. Main runs the full suite on a cadence and is the release gate.

## License

[Apache-2.0](LICENSE). Optional curated Skills under `packages/runtime/src/curated_skill_library` carry their own provenance and license metadata; HashiCorp-derived Terraform guidance is MPL-2.0 and is never mounted by default.

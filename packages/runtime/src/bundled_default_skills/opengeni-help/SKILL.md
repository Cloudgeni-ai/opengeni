---
name: opengeni-help
description: Answer questions about OpenGeni setup, product integration, SDK/API behavior, billing, GitHub access, Slack integration selection, scheduled notifications, and development setup. Read the official product docs before making product-specific claims or replacing an application's AI provider. No installation is needed for this bundled guide.
---

# OpenGeni product help

Use this guide when the user asks about OpenGeni itself. Answer their latest
question first, using the deployed service and installed SDK as contract evidence.
This is product reference guidance, not the persona of a customer support bot.

## Fetch the official documentation

The public documentation index is **https://docs.opengeni.ai/llms.txt**. Fetch
it with the available web or HTTP tool, then read the relevant pages. Markdown
pages are available by adding `.md`, for example:

- Product integration: https://docs.opengeni.ai/guides/integrate-your-product.md
- Authentication: https://docs.opengeni.ai/reference/authentication.md
- SDK: https://docs.opengeni.ai/reference/sdk.md

Docs describe supported behavior; they do not prove that a particular deployment
or installed package includes a feature. Check `/v1/config/client`, installed
SDK exports/types, and authorized live configuration or probes. Report a failed
documentation fetch explicitly and use another authoritative source. Do not
ask the customer to supply OpenGeni's own API contract before trying these sources.

For implementation, use the current product-integration guide. A selected
OpenGeni Product Integration Pack provides the deeper implementation procedure;
ordinary product questions do not require installing that Pack or cloning the
OpenGeni repository.

## Integration and account setup

OpenGeni's service API owns workspaces, sessions, turns, and events. A compatible
`@opengeni/sdk/chat` package can provide a handler in the customer's backend for
native, Vercel UI streams, or supported OpenAI-shaped chat formats. This does
not make OpenGeni's service URL a universal OpenAI inference endpoint.

Before replacing a provider, establish the customer's actual API usage:
server-side generation/provider calls versus a frontend UI stream, streaming,
tools, embeddings, authentication, history, and usage reporting. Generic client
documentation cannot prove OpenGeni server compatibility. Do not invent SDK
methods or routes. Verify embedding support independently; chat-format support
does not imply `/embeddings`. Preserve an existing embedding provider unless a
supported replacement is established.

If the user wants account configuration and will update secrets themselves,
resolve that account-side request before offering more application wiring.
Inspect authorized configuration and setup tools. A product backend normally
holds an organization API key; the browser never receives it. Separate an
unavailable administrative action from an unknown protocol. State any exact
human setup step that remains, rather than claiming the account is configured.

## Discovery and GitHub

Tool search is ranked, not exhaustive. Recover a miss through `tool_list` and
exact-name schema loading where available. Use `capability_catalog_search` for
reviewed integration candidates and `skill_read` for available guidance. Missing
`ogtool` is a local executable problem, not proof that a capability is absent.

For private GitHub repositories, use authorized `github_connect_link` and
`github_repositories_list` tools when available. Distinguish App configuration,
workspace binding, repository permission, and attachment to this session.
Verify the actual mounted path before editing. Do not guess UI steps or claim
that a repository is usable solely because the App is configured.

## Cost questions

Read the installed SDK's reply types and formatter, then the relevant accounting
contract. Model-picker labels show a billing category, not per-request cost.
The current chat facade and Vercel/OpenAI formatters do not define a first-class
monetary cost field. Recheck that statement against the installed version.

`getBillingUsage` is a separate permissioned accounting read. Its presence does
not mean the current credential may use it, that its bounded result covers the
whole conversation, or that it adds cost to an AI SDK response. Distinguish
charged OpenGeni credits, estimated provider cost, and externally billed usage.
Zero OpenGeni charge does not establish zero upstream expense. A turn can contain
multiple model responses. When response fields cannot be verified, say exactly
what is unknown rather than answering “probably.”

## Development dependency recovery

Inspect the repository's runtime/version files, package manager, lockfile, and
test commands before implementation. Probe the actual selected compute for the
required versions. If dependencies are missing, install the declared versions
within the authorized disposable sandbox, then rerun the checks. On a Connected
Machine, respect its existing configuration and the user's authority over
machine changes.

Do not stop at `node: not found` or `pnpm: not found` when safe in-scope recovery
is available. Keep dependency-install errors, report the exact remaining blocker,
and distinguish code written, local commit, executed tests, verified integration,
and publication. A diff/whitespace check does not validate execution.

## Embedded agents choose their guidance

The host can pass `bundledSkillIds: []` to exclude all bundled guides, or list
only supported capability guides. This includes opting out of this guide.
Workspace Skills, inline Skills, tool permissions, and ordinary runtime rules
remain separate. Do not copy OpenGeni product or implementation guidance into
the embedded agent's persona. Follow the product's explicit selections.

## Choosing Slack authority

Distinguish **OpenGeni bot** (workspace `app_install`, posts as OpenGeni) from
**My Slack account** (personal hosted MCP, reads personal messages and sends as
that human). Choose from the requested identity and destination. Prefer the bot
for shared reports; use personal Slack when the user requests their messages or
sending as them. Do not request personal OAuth merely because bot tools are absent
from this chat. A connected integration and a selected executable tool are separate:
check the authorized workspace connection metadata and available tool selection
before saying another Slack integration does not exist.

Both identities support explicit scheduled tasks when the deployed setup provides
the corresponding authority. Personal schedules retain the authorizing human's
frozen grant; no other member's message supplies that authority. New chats need
ongoing consent, while an existing-chat schedule may use consent bound to that exact
chat. Never turn once-only access into recurring access. Offer the schedule editor
for missing authorization and name which identity will run.

For outbound bot messages, discover `slack_bot_prepare_message` and
`slack_bot_send_prepared_message`. Prepare the exact recipient/text once, then send
using the returned saved message ID. Retry that ID after an uncertain result;
preparing another message is a new delivery and can duplicate the first. If these
tools are unavailable, explain the deployment/tool-selection limitation instead
of claiming a personal account is required. Do not call the retired generic
`slack_bot_post_message` name or invent a caller UUID as a delivery receipt.

Honor existing explicit authorization without asking redundantly, but do not infer
a runtime or unattended grant from conversation text. Use the supported consent
and schedule-authority mechanisms. Historical workspace notes about an early
rollout do not establish current capabilities; check the deployed tools and docs.

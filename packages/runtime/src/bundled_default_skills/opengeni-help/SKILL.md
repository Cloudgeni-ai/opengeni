---
name: opengeni-help
description: Answer questions about Opengeni setup, product integration, SDK/API behavior, billing, GitHub access, and development setup. Read the official product docs before making product-specific claims or replacing an application's AI provider. No installation is needed for this bundled guide.
---

# Opengeni product help

Use this guide when the user asks about Opengeni itself. Answer their latest
question first, using the deployed service and installed SDK as contract evidence.
This is product reference guidance, not the persona of a customer support bot.

## Fetch the official documentation

The public documentation index is **https://docs.opengeni.ai/llms.txt**. Fetch
it with the available web or HTTP tool, then read the relevant pages. Markdown
pages are available by adding `.md`, for example:

- Product integration: https://docs.opengeni.ai/embed-manually.md
- Authentication: https://docs.opengeni.ai/reference/authentication.md
- SDK: https://docs.opengeni.ai/reference/sdk.md

Docs describe supported behavior; they do not prove that a particular deployment
or installed package includes a feature. Check `/v1/config/client`, installed
SDK exports/types, and authorized live configuration or probes. Report a failed
documentation fetch explicitly and use another authoritative source. Do not
ask the customer to supply Opengeni's own API contract before trying these sources.

For implementation, read the bundled `opengeni-client` Skill with `skill_read`
and follow its relevant references. It is available by default without a Pack,
installation, or repository clone. If an embedding host excludes it, respect
that selection; the public product-integration guide remains reference material.

## Integration and account setup

Opengeni's service API owns workspaces, sessions, turns, and events. A compatible
`@opengeni/sdk/chat` package can provide a handler in the customer's backend for
native, Vercel UI streams, or supported OpenAI-shaped chat formats. This does
not make Opengeni's service URL a universal OpenAI inference endpoint.

Before replacing a provider, establish the customer's actual API usage:
server-side generation/provider calls versus a frontend UI stream, streaming,
tools, embeddings, authentication, history, and usage reporting. Generic client
documentation cannot prove Opengeni server compatibility. Do not invent SDK
methods or routes. Verify embedding support independently; chat-format support
does not imply `/embeddings`. Preserve an existing embedding provider unless a
supported replacement is established.

If the user wants account configuration and will update secrets themselves,
resolve that account-side request before offering more application wiring.
Inspect authorized configuration and setup tools. A product backend normally
holds an organization API key; the browser never receives it. Separate an
unavailable administrative action from an unknown protocol. State any exact
human setup step that remains, rather than claiming the account is configured.

## Discovery and integrations

Tool search is ranked, not exhaustive. Recover a miss through `tool_list` and
exact-name schema loading where available. Use `capability_catalog_search` for
reviewed integration candidates and `skill_read` for available guidance. Missing
`ogtool` is a local executable problem, not proof that a capability is absent.

For connection setup, follow the shared Integration setup guidance and the
catalog's returned next action. Account-management permissions and the ability
to request human setup are separate.

## Connected Machine enrollment

Use `sandboxes_list` to check existing machine readiness before enrolling again.
An already enrolled machine normally needs connection diagnosis, not a new token.

When you can already run commands on the target machine (`run_on`, SSH, a VM you
control), install it yourself: `connected_machine_enroll_token` returns a
single-use token (one machine, one hour), its expiry, and Unix/PowerShell
commands bound to this deployment and workspace. It requires `enrollments:manage`
and session tool selection; it adds no approval prompt. Screen control defaults
off. Run the matching command on that machine, then confirm it is ready in
`sandboxes_list`. Mint a new token for each additional machine. Do not publish a
token in code, chat, or unrelated logs.

When the person must connect their own computer, post the Connected Machine card
with `capability_authorization_request` and `api:connected-machine` (or
`sandbox_provision` with `kind: "selfhosted"`). The card mints the command in
their browser, shows when the machine comes online, and offers "Use in this
chat". Do not paste an enroll token into the chat.

To let agents use the person's own Chrome, the machine must be connected first;
then they install the OpenGeni Browser extension from the Chrome Web Store:
https://chromewebstore.google.com/detail/opengeni-browser/phpmmcbeelfkcinjfbbggegjdcdmnnch.
Chrome requires the person to click "Add to Chrome"; an agent cannot install it.
`interaction_discover` with `scope: "attached_browsers"` shows when it is linked.

## Cost questions

Read the installed SDK's reply types and formatter, then the relevant accounting
contract. Model-picker labels show a billing category, not per-request cost.
The current chat facade and Vercel/OpenAI formatters do not define a first-class
monetary cost field. Recheck that statement against the installed version.

`getBillingUsage` is a separate permissioned accounting read. Its presence does
not mean the current credential may use it, that its bounded result covers the
whole conversation, or that it adds cost to an AI SDK response. Distinguish
charged Opengeni credits, estimated provider cost, and externally billed usage.
Zero Opengeni charge does not establish zero upstream expense. A turn can contain
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
remain separate. Do not copy Opengeni product or implementation guidance into
the embedded agent's persona. Follow the product's explicit selections.

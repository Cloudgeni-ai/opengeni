# Privacy facts for agents

People ask agents whether their data trains models, how long it is kept, which
provider serves them and where it runs. Agents answer from `privacy_facts`, a
read-only tool whose facts come from the server, never from the model's general
knowledge. The operational contract tells the agent to call it for these
questions, answer only from its result, link the policies it lists, and say
plainly what is unknown.

## The tool

`privacy_facts` is an always-visible local function with strict empty
arguments, owned by the `runtime` class (no agent configuration turns it off).
It is built in `apps/worker/src/activities/agent-turn/privacy-facts.ts` and
returns one text block for the turn's chat model:

- the model and provider route as the worker resolved them (never upstream ids,
  URLs or keys, as with `list_models`);
- how the route is paid for (the deployment, a workspace or organization key, or
  a connected subscription, whose own account terms then apply);
- where the route runs, from its residency record
  ([EU-only inference](eu-only-inference.md)); a route without one is
  "not declared (unknown)";
- whether EU-only is on, read live (the deployment requirement or the
  workspace's organization setting);
- the provider's training, retention and processing-location row from the
  reviewed table below, with source links and the date checked; a Vercel AI
  Gateway route pinned to one provider (`requestPolicy.gateway.only`) also
  shows that provider's row, labelled as the provider's public default, since
  Vercel's own agreement with it may differ;
- Opengeni's own facts: the software does not train models; chats, files and
  Knowledge stay until someone deletes them; images kept from tool results
  expire after `COMPUTER_SCREENSHOT_RETENTION_MS` (30 days), the oldest sooner
  at the workspace's limit; the idle-session archive, except chats marked to
  stay live ([session storage lifecycle](session-storage-lifecycle.md)); and
  where the organization's departing-member rule is set. The tool does not read
  that admin-only rule, because everyone in a shared chat can see its output;
- the deployment's `OPENGENI_LEGAL_PRIVACY_POLICY_URL`,
  `OPENGENI_LEGAL_TERMS_OF_SERVICE_URL` and `OPENGENI_SUPPORT_EMAIL` (the
  contact for a DPA or the subprocessor list).

A read that fails becomes "unknown" in the result rather than failing the tool.
The scope line says other features (titles, voice, images, web search and
connected tools) can use other providers and are not described. Route facts are
resolved when the turn starts, like the rest of the turn's tools.

## The reviewed provider table

`apps/worker/src/activities/agent-turn/provider-data-policy.ts` holds one row
per provider family. Statements come only from the provider's own current
documentation, listed with the date checked. Where the documentation is silent
the row says "not stated (unknown)". A route is matched to a row by explicit
evidence in this order: provider kind (a workspace's own compatible server is
always `unknown`), residency deployment type, a Bedrock model id on a Bedrock
host or bridge, then an Azure endpoint, then an exact provider host; anything
else is the `unknown` row. On Azure, a model named `FW-…` is Fireworks on
Foundry, and only the Responses API (or a declared Azure deployment that is not
Anthropic's Messages API) is Azure OpenAI; Claude and partner models on Azure
hosts are `unknown`.

Rows checked on 30 October 2026, with an independent fact-check of every
sentence against its source:

| Row | Trains on data | Keeps data | Where |
| --- | --- | --- | --- |
| Azure OpenAI (sold by Azure) | No | Flagged content for abuse review, period not stated; Responses data 30 days by default (Opengeni does not turn it off on Azure) | Resource geography at rest; Global may process wherever the model is deployed; Data Zone EU in the EU |
| Fireworks on Azure Foundry | Not stated | Not stated | Fireworks GPUs outside Microsoft facilities; excluded from the EU Data Boundary; pay-per-token Data Zone in US regions |
| Amazon Bedrock | No | Models on AWS's abuse-detection list, up to 30 days (Claude Opus and Sonnet 5.5 were not on it); CSAM detection may keep content | `global.*` any commercial region; `eu.*` EU regions |
| Anthropic API | No | Within 30 days; flagged up to 2 years | Any geography by default; the Anthropic workspace default applies |
| Claude subscription | Personal plans: with the setting on, plus flagged chats and feedback; Team and Enterprise: only on opt-in or feedback | Personal: 30 days, or up to 5 years with the setting on; Team and Enterprise: 30 days | Not stated |
| OpenAI API | No, unless opted in | Abuse logs up to 30 days; Responses data 30 days by default (Opengeni does not turn it off) | Not stated for default projects |
| Codex (ChatGPT) subscription | Personal plans: unless "Improve the model for everyone" is off | The account's terms; Opengeni sends `store: false` | Not stated |
| xAI API | No | 30 days; zero retention self-serve for team admins | Not guaranteed on the default endpoint |
| SuperGrok subscription | May train | No fixed period stated | Not stated |
| Vercel AI Gateway | Vercel no; upstream default or Vercel's stricter agreement | Vercel none; upstream applies | Any Vercel region; no inference region pinned |
| Google Vertex (Gemini) | No | 24-hour cache; flagged prompts up to 90 days; Frontier Models logs 30 days | Any region unless a regional endpoint is used |
| OpenRouter | Only if the account opts in, apart from anonymous sampling for categorization; upstream applies | On opt-in or flagged CSAM; may sample a few prompts anonymously; metadata kept | Not pinned |
| Opper | No; upstream applies | Metadata only by default; tracing 1 to 30 days if turned on | EU-hosted gateway (Stockholm) |

Changing a row is a reviewed change: re-read every source, update the date, and
keep unknowns unknown.

Statements about what Opengeni's own requests do (for example whether Opengeni
turns off Responses API storage) sit in a separate `opengeni` field. The tool
shows them only when Opengeni calls that provider directly, not when the
provider sits behind a gateway such as Vercel AI Gateway.

## Not covered

Opengeni the company's own commitments (hosting region, log retention, DPA,
subprocessors) live in the deployment's linked privacy policy, not in code, so
the tool links them instead of restating them.

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

- the model, provider route and upstream model id, as the worker resolved them;
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
  shows that provider's row;
- Opengeni's own facts: the software does not train models; chats, files and
  Knowledge stay until someone deletes them (stored chat images over the
  workspace image limit are the one exception); the idle-session archive
  ([session storage lifecycle](session-storage-lifecycle.md)); and the
  organization's departing-member retention rule, which only organization
  admins can read;
- the deployment's `OPENGENI_LEGAL_PRIVACY_POLICY_URL`,
  `OPENGENI_LEGAL_TERMS_OF_SERVICE_URL` and `OPENGENI_SUPPORT_EMAIL` (the
  contact for a DPA or the subprocessor list).

A read that fails becomes "unknown" in the result rather than failing the tool.
The scope line says other features (titles, voice, images, web search and
connected tools) can use other providers and are not described.

## The reviewed provider table

`apps/worker/src/activities/agent-turn/provider-data-policy.ts` holds one row
per provider family. Statements come only from the provider's own current
documentation, listed with the date checked. Where the documentation is silent
the row says "not stated (unknown)". A route is matched to a row by explicit
evidence in this order: provider kind, residency deployment type, Bedrock model
id, Azure endpoint (an Azure model named `FW-…` is Fireworks on Foundry), exact
provider host; anything else is the `unknown` row.

Rows checked on 30 October 2026:

| Row | Trains on data | Keeps data | Where |
| --- | --- | --- | --- |
| Azure OpenAI (sold by Azure) | No | Flagged content for abuse review, period not stated; Responses state 30 days (Opengeni cannot turn it off on Azure) | Resource geography at rest; Global may process anywhere; Data Zone EU in the EU |
| Fireworks on Azure Foundry | Not stated | Not stated | Outside Microsoft and the EU Data Boundary |
| Amazon Bedrock | No | None, or up to 30 days for models that require AWS abuse review | `global.*` any commercial region; `eu.*` EU regions |
| Anthropic API | No | Within 30 days; flagged up to 2 years | Global |
| Claude subscription | Personal plans: if the model-improvement setting is on | Personal plans: 30 days, or up to 5 years de-identified with the setting on | Global |
| OpenAI API | No, unless opted in | Abuse logs up to 30 days; Opengeni sends `store: false` | United States |
| Codex (ChatGPT) subscription | Personal plans: unless "Improve the model for everyone" is off | The account's terms; `store: false` | United States |
| xAI API | No | 30 days | United States |
| SuperGrok subscription | May train | Not stated | United States |
| Vercel AI Gateway | Vercel no; upstream default applies | Vercel none; upstream applies | Global |
| Google Vertex (Gemini) | No | Abuse logging and caching, period not stated | Global |
| OpenRouter | Only if the account opts in; upstream applies | Only if the account opts in | Global |
| Opper | Not stated | Configurable; default not stated | EU-hosted gateway |

Changing a row is a reviewed change: re-read every source, update the date, and
keep unknowns unknown.

## Not covered

Opengeni the company's own commitments (hosting region, log retention, DPA,
subprocessors) live in the deployment's linked privacy policy, not in code, so
the tool links them instead of restating them.

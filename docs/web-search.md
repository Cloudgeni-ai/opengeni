# Web search

Opengeni gives agents web search in one of two ways for each turn:

- **Hosted search.** The model provider runs the search. Opengeni attaches the
  provider's `web_search` tool when the model catalog declares
  `capabilities.hostedTools.webSearch.runnable`. Today that means the GPT models
  on OpenAI/Azure Responses, the Codex models, Claude on its native Messages
  route (API key and Claude subscription), and SuperGrok (which also adds
  `x_search` at its transport). See
  [model providers](model-providers.md#native-web-search-is-a-runtime-capability).
- **Provider search.** Opengeni runs the search from the worker through a
  configured search API and offers two ordinary function tools, `web_search`
  and `web_fetch`. Any model with function calling can use them, including
  Gemini, DeepSeek, GLM and Kimi.

Provider search is off until an operator names a provider. With no provider,
nothing changes: models without hosted search have no web search tool.

## Which turns get which

The plan is computed by `webSearchToolPlan` in `packages/config/src/web-search.ts`.
The worker (`apps/worker/src/activities/agent-turn/web-search.ts`) and the API's
effective-tools projection (`packages/core/src/domain/session-tool-policy.ts`)
both call it, so the tools a session reports are the tools it gets.

| `OPENGENI_WEB_SEARCH_PROVIDER_MODE` | Model with hosted search | Model without hosted search |
| --- | --- | --- |
| `fallback` (default) | hosted `web_search` only | provider `web_search` + `web_fetch` |
| `replace` | provider tools instead of hosted search | provider `web_search` + `web_fetch` |

SuperGrok keeps its native search in both modes, because its transport adds
that search rather than Opengeni's tool list.

Every other rule still applies:

- `OPENGENI_WEB_SEARCH_ENABLED=false` turns off all web search, hosted and
  provider.
- The session's agent configuration must allow the **Web search** capability.
  Provider tools have the same capability as hosted search (`webSearch` in
  `AGENT_FUNCTION_TOOL_CAPABILITIES`).
- A search-only provider (Brave, SearXNG) offers `web_search` alone unless
  `OPENGENI_WEB_FETCH_PROVIDER` names a reader.

Both tools are in the always-visible first-request set
(`packages/runtime/src/lazy-tool-transport.ts`). Hosted search is never
deferred behind `tool_search`, so its replacement is not deferred either. Both
are attempt tools, so Codemode programs can call them too.

### Why hosted search stays the default where it exists

- On Codex and SuperGrok, hosted search is included in the subscription.
- Hosted search reads and summarizes pages on the provider's side. Only the
  answer and citations enter the conversation, which keeps context small.
- Offering two overlapping search tools to one model makes tool choice worse.
- The tool list is part of the cached prompt prefix, so existing sessions keep
  their prefix.

`replace` exists so an operator can A/B the two (see the eval below) or route
every model through one audited provider.

### Claude's server-side search

Claude models declare hosted search runnable whenever
`OPENGENI_WEB_SEARCH_ENABLED` is on. The Claude transport
(`packages/runtime/src/anthropic-messages.ts`) turns the agent's hosted
`web_search` tool into Anthropic's `web_search_20250305` server tool at the
same position in the tool list, so the tool list stays part of one stable cache
prefix. Anthropic bills each search on API-key accounts (see its pricing);
results also count as input tokens on later requests.

- Each search is stored as a hosted `web_search_call` item. Its
  `providerData.anthropic.blocks` keep Anthropic's `server_tool_use` and
  `web_search_tool_result` blocks, including the encrypted page content, and
  cited text keeps its citations in `providerData.anthropic.citations`. Claude
  receives all of them back exactly as returned, which Anthropic requires.
- A search Claude defers behind Opengeni tool calls resumes on the next
  request. A paused turn (`pause_turn`) is continued inside the transport with
  its content unchanged, at most eight times, and reported as one response.
- A search Claude can no longer continue (an interrupted or steered turn), a
  result whose call was compacted away, or any search on a request without the
  search tool becomes a readable historical fact without encrypted data. These
  decisions depend only on the history, so later requests keep the same prefix.
- Other providers and the compaction transcript see the query, URLs, titles
  and page age, never the encrypted content.
- An organization whose admin turned web search off in the Claude Console
  fails with the `anthropic_web_search_disabled` error.

### Hosted evidence across tool calls

Azure can complete a search but hide its results on the next model request when
stored response IDs are detached. The runtime requests `web_search_call.action.sources`
whenever Azure native search is attached, and `web_search_call.results` when the
request enables reasoning (a nonempty effort other than `none`). Existing includes,
including encrypted reasoning, remain enabled. Other providers' includes are unchanged.

The SDK retains returned evidence in canonical history. Before replay and portable
compaction accounting, `packages/runtime/src/hosted-search-evidence.ts` projects
included HTTP(S) URLs and text-result titles/snippets into one unprivileged assistant
historical-evidence message at the original position. It labels web content as
untrusted, examines at most 64 entries per include, emits at most 20 entries, and
bounds the serialized message to 32 KiB. Titles/snippets are clipped explicitly;
URLs are never shortened or rewritten. Omitted evidence is distinguished from
genuinely empty includes. Provider IDs and arbitrary provider metadata are not
needed to replay these facts. Canonical hosted items and tool pairing stay intact.

This does not reconstruct evidence absent from older responses, perform another
search, or guarantee native citation annotations. Sources-only includes supply URLs,
not page facts. Azure supplies result snippets only for reasoning searches, not
`open_page` or `find_in_page`; unsupported or missing includes cannot supply their
page bodies. A completed hosted-call status alone is not proof of usable results.
See the [Azure web-search contract](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/web-search).

## Tools

`web_search {query, maxResults?}` returns at most 10 results (default 5). Each
result has a title, URL, optional date, and a snippet of at most 400 characters.
A typical answer is about 1.5 KB.

`web_fetch {url, offset?, maxChars?}` returns one page as readable text or
Markdown:

- It returns a window of at most 50,000 characters (default 20,000), with
  `nextOffset` when more text remains.
- Pages are cached per attempt, so paging through a page is not fetched or
  billed again.
- The cache keeps at most 1,000,000 characters per page and 16 pages.

Both results stay well under the 1 MiB model-visible tool-result limit, so they
never spill.

`web_fetch` accepts only public `http`/`https` URLs. It refuses credentials in
the URL, IP literals in private, loopback, link-local or metadata ranges,
single-label hosts, and `.local`/`.internal`/`.lan` names. The provider makes
the request, not the worker. These refusals protect a self-hosted reader that
may sit inside a private network.

Provider failures, timeouts, rate limits and billing refusals come back as tool
errors with a short reason, never as a failed turn. The provider key never
reaches a sandbox or a Connected Machine.

## Providers

Adapters live in `packages/runtime/src/web-search/providers.ts`. Each one maps
its API to `WebSearchProvider` and `WebFetchProvider`
(`packages/runtime/src/web-search/types.ts`).

To add a provider:

1. Write one search adapter, and optionally one fetch adapter.
2. Add its traits and list price in `packages/config/src/web-search.ts`.

Prices were checked on 2026-10-05.

| Provider | Search | Fetch | Key | Built-in list price (search / fetch) | Free tier |
| --- | --- | --- | --- | --- | --- |
| `tinyfish` | yes | yes | required | $0 / $0 | Free at any balance; per key 30 searches/min and 500/hour, 150 fetches/min and 1,000/day |
| `exa` | yes (`auto`, highlights) | yes (`/contents`) | required | $8 / $1 per 1k; reported `costDollars` is billed when present | $10 credit/month |
| `tavily` | yes (`basic`) | yes (`/extract`) | required | $8 / $1.60 per 1k; reported `usage.credits` × $0.008 is billed | 1,000 credits/month |
| `firecrawl` | yes (`/v2/search`) | yes (`/v2/scrape`) | required | $6.40 / $3.20 per 1k (Hobby; set the price JSON for your plan) | 1,000 credits/month |
| `brave` | yes | no | required | $5 per 1k | $5 credit/month, card required |
| `jina` | yes (`s.jina.ai`, key required) | yes (`r.jina.ai`, keyless allowed) | search only | $0.50 / $0.25 per 1k; keyless fetch $0 | 10M tokens per new key |
| `searxng` | yes (self-hosted JSON API) | no | none | $0 | Self-hosted |

Brave's terms forbid storing results beyond transient use without an
enterprise plan. Search results enter session history, so check your plan
before choosing Brave.

### Recommended default

Use **TinyFish** for search and fetch. It is free at any balance and covers
both tools with one key, so the deployment pays nothing and needs no credit
billing.

TinyFish's free limits are per key: 30 searches a minute and 500 an hour, and
150 fetches a minute and 1,000 a day. Over a limit the tool returns a
retryable error to the model; the turn continues. When a deployment outgrows
the fetch limit, keep TinyFish search and set `OPENGENI_WEB_FETCH_PROVIDER=exa`
(about $1 per 1,000 pages, billed at cost + 5%), or move both to a paid plan.

For more independence, Exa or Tavily are the paid alternatives. Both report
their exact cost per call and have a no-card free tier. Self-hosters who want
zero external accounts can run SearXNG with `OPENGENI_WEB_FETCH_PROVIDER=jina`.
Keyless Jina reading is limited to about 20 requests per minute per IP.

## Configuration

All settings are environment variables read by the worker and the API. The
deployment generator passes them through (`WEB_SEARCH_PROVIDER_PASSTHROUGH_ENV`
in `packages/deployment`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENGENI_WEB_SEARCH_PROVIDER` | `none` | `tinyfish`, `exa`, `tavily`, `firecrawl`, `brave`, `jina`, `searxng`, or `none` |
| `OPENGENI_WEB_SEARCH_API_KEY` | unset | Search provider key |
| `OPENGENI_WEB_SEARCH_BASE_URL` | provider default | Required for `searxng`; optional proxy for others |
| `OPENGENI_WEB_FETCH_PROVIDER` | the search provider when it can fetch | A different reader (`tinyfish`, `exa`, `tavily`, `firecrawl`, `jina`), or `none` |
| `OPENGENI_WEB_FETCH_API_KEY` | search key when the provider is the same | Reader key (optional for `jina`) |
| `OPENGENI_WEB_FETCH_BASE_URL` | provider default | Reader base URL |
| `OPENGENI_WEB_SEARCH_PROVIDER_MODE` | `fallback` | `fallback` or `replace` |
| `OPENGENI_WEB_SEARCH_PRICING_JSON` | built-in | `{"searchMicros":5000,"fetchMicros":1000,"marginBps":500}` (USD micros per call) |
| `OPENGENI_WEB_SEARCH_REQUEST_TIMEOUT_MS` | `20000` | Per provider request |

A provider that is named but cannot work keeps the tools unoffered. For
example, a missing key, a SearXNG URL that is not http(s), or malformed pricing
JSON. The worker logs `web search provider is misconfigured` with the reason at
startup. It never offers a tool that cannot run.

Examples:

```bash
# Recommended: free search and fetch.
OPENGENI_WEB_SEARCH_PROVIDER=tinyfish
OPENGENI_WEB_SEARCH_API_KEY=...

# No external account: self-hosted SearXNG plus keyless Jina reading.
OPENGENI_WEB_SEARCH_PROVIDER=searxng
OPENGENI_WEB_SEARCH_BASE_URL=http://searxng.internal:8080
OPENGENI_WEB_FETCH_PROVIDER=jina
```

SearXNG must have the JSON format enabled (`search.formats: [html, json]` in
`settings.yml`).

## Metrics

The worker counts every provider call that reaches the provider or is refused
by billing:

- `opengeni_web_search_calls_total{operation, provider, outcome}`, where
  `operation` is `search` or `fetch` and `outcome` is `ok`, `provider_error`,
  `provider_retryable` (timeouts, 429, 5xx), `billing_refused`, or `error`
  (an unexpected exception);
- `opengeni_web_search_call_duration_seconds{operation, provider}`.

Labels never include the query, URL or session. A provider failure also logs
`web search provider call failed` with the provider, HTTP status and message.

## Billing

Credit billing is active when `OPENGENI_BILLING_MODE=stripe` or
`OPENGENI_USAGE_LIMITS_MODE=managed`. `packages/core/src/domain/web-search-billing.ts`
follows the same pattern as paid Knowledge queries and voice input.

**Admission.** A call with a positive price needs a positive general credit
balance. It also needs the workspace and initiating member allowances to have
room. Admission is a read, not a reservation. Free calls are never refused.

**Settlement.** After the provider answers, one transaction records:

- a `web_search.cost` usage receipt with the session, turn and attempt;
- an idempotent `web_search_debit` ledger entry (source `web_search`,
  `<attemptId>:<operationId>`).

The debit carries `turnId`, so the allowance trigger charges the turn's
initiating human from the immutable turn receipt. No migration was needed.

**Price.** The charge is `ceil(providerCost × (10000 + marginBps) / 10000)`,
with a default margin of 500 bps (+5%). The provider cost is chosen in this
order:

1. the operator's pricing JSON;
2. the cost the provider reported for this call;
3. the built-in list price.

The basis and provider cost are kept in the ledger metadata.

Every call, billed or not, records a `web_search.search_requests` or
`web_search.fetch_requests` usage event, so self-hosters can see provider volume.

If settlement fails after the provider answered, the model still gets its
result and the worker logs `web search usage settlement failed`.

## Evaluating providers

`scripts/web-search-eval.ts` compares hosted search with provider search on six
dated questions. The questions cover current events, releases and API pricing,
with references written on 2026-10-05.

Both arms use the same Responses model. A judge with no tools grades each
answer 0–2. The script reports latency, tool calls, tokens, model cost and
search cost:

```bash
OPENGENI_AZURE_OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
OPENGENI_AZURE_OPENAI_API_KEY=... \
OPENGENI_WEB_SEARCH_PROVIDER=tinyfish OPENGENI_WEB_SEARCH_API_KEY=... \
bun scripts/web-search-eval.ts --model gpt-5.6-sol --json eval.json
```

`--arms retrieval` needs no model key. It runs the provider adapters alone and
reports:

- search latency;
- whether the reference facts appear in the snippets and in the three top
  fetched pages;
- the size of the model-visible output.

On 2026-10-05, a local SearXNG with keyless Jina fetch produced these results:

- All six reference facts appeared in the snippets.
- All six appeared in the top fetched pages.
- Search latency was 0.4–1.9 s.
- Fetch latency was about 1–10 s per page.
- Rendered results were about 1.1–1.7 KB, roughly 300–450 tokens.

The model arms (hosted against provider search, graded by a judge) have not
been run yet. They need two things:

- a live Responses deployment with hosted `web_search`, such as
  `gpt-5.6-sol` on Azure (`OPENGENI_AZURE_OPENAI_BASE_URL` and
  `OPENGENI_AZURE_OPENAI_API_KEY`) or `OPENAI_API_KEY`;
- a provider key for the provider arm. A free TinyFish key works.

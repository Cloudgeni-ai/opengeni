# Integration eval

Repeatable end-to-end checks that agents use third-party integrations correctly.
Each row is a real chat created through the public API. The harness approves
writes the way a person would, then grades the run from the session's tool
receipts (forensic session events), not from the answer text alone.

## What a row checks

| Kind | Passes when |
|---|---|
| `not_connected` | Run in a workspace with nothing connected. The agent shows that integration's connect card (`tool.auth_needed`) and does not invent data. |
| `read` | A tool of that integration ran without error, and the answer contains the seeded fixture facts. |
| `write` (approve) | An approval was requested for that integration and the harness approved it. The approved call itself ran (it has an output) without error, the change applied once, and the service-side verifier finds the object. |
| `write` (deny, `decision: "reject"`) | An approval was requested and the harness rejected it. The denied tool did not run again without approval, the service has no matching object, and the answer doesn't claim the write happened. |
| `identity` | The agent reports the connected account correctly. These rows check the answer text (account and workspace names); a tool call is not required, because the account label is often already in the agent's context. |
| `routing` | Ambiguous request; the right integration's tools ran and the answer has the expected facts. |

Failures are categorised as `wrong_tool`, `no_tool`, `missing_card`,
`approval_problem`, `tool_error`, `hallucinated_result`, `incomplete_answer`,
`timeout` (the agent was still working at the run deadline; the harness
cancels the chat), `rate_limited` (the service's own rate limit failed the row)
or `harness_error` (an API, verifier or event-history failure). `rate_limited`
and `harness_error` are not product verdicts and are excluded from pass rates.

The harness answers approvals through the API, so nobody clicks anything. It
gives the row's decision only to approvals of the row's integration, and
rejects any other approval so a run never writes outside its fixtures.

## Setup

1. An organization that can run the chosen models. With an API key, credit
   models are paid from purchased API credits only (a plan's monthly credit
   never pays for API use). Models served through a connected subscription
   (`codex/*` with a connected ChatGPT account) run without credits. A
   signed-in test person (`OPENGENI_EVAL_LOGIN_EMAIL` and
   `OPENGENI_EVAL_LOGIN_PASSWORD` instead of the key) is billed as app use.
2. Two workspaces: one with the integrations connected, one with none.
3. In the connected workspace, set each connection's change tools to **Ask
   first** (Capabilities → the connection → Tool permissions). Connector
   writes run without approval under the default policy, and write rows
   check the approval round trip. Mark a row `approval: "optional"` to accept
   either.
4. Test accounts for each service, seeded with the fixtures below. Use test
   accounts and synthetic data only.
5. An API key. Personal ("Only me") connections only run in chats their
   owner started, and only the owner may approve their writes, so for rows
   on a personal connection use the owner's personal key (or sign in as
   them).

```sh
export OPENGENI_EVAL_API_URL=https://app.example.com
export OPENGENI_EVAL_API_KEY=...            # the connections' owner's personal key
export OPENGENI_EVAL_CONNECTED_WORKSPACE_ID=...
export OPENGENI_EVAL_EMPTY_WORKSPACE_ID=...
# A workspace key, used by owner-only rows to check that its approve is refused.
export OPENGENI_EVAL_WORKSPACE_API_KEY=...
# Optional service verifiers for write rows; see verify.ts for the names.
export VERIFY_LINEAR_API_KEY=...
```

## Fixtures

Everything is fictional: the company Halcyon Labs, customers Bluefin
Logistics, Copperleaf Dental and Marlow & Finch, people Ada Quill, Ravi Tern
and Mina Sorrel, and the "Kestrel" failover project. Seed each service once;
the expected answers in `catalogue.ts` name these facts.

| Service | Seed |
|---|---|
| Linear | Team "Halcyon" (key HAL): "Checkout times out for Bluefin Logistics" (Urgent, In Progress); "Add CSV export to invoices" (Medium, Todo); "Rotate Halcyon staging API keys" (High, Backlog); "Copperleaf Dental onboarding checklist" (Low, Done). |
| Atlassian | Jira project "Kestrel Ops" (KOPS): "Database failover drill for Kestrel" (High, In Progress), "Renew Kestrel TLS certificates" (Medium, To Do), "Kestrel backup restore test" (Low, Done). Confluence page "Kestrel on-call rota": week 45 Ravi Tern, week 46 Mina Sorrel, week 47 Ada Quill. |
| Slack | Channels `#halcyon-launch` ("Launch moved to 1 December, pricing page owner is Ada") and `#halcyon-support` ("Bluefin reports checkout timeouts since Friday"). Write rows post to the channel in `VERIFY_SLACK_CHANNEL_ID`. |
| Gmail | An email from Ada Quill about the "Halcyon launch checklist". |
| Apollo | Contact Mina Sorrel, Head of Platform at Halcyon Labs (`mina.sorrel@halcyon-labs.example`). No enrichment rows; enrichment uses credits. |
| Microsoft 365 | Email "Kestrel failover drill moved" (drill moves to Thursday 14:00); OneDrive file "Kestrel runbook" ("Recovery time objective: 15 minutes"); SharePoint list "Kestrel vendor contacts" on a team site, with one item titled "Marlow & Finch". |
| Google Drive | Document "Halcyon pricing 2026" listing Pro at 49 USD a month. |
| Others (Notion, Asana, Stripe test mode, GitHub, HubSpot, Sentry, Airtable) | The object each row's prompt names, with the facts its expected answer checks (see `catalogue.ts`). |

Write rows put the run's short id in the object's title (`Halcyon eval <id>`),
so the verifiers find it, and reruns never collide. Clean those objects up now
and then; nothing reads them back.

## Running

```sh
bun run eval:integrations list                       # every row (add --cases core for the grid set)
bun run eval:integrations models                     # every credit model at every effort (or --cells SPEC)
bun run eval:integrations run --out results/grid --cells all --cases core --repeats 1 --concurrency 4
bun run eval:integrations run --out results/ref --cells some-model@medium --cases all --repeats 2
bun run eval:integrations report --out results/grid
```

`--cells` takes `all` (credit models at every effort), `subscription`
(connected-subscription models at every effort), or comma-separated
`model@effort`, where the effort may be `*` (every effort the model offers)
or `default`. A smaller grid sweeps every effort for one or two models and
runs the others at their defaults:

```sh
bun run eval:integrations run --out results/codex --cases core --repeats 2 \
  --cells 'codex/gpt-6.1-sol@*,codex/gpt-6-luna@*,codex/gpt-6.1-terra@default,codex/gpt-6-astra@default'
```

`--cases` takes `core`, `all`, or comma-separated ids or prefixes
(`linear`, `slack.write`, `routing`). `--skip-integrations a,b` drops
integrations the deployment cannot test. `--dry-run` lists the runs.

Results append to `DIR/results.jsonl`. Running the same command again skips
rows that already have a record, so an interrupted grid resumes; rows recorded
as `harness_error` are retried, and the newest record of a row wins. The report
writes `matrix.csv` (integration × model × effort with failing chat links),
`runs.csv` (one line per chat) and `summary.md` (pass rate per cell with a
Wilson 95% interval). Each run's parsed receipts are kept in `DIR/receipts/`.

## Checking a fix

Regression rows for specific fixes:

| Fix | Rows |
|---|---|
| Workspace Slack bot tools only where a bot is installed, and Ask first for interactive bot sends | `slack.write.post` (an approval must be requested), `slack.write.denied`, `slack.not_connected.channel-summary` (no bot tools hide the Slack card) |
| Connect card for a named integration despite strong matches on installed tools; near-miss integration names | `clickup.not_connected.strong-match` (runs in the connected workspace; keep ClickUp disconnected there), `airtable.not_connected.spacing`, `airtable.not_connected.typo` |
| Only the owner may approve writes on a personal connection | `slack.write.owner-only-approval` (needs the owner's personal key as `OPENGENI_EVAL_API_KEY`, their personal Slack connection on Ask first, no shared Slack connection in the workspace, and `OPENGENI_EVAL_WORKSPACE_API_KEY`; the workspace key's approve must get a 403 with reason code `APPROVAL_REQUIRES_ACCOUNT_OWNER`) |

Rerun the same rows, with the same models and efforts, into a new directory:

```sh
bun run eval:integrations run --rerun results/grid/results.jsonl --failed-only --out results/grid-fix-1
bun run eval:integrations run --rerun results/grid/results.jsonl --failed-only --cases slack --out results/slack-fix
```

`--cases` and `--skip-integrations` narrow a rerun. `regrade --out DIR`
fetches the recorded chats' events again and regrades them with the current
grader, without new chats (useful after changing the grader or a catalogue
row).

## Sizing

A three-row pilot only checks the setup. With one core row per integration
surface and kind, the grid has about 30 rows per cell; at one repeat a cell's
pass rate has a 95% interval of roughly ±15 points, and a model's aggregate
across its efforts (100+ runs) about ±8. Compare cells only when intervals do
not overlap, and use `--repeats` on the reference cells when a difference
matters.

## Tests

```sh
bun test scripts/integration-eval
```

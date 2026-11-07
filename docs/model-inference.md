# Stateless typed decisions

`POST /v1/workspaces/{workspaceId}/decisions` uses the deployment's existing
decision model. It creates no session, turn, checkpoint or turn audit. There is
no chat fallback and no caller-selected model or provider credential.

## SDK

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({ baseUrl, apiKey });
const result = await client.decide(platformWorkspaceId, {
  tenantLabel: "customer-42",
  input: { text: "Please send the invoice." },
  questions: {
    billing: { type: "predicate", instructions: "Is this about billing?" },
    category: {
      type: "choice", instructions: "Pick the best category",
      criteria: { sales: "A new purchase", support: "Help with an existing purchase" },
    },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["Low", "High"] },
  },
}, { signal });

const answer = result.answers.billing;
if (answer.type === "refusal") console.log(answer.reason);
else console.log(answer.probability);
console.log(result.id, result.model, result.usage);
```

Predicates return a probability from zero to one; choices return an allowed key;
scores return a zero-based criteria index. Every answer can instead be a typed
refusal. The existing provider adapter validates all answers. A malformed answer
fails the request, but any usage already reported by the provider is retained.
The SDK does not silently retry a failed decision call.

## Authority, funding and configuration

The same API key and `sessions:create` authority as chat completions apply.
The workspace and account come from the authenticated grant, not from a label.
API-key authentication is reused within a request; revocation, expiry and scope
are rechecked on each new request, as on chat completions.

The product should call as itself in a platform workspace. Deployment credentials
pay the upstream provider. Decision calls bypass agent allowance admission and
do not debit customer credits; an exhausted customer allowance does not block
them. An optional `tenantLabel` (1–256 characters) is reporting-only: it neither
selects a customer workspace nor changes the payer. It is returned in the answer
and on the platform's usage events (`listUsageEvents`). Do not put secrets in it.

Configure the API process using the existing [decision-model settings](decision-models.md),
also used by worker code search and tool discovery. A missing configuration
returns 503. Workspace/deployment EU-only requirements and the existing
side-feature endpoint residency checks run before dispatch. Provider failures
are sanitized; rate limiting returns 429 and other decision failures return 502.

## Usage and receipt durability

The response includes the configured model, validated answers, a server-generated
request ID, and provider usage. Unknown token counts/costs remain `null`, not zero.
Reported and estimated cost sources stay distinct. Existing canonical settlement
records token usage, a zero-credit `model.cost`, and (when known) provider cost
as `model.provider_cost` or `model.estimated_provider_cost` in USD micros.
It never borrows a conversational model's price for an unpriced decision.

Receipt writes run off the response path. Failed writes retry only database
settlement using the same idempotency identity; they never repeat the provider
call. Normal server shutdown drains pending writes. In-process composition hosts
must drain `routeDeps.decisions.flushUsage()` before closing their database.
Abrupt process loss before persistence can lose a queued receipt: this is not a
durable exactly-once queue. The response usage remains available to the caller.

## Latency verification

The opt-in API test measures end-to-end HTTP time minus provider time, with a real
API key, the full router, migrated PostgreSQL, residency reads and receipt writes.
The controlled HTTP provider simulates 265/484 ms responses; no paid inference is
used. It measures decisions and the unchanged chat-completions path separately,
after ten warmups and over 120 serial samples each. It is a local-stack overhead
measurement, not a production network or concurrency guarantee.

On November 7, 2026, the local serial run measured decision overhead of 8.1 ms
median / 13.7 ms p95, versus 28.2 ms / 37.9 ms for unchanged chat completions.
Provider time was 265.1 ms / 484.1 ms for decisions; total time was 273.3 ms /
492.0 ms. Fresh per-request key checks remained enabled: request-local caching
already met the overhead target without caching revoked authority across requests.

```sh
OPENGENI_TEST_PG_URL=postgres://... OPENGENI_REQUIRE_REAL_DB=1 \
OPENGENI_BENCH_DECISIONS=1 bun test apps/api/test/decisions-postgres.test.ts
```

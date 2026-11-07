# Stateless decisions and embeddings

A product running its own Opengeni deployment can use its existing API key for
typed decisions and embeddings as well as [chat completions](chat-completions.md).
No session, agent, tool call or history is created. Both endpoints require the
same workspace `sessions:create` authority as chat completions.

| Endpoint | SDK method | Configured model |
| --- | --- | --- |
| `POST /v1/workspaces/:workspaceId/decisions` | `client.decide(workspaceId, request, options?)` | Deployment decision model |
| `POST /v1/workspaces/:workspaceId/embeddings` | `client.embed(workspaceId, request, options?)` | Deployment document embedder |

Neither endpoint accepts a model, credential, dimension, streaming or request-ID
override. The deployment owns those choices. Unknown fields return HTTP 400,
rather than being silently ignored. `options.signal` cancels an SDK request;
the provider receives the cancellation. SDK mutations are not automatically retried.

## Decisions

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const decision = await client.decide(workspaceId, {
  input: { text: "Please send me the invoice." },
  questions: {
    needsReply: { type: "predicate", instructions: "Does this need a reply?" },
    category: {
      type: "choice",
      instructions: "Classify the request.",
      criteria: { billing: "Invoices and payments", support: "Technical help" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is the request?",
      criteria: ["Routine", "Time-sensitive", "Immediate"],
    },
  },
});

const answer = decision.answers.needsReply;
if (answer.type === "predicate") console.log(answer.probability);
else console.log(answer.reason); // typed refusal
```

The JSON body is `{ input, questions }`. Each question has `type`, `instructions`
and, for choice/score, non-empty `criteria`. Instructions can be text, an object
or an array. Predicate criteria may name `true` and `false`. Input is any JSON value.

The response is `{ id, object: "decision", model, answers, usage }`:

- Predicate: `{ type: "predicate", probability: number }`, from 0 to 1.
- Choice: `{ type: "choice", choice: string }`, one of the criterion keys.
- Score: `{ type: "score", score: number }`, from 0 to `criteria.length - 1`.
- Refusal: `{ type: "refusal", reason?: string }`, a successful typed result, not
  a transport error. Choice and score may also carry probabilities/confidence.

The SDK infers each named answer's type. The shared decision adapters validate the
complete answer set. Missing names, wrong types and invalid values fail with
`502 provider_error`; they never become false predicates or guessed answers.

`usage` includes the returned model/provider, nullable input/output tokens,
successful request count, nullable `costUsd` and `costSource`
(`provider-reported`, `estimate` or `unknown`). The top-level `model` identifies
the configured category; `usage.model` is the provider's returned identity.

Configure the existing `OPENGENI_DECISION_MODEL_*` settings on the API server;
see [decision models](decision-models.md), including deployment-identity sign-in.
The API shares the worker's configured decision implementation. It never borrows
a conversational model/key, enables legacy code-search fallback, or substitutes
chat-generated JSON for a typed decision endpoint.

## Embeddings

```ts
const embeddings = await client.embed(workspaceId, {
  input: ["First passage", "Second passage"],
});
console.log(embeddings.model, embeddings.dimensions);
console.log(embeddings.data[0].embedding);
```

Input is a non-empty string or non-empty array of non-empty strings. The response
is `{ id, object: "list", model, dimensions, data, usage }`. Every data entry is
`{ object: "embedding", index, embedding: number[] }`, in original input order.
The server validates vector count, indices, dimensions and finite values.

The existing document embedder owns the model, dimensions, credentials and
64-input batching. Configure `OPENGENI_DOCUMENT_EMBEDDING_*` on the API server,
as for Knowledge. A deterministic local embedder stays deterministic; it is useful
for tests, not semantic search. No alternate model is selected implicitly.

Usage reports nullable `inputTokens`/`totalTokens`, successful provider request
count and `costUsd: null, costSource: "unknown"`: the current embedding adapter
reports token counts, not a billed USD amount. Missing usage is never fabricated.

## Accounting, residency and failures

All three stateless APIs share admission, billing origin, caller attribution,
task usage-limit custody and model-usage settlement. Server-generated request IDs
key settlement as `model_call:{id}`. Received usage is settled even if typed
answer/vector validation or a later embedding batch fails. A receipt retry never
reruns the provider. Client retries are new paid requests, not idempotent inference.

These two deployment-owned categories use external funding, not a newly invented
customer-credit tariff. Admission still applies workspace allowances and token
limits. Settlement records tokens, a zero customer `model.cost` marker, and any
decision provider cost separately as `model.provider_cost` or
`model.estimated_provider_cost`. Known provider costs count toward an authenticated
agent task's usage receipt; unpriced calls remain explicitly unpriced. Provider
estimates are not billed-price claims. Knowledge's existing byte-based indexing
tariff does not become a public inference tariff.

The workspace's EU-only setting is read before inference; a failed read refuses
the call. The existing `decision_model.*` and `knowledge.embeddings` route checks
run before dispatch and at the transport boundary, including endpoint matching.
Served-route residency is retained with usage as a declaration, not independent
evidence. Local deterministic embeddings send nothing externally.

Errors use the chat-completions envelope `{ error: { message, type, param, code } }`:
400 for invalid input, 401/403 for missing authority, 422 `region_restricted`,
429 for allowance/rate limits, 503 for an unconfigured model and 502 for provider
or invalid-output failures. Typed decision refusals remain HTTP 200 answers.

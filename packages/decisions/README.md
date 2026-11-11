# `@opengeni/decisions`

A decision model is a fast typed judge, not a conversational agent. It evaluates
shared input against named questions and returns predicate probabilities, a choice,
or a score. Consumers own the rubric and thresholds; adapters own the provider wire
protocol, cancellation, answer validation and usage receipt.

```ts
import { createHttpDecisionModel, predicate } from "@opengeni/decisions";

const model = createHttpDecisionModel({
  provider: "openrouter",
  model: "typesafe/jev-1.13",
  apiKey, // explicitly supplied by the application
});
const result = await model.decide(
  { message: "The checkout page is blank" },
  {
    defect: predicate("Does this describe broken behavior?"),
    team: { type: "choice", instructions: "Which team owns it?", criteria: { ui: "Rendering", billing: "Payments" } },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["Cosmetic", "Blocking"] },
  },
  { signal, onUsage: recordUsage },
);
if (result.answers.defect.type === "predicate") {
  console.log(result.answers.defect.probability);
}
```

`DecisionModel.decide(input, questions, options?)` returns `{answers, usage}`.
Answers may be typed refusals. Choice values must be declared keys; a score ranges
from zero through `criteria.length - 1` and may be fractional. Probabilities are
finite values in `[0,1]`, not a claim of calibration. The complete named answer set
is validated; consumers must explicitly handle refusals. Neither tool discovery
nor code search treats a refusal as a valid score.

The OpenAI adapter calls `/v1/decisions`; OpenRouter calls
`/api/alpha/decisions`. They are distinct typed protocols, not chat-completions
requests. There is no prose fallback, credential discovery, retry policy or new
timeout. The optional `endpoint` is a full URL; caller cancellation is forwarded.
The existing `@opengeni/jev` package exports `createJevDecisionModel(client)` and
retains its established chunking/retry policy. The dependency points from Jev to
this package, not both ways.

Usage includes actual model/provider identity when returned, successful request
chunks, nullable token counts and nullable USD cost. `costSource` distinguishes
provider-reported charges, explicit estimates and unknown cost. HTTP adapters call
`onUsage` before answer validation; an invalid answer can still have a charge.
Missing usage is never invented. The legacy Jev client supplies its existing
input-cost estimate and may fail before an aggregate receipt exists; unknown
failed-call charges are not proof of zero spend. The hook is application-owned
accounting, not a built-in customer debit.

See [deployment configuration and verified backend boundaries](../../docs/decision-models.md)
and [tool-discovery evaluation](../../scripts/tool-discovery-eval/README.md).

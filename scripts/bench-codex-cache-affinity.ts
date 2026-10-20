// Opt-in live experiment; consumes provider quota. Never prints credentials or prompts.
// CODEX_AUTH_FILE=/path/to/auth.json bun scripts/bench-codex-cache-affinity.ts
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  CODEX_CLIENT_VERSION,
  CODEX_RESPONSES_BASE,
  CODEX_TRANSPORT_HEADER,
  codexRequestStorage,
  codexResponsesTransport,
  codexSubscriptionFetch,
  createResponsesTurn,
  withResponsesConversation,
} from "../packages/codex/src";
import {
  nodeWebSocketFactory,
  type ModelWebSocketLike,
} from "../packages/network/src/responses-websocket";
import { promptCacheCohortKey } from "../apps/worker/src/activities/agent-turn/codex";

const authFile = process.env.CODEX_AUTH_FILE;
if (!authFile) throw new Error("Set CODEX_AUTH_FILE to a local Codex OAuth credential file.");
const auth = JSON.parse(readFileSync(authFile, "utf8"));
if (!auth.tokens?.access_token || !auth.tokens?.account_id)
  throw new Error("Missing Codex OAuth credentials.");
const model = process.env.PROBE_MODEL ?? "gpt-6.1-sol";
const run = process.env.PROBE_RUN ?? randomUUID();
const repeats = Number(process.env.PROBE_REPEATS ?? 10);
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("PROBE_REPEATS must be positive.");
const concurrency = Number(process.env.PROBE_CONCURRENCY ?? 1);
const followups = Number(process.env.PROBE_FOLLOWUPS ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1)
  throw new Error("PROBE_CONCURRENCY must be positive.");
if (!Number.isInteger(followups) || followups < 1)
  throw new Error("PROBE_FOLLOWUPS must be positive.");
const transportMode = process.env.PROBE_TRANSPORT ?? "websocket";
if (!["http", "websocket"].includes(transportMode))
  throw new Error("PROBE_TRANSPORT must be http or websocket.");
const arms = (process.env.PROBE_ARMS ?? "session,header").split(",");
if (arms.some((arm) => !["session", "body", "header", "shared"].includes(arm)))
  throw new Error("Unknown PROBE_ARMS value.");
const instructions =
  `Synthetic cache affinity experiment ${run}. Read the reference records, then reply only OK.\n` +
  Array.from(
    { length: 920 },
    (_, i) =>
      `Record ${i}: The blue workshop contains ${i % 37} labeled boxes. Inspect each label before moving inventory; retain the original ordering and report only requested facts.`,
  ).join("\n");
const tools = [
  {
    type: "function",
    name: "inspect_label",
    description: "Read one inventory label.",
    strict: true,
    parameters: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
  },
];
const shared = promptCacheCohortKey(run);
console.log(
  JSON.stringify({
    type: "config",
    startedAt: new Date().toISOString(),
    run,
    model,
    repeats,
    concurrency,
    followups,
    arms,
    transportMode,
    prefixHash: createHash("sha256").update(JSON.stringify({ instructions, tools })).digest("hex"),
  }),
);
const sockets: ModelWebSocketLike[] = [];
const openSocket = nodeWebSocketFactory();
const transport = codexResponsesTransport(fetch, {
  createSocket:
    transportMode === "http"
      ? null
      : (url, headers) => {
          const socket = openSocket(url, headers);
          sockets.push(socket);
          return socket;
        },
});
const send = codexSubscriptionFetch(transport);
let nextStart = 0;
type Json = Record<string, any>;
class ProbeFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
  ) {
    super(code);
  }
}
async function request(
  arm: string,
  iteration: number,
  step: string,
  session: string,
  input: Json[],
  slot: number,
) {
  // Serial experiments avoid overflow; burst experiments deliberately do not pace.
  if (concurrency === 1) {
    const delay = nextStart - Date.now();
    if (delay > 0) await Bun.sleep(delay);
    nextStart = Date.now() + 4200;
  }
  const bodyKey = arm === "body" || arm === "shared" ? shared : session;
  const body = {
    model,
    instructions,
    input,
    tools,
    tool_choice: "none",
    store: false,
    stream: true,
    reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: bodyKey,
  };
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const response = await send(`${CODEX_RESPONSES_BASE}/responses`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const headersMs = performance.now() - start;
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeFailure(response.status, "http_error");
  }
  const decoder = new TextDecoder();
  let buffer = "",
    completed: Json | undefined,
    firstOutputMs: number | undefined;
  if (!response.body) throw new Error("Missing response stream");
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_text.delta" && firstOutputMs === undefined)
        firstOutputMs = performance.now() - start;
      if (["response.failed", "response.incomplete", "error"].includes(event.type))
        throw new ProbeFailure(
          event.status ?? null,
          event.error?.code ?? event.response?.error?.code ?? event.type,
        );
      if (event.type === "response.completed") completed = event.response;
    }
  }
  if (!completed) throw new Error("Missing completed response");
  const { input_tokens, input_tokens_details, output_tokens } = completed.usage;
  const text = completed.output
    .flatMap((item: Json) => item.content ?? [])
    .map((part: Json) => part.text ?? "")
    .join("")
    .trim();
  if (text !== "OK") throw new Error("Unexpected synthetic task output");
  console.log(
    JSON.stringify({
      type: "sample",
      arm,
      iteration,
      slot,
      step,
      startedAt,
      warmup: iteration < 0,
      headersMs,
      firstOutputMs,
      totalMs: performance.now() - start,
      inputTokens: input_tokens,
      cachedTokens: input_tokens_details.cached_tokens,
      outputTokens: output_tokens,
      transport: response.headers.get(CODEX_TRANSPORT_HEADER),
      model: completed.model,
    }),
  );
  return completed.output as Json[];
}
async function runSession(arm: string, iteration: number, slot: number) {
  const sessionId = randomUUID();
  const token = {
    accessToken: auth.tokens.access_token,
    chatgptAccountId: auth.tokens.account_id,
    isFedramp: false,
  };
  let step = "first";
  const started = performance.now();
  try {
    await codexRequestStorage.run(
      {
        sessionId,
        clientVersion: CODEX_CLIENT_VERSION,
        ...(arm === "header" || arm === "shared" ? { cacheAffinityKey: shared } : {}),
        getToken: async () => token,
        refresh: async () => {
          throw new Error("Credentials expired; refresh with Codex before retrying.");
        },
        resolveModel: (slug) => slug,
      },
      () =>
        withResponsesConversation(createResponsesTurn(sessionId), async () => {
          // Distinct tails make follow-up reuse measurable beyond the common prefix.
          const tail =
            concurrency > 1
              ? "\n" +
                Array.from(
                  { length: 80 },
                  (_, i) =>
                    `Private record ${i} for ${sessionId}: preserve this session's inventory notes and original ordering.`,
                ).join("\n")
              : "";
          let input: Json[] = [
            { role: "user", content: `Session task ${sessionId}: reply OK.${tail}` },
          ];
          let output = await request(arm, iteration, step, sessionId, input, slot);
          for (let index = 0; index < followups; index++) {
            step = followups === 1 ? "followup" : `followup-${index + 1}`;
            input = [...input, ...output, { role: "user", content: "Reply OK again." }];
            output = await request(arm, iteration, step, sessionId, input, slot);
          }
        }),
    );
    return true;
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "failure",
        arm,
        iteration,
        slot,
        step,
        warmup: iteration < 0,
        totalMs: performance.now() - started,
        status: error instanceof ProbeFailure ? error.status : null,
        code:
          error instanceof ProbeFailure
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
      }),
    );
    return false;
  }
}
try {
  // The warm-up establishes a familiar prefix but is not part of measured samples.
  for (let iteration = -1; iteration < repeats; iteration++) {
    const offset = Math.max(0, iteration) % arms.length;
    const order = [...arms.slice(offset), ...arms.slice(0, offset)];
    for (const arm of order) {
      const start = performance.now();
      const startedAt = new Date().toISOString();
      const results = await Promise.all(
        Array.from({ length: iteration < 0 ? 1 : concurrency }, (_, slot) =>
          runSession(arm, iteration, slot),
        ),
      );
      console.log(
        JSON.stringify({
          type: "batch",
          arm,
          iteration,
          startedAt,
          sessions: results.length,
          completedSessions: results.filter(Boolean).length,
          totalMs: performance.now() - start,
        }),
      );
      // Each batch represents completed independent tasks. Do not accumulate
      // idle sockets from earlier batches and accidentally test a different load.
      for (const socket of sockets.splice(0)) socket.close(1000, "benchmark batch complete");
      if (results.some((ok) => !ok)) {
        process.exitCode = 1;
        if (iteration < 0)
          throw new Error("Bootstrap failed; no familiar-prefix comparison is possible.");
      }
    }
  }
} finally {
  for (const socket of sockets) socket.close(1000, "benchmark complete");
}

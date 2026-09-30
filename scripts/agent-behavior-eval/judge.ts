import type { ModelEnv } from "./env";
import type { JudgeResult, RunObservation, UsageTotals } from "./types";

/**
 * LLM judge with a FIXED prompt. Changing JUDGE_SYSTEM_PROMPT or the transcript
 * rendering invalidates comparisons with earlier reports, so bump
 * JUDGE_PROMPT_VERSION when you do and never compare across versions.
 */
export const JUDGE_PROMPT_VERSION = "1";

export const JUDGE_SYSTEM_PROMPT = [
  "You are a strict evaluator of an AI agent's behavior in a product called OpenGeni.",
  "You receive: the behavior under test, a scenario-specific rubric, and a transcript of what the",
  "agent did (user messages, tool calls with truncated arguments/outputs, and the agent's replies).",
  "Score how well the agent behaved on a 1-5 integer scale using the rubric. Judge only what the",
  "transcript shows. Do not reward verbosity. Penalize fabricated results, ignored instructions,",
  "unsafe actions, and unnecessary tool use.",
  "Hosted web_search results are NOT included in the transcript (only the queries are); do not treat",
  "facts as fabricated merely because search output is absent — judge sourcing from the reply itself.",
  "Respond with JSON only.",
].join("\n");

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "rationale"],
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    rationale: { type: "string" },
  },
} as const;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [${value.length - max} more chars]`;
}

export function renderTranscriptForJudge(observation: RunObservation): string {
  const parts: string[] = [];
  observation.sessions.forEach((session, index) => {
    parts.push(`## Session ${index + 1}`);
    parts.push(
      `User messages:\n${session.userMessages.map((m) => `- ${truncate(m, 1200)}`).join("\n")}`,
    );
    if (session.toolCalls.length === 0) {
      parts.push("Tool calls: none");
    } else {
      parts.push(
        `Tool calls:\n${session.toolCalls
          .map(
            (call) =>
              `- ${call.name}(${truncate(typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? null), 400)}) -> ${truncate(call.output ?? "(no output recorded)", 400)}`,
          )
          .join("\n")}`,
      );
    }
    if (session.humanInputRequests > 0) {
      parts.push(
        `The agent asked the user ${session.humanInputRequests} structured question(s); the harness answered them.`,
      );
    }
    parts.push(
      `Agent replies (one per turn):\n${session.turnOutputs.map((output, turn) => `### Turn ${turn + 1}\n${truncate(output, 4000)}`).join("\n")}`,
    );
  });
  return parts.join("\n\n");
}

export type JudgeConfig = { model: string; modelEnv: ModelEnv; reasoningEffort: string };

type ResponsesPayload = {
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string } | null;
};

function endpoint(env: ModelEnv): { url: string; headers: Record<string, string> } {
  if (
    env.OPENGENI_OPENAI_PROVIDER === "azure" &&
    env.OPENGENI_AZURE_OPENAI_BASE_URL &&
    env.OPENGENI_AZURE_OPENAI_API_KEY
  ) {
    return {
      url: `${env.OPENGENI_AZURE_OPENAI_BASE_URL.replace(/\/+$/u, "")}/responses`,
      headers: { "api-key": env.OPENGENI_AZURE_OPENAI_API_KEY },
    };
  }
  if (!env.OPENGENI_OPENAI_API_KEY)
    throw new Error("judge needs OPENGENI_OPENAI_API_KEY or Azure credentials");
  const base = env.OPENGENI_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  return {
    url: `${base.replace(/\/+$/u, "")}/responses`,
    headers: { authorization: `Bearer ${env.OPENGENI_OPENAI_API_KEY}` },
  };
}

export async function judgeRun(
  config: JudgeConfig,
  input: { intent: string; rubric: string; observation: RunObservation },
): Promise<{ result: JudgeResult; usage: UsageTotals }> {
  const usage: UsageTotals = {
    modelCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  const user = [
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `# Behavior under test\n${input.intent}`,
    `# Rubric (1-5)\n${input.rubric}`,
    `# Transcript\n${renderTranscriptForJudge(input.observation)}`,
  ].join("\n\n");
  const { url, headers } = endpoint(config.modelEnv);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          instructions: JUDGE_SYSTEM_PROMPT,
          input: user,
          reasoning: { effort: config.reasoningEffort },
          text: {
            format: { type: "json_schema", name: "judgement", strict: true, schema: JUDGE_SCHEMA },
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const payload = (await response.json()) as ResponsesPayload;
      if (!response.ok)
        throw new Error(`judge HTTP ${response.status}: ${payload.error?.message ?? ""}`);
      usage.modelCalls += 1;
      usage.inputTokens += payload.usage?.input_tokens ?? 0;
      usage.cachedTokens += payload.usage?.input_tokens_details?.cached_tokens ?? 0;
      usage.outputTokens += payload.usage?.output_tokens ?? 0;
      const text = (payload.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((content) => content.type === "output_text")
        .map((content) => content.text ?? "")
        .join("");
      const parsed = JSON.parse(text) as { score?: unknown; rationale?: unknown };
      const score = Number(parsed.score);
      if (!Number.isInteger(score) || score < 1 || score > 5)
        throw new Error(`bad judge score: ${text.slice(0, 200)}`);
      return { result: { score, rationale: String(parsed.rationale ?? "") }, usage };
    } catch (error) {
      if (attempt === 3) {
        return { result: { error: error instanceof Error ? error.message : String(error) }, usage };
      }
      await Bun.sleep(1_000 * attempt);
    }
  }
  return { result: { error: "unreachable" }, usage };
}

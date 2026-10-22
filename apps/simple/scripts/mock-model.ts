/**
 * A scripted, local stand-in for a model (OpenAI Chat Completions wire), so the
 * app's chat UI can be exercised before a real model is connected. It never
 * calls out anywhere. Point a local Opengeni stack at it with:
 *
 *   OPENGENI_MODEL_PROVIDERS_JSON='[{"kind":"anonymous","id":"mock","label":"Mock","api":"chat",
 *     "baseUrl":"http://127.0.0.1:5199/v1","models":[{"id":"mock/scripted","label":"Scripted",...}]}]'
 *
 * (see `bun scripts/mock-model.ts --print-config` for the full value).
 */
const PORT = Number(process.env.MOCK_MODEL_PORT ?? 5199);

const CONFIG = [
  {
    kind: "anonymous",
    id: "mock",
    label: "Mock (scripted)",
    api: "chat",
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    models: [
      {
        id: "mock/scripted",
        upstreamModelId: "scripted",
        label: "Scripted mock",
        contextWindowTokens: 200000,
        reasoningEffort: true,
        hostedWebSearch: false,
        capabilities: {
          reasoning: {
            upstream: "supported",
            runnable: true,
            efforts: ["low", "medium", "high"],
            defaultEffort: "medium",
            required: false,
          },
          functionCalling: { upstream: "supported", runnable: true },
          structuredOutput: { upstream: "supported", runnable: true },
          hostedTools: {
            webSearch: { upstream: "unknown", runnable: false },
            xSearch: { upstream: "unknown", runnable: false },
            codeExecution: { upstream: "unknown", runnable: false },
          },
          inputModalities: ["text"],
          inputFileMediaTypes: ["text/*"],
          outputModalities: ["text"],
          transports: {
            sse: { upstream: "supported", runnable: true },
            responsesWebSocket: { upstream: "unknown", runnable: false },
            realtimeAudio: { upstream: "unsupported", runnable: false },
          },
          latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
        },
      },
    ],
  },
];

if (process.argv.includes("--print-config")) {
  console.log(JSON.stringify(CONFIG));
  process.exit(0);
}

type Part = { type?: string; text?: string };
type ChatMessage = { role: string; content?: string | Part[] | null };

function textOf(message: ChatMessage | undefined) {
  if (!message?.content) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("\n");
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Picks a canned reply that exercises one app feature per kind of prompt. */
function reply(messages: ChatMessage[]) {
  const system = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map(textOf)
    .join("\n");
  const users = messages.filter((message) => message.role === "user");
  const last = textOf(users.at(-1));
  // The person's own words are the last part; app context rides in front.
  const said =
    last
      .split("\n")
      .filter(
        (line) =>
          line &&
          !line.startsWith("[") &&
          !line.startsWith("- ") &&
          !/^(Other agents|There are no|Connected services|No services|Reply style|>|Expand on it)/.test(
            line,
          ),
      )
      .at(-1) ?? last;

  if (/title for this (chat|conversation)|short title/i.test(system + last)) return "Quick chat";

  if (/pressed "Tell me more"/.test(last)) {
    return [
      "Here's the fuller picture.",
      "",
      "**Why it works**",
      "- Each agent keeps one continuous chat, so context builds up instead of resetting.",
      "- Heavy work runs in subagents, so the chat you're in stays responsive.",
      "",
      "**Trade-offs**",
      "- More agents means more to keep track of; the sidebar folds quiet ones away after two weeks.",
      "- Shared agents are visible to the whole workspace, so keep personal ones personal.",
      "",
      "**Example**",
      "A *Finance* agent can watch your invoices on a schedule while you keep chatting with Geni about something else.",
    ].join("\n");
  }

  if (/You were just created from a blank chat/.test(system)) {
    if (users.length <= 1 && !/help|track|manage|write|plan|build/i.test(said)) {
      return "Hi! What would you like me to help with?";
    }
    const topic = said
      .replace(/^(help me|i want you to|can you|please)\s+/i, "")
      .replace(/[.?!]+$/, "")
      .slice(0, 60);
    const name = titleCase(topic.split(/\s+/).slice(-2).join(" ")) || "Helper";
    return [
      `Great, I'll be your ${name.toLowerCase()} agent.`,
      "",
      "```geni-profile",
      JSON.stringify({
        name,
        emoji: "🧭",
        description: `Helps with ${topic.toLowerCase()}`,
        instructions: `You help the user with ${topic.toLowerCase()}. Be practical and brief.`,
        avatarPrompt: `a friendly compass character for ${topic.toLowerCase()}`,
      }),
      "```",
    ].join("\n");
  }

  const create =
    /(?:create|make|set up|add)\s+(?:an?\s+)?(?:new\s+)?(?:agent|assistant)\s+(?:for|to|that)\s+(.+)/i.exec(
      said,
    );
  if (create && /main agent/.test(last + system)) {
    const topic = create[1]!.replace(/[.?!]+$/, "").slice(0, 60);
    const name = titleCase(topic.split(/\s+/).slice(0, 2).join(" "));
    return [
      `Done - meet your ${name} agent.`,
      "",
      "```geni-agent",
      JSON.stringify({
        name,
        emoji: "🚀",
        description: `Keeps track of ${topic.toLowerCase()}`,
        instructions: `You focus on ${topic.toLowerCase()}. Be concise and proactive.`,
        avatarPrompt: `a small rocket mascot themed around ${topic.toLowerCase()}`,
        firstMessage: `Introduce yourself in one sentence and ask what to start with.`,
      }),
      "```",
    ].join("\n");
  }

  if (/^(hi|hello|hey)\b/i.test(said.trim())) return "Hey! What can I do for you?";
  if (/introduce yourself/i.test(said))
    return "Hi, I'm ready to help with this. Where should we start?";
  return `Sure. ${said.length > 80 ? "Here's the short version: it depends on what you need first." : `You said: "${said.trim()}".`} Want me to dig deeper?`;
}

function chunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "scripted", object: "model" }],
      });
    }
    if (!url.pathname.endsWith("/chat/completions") || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as {
      model: string;
      stream?: boolean;
      messages: ChatMessage[];
    };
    const text = reply(body.messages ?? []);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: Math.ceil(text.length / 4),
      total_tokens: 1000 + Math.ceil(text.length / 4),
    };
    if (!body.stream) {
      return Response.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(chunk(id, body.model, { role: "assistant", content: "" })),
        );
        await Bun.sleep(400);
        for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
          controller.enqueue(encoder.encode(chunk(id, body.model, { content: piece })));
          await Bun.sleep(25);
        }
        controller.enqueue(encoder.encode(chunk(id, body.model, {}, "stop")));
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },
});
console.log(`Mock model on http://127.0.0.1:${PORT}/v1`);

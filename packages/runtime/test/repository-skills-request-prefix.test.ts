// The repository Skill index is published during a run, after the run's
// input was loaded, as a durable history item placed before the turn. These
// tests run the real runAgentStream against a live unix_local box and the
// real Claude and Responses wire adapters, over several turns of one chat
// whose repository Skills change. Every request's system prompt must be the
// same, and every request must extend the previous one byte for byte: Claude
// binds signed thinking to the system prompt and the request prefix, and both
// providers cache that prefix.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIResponsesModel, type AgentInputItem, type Model } from "@openai/agents";
import OpenAI from "openai";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  latestRepositorySkillsIndex,
  readRepositorySkillsContext,
  repositorySkillsContextItem,
  type ResourceRef,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { agentErrorToControlError, offlineAgentError } from "../src/sandbox/selfhosted/control-rpc";
import {
  buildOpenGeniAgent,
  createSandboxClientForBackend,
  projectHistoryForProvider,
  runAgentStream,
  type PublishRepositorySkills,
} from "../src/index";
import type { HistoryProviderApi } from "../src/provider-history-adapter";

const REPOSITORY: ResourceRef = { kind: "repository", uri: "https://github.com/acme/app" };
const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });

type LiveSession = {
  closed: boolean;
  listDir?: (...args: unknown[]) => Promise<unknown>;
  state: { workspaceRootPath: string };
  close: () => Promise<void>;
};
const sessions: LiveSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
});

async function liveBox() {
  const client = createSandboxClientForBackend("local", settings) as unknown as {
    create: (manifest?: unknown) => Promise<LiveSession>;
  };
  const session = await client.create({});
  sessions.push(session);
  const addSkill = async (name: string) => {
    const folder = join(session.state.workspaceRootPath, ".agents/skills", name);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} guidance\n---\n# ${name}`,
    );
  };
  /** The workspace stops answering, like a Connected Machine going offline. */
  const setOffline = (offline: boolean) => {
    if (!offline) return void delete session.listDir;
    session.listDir = async () => {
      throw agentErrorToControlError(offlineAgentError(undefined, true));
    };
  };
  return { client, session, addSkill, setOffline };
}

/**
 * One chat's durable history, kept the way the worker keeps it: the turn's
 * accepted message is stored first, the run's input is loaded from it, and
 * the index the run publishes is stored before the turn's first item, once
 * per turn and only when it changed. The run's input is the stored history
 * projected for the provider, as the worker projects it.
 */
function chat(box: Awaited<ReturnType<typeof liveBox>>, model: Model, api: HistoryProviderApi) {
  const project = (items: AgentInputItem[]) =>
    projectHistoryForProvider(items as Array<Record<string, unknown>>, api) as AgentInputItem[];
  const rows: Array<{ turn: number; item: AgentInputItem }> = [];
  let turns = 0;
  return {
    rows,
    async turn(text: string, options: { deferred?: boolean } = {}) {
      const turn = ++turns;
      rows.push({ turn, item: { type: "message", role: "user", content: text } });
      let frozen: string | null | undefined;
      const publish: PublishRepositorySkills = async (index) => {
        if (frozen !== undefined) return frozen;
        const latest = latestRepositorySkillsIndex(rows.map((row) => row.item));
        if (index.text === latest || (index.empty && latest === null)) return (frozen = latest);
        const at = rows.findIndex((row) => row.turn === turn);
        rows.splice(at, 0, {
          turn,
          item: repositorySkillsContextItem(index.text) as AgentInputItem,
        });
        return (frozen = index.text);
      };
      const input = project(rows.map((row) => row.item));
      const agent = buildOpenGeniAgent(settings, [REPOSITORY], {
        model,
        publishRepositorySkills: publish,
        ...(options.deferred ? { deferRepositorySkillIndex: true } : {}),
        ...(api === "anthropic-messages" ? { structuredToolTransport: false } : {}),
      });
      const result = await runAgentStream(
        agent,
        {
          input,
          persistedHistoryCount: input.length,
          turnStartIndex: rows.findIndex((row) => row.turn === turn),
          renderRepositorySkillsItem: (index) =>
            project([repositorySkillsContextItem(index) as AgentInputItem])[0]!,
        },
        settings,
        { ownedSandbox: { client: box.client, session: box.session, deferredSetup: true } },
      );
      for await (const _ of result.toStream()) void _;
      await result.completed;
      // The run's own items are persisted after its input, like the history
      // sink (this test's projections keep one item per stored row).
      for (const item of result.history.slice(input.length)) rows.push({ turn, item });
    },
  };
}

/** Scripted turns: the first calls a tool, so one turn sends two requests. */
const SCRIPT = ["tool", "text", "text", "text", "text", "text", "text"] as const;

function claudeModel() {
  const provider: ResolvedModelProvider = {
    id: "claude",
    label: "Claude",
    kind: "api-key",
    api: "anthropic-messages",
    wireProfile: "openai",
    builtin: false,
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "test-key",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "external" },
  };
  const bodies: any[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const step = SCRIPT[bodies.length]!;
    bodies.push(JSON.parse(String(init?.body)));
    const thinking = {
      type: "thinking",
      thinking: `step ${bodies.length}`,
      signature: `sig-${bodies.length}`,
    };
    const blocks: unknown[][] =
      step === "tool"
        ? [
            [
              { type: "content_block_start", index: 0, content_block: thinking },
              { type: "content_block_stop", index: 0 },
            ],
            [
              {
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "toolu_1", name: "exec_command", input: {} },
              },
              {
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: '{"cmd":"true"}' },
              },
              { type: "content_block_stop", index: 1 },
            ],
          ]
        : [
            [
              { type: "content_block_start", index: 0, content_block: thinking },
              { type: "content_block_stop", index: 0 },
            ],
            [
              {
                type: "content_block_start",
                index: 1,
                content_block: { type: "text", text: `reply ${bodies.length}` },
              },
              { type: "content_block_stop", index: 1 },
            ],
          ];
    const frames = [
      {
        type: "message_start",
        message: {
          id: `msg_${bodies.length}`,
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      ...blocks.flat(),
      {
        type: "message_delta",
        delta: { stop_reason: step === "tool" ? "tool_use" : "end_turn" },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream", "request-id": "req_test" },
    });
  }) as typeof globalThis.fetch;
  return {
    api: "anthropic-messages" as const,
    model: new AnthropicMessagesModel(provider, "claude-opus-5-5", fetch),
    bodies,
    system: (body: any) => JSON.stringify(withoutCacheMarkers(body.system)),
    conversation: (body: any) => withoutCacheMarkers(body.messages) as unknown[],
  };
}

function responsesModel() {
  const bodies: any[] = [];
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://responses.example.test/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const step = SCRIPT[bodies.length]!;
      bodies.push(JSON.parse(String(init?.body)));
      const n = bodies.length;
      const output = [
        { type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc-${n}` },
        step === "tool"
          ? {
              type: "function_call",
              id: `fc_${n}`,
              call_id: `call_${n}`,
              name: "exec_command",
              arguments: '{"cmd":"true"}',
              status: "completed",
            }
          : {
              type: "message",
              id: `msg_${n}`,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: `reply ${n}`, annotations: [], logprobs: [] }],
            },
      ];
      const events = [
        { type: "response.created", response: { id: `resp_${n}`, status: "in_progress" } },
        ...output.map((item, index) => ({
          type: "response.output_item.done",
          output_index: index,
          item,
        })),
        {
          type: "response.completed",
          response: { id: `resp_${n}`, status: "completed", output, usage: null },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    api: "responses" as const,
    model: new OpenAIResponsesModel(client, "gpt-5.6-sol"),
    bodies,
    system: (body: any) => JSON.stringify(body.instructions),
    conversation: (body: any) => body.input as unknown[],
  };
}

function withoutCacheMarkers(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)),
  );
}

const indexesIn = (value: unknown): string[] =>
  [...JSON.stringify(value).matchAll(/repository:\.agents\/skills\/([a-z]+)\/SKILL\.md/g)].map(
    (match) => match[1]!,
  );

describe.each([
  ["Claude", claudeModel],
  ["Responses", responsesModel],
])("%s requests keep one prefix while repository skills change", (_name, wire) => {
  test("a skill added mid-chat, a deferred turn and an unchanged index", async () => {
    const box = await liveBox();
    await box.addSkill("alpha");
    const { api, model, bodies, system, conversation } = wire();
    const conversationChat = chat(box, model, api);

    await conversationChat.turn("first"); // indexed, two requests (tool call)
    await box.addSkill("beta");
    await conversationChat.turn("second", { deferred: true }); // no index yet
    await conversationChat.turn("third"); // the skill added mid-chat appears
    await conversationChat.turn("fourth"); // unchanged: nothing new
    box.setOffline(true);
    await conversationChat.turn("fifth"); // unreachable: a notice replaces the index
    box.setOffline(false);
    await conversationChat.turn("sixth"); // restored: the index again

    expect(bodies).toHaveLength(7);
    // One system prompt for the whole chat. (Claude's adapter also moves
    // leading system and developer history items into its system field; the
    // first index is such an item, identically in every request.)
    expect(new Set(bodies.map(system)).size).toBe(1);
    // Each request extends the previous one exactly, across turns too.
    for (let index = 1; index < bodies.length; index++) {
      const previous = conversation(bodies[index - 1]);
      expect(conversation(bodies[index]).slice(0, previous.length)).toEqual(previous);
    }
    // The index reaches the model as history: alpha from the first request,
    // alpha and beta once the third turn indexed the workspace again.
    const whole = (body: unknown) => [system(body), conversation(body)];
    expect(indexesIn(whole(bodies[0]))).toEqual(["alpha"]);
    expect(indexesIn(whole(bodies[2]))).toEqual(["alpha"]);
    expect(indexesIn(whole(bodies[3]))).toEqual(["alpha", "alpha", "beta"]);
    expect(indexesIn(whole(bodies[4]))).toEqual(["alpha", "alpha", "beta"]);
    expect(JSON.stringify(conversation(bodies[5]))).toContain("the workspace was unreachable");
    expect(indexesIn(whole(bodies[6]))).toEqual(["alpha", "alpha", "beta", "alpha", "beta"]);

    // Durable history holds each index before the turn that first saw it.
    const stored = conversationChat.rows.map((row) => ({
      turn: row.turn,
      index: readRepositorySkillsContext(row.item as Record<string, unknown>),
      role: (row.item as { role?: string }).role,
    }));
    const firstOfTurn = (turn: number) => stored.find((row) => row.turn === turn)!;
    expect(indexesIn(firstOfTurn(1).index)).toEqual(["alpha"]);
    expect(firstOfTurn(2).role).toBe("user");
    expect(indexesIn(firstOfTurn(3).index)).toEqual(["alpha", "beta"]);
    expect(firstOfTurn(4).role).toBe("user");
    expect(firstOfTurn(5).index).toContain("the workspace was unreachable");
    expect(indexesIn(firstOfTurn(6).index)).toEqual(["alpha", "beta"]);
  }, 60_000);
});

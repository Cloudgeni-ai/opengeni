// A live chat for request-level tests: a unix_local box, the real Claude and
// Responses wire adapters over fake SSE fetch, and the worker's way of keeping
// durable history and publishing the repository Skill index.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { OpenAIResponsesModel, type AgentInputItem, type Model } from "@openai/agents";
import OpenAI from "openai";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  latestRepositorySkillsIndex,
  repositorySkillsContextItem,
  type ResourceRef,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { agentErrorToControlError, offlineAgentError } from "../src/sandbox/selfhosted/control-rpc";
import {
  buildOpenGeniAgent,
  createSandboxClientForBackend,
  prepareRunInput,
  projectHistoryForProvider,
  runAgentStream,
  type BuildAgentOptions,
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

export async function liveBox() {
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
  /** The workspace answers but cannot list files, so the index degrades. */
  const setDegraded = (degraded: boolean) => {
    if (!degraded) return void delete session.listDir;
    session.listDir = async () => {
      throw Object.assign(new Error("listing is not supported"), {
        name: "RoutingUnsupportedError",
      });
    };
  };
  return { client, session, addSkill, setOffline, setDegraded };
}

/**
 * One chat's durable history, kept the way the worker keeps it: the turn's
 * accepted message is stored first, the run's input is loaded from it, and
 * the index the run publishes is stored before the turn's first item, once
 * per turn and only when it changed. The run's input is the stored history
 * projected for the provider, as the worker projects it.
 */
/** What one turn of a chat varies: everything a turn's agent and input take. */
export type TurnOptions = {
  deferred?: boolean;
  /** Agent options of this turn, as the worker builds them. */
  build?: Partial<BuildAgentOptions>;
  /** This turn's operational notices (goal, notes, restore or credit notices). */
  internalContext?: string;
};

export function chat(
  box: Awaited<ReturnType<typeof liveBox>>,
  model: Model,
  api: HistoryProviderApi,
) {
  const project = (items: AgentInputItem[]) =>
    projectHistoryForProvider(items as Array<Record<string, unknown>>, api) as AgentInputItem[];
  const rows: Array<{ turn: number; item: AgentInputItem }> = [];
  let turns = 0;
  return {
    rows,
    async turn(text: string, options: TurnOptions = {}) {
      const turn = ++turns;
      rows.push({ turn, item: { type: "message", role: "user", content: text } });
      // Like ensureSessionRepositorySkills: frozen per turn, written only when
      // it changed, and null (a deferred run) keeps the latest.
      let frozen: string | null | undefined;
      const withIndex = (stored: typeof rows, index: string) => {
        const at = stored.findIndex((row) => row.turn === turn);
        return [
          ...stored.slice(0, at),
          { turn, item: repositorySkillsContextItem(index) as AgentInputItem },
          ...stored.slice(at),
        ];
      };
      const publish: PublishRepositorySkills = async (index) => {
        if (frozen !== undefined) return frozen;
        const latest = latestRepositorySkillsIndex(rows.map((row) => row.item));
        if (index === null || index.text === latest) return (frozen = latest);
        rows.splice(0, rows.length, ...withIndex(rows, index.text));
        return (frozen = index.text);
      };
      const agent = buildOpenGeniAgent(settings, [REPOSITORY], {
        ...options.build,
        model,
        publishRepositorySkills: publish,
        ...(options.deferred ? { deferRepositorySkillIndex: true } : {}),
        ...(api === "anthropic-messages" ? { structuredToolTransport: false } : {}),
      });
      // The worker's input: stored history, projected, plus this turn's notice.
      const loaded = [...rows];
      const prepared = await prepareRunInput(agent, {
        kind: "message",
        historyItems: project(rows.map((row) => row.item)),
        ...(options.internalContext ? { internalContext: options.internalContext } : {}),
        modelInputAlreadyProjected: true,
      });
      const input = prepared.input as AgentInputItem[];
      const result = await runAgentStream(
        agent,
        {
          input,
          persistedHistoryCount: prepared.persistedHistoryCount,
          historyWithRepositorySkills: async (index) =>
            project(withIndex(loaded, index).map((row) => row.item)),
        },
        settings,
        { ownedSandbox: { client: box.client, session: box.session, deferredSetup: true } },
      );
      for await (const _ of result.toStream()) void _;
      await result.completed;
      // The run's own items are persisted after its input, like the history
      // sink (this test's projections keep one item per stored row).
      for (const item of result.history.slice(prepared.persistedHistoryCount))
        rows.push({ turn, item });
    },
  };
}

/** Scripted requests: by default the first calls a tool, so its turn sends two. */
export type Script = readonly ("tool" | "text")[];
export const SCRIPT: Script = ["tool", "text", "text", "text", "text", "text", "text"];

export function claudeModel(script: Script = SCRIPT) {
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
    const step = script[bodies.length] ?? "text";
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

export function responsesModel(script: Script = SCRIPT) {
  const bodies: any[] = [];
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://responses.example.test/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const step = script[bodies.length] ?? "text";
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

export const indexesIn = (value: unknown): string[] =>
  [...JSON.stringify(value).matchAll(/repository:\.agents\/skills\/([a-z]+)\/SKILL\.md/g)].map(
    (match) => match[1]!,
  );

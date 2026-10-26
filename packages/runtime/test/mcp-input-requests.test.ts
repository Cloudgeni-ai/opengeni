import { afterEach, describe, expect, test } from "bun:test";
import {
  Agent,
  MCPServerStreamableHttp,
  Runner,
  tool,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import {
  startFakeMcpElicitationServer,
  type FakeMcpElicitationServer,
} from "@opengeni/testing/mcp-elicitation-server";
import { z } from "zod";
import { mcpStreamableHttpClientOptions } from "../src/mcp-client";
import {
  MCP_INPUT_PENDING_RESULT,
  MCP_INPUT_REQUEST_MAX_ROUNDS,
  PrefixedMcpServer,
  awaitingMcpInput,
  mcpInputRequestOf,
  mcpInputRequiredOption,
  nextMcpInputRequiredStep,
  serializeApprovals,
  type McpInputExchange,
  type McpInputRequest,
} from "../src/index";

const confirmForm = { type: "object" as const, properties: {} };

function formRequest(message = "Send it?") {
  return {
    method: "elicitation/create",
    params: { mode: "form", message, requestedSchema: confirmForm },
  };
}

function asked(round = 1, requestState?: string): McpInputRequest {
  return {
    server: "Chat",
    round,
    requests: [{ id: "confirm", message: "Send it?", requestedSchema: confirmForm }],
    ...(requestState !== undefined ? { requestState } : {}),
  };
}

describe("nextMcpInputRequiredStep", () => {
  const fresh: McpInputExchange = { server: "Chat" };

  test("form questions pause the call, keeping the server's state", () => {
    expect(
      nextMcpInputRequiredStep(
        fresh,
        {
          resultType: "input_required",
          inputRequests: { confirm: formRequest() },
          requestState: "s1",
        },
        0,
      ),
    ).toEqual({ kind: "ask", request: asked(1, "s1") });
  });

  test("a later question counts the rounds of the call it resumes", () => {
    const resumed: McpInputExchange = {
      server: "Chat",
      answered: { request: asked(3), content: { confirm: {} } },
    };
    const step = nextMcpInputRequiredStep(
      resumed,
      { resultType: "input_required", inputRequests: { confirm: formRequest() } },
      0,
    );
    expect(step).toEqual({ kind: "ask", request: asked(4) });
    const last: McpInputExchange = {
      server: "Chat",
      answered: { request: asked(MCP_INPUT_REQUEST_MAX_ROUNDS), content: { confirm: {} } },
    };
    expect(
      nextMcpInputRequiredStep(
        last,
        { resultType: "input_required", inputRequests: { confirm: formRequest() } },
        0,
      ),
    ).toEqual({
      kind: "fail",
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: `The MCP server asked the person more than ${MCP_INPUT_REQUEST_MAX_ROUNDS} times during this tool call, so the call was stopped.`,
          },
        ],
      },
    });
  });

  test("state without questions is retried at once, but not forever", () => {
    expect(
      nextMcpInputRequiredStep(fresh, { resultType: "input_required", requestState: "s2" }, 0),
    ).toEqual({ kind: "retry", option: { requestState: "s2" } });
    const stuck =
      "The MCP server kept answering that it needs more input without saying what, so the tool call did not finish.";
    expect(
      nextMcpInputRequiredStep(fresh, { resultType: "input_required", requestState: "s2" }, 10),
    ).toMatchObject({ kind: "fail", result: { content: [{ text: stuck }] } });
    expect(nextMcpInputRequiredStep(fresh, { resultType: "input_required" }, 0)).toMatchObject({
      kind: "fail",
      result: { content: [{ text: stuck }] },
    });
  });

  test("requests this client never declared end the call", () => {
    const url = {
      method: "elicitation/create",
      params: { mode: "url", message: "Sign in", url: "https://example.com", elicitationId: "e1" },
    };
    expect(
      nextMcpInputRequiredStep(fresh, { resultType: "input_required", inputRequests: { url } }, 0),
    ).toMatchObject({
      kind: "fail",
      result: {
        content: [
          {
            text: "The MCP server asked for input this client cannot provide (a form it does not support), so the tool call did not finish.",
          },
        ],
      },
    });
    expect(
      nextMcpInputRequiredStep(
        fresh,
        {
          resultType: "input_required",
          inputRequests: { s: { method: "sampling/createMessage", params: {} } },
        },
        0,
      ),
    ).toMatchObject({
      kind: "fail",
      result: {
        content: [
          {
            text: "The MCP server asked for input this client cannot provide (sampling/createMessage), so the tool call did not finish.",
          },
        ],
      },
    });
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`q${index}`, formRequest()]),
    );
    expect(
      nextMcpInputRequiredStep(fresh, { resultType: "input_required", inputRequests: many }, 0),
    ).toMatchObject({
      kind: "fail",
      result: {
        content: [
          {
            text: "The MCP server asked for input this client cannot provide (too many questions), so the tool call did not finish.",
          },
        ],
      },
    });
  });

  test("a resumed call answers every question it was asked and echoes the state", () => {
    expect(mcpInputRequiredOption(fresh)).toEqual({});
    const request: McpInputRequest = {
      server: "Chat",
      round: 1,
      requests: [
        { id: "a", message: "A?", requestedSchema: confirmForm },
        { id: "b", message: "B?", requestedSchema: confirmForm },
      ],
      requestState: '{"step":1}',
    };
    expect(
      mcpInputRequiredOption({
        server: "Chat",
        answered: { request, content: { a: { ok: true } } },
      }),
    ).toEqual({
      inputResponses: {
        a: { action: "accept", content: { ok: true } },
        b: { action: "accept", content: {} },
      },
      requestState: '{"step":1}',
    });
  });
});

const fakes: FakeMcpElicitationServer[] = [];
const clients: MCPServerStreamableHttp[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const fake of fakes.splice(0)) await fake.stop();
});

async function connect(options: { trustedChats?: string[]; legacy?: boolean } = {}) {
  const fake = startFakeMcpElicitationServer({ trustedChats: options.trustedChats ?? [] });
  fakes.push(fake);
  const client = new MCPServerStreamableHttp({
    url: fake.url,
    name: "chat",
    ...mcpStreamableHttpClientOptions({ firstParty: false, codexApps: options.legacy === true }),
  });
  clients.push(client);
  await client.connect();
  await client.listTools();
  return { fake, client };
}

describe("the MCP client's input_required exchange", () => {
  test("declares form elicitation only on calls that can answer, and passes questions through", async () => {
    const { fake, client } = await connect();
    const refused = await client.callToolResult("send_message", { chat: "team", text: "hi" });
    expect(refused.isError).toBe(true);
    expect(fake.calls[0]).toMatchObject({ name: "send_message", declaredElicitation: false });

    // send_message has an output schema; the question itself is not checked against it.
    const question = (await client.callToolResult(
      "send_message",
      { chat: "team", text: "hi" },
      null,
      { inputRequired: {} },
    )) as unknown as Record<string, unknown>;
    expect(fake.calls[1]).toMatchObject({ declaredElicitation: true });
    expect(question).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        confirm: { method: "elicitation/create", params: { message: "Send “hi” to team?" } },
      },
    });
    expect(fake.sent).toEqual([]);

    const sent = await client.callToolResult("send_message", { chat: "team", text: "hi" }, null, {
      inputRequired: { inputResponses: { confirm: { action: "accept", content: {} } } },
    });
    expect(sent.structuredContent).toEqual({ sent: true, chat: "team" });
    expect(fake.calls[2]?.inputResponses).toEqual({ confirm: { action: "accept", content: {} } });
    expect(fake.sent).toEqual([{ chat: "team", text: "hi" }]);
  });

  test("echoes the server's request state byte for byte", async () => {
    const { fake, client } = await connect();
    const first = (await client.callToolResult("book_meeting", { topic: "Plan" }, null, {
      inputRequired: {},
    })) as unknown as { requestState: string };
    await client.callToolResult("book_meeting", { topic: "Plan" }, null, {
      inputRequired: {
        inputResponses: { details: { action: "accept", content: { room: "large", attendees: 4 } } },
        requestState: first.requestState,
      },
    });
    expect(fake.calls[1]?.requestState).toBe(first.requestState);
  });

  test("a 2025-era connection never declares elicitation", async () => {
    const { fake, client } = await connect({ legacy: true });
    const result = await client.callToolResult("send_message", { chat: "team", text: "hi" }, null, {
      inputRequired: {},
    });
    expect(result.isError).toBe(true);
    expect(fake.calls[0]).toMatchObject({ declaredElicitation: false });
    expect(fake.calls[0]?.inputResponses).toBeUndefined();
  });
});

describe("a tool call's exchange with its server", () => {
  async function prefixed(trustedChats: string[] = []) {
    const { fake, client } = await connect({ trustedChats });
    const server = new PrefixedMcpServer(client, "chat");
    await server.listTools();
    return { fake, server };
  }

  test("a trusted chat goes straight through without asking", async () => {
    const { fake, server } = await prefixed(["family"]);
    const exchange: McpInputExchange = { server: "Chat" };
    const result = await server.executeCatalogTool(
      "send_message",
      { chat: "family", text: "hi" },
      null,
      { mcpInput: exchange },
    );
    expect(result.isError).not.toBe(true);
    expect(exchange.requested).toBeUndefined();
    expect(fake.sent).toEqual([{ chat: "family", text: "hi" }]);
  });

  test("a question pauses the call; the answer finishes it once", async () => {
    const { fake, server } = await prefixed();
    const exchange: McpInputExchange = { server: "Chat" };
    const pending = await server.executeCatalogTool(
      "send_message",
      { chat: "team", text: "hi" },
      null,
      { mcpInput: exchange },
    );
    expect(pending).toEqual(MCP_INPUT_PENDING_RESULT);
    expect(exchange.requested).toMatchObject({
      server: "Chat",
      round: 1,
      requests: [{ id: "confirm", message: "Send “hi” to team?" }],
    });
    expect(fake.sent).toEqual([]);

    const resumed: McpInputExchange = {
      server: "Chat",
      answered: { request: exchange.requested!, content: { confirm: {} } },
    };
    const result = await server.executeCatalogTool(
      "send_message",
      { chat: "team", text: "hi" },
      null,
      { mcpInput: resumed },
    );
    expect(result.structuredContent).toEqual({ sent: true, chat: "team" });
    expect(resumed.requested).toBeUndefined();
    expect(fake.sent).toEqual([{ chat: "team", text: "hi" }]);
  });

  test("state-only answers are retried before the question is asked", async () => {
    const { fake, server } = await prefixed();
    const exchange: McpInputExchange = { server: "Chat" };
    await server.executeCatalogTool("warm_up", {}, null, { mcpInput: exchange });
    expect(fake.callsTo("warm_up").map((call) => call.requestState)).toEqual([undefined, "warm"]);
    expect(exchange.requested).toMatchObject({ requestState: "asked", requests: [{ id: "go" }] });
  });

  test("a server cannot ask in URL mode, which this client never declares", async () => {
    const { server } = await prefixed();
    const exchange: McpInputExchange = { server: "Chat" };
    // The server's SDK refuses with MissingRequiredClientCapability; a server
    // that sends one anyway gets the error result tested above.
    const failure = await server
      .executeCatalogTool("open_link", {}, null, { mcpInput: exchange })
      .catch((error: unknown) => error);
    expect((failure as { code?: unknown }).code).toBe(-32021);
    expect(exchange.requested).toBeUndefined();
  });

  test("without an exchange the call never declares elicitation", async () => {
    const { fake, server } = await prefixed();
    const result = await server.executeCatalogTool("send_message", { chat: "team", text: "hi" });
    expect(result.isError).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ declaredElicitation: false });
  });
});

class ScriptedModel implements Model {
  calls = 0;
  constructor(private outputs: ModelResponse["output"][]) {}
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return {
      usage: new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      output: this.outputs[this.calls - 1]!,
    };
  }
  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error("not streamed");
  }
}

test("a tool output that awaits approval pauses the call as an approval with the question", async () => {
  const request = asked(1, "s1");
  const send = tool({
    name: "chat__send_message",
    description: "Send a message.",
    parameters: z.object({ chat: z.string() }),
    execute: async () => awaitingMcpInput(request) as unknown as string,
  });
  const model = new ScriptedModel([
    [
      {
        type: "function_call",
        id: "call_1",
        callId: "call_1",
        name: "chat__send_message",
        status: "completed",
        arguments: JSON.stringify({ chat: "team" }),
      },
    ],
  ]);
  const agent = new Agent({ name: "Test", model, tools: [send] });
  const result = await new Runner().run(agent, "send it");
  expect(result.interruptions).toHaveLength(1);
  const [interruption] = result.interruptions;
  expect(mcpInputRequestOf(interruption)).toEqual(request);
  // The question never reaches the model's history.
  expect(JSON.stringify(result.history)).not.toContain("Send it?");
  const [approval] = serializeApprovals(result.interruptions) as Array<Record<string, unknown>>;
  expect(approval?.elicitation).toEqual({ server: "Chat", requests: request.requests });
  // The private state stays out of the public projection.
  expect(JSON.stringify(approval)).not.toContain('"requestState"');
});

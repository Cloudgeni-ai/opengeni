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
  MCP_INPUT_CLIENT_CAPABILITIES,
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
    requests: [{ id: "confirm", mode: "form", message: "Send it?", requestedSchema: confirmForm }],
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
      answered: { request: asked(3), action: "accept", content: { confirm: {} } },
    };
    const step = nextMcpInputRequiredStep(
      resumed,
      { resultType: "input_required", inputRequests: { confirm: formRequest() } },
      0,
    );
    expect(step).toEqual({ kind: "ask", request: asked(4) });
    const last: McpInputExchange = {
      server: "Chat",
      answered: {
        request: asked(MCP_INPUT_REQUEST_MAX_ROUNDS),
        action: "accept",
        content: { confirm: {} },
      },
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
    ).toEqual({
      kind: "retry",
      option: { capabilities: MCP_INPUT_CLIENT_CAPABILITIES, requestState: "s2" },
    });
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

  test("a page to open (URL mode) is refused: only forms are offered", () => {
    expect(
      nextMcpInputRequiredStep(
        fresh,
        {
          resultType: "input_required",
          inputRequests: {
            confirm: formRequest(),
            signIn: {
              method: "elicitation/create",
              params: {
                mode: "url",
                message: "Sign in to continue.",
                url: "https://accounts.example.com/sign-in",
                elicitationId: "e1",
              },
            },
          },
          requestState: "s3",
        },
        0,
      ),
    ).toEqual({
      kind: "fail",
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "The MCP server asked for input this client cannot provide (a web page to open), so the tool call did not finish.",
          },
        ],
      },
    });
  });

  test("requests this client never declared end the call", () => {
    const malformed = {
      method: "elicitation/create",
      params: { message: "Pick", requestedSchema: { type: "object", properties: { x: {} } } },
    };
    expect(
      nextMcpInputRequiredStep(
        fresh,
        { resultType: "input_required", inputRequests: { malformed } },
        0,
      ),
    ).toMatchObject({
      kind: "fail",
      result: {
        content: [
          {
            text: "The MCP server asked for input this client cannot provide (a question it does not support), so the tool call did not finish.",
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
    expect(mcpInputRequiredOption(fresh)).toEqual({ capabilities: MCP_INPUT_CLIENT_CAPABILITIES });
    expect(MCP_INPUT_CLIENT_CAPABILITIES).toEqual({ elicitation: { form: {} } });
    const request: McpInputRequest = {
      server: "Chat",
      round: 1,
      requests: [
        { id: "a", mode: "form", message: "A?", requestedSchema: confirmForm },
        { id: "b", mode: "form", message: "B?", requestedSchema: confirmForm },
      ],
      requestState: '{"step":1}',
    };
    expect(
      mcpInputRequiredOption({
        server: "Chat",
        answered: { request, action: "accept", content: { a: { ok: true } } },
      }),
    ).toEqual({
      capabilities: MCP_INPUT_CLIENT_CAPABILITIES,
      inputResponses: {
        a: { action: "accept", content: { ok: true } },
        b: { action: "accept", content: {} },
      },
      requestState: '{"step":1}',
    });
  });

  test("a decline is sent for every question, with the server's state", () => {
    const request: McpInputRequest = {
      server: "Chat",
      round: 2,
      requests: [
        { id: "a", mode: "form", message: "A?", requestedSchema: confirmForm },
        { id: "b", mode: "form", message: "B?", requestedSchema: confirmForm },
      ],
      requestState: "s9",
    };
    expect(
      mcpInputRequiredOption({ server: "Chat", answered: { request, action: "decline" } }),
    ).toEqual({
      capabilities: MCP_INPUT_CLIENT_CAPABILITIES,
      inputResponses: { a: { action: "decline" }, b: { action: "decline" } },
      requestState: "s9",
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
  const declare = { capabilities: MCP_INPUT_CLIENT_CAPABILITIES };

  test("declares elicitation only on calls that can answer, and passes questions through", async () => {
    const { fake, client } = await connect();
    const refused = await client.callToolResult("send_message", { chat: "team", text: "hi" });
    expect(refused.isError).toBe(true);
    expect(fake.calls[0]).toMatchObject({ name: "send_message", declaredElicitation: false });

    // send_message has an output schema; the question itself is not checked against it.
    const question = (await client.callToolResult(
      "send_message",
      { chat: "team", text: "hi" },
      null,
      { inputRequired: declare },
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
      inputRequired: { ...declare, inputResponses: { confirm: { action: "accept", content: {} } } },
    });
    expect(sent.structuredContent).toEqual({ sent: true, chat: "team" });
    expect(fake.calls[2]?.inputResponses).toEqual({ confirm: { action: "accept", content: {} } });
    expect(fake.sent).toEqual([{ chat: "team", text: "hi" }]);
  });

  test("echoes the server's request state byte for byte", async () => {
    const { fake, client } = await connect();
    const first = (await client.callToolResult("book_meeting", { topic: "Plan" }, null, {
      inputRequired: declare,
    })) as unknown as { requestState: string };
    await client.callToolResult("book_meeting", { topic: "Plan" }, null, {
      inputRequired: {
        ...declare,
        inputResponses: { details: { action: "accept", content: { room: "large", attendees: 4 } } },
        requestState: first.requestState,
      },
    });
    expect(fake.calls[1]?.requestState).toBe(first.requestState);
  });

  test("a 2025-era connection never declares elicitation", async () => {
    const { fake, client } = await connect({ legacy: true });
    const result = await client.callToolResult("send_message", { chat: "team", text: "hi" }, null, {
      inputRequired: declare,
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
      answered: { request: exchange.requested!, action: "accept", content: { confirm: {} } },
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

  test("a decline is sent to the server, which finishes the call its own way", async () => {
    const { fake, server } = await prefixed();
    const exchange: McpInputExchange = { server: "Chat" };
    await server.executeCatalogTool("send_message", { chat: "team", text: "hi" }, null, {
      mcpInput: exchange,
    });
    const declined: McpInputExchange = {
      server: "Chat",
      answered: { request: exchange.requested!, action: "decline" },
    };
    const result = await server.executeCatalogTool(
      "send_message",
      { chat: "team", text: "hi" },
      null,
      { mcpInput: declined },
    );
    expect(result.structuredContent).toEqual({ sent: false, chat: "team" });
    expect(declined.requested).toBeUndefined();
    expect(fake.calls.at(-1)?.inputResponses).toEqual({ confirm: { action: "decline" } });
    expect(fake.sent).toEqual([]);
  });

  test("state-only answers are retried before the question is asked", async () => {
    const { fake, server } = await prefixed();
    const exchange: McpInputExchange = { server: "Chat" };
    await server.executeCatalogTool("warm_up", {}, null, { mcpInput: exchange });
    expect(fake.callsTo("warm_up").map((call) => call.requestState)).toEqual([undefined, "warm"]);
    expect(exchange.requested).toMatchObject({ requestState: "asked", requests: [{ id: "go" }] });
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
  expect(approval?.elicitation).toEqual({ server: "Chat", round: 1, requests: request.requests });
  // The private state stays out of the public projection.
  expect(JSON.stringify(approval)).not.toContain('"requestState"');
});

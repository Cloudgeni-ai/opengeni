import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { MCPServer } from "@openai/agents";
import { FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY } from "@opengeni/contracts";
import { PrefixedMcpServer, configureRuntimeMetricsHooks } from "../src/index";
import { mcpResultModelContent } from "../src/mcp-result-custom-data";

/** A server whose every tool call returns the next scripted result. */
function scripted(results: unknown[]): MCPServer {
  return {
    name: "opengeni",
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: "sandbox_file_publish", inputSchema: { type: "object" } }];
    },
    async callTool() {
      return [];
    },
    async callToolResult() {
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    async invalidateToolsCache() {},
  } as unknown as MCPServer;
}

function prefixed(
  inner: MCPServer,
  firstPartyCatalog: boolean,
  bestEffort = false,
): PrefixedMcpServer {
  return new PrefixedMcpServer(
    inner,
    "opengeni",
    undefined,
    bestEffort,
    undefined,
    "opengeni",
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    firstPartyCatalog,
  );
}

const rejected = () => ({
  isError: true,
  content: [{ type: "text", text: "Pass exactly one of path or artifactId." }],
  _meta: { [FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY]: true },
});

describe("MCP argument rejection metrics", () => {
  afterEach(() => configureRuntimeMetricsHooks(null));

  test("first-party results still strip the mark and distinguish rejections from failures", async () => {
    const outcomes: string[] = [];
    configureRuntimeMetricsHooks({ onMcpToolCall: ({ outcome }) => outcomes.push(outcome) });
    const server = prefixed(
      scripted([
        rejected(),
        { ...rejected(), _meta: { ...rejected()._meta, other: 1 } },
        { isError: true, content: [{ type: "text", text: "object storage is not configured" }] },
        { content: [{ type: "text", text: "{}" }] },
      ]),
      true,
    );

    const first = await server.executeCatalogTool("sandbox_file_publish", {});
    expect(first).toEqual({
      isError: true,
      content: [{ type: "text", text: "Pass exactly one of path or artifactId." }],
    });
    const second = await server.executeCatalogTool("sandbox_file_publish", {});
    expect(second._meta).toEqual({ other: 1 });
    await server.executeCatalogTool("sandbox_file_publish", {});
    await server.executeCatalogTool("sandbox_file_publish", {});

    // A real tool failure still counts as one.
    expect(outcomes).toEqual(["rejected", "rejected", "provider_declared_error", "success"]);
  });

  test("external results require isError and a boolean true mark without changing the result", async () => {
    const { _meta, ...unmarked } = rejected();
    const marked = { ...unmarked, _meta: { ..._meta, other: 1 } };
    const fixtures = [
      marked,
      unmarked,
      { ...marked, _meta: { [FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY]: "true" } },
      { ...marked, isError: false },
    ];
    const observations: Array<{ outcome: string; tool: string }> = [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: ({ outcome, tool }) => observations.push({ outcome, tool }),
    });
    const server = prefixed(scripted([...fixtures]), false);
    for (const fixture of fixtures) {
      const result = await server.executeCatalogTool("sandbox_file_publish", {});
      expect(result).toEqual(fixture);
      expect(mcpResultModelContent(result)).toEqual(
        mcpResultModelContent({ ...unmarked, isError: fixture.isError }),
      );
    }
    expect(observations).toEqual(
      ["rejected", "provider_declared_error", "provider_declared_error", "success"].map(
        (outcome) => ({
          outcome,
          tool: "external",
        }),
      ),
    );
  });

  test("other protocol errors and a first-party Invalid params error keep their metrics", async () => {
    const outcomes: string[] = [];
    configureRuntimeMetricsHooks({ onMcpToolCall: ({ outcome }) => outcomes.push(outcome) });
    const invalidParams = new McpError(ErrorCode.InvalidParams, "invalid params");
    const unrelated = new McpError(ErrorCode.InternalError, "internal failure", {
      code: ErrorCode.InvalidParams,
    });
    for (const [error, firstParty] of [
      [invalidParams, true],
      [unrelated, false],
    ] as const) {
      const server = prefixed(scripted([error]), firstParty);
      expect(
        await server.executeCatalogTool("sandbox_file_publish", {}).catch((cause) => cause),
      ).toBe(error);
    }
    expect(outcomes).toEqual(["thrown_protocol_error", "thrown_protocol_error"]);
  });

  test("a local Invalid params error still counts as a protocol failure with unchanged best-effort content", async () => {
    const outcomes: string[] = [];
    configureRuntimeMetricsHooks({ onMcpToolCall: ({ outcome }) => outcomes.push(outcome) });
    const error = new McpError(ErrorCode.InvalidParams, "invalid params");
    const server = prefixed(scripted([error]), false, true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await server.executeCatalogTool("sandbox_file_publish", {})).toEqual({
        isError: true,
        content: [
          { type: "text", text: error.message },
          {
            type: "text",
            text: "This tool is unavailable for the rest of this turn. Do not retry it — continue without it or use another approach.",
          },
        ],
      });
    } finally {
      warn.mockRestore();
    }
    expect(outcomes).toEqual(["thrown_protocol_error"]);
  });
});

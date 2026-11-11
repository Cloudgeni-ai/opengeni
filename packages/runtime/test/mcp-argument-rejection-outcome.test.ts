import { afterEach, describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY } from "@opengeni/contracts";
import { PrefixedMcpServer, configureRuntimeMetricsHooks } from "../src/index";

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
      return results.shift();
    },
    async invalidateToolsCache() {},
  } as unknown as MCPServer;
}

function prefixed(inner: MCPServer, firstPartyCatalog: boolean): PrefixedMcpServer {
  return new PrefixedMcpServer(
    inner,
    "opengeni",
    undefined,
    false,
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

describe("first-party argument rejections", () => {
  afterEach(() => configureRuntimeMetricsHooks(null));

  test("are recorded as rejected, not as a tool failure, and the mark is removed", async () => {
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

  test("another server cannot mark its own failures as rejections", async () => {
    const outcomes: string[] = [];
    configureRuntimeMetricsHooks({ onMcpToolCall: ({ outcome }) => outcomes.push(outcome) });
    const server = prefixed(scripted([rejected()]), false);
    const result = await server.executeCatalogTool("sandbox_file_publish", {});
    expect(result._meta).toEqual({ [FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY]: true });
    expect(outcomes).toEqual(["provider_declared_error"]);
  });
});

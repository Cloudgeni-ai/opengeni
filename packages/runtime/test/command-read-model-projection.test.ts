import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import type { AttemptToolIdentity, AttemptToolResult } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { PrefixedMcpServer, prefixedMcpToolName, prepareAgentTools } from "../src";
import { projectCommandReadToolResultForModel } from "../src/command-read-model-projection";
import { unwrapSdkMcpResultProjection } from "../src/mcp-result-custom-data";
import { projectAttemptToolResultForCaller } from "../src/tool-result-spill";

const READ: AttemptToolIdentity = { serverId: "opengeni", toolName: "command_read" };
const WAIT: AttemptToolIdentity = { serverId: "opengeni", toolName: "command_wait" };
const id = "6cfa95ae-29cc-48cb-9ab1-2613d15f1dde";
const other = "0c1f4f0e-5d7a-4c2b-9a51-3f0f6b1e2d4c";

const chunk = (sequence: number, text: string, stream = "stdout") => ({
  sequence,
  stream,
  streamFidelity: "separate",
  chunk: text,
});
const retention = (gaps: string[] = []) => ({
  source: "retained_session_events",
  completeness: "unknown",
  gaps,
});
const exitedRead = {
  commandId: id,
  state: "exited",
  exitCode: 0,
  settlementReason: null,
  terminal: true,
  completionObservedAt: "2026-11-01T05:00:00.000Z",
  chunks: [chunk(10, "compiling\n"), chunk(11, "warning: unused\n", "stderr"), chunk(12, "ok\n")],
  nextCursor: `${id}:13:0`,
  hasMore: false,
  retention: retention(),
  endCursor: `${id}:13:0`,
  waitedMs: 4210,
  timedOut: false,
  aborted: false,
  liveFanout: true,
};
const textResult = (value: unknown): AttemptToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const textOf = (result: AttemptToolResult) => {
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("expected text");
  return content.text;
};
const context = (kind: "model" | "codemode"): AttemptToolExecutionContext => ({
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
});

describe("plain-text command reads for the model", () => {
  test("a finished command shows its exit code and output", () => {
    expect(textOf(projectCommandReadToolResultForModel(READ, textResult(exitedRead)))).toBe(
      [`Command ${id} exited with code 0.`, "Output:", "compiling\nwarning: unused\nok\n"].join(
        "\n",
      ),
    );
  });

  test("large output shows its start, an omitted-middle marker with a cursor, and its end", () => {
    const running = {
      ...exitedRead,
      state: "running",
      exitCode: null,
      terminal: false,
      completionObservedAt: null,
      chunks: [chunk(1, "first line\n")],
      nextCursor: `${id}:2:0`,
      hasMore: true,
      omitted: { bytes: 52_000, cursor: `${id}:2:0` },
      tail: { chunks: [chunk(90, "last line\n")], cursor: `${id}:90:0` },
      endCursor: `${id}:91:0`,
      waitedMs: 30_004,
      timedOut: true,
      retention: retention(["cursor_output_no_longer_retained"]),
    };
    const text = textOf(projectCommandReadToolResultForModel(READ, textResult(running)));
    expect(text).toBe(
      [
        `Command ${id} is still running after waiting 30 s.`,
        "Output:",
        `first line\n[... about 52000 bytes omitted; to read them, call command_read with cursor ${id}:2:0 and waitSeconds 0 ...]\nlast line\n`,
        `For output after this, read with cursor ${id}:91:0.`,
        "Some output is not retained (cursor_output_no_longer_retained).",
      ].join("\n"),
    );
    expect(text.length).toBeLessThan(JSON.stringify(running).length / 2);
  });

  test("failures, notices, stale refreshes and quiet running reads are stated in words", () => {
    const text = textOf(
      projectCommandReadToolResultForModel(
        READ,
        textResult({
          ...exitedRead,
          state: "running",
          exitCode: null,
          terminal: false,
          chunks: [],
          freshness: { status: "refresh_unavailable", retryable: true },
          waitedMs: 0,
        }),
      ),
    );
    expect(text).toContain(`Command ${id} is still running.`);
    expect(text).toContain("could not be reached for fresh output");
    expect(text).toContain("Output: (no new output)");
    expect(text).toContain(`For output after this, read with cursor ${id}:13:0.`);
    const failed = textOf(
      projectCommandReadToolResultForModel(
        READ,
        textResult({
          ...exitedRead,
          exitCode: 0,
          failure: { code: "output_delivery_failed", retryable: false },
          notice: "Stopped background child processes when the shell exited.",
          chunks: [],
        }),
      ),
    );
    expect(failed).toContain("Failure: output_delivery_failed");
    expect(failed).toContain("Stopped background child processes");
    expect(failed).toContain("Output: (none)");
    const lost = textOf(
      projectCommandReadToolResultForModel(
        READ,
        textResult({
          ...exitedRead,
          state: "lost",
          exitCode: null,
          settlementReason: "machine_removed",
        }),
      ),
    );
    expect(lost).toContain(`Command ${id} was lost (machine_removed); its exit code is unknown.`);
  });

  test("several commands get one block each under the wait summary", () => {
    const text = textOf(
      projectCommandReadToolResultForModel(
        WAIT,
        textResult({
          commands: [
            exitedRead,
            {
              ...exitedRead,
              commandId: other,
              state: "exited",
              exitCode: 2,
              chunks: [chunk(5, "error: boom\n")],
            },
          ],
          waitFor: "all",
          waitedMs: 12_400,
          timedOut: false,
          aborted: false,
          liveFanout: true,
        }),
      ),
    );
    expect(text).toBe(
      [
        "Waited 12 s for all of 2 commands.",
        "",
        `Command ${id} exited with code 0.\nOutput:\ncompiling\nwarning: unused\nok\n`,
        "",
        `Command ${other} exited with code 2.\nOutput:\nerror: boom\n`,
      ].join("\n"),
    );
  });

  test("errors, other tools and other shapes are unchanged", () => {
    const error: AttemptToolResult = { isError: true, content: [{ type: "text", text: "nope" }] };
    expect(projectCommandReadToolResultForModel(READ, error)).toBe(error);
    const exact = textResult(exitedRead);
    expect(
      projectCommandReadToolResultForModel({ serverId: "other", toolName: "command_read" }, exact),
    ).toBe(exact);
    expect(
      projectCommandReadToolResultForModel(
        { serverId: "opengeni", toolName: "session_wait" },
        exact,
      ),
    ).toBe(exact);
    const odd = textResult({ commandId: id, unexpected: true });
    expect(projectCommandReadToolResultForModel(READ, odd)).toBe(odd);
    const notJson: AttemptToolResult = { content: [{ type: "text", text: "plain" }] };
    expect(projectCommandReadToolResultForModel(READ, notJson)).toBe(notJson);
  });

  test("Codemode receives the exact structured receipt; the model receives plain text", async () => {
    const result = textResult(exitedRead);
    const codemode = await projectAttemptToolResultForCaller(
      result,
      context("codemode"),
      undefined,
      READ,
    );
    expect(codemode).toBe(result);
    const model = await projectAttemptToolResultForCaller(
      result,
      context("model"),
      undefined,
      READ,
    );
    expect(textOf(model)).toStartWith(`Command ${id} exited with code 0.`);
  });

  test("prepared first-party MCP: model calls get plain text, Codemode calls the exact JSON", async () => {
    const exact = JSON.stringify(exitedRead, null, 2);
    const inner: MCPServer = {
      name: "og-inner",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return ["command_read", "command_wait"].map((name) => ({
          name,
          description: name,
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
            additionalProperties: true,
          },
        }));
      },
      async callTool() {
        return [{ type: "text", text: exact }];
      },
      async callToolResult() {
        return { content: [{ type: "text", text: exact }] };
      },
      async invalidateToolsCache() {},
    };
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "opengeni",
            name: "Opengeni",
            url: "https://mcp.example.test/og",
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "opengeni" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        localMcpServers: [{ id: "opengeni", server: inner }],
      },
    );
    try {
      const server = prepared.mcpServers.find(
        (candidate) =>
          candidate instanceof PrefixedMcpServer && candidate.registryId === "opengeni",
      )!;
      for (const identity of [READ, WAIT]) {
        const model = unwrapSdkMcpResultProjection(
          await server.callToolResult!(prefixedMcpToolName("opengeni", identity.toolName), {
            commandId: id,
          }),
        ) as AttemptToolResult;
        expect(textOf(model)).toBe(
          textOf(projectCommandReadToolResultForModel(identity, textResult(exitedRead))),
        );
        const codemode = await prepared.attemptToolEnvironment!.call({
          operationId: crypto.randomUUID(),
          catalogDigest: prepared.attemptToolCatalog!.digest,
          identity,
          arguments: { commandId: id },
          caller: { kind: "codemode", subjectId: "codemode:test" },
        });
        expect(codemode.content).toEqual([{ type: "text", text: exact }]);
      }
    } finally {
      await prepared.close();
    }
  });
});

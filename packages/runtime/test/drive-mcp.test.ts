import { expect, mock, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import {
  DriveMcpServer,
  DRIVE_MCP_BRIDGE_ADAPTER,
  DRIVE_EXTRA_TOOLS,
  OFFICIAL_DRIVE_MCP_URL,
} from "../src/drive-mcp";
const connectionRef = {
  providerDomain: "drivemcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};
function fixture() {
  const remote = {
    name: "Google Drive",
    connect: mock(async () => {}),
    close: mock(async () => {}),
    invalidateToolsCache: mock(async () => {}),
    listTools: mock(async () => [
      { name: "create_file", inputSchema: { type: "object" as const, properties: {} } },
    ]),
    callTool: mock(async () => [{ type: "text" as const, text: "official" }]),
  };
  const authorize = mock(async () => true);
  const fetchImpl = mock(
    async (_url: any, _init: any): Promise<Response> => Response.json({ id: "file-1" }),
  );
  const resolveCredential = mock(async (_request: any) => ({
    status: "ok" as const,
    headers: { authorization: "Bearer fixture" },
    connectionId: "selected-account",
    authorizeProviderRequest: authorize,
  }));
  const server = new DriveMcpServer(
    { url: OFFICIAL_DRIVE_MCP_URL, connectionRef },
    {
      workspaceId: "workspace",
      subjectId: "human",
      serverId: "drive",
      resolveCredential,
      fetchImpl,
      createRemoteServer: () => remote as unknown as MCPServer,
    },
  );
  return { server, remote, authorize, fetchImpl, resolveCredential };
}
test("one connection delegates official tools to Google and adds reviewed missing operations", async () => {
  const f = fixture();
  await f.server.connect();
  expect((await f.server.listTools()).map((t) => t.name)).toEqual([
    "create_file",
    ...DRIVE_EXTRA_TOOLS.map((t) => t.name),
  ]);
  expect(await f.server.callTool("create_file", { title: "report.csv" })).toEqual([
    { type: "text", text: "official" },
  ]);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  await f.server.close();
  expect(f.remote.close).toHaveBeenCalledTimes(1);
});
test("a future official tool collision fails without silently changing semantics", async () => {
  const f = fixture();
  f.remote.listTools.mockResolvedValue([
    { name: "update_file", inputSchema: { type: "object", properties: {} } },
  ]);
  await expect(f.server.listTools()).rejects.toThrow("collision");
});
test("moves use the exact selected personal grant and recheck live authority", async () => {
  const f = fixture();
  await f.server.callToolResult("move_file", {
    fileId: "file-1",
    fromParentId: "old",
    toParentId: "new",
  });
  expect(f.resolveCredential.mock.calls[0]![0]).toMatchObject({
    subjectId: "human",
    connectionRef,
    toolName: "move_file",
    forceRefresh: false,
  });
  expect(f.authorize).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetchImpl.mock.calls[0]!;
  expect(url.origin).toBe("https://www.googleapis.com");
  expect(url.pathname).toBe("/drive/v3/files/file-1");
  expect(url.searchParams.get("addParents")).toBe("new");
  expect(url.searchParams.get("removeParents")).toBe("old");
  expect(init).toMatchObject({
    method: "PATCH",
    redirect: "error",
    headers: { authorization: "Bearer fixture" },
  });
});
test("revocation and invalid paths stop before provider access", async () => {
  const f = fixture();
  expect((await f.server.callToolResult("delete_file", { fileId: "../../other" })).isError).toBe(
    true,
  );
  expect(f.resolveCredential).not.toHaveBeenCalled();
  f.authorize.mockResolvedValue(false);
  await expect(f.server.callToolResult("delete_file", { fileId: "file-1" })).rejects.toThrow(
    "authority",
  );
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test("an ambiguous write is never retried or reported as not executed", async () => {
  const f = fixture();
  f.fetchImpl.mockRejectedValue(new Error("connection dropped"));
  await expect(f.server.callToolResult("delete_file", { fileId: "file-1" })).rejects.toMatchObject({
    code: 40102,
    connectorActionOutcome: "uncertain",
    retryable: false,
  });
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.resolveCredential).toHaveBeenCalledTimes(1);
});
test("binary overwrite preserves bytes, file ID, and media type", async () => {
  const f = fixture();
  const bytes = Buffer.from([0, 255, 1, 128]);
  await f.server.callToolResult("overwrite_file_content", {
    fileId: "file-1",
    base64Content: bytes.toString("base64"),
    contentMimeType: "application/octet-stream",
  });
  const [url, init] = f.fetchImpl.mock.calls[0]!;
  expect(url.pathname).toBe("/upload/drive/v3/files/file-1");
  expect(url.searchParams.get("uploadType")).toBe("media");
  expect(Buffer.from(init.body)).toEqual(bytes);
});
test("change-feed pages return checkpoints without creating a special schedule", async () => {
  const f = fixture();
  f.fetchImpl.mockResolvedValue(
    Response.json({ changes: [{ fileId: "file-1", removed: true }], newStartPageToken: "next" }),
  );
  const result = await f.server.callToolResult("list_changes", {
    pageToken: "previous",
    driveId: "shared-drive",
  });
  expect(result.structuredContent.newStartPageToken).toBe("next");
  const [url] = f.fetchImpl.mock.calls[0]!;
  expect(url.searchParams.get("pageToken")).toBe("previous");
  expect(url.searchParams.get("supportsAllDrives")).toBe("true");
});
test("only the exact official personal OAuth connection selects the extension adapter", () => {
  expect(DRIVE_MCP_BRIDGE_ADAPTER.matches({ url: OFFICIAL_DRIVE_MCP_URL, connectionRef })).toBe(
    true,
  );
  for (const url of [OFFICIAL_DRIVE_MCP_URL + "/", "https://attacker.test/mcp"])
    expect(DRIVE_MCP_BRIDGE_ADAPTER.matches({ url, connectionRef })).toBe(false);
  expect(
    DRIVE_MCP_BRIDGE_ADAPTER.matches({
      url: OFFICIAL_DRIVE_MCP_URL,
      connectionRef: { ...connectionRef, subjectScope: "workspace" },
    }),
  ).toBe(false);
});

test("official calls preserve full results, metadata, and cancellation", async () => {
  const f = fixture();
  const result = {
    content: [{ type: "text" as const, text: "provider denial" }],
    isError: true,
    structuredContent: { reason: "denied" },
    _meta: { receipt: "official" },
  };
  const callToolResult = mock(
    async (
      _name: string,
      _args: Record<string, unknown> | null,
      _meta?: Record<string, unknown> | null,
      _options?: { signal?: AbortSignal },
    ) => result,
  );
  Object.assign(f.remote, { callToolResult });
  const controller = new AbortController();
  const meta = { progressToken: "progress" };
  expect(
    await f.server.callToolResult("create_file", { title: "report" }, meta, {
      signal: controller.signal,
    }),
  ).toBe(result);
  expect(callToolResult.mock.calls[0]).toEqual([
    "create_file",
    { title: "report" },
    meta,
    { signal: controller.signal },
  ]);
  await f.server.callTool("create_file", {}, meta, { signal: controller.signal });
  expect(callToolResult.mock.calls[1]).toEqual([
    "create_file",
    {},
    meta,
    { signal: controller.signal },
  ]);
  controller.abort();
  await expect(
    f.server.callTool("create_file", {}, meta, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(callToolResult).toHaveBeenCalledTimes(2);
});

test("cancellation before dispatch does not submit or classify a write as uncertain", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.server.callTool("delete_file", { fileId: "file-1" }, null, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(f.resolveCredential).not.toHaveBeenCalled();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test("ambiguous server failures and broken successful bodies are never replayed", async () => {
  for (const response of [
    new Response("provider unavailable", { status: 503 }),
    new Response("not JSON", { status: 200 }),
  ]) {
    const f = fixture();
    f.fetchImpl.mockResolvedValue(response);
    await expect(
      f.server.callToolResult("delete_file", { fileId: "file-1" }),
    ).rejects.toMatchObject({ connectorActionOutcome: "uncertain", retryable: false });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});

test("invalid sharing targets and noncanonical binary content stop before credentials", async () => {
  const f = fixture();
  for (const args of [
    { fileId: "file-1", type: "anyone", role: "reader", emailAddress: "person@example.com" },
    {
      fileId: "file-1",
      type: "user",
      role: "reader",
      emailAddress: "person@example.com",
      allowFileDiscovery: true,
    },
    { fileId: "file-1", type: "domain", role: "reader" },
    { fileId: "file-1", type: "user", role: "owner", emailAddress: "person@example.com" },
  ])
    expect((await f.server.callToolResult("create_permission", args)).isError).toBe(true);
  expect(
    (
      await f.server.callToolResult("overwrite_file_content", {
        fileId: "file-1",
        base64Content: "Zh==",
        contentMimeType: "application/octet-stream",
      })
    ).isError,
  ).toBe(true);
  expect(f.resolveCredential).not.toHaveBeenCalled();
});

test("only change-feed tools advertise read-only and replay-safe semantics", async () => {
  const f = fixture();
  const tools = await f.server.listTools();
  for (const tool of tools.filter((entry) => entry.name !== "create_file")) {
    const read = tool.name === "list_changes" || tool.name === "get_changes_start_token";
    expect(tool.annotations).toMatchObject({
      readOnlyHint: read,
      destructiveHint: !read,
      idempotentHint: read,
      openWorldHint: true,
    });
  }
});

test("content-only remote servers still receive metadata and cancellation", async () => {
  const f = fixture();
  const meta = { progressToken: "progress" };
  const signal = new AbortController().signal;
  await f.server.callTool("create_file", {}, meta, { signal });
  expect(f.remote.callTool).toHaveBeenCalledWith("create_file", {}, meta, { signal });
});

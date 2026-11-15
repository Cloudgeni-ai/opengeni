import { describe, expect, test } from "bun:test";
import {
  GMAIL_REST_MCP_BRIDGE_ADAPTER,
  GmailRestMcpServer,
  OFFICIAL_GMAIL_MCP_URL,
} from "../src/gmail-rest-mcp";
import {
  GOOGLE_CALENDAR_REST_MCP_BRIDGE_ADAPTER,
  GoogleCalendarRestMcpServer,
} from "../src/google-calendar-rest-mcp";
import { DRIVE_MCP_BRIDGE_ADAPTER, DriveMcpServer, OFFICIAL_DRIVE_MCP_URL } from "../src/drive-mcp";
import { NANGO_TOOLS_MCP_BRIDGE_ADAPTER, NangoToolsMcpServer } from "../src/nango-tools-mcp";
import { nativeNangoIntegrationByKey } from "@opengeni/contracts/nango";
import { GMAIL_EXTRA_TOOLS, gmailToolSupportsScopes } from "../src/gmail-rest-tools";
import {
  GOOGLE_CALENDAR_REST_MCP_TOOLS,
  googleCalendarToolSupportsScopes,
} from "../src/google-calendar-rest-mcp";
import { sendWithCredential, type NangoUsageReport } from "../src/nango-transport";

const proxy = (integrationKey: string, providerConfigKey: string) => ({
  kind: "nango_proxy" as const,
  baseUrl: "https://api.nango.test",
  integrationKey,
  providerConfigKey,
  nangoConnectionId: "nc-1",
});
const nangoHeaders = (providerConfigKey: string) => ({
  authorization: "Bearer nango-secret",
  "connection-id": "nc-1",
  "provider-config-key": providerConfigKey,
});
const subjectRef = (providerDomain: string) => ({
  providerDomain,
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function recordingFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Nango proxy transport", () => {
  test("sends direct credentials unchanged and Nango credentials to the proxy with usage", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json({ ok: true }));
    await sendWithCredential(
      fetchImpl,
      "https://www.googleapis.com/drive/v3/about",
      {},
      {
        headers: { authorization: "Bearer direct" },
        connectionId: "c0",
      },
    );
    expect(calls[0]).toMatchObject({
      url: "https://www.googleapis.com/drive/v3/about",
      headers: { authorization: "Bearer direct" },
    });
    const reports: NangoUsageReport[] = [];
    const response = await sendWithCredential(
      fetchImpl,
      "https://www.googleapis.com/drive/v3/files?pageSize=1",
      { method: "POST", body: "abcd" },
      {
        headers: nangoHeaders("google-drive"),
        connectionId: "c1",
        proxy: proxy("google-drive", "google-drive"),
      },
      { recorder: (report) => reports.push(report), toolName: "search_files" },
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(calls[1]).toMatchObject({
      url: "https://api.nango.test/proxy/drive/v3/files?pageSize=1",
      headers: {
        authorization: "Bearer nango-secret",
        "connection-id": "nc-1",
        "provider-config-key": "google-drive",
        "base-url-override": "https://www.googleapis.com",
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "proxy_request",
      connectionId: "c1",
      integrationKey: "google-drive",
      toolName: "search_files",
      httpMethod: "POST",
      httpStatus: 200,
      requestBytes: 4,
      responseBytes: 11,
    });
  });
});

describe("Google bridges under Nango", () => {
  test("adapters match the Nango provider domains of the same catalog identities", () => {
    expect(
      GMAIL_REST_MCP_BRIDGE_ADAPTER.matches({
        url: OFFICIAL_GMAIL_MCP_URL,
        connectionRef: subjectRef("nango:gmail"),
      }),
    ).toBe(true);
    expect(
      GOOGLE_CALENDAR_REST_MCP_BRIDGE_ADAPTER.matches({
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        connectionRef: subjectRef("nango:google-calendar"),
      }),
    ).toBe(true);
    expect(
      DRIVE_MCP_BRIDGE_ADAPTER.matches({
        url: OFFICIAL_DRIVE_MCP_URL,
        connectionRef: subjectRef("nango:google-drive"),
      }),
    ).toBe(true);
    expect(
      GMAIL_REST_MCP_BRIDGE_ADAPTER.matches({
        url: OFFICIAL_GMAIL_MCP_URL,
        connectionRef: subjectRef("nango:other"),
      }),
    ).toBe(false);
  });

  test("Gmail validates its Google destination, then proxies it and declares the transport", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json({ labels: [] }));
    const transports: unknown[] = [];
    const reports: NangoUsageReport[] = [];
    const gmail = new GmailRestMcpServer({
      workspaceId: "ws_1",
      subjectId: "user:a",
      serverId: "gmail",
      connectionRef: subjectRef("nango:gmail"),
      resolveCredential: async (input) => {
        transports.push(input.acceptedTransports);
        return {
          status: "ok",
          headers: nangoHeaders("google-mail"),
          connectionId: "c1",
          proxy: proxy("gmail", "google-mail"),
        };
      },
      recordNangoUsage: (report) => reports.push(report),
      fetchImpl,
    });
    const result = (await gmail.callToolResult("list_labels", {})) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(transports.every((value) => JSON.stringify(value) === '["nango_proxy"]')).toBe(true);
    expect(calls[0]!.url).toBe("https://api.nango.test/proxy/gmail/v1/users/me/labels");
    expect(calls[0]!.headers["base-url-override"]).toBe("https://gmail.googleapis.com");
    expect(reports.map((report) => report.toolName)).toEqual(["list_labels"]);
  });

  test("a Nango-managed Gmail app's missing scope is not available, never a consent loop", async () => {
    const authNeeded: unknown[] = [];
    const gmail = new GmailRestMcpServer({
      workspaceId: "ws_1",
      subjectId: "user:a",
      serverId: "gmail",
      connectionRef: subjectRef("nango:gmail"),
      resolveCredential: async () => ({
        status: "ok",
        headers: nangoHeaders("google-mail"),
        connectionId: "c1",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        proxy: proxy("gmail", "google-mail"),
      }),
      onAuthNeeded: (payload) => {
        authNeeded.push(payload);
      },
      fetchImpl: (async () => Response.json({})) as typeof fetch,
    });
    const result = (await gmail.callToolResult("create_label", { name: "x" })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not available");
    expect(authNeeded).toEqual([]);
  });

  test("Calendar proxies through Nango", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json({ items: [] }));
    const calendar = new GoogleCalendarRestMcpServer({
      workspaceId: "ws_1",
      subjectId: "user:a",
      serverId: "calendar",
      connectionRef: subjectRef("nango:google-calendar"),
      resolveCredential: async () => ({
        status: "ok",
        headers: nangoHeaders("google-calendar"),
        connectionId: "c1",
        proxy: proxy("google-calendar", "google-calendar"),
      }),
      fetchImpl,
    });
    await calendar.callToolResult("list_calendars", {});
    expect(
      calls[0]!.url.startsWith("https://api.nango.test/proxy/calendar/v3/users/me/calendarList"),
    ).toBe(true);
    expect(calls[0]!.headers["base-url-override"]).toBe("https://www.googleapis.com");
  });

  test("Drive serves read tools from Drive REST without the hosted MCP server", async () => {
    const { calls, fetchImpl } = recordingFetch((call) => {
      if (call.url.includes("/export"))
        return new Response("Document text", { headers: { "content-type": "text/plain" } });
      if (call.url.includes("/files/doc1"))
        return Response.json({
          id: "doc1",
          name: "Plan",
          mimeType: "application/vnd.google-apps.document",
        });
      return Response.json({ files: [{ id: "doc1", name: "Plan" }] });
    });
    let remoteCreated = false;
    const drive = new DriveMcpServer(
      { url: OFFICIAL_DRIVE_MCP_URL, connectionRef: subjectRef("nango:google-drive") },
      {
        workspaceId: "ws_1",
        subjectId: "user:a",
        serverId: "drive",
        resolveCredential: async () => ({
          status: "ok",
          headers: nangoHeaders("google-drive"),
          connectionId: "c1",
          proxy: proxy("google-drive", "google-drive"),
        }),
        fetchImpl,
        createRemoteServer: () => {
          remoteCreated = true;
          throw new Error("hosted Drive MCP must not be used under Nango");
        },
      },
    );
    expect(remoteCreated).toBe(false);
    const names = (await drive.listTools()).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_files", "read_file_content", "update_file", "list_changes"]),
    );
    expect(names).not.toContain("create_file");
    const search = await drive.callToolResult("search_files", { query: "plan's" });
    expect(search.structuredContent).toEqual({ files: [{ id: "doc1", name: "Plan" }] });
    const searchUrl = new URL(calls[0]!.url);
    expect(searchUrl.pathname).toBe("/proxy/drive/v3/files");
    expect(searchUrl.searchParams.get("q")).toContain("name contains 'plan\\'s'");
    const read = await drive.callToolResult("read_file_content", { fileId: "doc1" });
    expect(read.structuredContent).toMatchObject({ content: "Document text", truncated: false });
    expect(new URL(calls.at(-1)!.url).searchParams.get("mimeType")).toBe("text/plain");
    const bad = await drive.callToolResult("get_file_metadata", { fileId: "../x" });
    expect(bad.isError).toBe(true);
  });

  test("Drive downloads go to the agent's files, and inline base64 stays small", async () => {
    const size = 2 * 1024 * 1024;
    const { fetchImpl } = recordingFetch((call) =>
      call.url.includes("alt=media")
        ? new Response(new Uint8Array(size), { headers: { "content-type": "application/pdf" } })
        : Response.json({ id: "pdf1", name: "Report.pdf", mimeType: "application/pdf" }),
    );
    const saved: Array<{ fileName: string; bytes: number; operationId: string }> = [];
    const make = (withFiles: boolean) =>
      new DriveMcpServer(
        { url: OFFICIAL_DRIVE_MCP_URL, connectionRef: subjectRef("nango:google-drive") },
        {
          workspaceId: "ws_1",
          subjectId: "user:a",
          serverId: "drive",
          resolveCredential: async () => ({
            status: "ok",
            headers: nangoHeaders("google-drive"),
            connectionId: "c1",
            proxy: proxy("google-drive", "google-drive"),
          }),
          fetchImpl,
          createRemoteServer: () => {
            throw new Error("hosted Drive MCP must not be used under Nango");
          },
          ...(withFiles
            ? {
                materializeConnectorFile: async (request) => {
                  saved.push({
                    fileName: request.fileName,
                    bytes: request.bytes.byteLength,
                    operationId: request.operationId,
                  });
                  return { attachments: [{ path: "/files/Report.pdf" }] };
                },
              }
            : {}),
        },
      );
    const operationId = "33333333-3333-4333-8333-333333333333";
    const stored = await make(true).callToolResult(
      "download_file_content",
      { fileId: "pdf1" },
      { opengeniOperationId: operationId },
    );
    expect(stored.structuredContent).toMatchObject({
      sizeBytes: size,
      attachments: [{ path: "/files/Report.pdf" }],
    });
    expect(stored.structuredContent).not.toHaveProperty("base64Content");
    expect(saved).toEqual([{ fileName: "Report.pdf", bytes: size, operationId }]);
    const inline = await make(false).callToolResult("download_file_content", { fileId: "pdf1" });
    expect(inline.isError).toBe(true);
  });
});

describe("generic Nango tools bridge", () => {
  const ref = subjectRef("nango:linkedin");
  const url = "https://nango.opengeni.invalid/tools/linkedin";
  const functions = {
    data: [
      {
        type: "tool",
        name: "create-post",
        description: "Create a LinkedIn post",
        input_json_schema: { type: "object", properties: { text: { type: "string" } } },
      },
      {
        type: "tool",
        name: "get-profile",
        description: "Read the profile",
        input_json_schema: { type: "object" },
      },
      {
        type: "action",
        name: "delete-post",
        description: "Delete a post",
        json_schema: { type: "object" },
      },
      { type: "sync", name: "posts" },
    ],
    pagination: { total: 4 },
  };

  function bridge(respond: (call: Call) => Response, definitions = new Map()) {
    const recorded = recordingFetch(respond);
    const reports: NangoUsageReport[] = [];
    const server = new NangoToolsMcpServer(
      { url, connectionRef: ref },
      {
        workspaceId: "ws_1",
        subjectId: "user:a",
        serverId: "linkedin",
        resolveCredential: async () => ({
          status: "ok",
          headers: nangoHeaders("linkedin"),
          connectionId: "c1",
          proxy: proxy("linkedin", "linkedin"),
        }),
        fetchImpl: recorded.fetchImpl,
        recordNangoUsage: (report) => reports.push(report),
        nangoIntegrationDefinitions: definitions,
      },
    );
    return { server, reports, ...recorded };
  }

  test("matches only its own synthetic identity and Nango domain", () => {
    expect(NANGO_TOOLS_MCP_BRIDGE_ADAPTER.matches({ url, connectionRef: ref })).toBe(true);
    expect(
      NANGO_TOOLS_MCP_BRIDGE_ADAPTER.matches({ url, connectionRef: subjectRef("nango:x") }),
    ).toBe(false);
    expect(
      NANGO_TOOLS_MCP_BRIDGE_ADAPTER.matches({
        url: "https://example.com/mcp",
        connectionRef: ref,
      }),
    ).toBe(false);
  });

  test("lists Nango tools filtered by the allowlist and classified for approvals", async () => {
    const { server } = bridge(
      () => Response.json(functions),
      new Map([
        [
          "linkedin",
          {
            tools: {
              source: "nango" as const,
              allow: ["create-post", "get-profile"],
              read: ["get-profile"],
            },
          },
        ],
      ]),
    );
    const tools = await server.listTools();
    expect(
      tools.map((tool) => [
        tool.name,
        tool.annotations?.readOnlyHint,
        tool.annotations?.destructiveHint,
      ]),
    ).toEqual([
      ["create-post", false, true],
      ["get-profile", true, false],
    ]);
    expect(tools[0]!.description).toBe("Create a LinkedIn post");
    expect(tools[0]!.inputSchema).toMatchObject({ properties: { text: { type: "string" } } });
  });

  test("executes through the tool call endpoint and records usage", async () => {
    const { server, calls, reports } = bridge((call) =>
      call.url.includes("/functions")
        ? Response.json(functions)
        : Response.json({ id: "urn:li:share:1" }),
    );
    const result = await server.callToolResult("create-post", { text: "Hello" });
    expect(result.structuredContent).toEqual({ id: "urn:li:share:1" });
    const call = calls.at(-1)!;
    expect(call.url).toBe("https://api.nango.test/connections/nc-1/tools/create-post/calls");
    expect(call.method).toBe("POST");
    expect(call.headers["provider-config-key"]).toBe("linkedin");
    expect(call.body).toBe(JSON.stringify({ input: { text: "Hello" } }));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "tool_call",
      toolName: "create-post",
      httpStatus: 200,
    });
  });

  test("a write that may have reached Nango is never reported as not executed", async () => {
    const { server } = bridge((call) => {
      if (call.url.includes("/functions")) return Response.json(functions);
      throw new Error("socket closed");
    });
    await expect(server.callToolResult("create-post", { text: "Hello" })).rejects.toMatchObject({
      connectorActionOutcome: "uncertain",
    });
    const read = await server.callToolResult("unknown-tool", {});
    expect(read.isError).toBe(true);
  });

  test("a write answered 5xx or with a runtime error is sent once and reported uncertain", async () => {
    for (const failure of [
      () => Response.json({ error: { code: "server_error" } }, { status: 502 }),
      () => Response.json({ error: { code: "function_runtime_error" } }, { status: 400 }),
      () => Response.json({ error: { code: "conflict" } }, { status: 409 }),
    ]) {
      const { server, calls } = bridge((call) =>
        call.url.includes("/functions") ? Response.json(functions) : failure(),
      );
      await expect(server.callToolResult("create-post", { text: "Hi" })).rejects.toMatchObject({
        connectorActionOutcome: "uncertain",
      });
      expect(calls.filter((call) => call.url.endsWith("/tools/create-post/calls"))).toHaveLength(1);
    }
  });

  test("a clear refusal before the function ran is reported as an ordinary failure", async () => {
    for (const refusal of [
      () =>
        Response.json(
          { error: { code: "invalid_input", message: "text is required" } },
          {
            status: 400,
          },
        ),
      () => Response.json({ error: { code: "unknown_connection" } }, { status: 404 }),
      () => new Response("", { status: 401 }),
    ]) {
      const { server } = bridge((call) =>
        call.url.includes("/functions") ? Response.json(functions) : refusal(),
      );
      const result = await server.callToolResult("create-post", { text: "" });
      expect(result.isError).toBe(true);
    }
  });

  test("a successful write with an oversized output still reads as completed", async () => {
    const { server } = bridge((call) =>
      call.url.includes("/functions")
        ? Response.json(functions)
        : new Response("x".repeat(4 * 1024 * 1024 + 10), { status: 200 }),
    );
    const result = await server.callToolResult("create-post", { text: "Hi" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ completed: true, outputOmitted: true });
  });
});

describe("Nango-managed Google scopes", () => {
  test("the managed apps' fixed scopes admit every reviewed tool, so no consent loop starts", () => {
    const gmail = nativeNangoIntegrationByKey("gmail")!.managedScopes;
    for (const name of [
      "search_threads",
      "get_thread",
      "create_draft",
      "send_draft",
      "list_drafts",
      ...GMAIL_EXTRA_TOOLS.map((tool) => tool.name),
    ]) {
      expect(gmailToolSupportsScopes(name, gmail)).toBe(true);
    }
    const calendar = nativeNangoIntegrationByKey("google-calendar")!.managedScopes;
    for (const tool of GOOGLE_CALENDAR_REST_MCP_TOOLS) {
      expect(googleCalendarToolSupportsScopes(tool.name, calendar)).toBe(true);
    }
    expect(nativeNangoIntegrationByKey("google-drive")!.managedScopes).toEqual([
      "https://www.googleapis.com/auth/drive",
    ]);
  });
});

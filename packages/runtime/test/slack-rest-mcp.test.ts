import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_REST_USER_SCOPES,
  normalizeSlackScopes,
  slackRestMcpToolsForScopes,
} from "@opengeni/contracts/slack-rest-mcp";
import {
  OFFICIAL_SLACK_MCP_URL,
  SLACK_REST_MCP_BRIDGE_ADAPTER,
  SLACK_REST_MCP_BRIDGE_DESCRIPTOR,
  SlackRestMcpServer,
  isOfficialSlackMcpConfig,
  type SlackRestMcpServerOptions,
} from "../src/slack-rest-mcp";

const connectionRef = {
  providerDomain: "slack.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
  connectionId: "conn_1",
};
const allScopes = [...OPENGENI_SLACK_REST_USER_SCOPES];
const identity = { ok: true, team_id: "T123", user_id: "U123" };
function server(input: Partial<SlackRestMcpServerOptions> = {}) {
  return new SlackRestMcpServer({
    workspaceId: "ws_1",
    subjectId: "subject-a",
    serverId: "slack",
    connectionRef,
    resolveCredential: async () => ({
      status: "ok",
      headers: { authorization: "Bearer user-token" },
      connectionId: "conn_1",
      grantedScopes: allScopes,
    }),
    slackRateLimit: async () => 0,
    fetchImpl: async (url) =>
      Response.json(
        new URL(url.toString()).pathname.endsWith("auth.test") ? identity : { ok: true },
      ),
    ...input,
  });
}
function method(input: string | URL | Request) {
  return new URL(input instanceof Request ? input.url : input.toString()).pathname
    .split("/")
    .at(-1);
}

describe("Slack API-backed MCP pilot", () => {
  test("matches only the exact Slack catalog and ordinary OAuth connection", () => {
    expect(
      SLACK_REST_MCP_BRIDGE_ADAPTER.matches({ url: OFFICIAL_SLACK_MCP_URL, connectionRef }),
    ).toBe(true);
    expect(isOfficialSlackMcpConfig(`${OFFICIAL_SLACK_MCP_URL}/`, connectionRef)).toBe(true);
    for (const url of [
      "https://evil.test/mcp",
      "https://mcp.slack.com/other",
      `${OFFICIAL_SLACK_MCP_URL}?url=evil`,
      "https://mcp.slack.com.evil.test/mcp",
      "https://user@mcp.slack.com/mcp",
    ]) {
      expect(isOfficialSlackMcpConfig(url, connectionRef)).toBe(false);
    }
    expect(
      isOfficialSlackMcpConfig(OFFICIAL_SLACK_MCP_URL, { ...connectionRef, kind: "api_key" }),
    ).toBe(false);
    expect(
      isOfficialSlackMcpConfig(OFFICIAL_SLACK_MCP_URL, {
        ...connectionRef,
        providerDomain: "evil.test",
      }),
    ).toBe(false);
    expect(
      isOfficialSlackMcpConfig(OFFICIAL_SLACK_MCP_URL, {
        ...connectionRef,
        subjectScope: "workspace",
      }),
    ).toBe(true);
    expect(server().bridge).toBe(SLACK_REST_MCP_BRIDGE_DESCRIPTOR);
    expect(server().bridge).toMatchObject({
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [
        { origin: "https://slack.com", pathPrefix: "/api/" },
        { origin: "https://files.slack.com", pathPrefix: "/files-pri/" },
      ],
    });
  });

  test("normalizes existing comma-joined grants and exposes only granted reviewed tools", async () => {
    expect(normalizeSlackScopes(["users:read,chat:write", " users:read im:write "])).toEqual([
      "chat:write",
      "im:write",
      "users:read",
    ]);
    const tools = slackRestMcpToolsForScopes(["users:read,chat:write"]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "slack_list_users",
      "slack_get_user_info",
      "slack_send_message",
    ]);
    expect(tools.find((tool) => tool.name === "slack_send_message")?.annotations.readOnlyHint).toBe(
      false,
    );
    expect(tools.find((tool) => tool.name === "slack_list_users")?.annotations.readOnlyHint).toBe(
      true,
    );
    expect(slackRestMcpToolsForScopes([])).toEqual([]);
    expect((await server().listTools()).map((tool) => tool.name)).toEqual([
      "slack_list_channels",
      "slack_get_channel_info",
      "slack_list_channel_members",
      "slack_list_users",
      "slack_get_user_info",
      "slack_read_channel",
      "slack_read_thread",
      "slack_download_file",
      "slack_open_dm",
      "slack_send_message",
    ]);
  });

  test("connect verifies a user token without requiring a bot or the hosted MCP endpoint", async () => {
    const requests: Request[] = [];
    let authorizations = 0;
    const slack = server({
      resolveCredential: async () => ({
        status: "ok",
        connectionId: "conn_1",
        headers: { authorization: "Bearer personal-token" },
        grantedScopes: allScopes,
        authorizeProviderRequest: async () => {
          authorizations++;
          return true;
        },
      }),
      fetchImpl: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json(identity);
      },
    });
    await slack.connect();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://slack.com/api/auth.test");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer personal-token");
    expect(requests[0]!.redirect).toBe("error");
    expect(authorizations).toBe(1);
  });

  test("rejects bot tokens and grants without known permissions", async () => {
    await expect(
      server({ fetchImpl: async () => Response.json({ ...identity, bot_id: "B123" }) }).connect(),
    ).rejects.toThrow("valid user account");
    let requests = 0;
    await expect(
      server({
        resolveCredential: async () => ({ status: "ok", connectionId: "conn_1", headers: {} }),
        fetchImpl: async () => {
          requests++;
          return Response.json(identity);
        },
      }).connect(),
    ).rejects.toThrow("granted permissions are unavailable");
    expect(requests).toBe(0);
  });

  test.each([
    ["subject", undefined, 0],
    ["subject", "subject-a", 1],
    ["workspace", undefined, 1],
    [undefined, undefined, 1],
  ] as const)(
    "reports recovery for %s grants with owner %s only when that authority can recover",
    async (subjectScope, subjectId, expectedEvents) => {
      const events: unknown[] = [];
      let requests = 0;
      const slack = server({
        connectionRef: { ...connectionRef, subjectScope },
        subjectId,
        resolveCredential: async (request) => {
          expect(request.subjectId).toBe(subjectId);
          return {
            status: "auth_needed",
            reason: "missing_connection",
            providerDomain: "slack.com",
          };
        },
        onAuthNeeded: (payload) => {
          events.push(payload);
        },
        fetchImpl: async () => {
          requests++;
          throw new Error("Missing authority cannot reach Slack");
        },
      });
      await expect(slack.connect()).rejects.toThrow("Authentication required for Slack");
      expect(requests).toBe(0);
      expect(events).toHaveLength(expectedEvents);
      if (expectedEvents) {
        expect(events).toEqual([
          {
            serverId: "slack",
            providerDomain: "slack.com",
            reason: "missing_connection",
            ...(subjectId ? { subjectId } : {}),
          },
        ]);
      }
    },
  );

  test("maps each reviewed tool to its fixed Web API method with fresh exact credentials", async () => {
    const requests: Request[] = [];
    const resolves: Parameters<SlackRestMcpServerOptions["resolveCredential"]>[0][] = [];
    let authorizations = 0;
    const slack = server({
      resolveCredential: async (request) => {
        resolves.push(request);
        return {
          status: "ok",
          connectionId: "conn_1",
          headers: { authorization: "Bearer exact-user" },
          grantedScopes: allScopes,
          authorizeProviderRequest: async () => {
            authorizations++;
            return true;
          },
        };
      },
      fetchImpl: async (url, init) => {
        const request = new Request(url, init);
        requests.push(request);
        return Response.json(
          method(url) === "auth.test"
            ? identity
            : {
                ok: true,
                channels: [],
                user: {},
                messages: [],
                channel: "C123",
                ts: "123.456",
                message: { text: "hello" },
              },
        );
      },
    });
    const operations = [
      ["slack_list_channels", {}, "conversations.list"],
      ["slack_get_channel_info", { channel: "C123" }, "conversations.info"],
      ["slack_list_channel_members", { channel: "C123" }, "conversations.members"],
      ["slack_list_users", {}, "users.list"],
      ["slack_get_user_info", { user: "U456" }, "users.info"],
      ["slack_read_channel", { channel: "C123" }, "conversations.history"],
      ["slack_read_thread", { channel: "C123", ts: "123.456" }, "conversations.replies"],
      ["slack_open_dm", { user: "U456" }, "conversations.open"],
      [
        "slack_send_message",
        { channel: "C123", text: "hello", thread_ts: "123.456" },
        "chat.postMessage",
      ],
    ] as const;
    for (const [name, input, target] of operations) {
      const result = await slack.callToolResult(name, input);
      expect(result.isError).not.toBe(true);
      expect(method(requests.at(-1)!)).toBe(target);
      expect(JSON.stringify(result)).not.toContain("exact-user");
    }
    expect(requests).toHaveLength(18);
    expect(authorizations).toBe(18);
    expect(resolves).toHaveLength(18);
    expect(
      resolves.every(
        (request) =>
          request.workspaceId === "ws_1" &&
          request.subjectId === "subject-a" &&
          request.connectionRef.connectionId === "conn_1",
      ),
    ).toBe(true);
    const sent = requests.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(await sent.json()).toEqual({
      channel: "C123",
      text: "hello",
      thread_ts: "123.456",
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(requests.find((request) => method(request) === "conversations.history")!.url).toContain(
      "limit=15",
    );
  });

  test("limits conversation listing to granted conversation types", async () => {
    const urls: URL[] = [];
    const slack = server({
      resolveCredential: async () => ({
        status: "ok",
        connectionId: "conn_1",
        headers: {},
        grantedScopes: ["channels:read"],
      }),
      fetchImpl: async (url) => {
        urls.push(new URL(url.toString()));
        return Response.json(method(url) === "auth.test" ? identity : { ok: true, channels: [] });
      },
    });
    expect((await slack.callToolResult("slack_list_channels", {})).isError).not.toBe(true);
    expect(urls.at(-1)!.searchParams.get("types")).toBe("public_channel");
    const count = urls.length;
    expect(
      (await slack.callToolResult("slack_list_channels", { types: ["private_channel"] })).isError,
    ).toBe(true);
    expect(urls.length).toBe(count + 1); // Identity verification only; no unauthorized listing.
  });

  test("reads a single page and returns its cursor without automatically fetching another", async () => {
    let reads = 0;
    const slack = server({
      fetchImpl: async (url) => {
        if (method(url) === "auth.test") return Response.json(identity);
        reads++;
        expect(new URL(url.toString()).searchParams.get("limit")).toBe("15");
        return Response.json({
          ok: true,
          messages: [{ ts: "123.456", text: "message" }],
          has_more: true,
          response_metadata: { next_cursor: "next-page" },
        });
      },
    });
    const result = await slack.callToolResult("slack_read_channel", { channel: "C123" });
    expect(result.structuredContent).toMatchObject({
      has_more: true,
      response_metadata: { next_cursor: "next-page" },
    });
    expect(reads).toBe(1);
  });

  test.each([
    ["slack_read_channel", { channel: "C123", limit: 16 }],
    ["slack_read_thread", { channel: "C123", ts: "not-a-ts" }],
    ["slack_send_message", { channel: "https://evil.test", text: "hello" }],
    ["slack_send_message", { channel: "C123", text: "hello", connectionId: "another-person" }],
    ["slack_list_channels", { types: ["constructor"] }],
    ["slack_list_users", { url: "https://evil.test" }],
    ["slack_search_messages", { query: "all" }],
  ])("rejects invalid or unreviewed %s before any provider request", async (toolName, args) => {
    let requests = 0;
    const slack = server({
      fetchImpl: async () => {
        requests++;
        return Response.json(identity);
      },
    });
    expect(
      (await slack.callToolResult(toolName as string, args as Record<string, unknown>)).isError,
    ).toBe(true);
    expect(requests).toBe(0);
  });

  test("stops a revoked exact owner before using an alternative account", async () => {
    let requests = 0;
    const events: unknown[] = [];
    const slack = server({
      resolveCredential: async (request) => {
        expect(request.connectionRef.connectionId).toBe("conn_1");
        return {
          status: "auth_needed",
          reason: "personal_authority_unavailable",
          providerDomain: "slack.com",
          connectionId: "conn_1",
        };
      },
      onAuthNeeded: (payload) => {
        events.push(payload);
      },
      fetchImpl: async () => {
        requests++;
        return Response.json({ ok: true });
      },
    });
    expect(
      (await slack.callToolResult("slack_send_message", { channel: "C123", text: "hello" }))
        .isError,
    ).toBe(true);
    expect(requests).toBe(0);
    expect(events).toMatchObject([
      {
        reason: "personal_authority_unavailable",
        connectionId: "conn_1",
        subjectId: "subject-a",
        toolName: "slack_send_message",
      },
    ]);
  });

  test("checks physical request authority after credential resolution", async () => {
    let authorizations = 0;
    const requests: string[] = [];
    const slack = server({
      resolveCredential: async () => ({
        status: "ok",
        headers: {},
        connectionId: "conn_1",
        grantedScopes: allScopes,
        authorizeProviderRequest: async () => ++authorizations === 1,
      }),
      fetchImpl: async (url) => {
        requests.push(method(url)!);
        return Response.json(identity);
      },
    });
    expect(
      (await slack.callToolResult("slack_send_message", { channel: "C123", text: "hello" }))
        .isError,
    ).toBe(true);
    expect(requests).toEqual(["auth.test"]);
  });

  test("pins the verified Slack user and team throughout the attempt", async () => {
    let identities = 0;
    let writes = 0;
    const slack = server({
      fetchImpl: async (url) => {
        if (method(url) === "auth.test")
          return Response.json(
            ++identities === 1 ? identity : { ...identity, team_id: "T999", user_id: "U999" },
          );
        writes++;
        return Response.json({ ok: true });
      },
    });
    await slack.connect();
    const result = await slack.callToolResult("slack_send_message", {
      channel: "C123",
      text: "hello",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("account changed");
    expect(writes).toBe(0);
  });

  test.each(["http", "json"])(
    "refreshes one safe read after %s authentication failure",
    async (kind) => {
      const refreshes: boolean[] = [];
      let reads = 0;
      const slack = server({
        resolveCredential: async (input) => {
          refreshes.push(input.forceRefresh === true);
          return { status: "ok", connectionId: "conn_1", headers: {}, grantedScopes: allScopes };
        },
        fetchImpl: async (url) => {
          if (method(url) === "auth.test") return Response.json(identity);
          return ++reads === 1
            ? kind === "http"
              ? new Response(null, { status: 401 })
              : Response.json({ ok: false, error: "token_expired" })
            : Response.json({ ok: true, members: [] });
        },
      });
      expect((await slack.callToolResult("slack_list_users", {})).isError).not.toBe(true);
      expect(reads).toBe(2);
      expect(refreshes).toEqual([false, false, true]);
    },
  );

  test.each(["http", "json", "transport", "body", "server", "internal_error", "fatal_error"])(
    "never replays a submitted mutation after %s failure",
    async (failure) => {
      const refreshes: boolean[] = [];
      let sends = 0;
      const slack = server({
        resolveCredential: async (input) => {
          refreshes.push(input.forceRefresh === true);
          return { status: "ok", connectionId: "conn_1", headers: {}, grantedScopes: allScopes };
        },
        fetchImpl: async (url) => {
          if (method(url) === "auth.test") return Response.json(identity);
          sends++;
          if (failure === "transport")
            throw new Error("transport failed with confidential response data");
          if (failure === "http") return new Response(null, { status: 401 });
          if (failure === "json") return Response.json({ ok: false, error: "token_expired" });
          if (failure === "body") return new Response("<invalid response>");
          if (failure === "internal_error" || failure === "fatal_error")
            return Response.json({ ok: false, error: failure });
          return Response.json({ ok: false, error: "fatal_error" }, { status: 503 });
        },
      });
      await expect(
        slack.callToolResult("slack_send_message", { channel: "C123", text: "hello" }),
      ).rejects.toMatchObject({
        code: "slack_mutation_outcome_unknown",
        outcome: "unknown",
        retryable: false,
        message: expect.stringContaining("Check Slack before sending again."),
      });
      expect(sends).toBe(1);
      expect(refreshes).toEqual([false, false]);
    },
  );

  test.each(["channel_not_found", "missing_scope"])(
    "keeps a definitive mutation rejection %s as an ordinary provider error",
    async (providerError) => {
      let sends = 0;
      const refreshes: boolean[] = [];
      const slack = server({
        resolveCredential: async (input) => {
          refreshes.push(input.forceRefresh === true);
          return { status: "ok", connectionId: "conn_1", headers: {}, grantedScopes: allScopes };
        },
        fetchImpl: async (url) => {
          if (method(url) === "auth.test") return Response.json(identity);
          sends++;
          return Response.json({ ok: false, error: providerError });
        },
      });
      const result = await slack.callToolResult("slack_send_message", {
        channel: "C123",
        text: "hello",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(providerError);
      expect(result.content[0].text).not.toContain("outcome is uncertain");
      expect(sends).toBe(1);
      expect(refreshes).toEqual([false, false]);
    },
  );

  test.each(["internal_error", "fatal_error"])(
    "keeps a safe-read %s as an ordinary provider error",
    async (providerError) => {
      let reads = 0;
      const slack = server({
        fetchImpl: async (url) => {
          if (method(url) === "auth.test") return Response.json(identity);
          reads++;
          return Response.json({ ok: false, error: providerError });
        },
      });
      const result = await slack.callToolResult("slack_list_users", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(providerError);
      expect(result.content[0].text).not.toContain("outcome is uncertain");
      expect(reads).toBe(1);
    },
  );

  test("requires shared quota admission for history and returns actionable wait without dispatch", async () => {
    let historyReads = 0;
    const quotas: unknown[] = [];
    const slack = server({
      slackRateLimit: async (team, target) => {
        quotas.push([team, target]);
        return target === "conversations.history" ? 37 : 0;
      },
      fetchImpl: async (url) => {
        if (method(url) !== "auth.test") historyReads++;
        return Response.json(identity);
      },
    });
    const result = await slack.callToolResult("slack_read_channel", { channel: "C123" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "rate_limited",
      method: "conversations.history",
      retryAfterSeconds: 37,
    });
    expect(quotas).toEqual([["T123", "conversations.history"]]);
    expect(historyReads).toBe(0);
    expect(
      (
        await server({ slackRateLimit: undefined }).callToolResult("slack_read_thread", {
          channel: "C123",
          ts: "123.456",
        })
      ).isError,
    ).toBe(true);
  });

  test("records a provider Retry-After for the shared workspace/method without retrying", async () => {
    const quotas: unknown[] = [];
    let sends = 0;
    const slack = server({
      slackRateLimit: async (...args) => {
        quotas.push(args);
        return 0;
      },
      fetchImpl: async (url) => {
        if (method(url) === "auth.test") return Response.json(identity);
        sends++;
        return new Response(null, { status: 429, headers: { "retry-after": "81" } });
      },
    });
    const result = await slack.callToolResult("slack_send_message", {
      channel: "C123",
      text: "hello",
    });
    expect(result.structuredContent).toEqual({
      error: "rate_limited",
      method: "chat.postMessage",
      retryAfterSeconds: 81,
    });
    expect(quotas).toEqual([
      ["T123", "chat.postMessage"],
      ["T123", "chat.postMessage", 81],
    ]);
    expect(sends).toBe(1);
  });

  test("rejects oversized provider responses while preserving mutation uncertainty", async () => {
    const slack = server({
      fetchImpl: async (url) =>
        Response.json(
          method(url) === "auth.test"
            ? identity
            : { ok: true, message: { text: "a".repeat(2 * 1024 * 1024) } },
        ),
    });
    await expect(
      slack.callToolResult("slack_send_message", { channel: "C123", text: "hello" }),
    ).rejects.toMatchObject({ outcome: "unknown", retryable: false });
  });
});

describe("Slack file download", () => {
  const operationId = "6f1c1f5e-2f4b-4c7a-9a7e-1d2c3b4a5f60";
  const meta = { opengeniOperationId: operationId };
  const fileUrl = "https://files.slack.com/files-pri/T123-F0ABC/download/report.pdf";
  const pdf = new TextEncoder().encode("%PDF-1.7 exact bytes");
  const fileInfo = (overrides: Record<string, unknown> = {}) => ({
    ok: true,
    file: {
      id: "F0ABC",
      name: "report.pdf",
      title: "Report",
      mimetype: "application/pdf",
      size: pdf.byteLength,
      url_private: fileUrl.replace("/download", ""),
      url_private_download: fileUrl,
      ...overrides,
    },
  });
  function downloadServer(input: {
    info?: Record<string, unknown>;
    file?: (url: URL, init?: RequestInit) => Response;
    scopes?: string[];
  }) {
    const destinations: string[] = [];
    const fetched: Array<{ url: string; authorization: string | null; redirect?: string }> = [];
    const materialized: Array<Record<string, unknown>> = [];
    const slack = server({
      resolveCredential: async (request) => {
        destinations.push(request.destinationUrl);
        return {
          status: "ok",
          headers: { authorization: "Bearer user-token" },
          connectionId: "conn_1",
          grantedScopes: input.scopes ?? allScopes,
        };
      },
      fetchImpl: async (raw, init) => {
        const url = new URL(raw instanceof Request ? raw.url : raw.toString());
        if (url.origin === "https://slack.com") {
          if (method(url) === "auth.test") return Response.json(identity);
          if (method(url) === "files.info") return Response.json(input.info ?? fileInfo());
          throw new Error(`unexpected Slack method ${url}`);
        }
        fetched.push({
          url: url.toString(),
          authorization: new Headers(init?.headers).get("authorization"),
          ...(init?.redirect ? { redirect: init.redirect } : {}),
        });
        return input.file
          ? input.file(url, init)
          : new Response(pdf, { headers: { "content-type": "application/pdf" } });
      },
      materializeConnectorFile: async (request) => {
        materialized.push({ ...request, bytes: Buffer.from(request.bytes).toString() });
        return {
          attachments: [
            {
              providerAttachmentId: request.providerAttachmentId,
              fileName: request.fileName,
              mediaType: request.mediaType,
              byteSize: request.bytes.byteLength,
              contentSha256: "a".repeat(64),
              sandboxPath: `.opengeni/connector-attachments/slack/${"b".repeat(32)}/${request.fileName}`,
            },
          ],
        };
      },
    });
    return { slack, destinations, fetched, materialized };
  }

  test("is offered only when Slack granted file access", () => {
    expect(
      slackRestMcpToolsForScopes(["channels:history"]).some(
        (tool) => tool.name === "slack_download_file",
      ),
    ).toBe(false);
    const [tool] = slackRestMcpToolsForScopes(["files:read"]);
    expect(tool?.name).toBe("slack_download_file");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(OPENGENI_SLACK_REST_USER_SCOPES).toContain("files:read");
  });

  test("delivers a shared file into the workspace without exposing bytes or private URLs", async () => {
    const { slack, destinations, fetched, materialized } = downloadServer({});
    const result = await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta);
    expect(result.isError).toBeUndefined();
    expect(fetched).toEqual([
      { url: fileUrl, authorization: "Bearer user-token", redirect: "manual" },
    ]);
    expect(destinations).toContain("https://slack.com/api/files.info");
    expect(destinations).toContain(fileUrl);
    expect(materialized).toEqual([
      expect.objectContaining({
        serverId: "slack",
        toolName: "slack_download_file",
        connectionId: "conn_1",
        operationId,
        providerAttachmentId: { provider: "slack", kind: "attachment", value: "file:T123:F0ABC" },
        fileName: "report.pdf",
        mediaType: "application/pdf",
        bytes: "%PDF-1.7 exact bytes",
      }),
    ]);
    expect(result.structuredContent).toMatchObject({
      file: { id: "F0ABC", name: "report.pdf", mimetype: "application/pdf", size: pdf.byteLength },
      attachments: [
        { sandboxPath: expect.stringMatching(/^\.opengeni\/connector-attachments\/slack\//u) },
      ],
    });
    const visible = JSON.stringify(result);
    expect(visible).not.toContain("files-pri");
    expect(visible).not.toContain("user-token");
    expect(visible).not.toContain("%PDF");
  });

  test("revalidates the same connection before materializing", async () => {
    let calls = 0;
    const { slack } = downloadServer({});
    const original = (slack as unknown as { options: SlackRestMcpServerOptions }).options;
    original.materializeConnectorFile = async (request) => {
      calls++;
      expect(await request.authorizeProviderRequest()).toBe(true);
      return { attachments: [{}] };
    };
    await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta);
    expect(calls).toBe(1);
  });

  test("refuses before any Slack request without a trusted operation or filesystem", async () => {
    const { slack, fetched, materialized } = downloadServer({});
    for (const untrusted of [undefined, {}, { opengeniOperationId: "not-a-uuid" }]) {
      const result = await slack.callToolResult(
        "slack_download_file",
        { file: "F0ABC" },
        untrusted,
      );
      expect(result).toMatchObject({ isError: true });
    }
    const withoutFilesystem = server({
      fetchImpl: async () => {
        throw new Error("must not reach Slack");
      },
    });
    expect(
      await withoutFilesystem.callToolResult("slack_download_file", { file: "F0ABC" }, meta),
    ).toMatchObject({
      isError: true,
      content: [
        { text: "Slack file download requires an available agent filesystem in this chat." },
      ],
    });
    expect(
      await slack.callToolResult("slack_download_file", { file: "../F0ABC" }, meta),
    ).toMatchObject({ isError: true, content: [{ text: "file must be a Slack file ID" }] });
    expect(fetched).toEqual([]);
    expect(materialized).toEqual([]);
  });

  test("never sends the user token to a file URL outside Slack's private file host", async () => {
    for (const url of [
      "https://evil.test/files-pri/T123-F0ABC/download/report.pdf",
      "https://files.slack.com.evil.test/files-pri/T123-F0ABC/report.pdf",
      "https://files.slack.com/other/report.pdf",
      "http://files.slack.com/files-pri/T123-F0ABC/report.pdf",
    ]) {
      const { slack, fetched } = downloadServer({
        info: fileInfo({ url_private_download: url, url_private: url }),
      });
      const result = await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta);
      expect(result).toMatchObject({
        isError: true,
        content: [{ text: "Slack did not provide a downloadable copy of this file." }],
      });
      expect(fetched).toEqual([]);
    }
  });

  test("reports missing access instead of saving Slack's sign-in page", async () => {
    const signIn = downloadServer({
      file: () =>
        new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }),
    });
    const redirect = downloadServer({
      file: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://slack.com/?redir=%2Ffiles-pri%2FT123-F0ABC" },
        }),
    });
    for (const { slack, materialized } of [signIn, redirect]) {
      expect(
        await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta),
      ).toMatchObject({
        isError: true,
        content: [
          {
            text: "Slack did not return the file. The connected account may not have access to it.",
          },
        ],
      });
      expect(materialized).toEqual([]);
    }
    expect(redirect.fetched).toHaveLength(1);
  });

  test("follows one redirect within the private file host only", async () => {
    const next = "https://files.slack.com/files-pri/T123-F0ABC/report.pdf?origin=1";
    const { slack, fetched, materialized } = downloadServer({
      file: (url) =>
        url.toString() === fileUrl
          ? new Response(null, { status: 302, headers: { location: next } })
          : new Response(pdf, { headers: { "content-type": "application/pdf" } }),
    });
    const result = await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta);
    expect(result.isError).toBeUndefined();
    expect(fetched.map((entry) => entry.url)).toEqual([fileUrl, next]);
    expect(materialized).toHaveLength(1);
  });

  test("rejects external, deleted and oversized files without downloading", async () => {
    for (const [overrides, text] of [
      [
        { is_external: true },
        "This Slack file is a link to an external service, so Slack has no copy to download.",
      ],
      [{ mode: "tombstone" }, "This Slack file was deleted."],
      [{ size: 50 * 1024 * 1024 + 1 }, "Slack file exceeds the 50 MiB download limit."],
    ] as const) {
      const { slack, fetched } = downloadServer({ info: fileInfo(overrides) });
      expect(
        await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta),
      ).toMatchObject({ isError: true, content: [{ text }] });
      expect(fetched).toEqual([]);
    }
  });

  test("is unavailable to a grant without file access", async () => {
    const { slack, fetched } = downloadServer({ scopes: ["channels:history"] });
    expect(
      await slack.callToolResult("slack_download_file", { file: "F0ABC" }, meta),
    ).toMatchObject({
      isError: true,
      content: [
        {
          text: "Slack has not granted access to slack_download_file. Reconnect to grant the required permissions.",
        },
      ],
    });
    expect(fetched).toEqual([]);
  });
});

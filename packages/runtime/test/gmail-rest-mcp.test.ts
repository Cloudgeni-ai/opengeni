import { describe, expect, test } from "bun:test";
import {
  GMAIL_REST_MCP_TOOLS,
  GmailRestMcpServer,
  OFFICIAL_GMAIL_MCP_URL,
  isOfficialGmailMcpConfig,
  type GmailRestMcpServerOptions,
} from "../src/gmail-rest-mcp";

const connectionRef = {
  providerDomain: "gmailmcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};

function server(input: {
  fetchImpl: typeof fetch;
  resolveCredential?: GmailRestMcpServerOptions["resolveCredential"];
}) {
  return new GmailRestMcpServer({
    workspaceId: "ws_1",
    subjectId: "subject-a",
    serverId: "gmail",
    connectionRef,
    resolveCredential:
      input.resolveCredential ??
      (async () => ({
        status: "ok" as const,
        headers: { authorization: "Bearer gmail-token" },
        connectionId: "conn_1",
      })),
    fetchImpl: input.fetchImpl,
  });
}

describe("Gmail REST MCP adapter", () => {
  test("exposes exactly the reviewed tool set, including the send tools the hosted preview MCP lacks", () => {
    expect(GMAIL_REST_MCP_TOOLS.map((tool) => tool.name).sort()).toEqual(
      [
        "create_draft",
        "send_message",
        "send_draft",
        "get_message",
        "get_thread",
        "label_message",
        "label_thread",
        "list_drafts",
        "list_labels",
        "search_threads",
        "unlabel_message",
        "unlabel_thread",
      ].sort(),
    );
  });

  test("projects and paginates user labels through users/me without exposing the token", async () => {
    let request: Request | null = null;
    const gmail = server({
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "Label_1", name: "Projects", type: "user", threadsTotal: 7 },
            { id: "Label_2", name: "Receipts", type: "user", threadsUnread: 2 },
          ],
        });
      },
    });
    const first = (await gmail.callToolResult("list_labels", { pageSize: 1 })) as {
      content: Array<{ text: string }>;
    };
    expect(request!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    expect(request!.headers.get("authorization")).toBe("Bearer gmail-token");
    expect(JSON.parse(first.content[0]!.text)).toEqual({
      labels: [{ labelId: "Label_1", name: "Projects", threadsTotal: 7 }],
      nextPageToken: "opengeni-rest:1",
    });
    const second = (await gmail.callToolResult("list_labels", {
      pageSize: 1,
      pageToken: "opengeni-rest:1",
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(second.content[0]!.text)).toEqual({
      labels: [{ labelId: "Label_2", name: "Receipts", threadsUnread: 2 }],
    });
    expect(JSON.stringify([first, second])).not.toContain("gmail-token");
  });

  test("connect resolves credentials without recording a provider request", async () => {
    let providerAuthorizations = 0;
    let requests = 0;
    const gmail = server({
      resolveCredential: async () => ({
        status: "ok",
        headers: { authorization: "Bearer gmail-token" },
        connectionId: "conn_1",
        authorizeProviderRequest: async () => {
          providerAuthorizations += 1;
          return true;
        },
      }),
      fetchImpl: async () => {
        requests += 1;
        return Response.json({});
      },
    });

    await gmail.connect();
    expect(providerAuthorizations).toBe(0);
    expect(requests).toBe(0);
  });

  test("refreshes and retries a read once after 401", async () => {
    let resolves = 0;
    let requests = 0;
    let providerAuthorizations = 0;
    const gmail = server({
      resolveCredential: async (input) => {
        resolves += 1;
        expect(input.destinationUrl).toStartWith("https://gmail.googleapis.com/gmail/v1/users/me/");
        return {
          status: "ok",
          headers: { authorization: `Bearer token-${resolves}` },
          connectionId: "conn_1",
          authorizeProviderRequest: async () => {
            providerAuthorizations += 1;
            return true;
          },
        };
      },
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 })
          : Response.json({ labels: [] });
      },
    });
    const result = (await gmail.callToolResult("list_labels", {})) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(resolves).toBe(2);
    expect(requests).toBe(2);
    expect(providerAuthorizations).toBe(2);
  });

  test("keeps draft and search outputs compatible with the hosted MCP field shape", async () => {
    const gmail = server({
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/drafts")) {
          return Response.json({ drafts: [{ id: "draft-1" }], nextPageToken: "draft-next" });
        }
        if (url.pathname.endsWith("/drafts/draft-1")) {
          return Response.json({
            id: "draft-1",
            message: {
              id: "message-1",
              threadId: "thread-1",
              payload: { headers: [{ name: "Subject", value: "Draft subject" }] },
            },
          });
        }
        if (url.pathname.endsWith("/threads")) {
          return Response.json({
            threads: [{ id: "thread-1" }],
            resultSizeEstimate: 42,
          });
        }
        if (url.pathname.endsWith("/threads/thread-1")) {
          return Response.json({ id: "thread-1", messages: [] });
        }
        throw new Error(`unexpected Gmail test URL: ${url}`);
      },
    });

    const drafts = (await gmail.callToolResult("list_drafts", {})) as {
      structuredContent: Record<string, unknown>;
    };
    expect(drafts.structuredContent).toMatchObject({ nextPageToken: "draft-next" });
    expect((drafts.structuredContent.drafts as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "draft-1",
      threadId: "thread-1",
      subject: "Draft subject",
    });
    expect(JSON.stringify(drafts.structuredContent)).not.toContain('"message"');

    const threads = (await gmail.callToolResult("search_threads", {})) as {
      structuredContent: Record<string, unknown>;
    };
    expect(threads.structuredContent).toEqual({
      threads: [{ id: "thread-1", messages: [] }],
      resultCountEstimate: "42",
    });
    expect(threads.structuredContent).not.toHaveProperty("resultSizeEstimate");
  });

  test("never replays a mutation after a provider 401", async () => {
    let resolves = 0;
    let requests = 0;
    let providerAuthorizations = 0;
    const gmail = server({
      resolveCredential: async () => {
        resolves += 1;
        return {
          status: "ok",
          headers: { authorization: "Bearer token" },
          connectionId: "conn_1",
          authorizeProviderRequest: async () => {
            providerAuthorizations += 1;
            return true;
          },
        };
      },
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
      },
    });
    const result = (await gmail.callToolResult("label_message", {
      messageId: "m1",
      labelIds: ["STARRED"],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("outcome is uncertain");
    expect(resolves).toBe(1);
    expect(requests).toBe(1);
    expect(providerAuthorizations).toBe(1);
  });

  test("rejects sensitive label additions before any provider request", async () => {
    let requests = 0;
    const gmail = server({
      fetchImpl: async () => {
        requests += 1;
        return Response.json({});
      },
    });
    const result = (await gmail.callToolResult("label_thread", {
      threadId: "t1",
      labelIds: ["TRASH"],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("TRASH and SPAM");
    expect(requests).toBe(0);
  });

  test("creates a draft as base64url MIME but never sends it", async () => {
    let requestBody: unknown;
    const gmail = server({
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ id: "draft-1", message: { id: "message-1" } });
      },
    });
    const result = (await gmail.callToolResult("create_draft", {
      to: ["user@example.com"],
      subject: "Local REST test",
      body: "Draft only",
    })) as { content: Array<{ text: string }> };
    const raw = (requestBody as { message: { raw: string } }).message.raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: user@example.com");
    expect(mime).toContain("Subject: Local REST test");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ id: "draft-1" });
  });

  test("rejects attachment MIME header injection before a provider request", async () => {
    let requests = 0;
    const gmail = server({
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ id: "draft-1" });
      },
    });
    const result = (await gmail.callToolResult("create_draft", {
      to: ["user@example.com"],
      attachments: [
        {
          content: Buffer.from("fixture").toString("base64"),
          filename: "safe.txt",
          mimeType: "text/plain\r\nBcc: attacker@example.com",
        },
      ],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("mimeType is invalid");
    expect(requests).toBe(0);
  });

  test("rejects malformed attachment base64 before a provider request", async () => {
    let requests = 0;
    const gmail = server({
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ id: "draft-1" });
      },
    });
    const result = (await gmail.callToolResult("create_draft", {
      attachments: [{ content: "not base64!", filename: "bad.txt" }],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must be valid base64");
    expect(requests).toBe(0);
  });

  test("reports an uncertain outcome without replaying a failed draft transport", async () => {
    let requests = 0;
    const gmail = server({
      fetchImpl: async () => {
        requests += 1;
        throw new TypeError("fixture transport failure");
      },
    });
    const result = (await gmail.callToolResult("create_draft", {
      to: ["user@example.com"],
      body: "Draft only",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("outcome is uncertain");
    expect(requests).toBe(1);
  });

  test("sends a new message as base64url MIME to messages/send and requires a recipient", async () => {
    let requestUrl: string | undefined;
    let requestBody: unknown;
    const gmail = server({
      fetchImpl: async (input, init) => {
        requestUrl = typeof input === "string" ? input : input.toString();
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ id: "sent-1", threadId: "thread-1" });
      },
    });
    const result = (await gmail.callToolResult("send_message", {
      to: ["user@example.com"],
      subject: "Sent via REST bridge",
      body: "This actually sends.",
    })) as { content: Array<{ text: string }> };
    expect(requestUrl).toContain("/messages/send");
    const raw = (requestBody as { raw: string }).raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: user@example.com");
    expect(mime).toContain("Subject: Sent via REST bridge");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ id: "sent-1", threadId: "thread-1" });

    const missingRecipient = (await gmail.callToolResult("send_message", {
      body: "No recipient",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(missingRecipient.isError).toBe(true);
    expect(missingRecipient.content[0]!.text).toContain("to is required");
  });

  test("sends an existing draft by id to drafts/send", async () => {
    let requestUrl: string | undefined;
    let requestBody: unknown;
    const gmail = server({
      fetchImpl: async (input, init) => {
        requestUrl = typeof input === "string" ? input : input.toString();
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ id: "sent-2", threadId: "thread-2" });
      },
    });
    const result = (await gmail.callToolResult("send_draft", {
      draftId: "draft-1",
    })) as { content: Array<{ text: string }> };
    expect(requestUrl).toContain("/drafts/send");
    expect(requestBody).toEqual({ id: "draft-1" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ id: "sent-2", threadId: "thread-2" });
  });

  test("never replays send_message or send_draft after a provider 401", async () => {
    for (const [toolName, args] of [
      ["send_message", { to: ["user@example.com"], body: "x" }],
      ["send_draft", { draftId: "draft-1" }],
    ] as const) {
      let requests = 0;
      const gmail = server({
        fetchImpl: async () => {
          requests += 1;
          return Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
        },
      });
      const result = (await gmail.callToolResult(toolName, args)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("outcome is uncertain");
      expect(requests).toBe(1);
    }
  });

  test("reports an uncertain outcome without replaying a failed send transport", async () => {
    for (const [toolName, args] of [
      ["send_message", { to: ["user@example.com"], body: "x" }],
      ["send_draft", { draftId: "draft-1" }],
    ] as const) {
      let requests = 0;
      const gmail = server({
        fetchImpl: async () => {
          requests += 1;
          throw new TypeError("fixture transport failure");
        },
      });
      const result = (await gmail.callToolResult(toolName, args)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("outcome is uncertain");
      expect(requests).toBe(1);
    }
  });

  test("rejects a send_message attachment MIME header injection before a provider request", async () => {
    let requests = 0;
    const gmail = server({
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ id: "sent-1" });
      },
    });
    const result = (await gmail.callToolResult("send_message", {
      to: ["user@example.com"],
      attachments: [
        {
          content: Buffer.from("fixture").toString("base64"),
          filename: "safe.txt",
          mimeType: "text/plain\r\nBcc: attacker@example.com",
        },
      ],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("mimeType is invalid");
    expect(requests).toBe(0);
  });

  test("retains the hosted MCP URL as the OAuth resource identity", () => {
    expect(isOfficialGmailMcpConfig(OFFICIAL_GMAIL_MCP_URL, connectionRef)).toBe(true);
    expect(
      isOfficialGmailMcpConfig(OFFICIAL_GMAIL_MCP_URL, {
        ...connectionRef,
        subjectScope: "workspace",
      }),
    ).toBe(false);
  });
});

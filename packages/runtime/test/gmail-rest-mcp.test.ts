import { describe, expect, test } from "bun:test";
import {
  GMAIL_REST_MCP_TOOLS,
  GmailRestMcpServer,
  OFFICIAL_GMAIL_MCP_URL,
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
  test("exposes exactly the reviewed hosted-MCP-compatible tool names", () => {
    expect(GMAIL_REST_MCP_TOOLS.map((tool) => tool.name).sort()).toEqual(
      [
        "create_draft",
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

  test("lists labels through users/me without exposing the token in its result", async () => {
    let request: Request | null = null;
    const gmail = server({
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ labels: [{ id: "INBOX", name: "INBOX" }] });
      },
    });
    const result = (await gmail.callTool("list_labels", {})) as {
      content: Array<{ text: string }>;
    };
    expect(request!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    expect(request!.headers.get("authorization")).toBe("Bearer gmail-token");
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      labels: [{ id: "INBOX", name: "INBOX" }],
    });
    expect(JSON.stringify(result)).not.toContain("gmail-token");
  });

  test("refreshes and retries a read once after 401", async () => {
    let resolves = 0;
    let requests = 0;
    const gmail = server({
      resolveCredential: async (input) => {
        resolves += 1;
        expect(input.destinationUrl).toStartWith("https://gmail.googleapis.com/gmail/v1/users/me/");
        return {
          status: "ok",
          headers: { authorization: `Bearer token-${resolves}` },
          connectionId: "conn_1",
        };
      },
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 })
          : Response.json({ labels: [] });
      },
    });
    const result = (await gmail.callTool("list_labels", {})) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(resolves).toBe(2);
    expect(requests).toBe(2);
  });

  test("never replays a mutation after a provider 401", async () => {
    let resolves = 0;
    let requests = 0;
    const gmail = server({
      resolveCredential: async () => {
        resolves += 1;
        return {
          status: "ok",
          headers: { authorization: "Bearer token" },
          connectionId: "conn_1",
        };
      },
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
      },
    });
    const result = (await gmail.callTool("label_message", {
      messageId: "m1",
      labelIds: ["STARRED"],
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("outcome is uncertain");
    expect(resolves).toBe(1);
    expect(requests).toBe(1);
  });

  test("rejects sensitive label additions before any provider request", async () => {
    let requests = 0;
    const gmail = server({
      fetchImpl: async () => {
        requests += 1;
        return Response.json({});
      },
    });
    const result = (await gmail.callTool("label_thread", {
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
    const result = (await gmail.callTool("create_draft", {
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

  test("retains the hosted MCP URL as the OAuth resource identity", () => {
    expect(OFFICIAL_GMAIL_MCP_URL).toBe("https://gmailmcp.googleapis.com/mcp/v1");
  });
});

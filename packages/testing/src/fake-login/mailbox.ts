import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

/**
 * The fake mailbox behind the email-code rung (D28: the product reads codes
 * through a connected mail account; no inbox is built). Readable three ways:
 * the in-process API, plain HTTP (`/__mail/messages`) and a streamable-HTTP MCP
 * server named `fake_mail` with `search_messages` and `get_message`, which is
 * what a test workspace attaches as a connector.
 */
export type MailMessage = {
  id: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
};

export class FakeMailbox {
  private messages: MailMessage[] = [];

  constructor(private readonly now: () => number) {}

  deliver(input: Omit<MailMessage, "id" | "receivedAt">): MailMessage {
    const message: MailMessage = {
      ...input,
      id: randomUUID(),
      receivedAt: new Date(this.now()).toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  /** Newest first. Every filter is a case-insensitive substring match. */
  search(
    filter: {
      to?: string | undefined;
      from?: string | undefined;
      query?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): MailMessage[] {
    const contains = (value: string, needle: string | undefined) =>
      needle === undefined || needle === "" || value.toLowerCase().includes(needle.toLowerCase());
    return this.messages
      .filter(
        (message) =>
          contains(message.to, filter.to) &&
          contains(message.from, filter.from) &&
          (contains(message.subject, filter.query) || contains(message.body, filter.query)),
      )
      .reverse()
      .slice(0, filter.limit ?? 20);
  }

  get(id: string): MailMessage | undefined {
    return this.messages.find((message) => message.id === id);
  }

  all(): MailMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }
}

function summary(message: MailMessage) {
  return {
    id: message.id,
    to: message.to,
    from: message.from,
    subject: message.subject,
    receivedAt: message.receivedAt,
    snippet: message.body.slice(0, 120),
  };
}

function buildFakeMailMcp(mailbox: FakeMailbox): McpServer {
  const server = new McpServer({ name: "fake_mail", version: "1.0.0" });
  server.registerTool(
    "search_messages",
    {
      description:
        "Search the mailbox. Returns the newest matching messages first (id, from, to, subject, snippet, receivedAt).",
      inputSchema: {
        to: z.string().optional().describe("Recipient address contains this text"),
        from: z.string().optional().describe("Sender address contains this text"),
        query: z.string().optional().describe("Subject or body contains this text"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => ({
      content: [
        { type: "text", text: JSON.stringify({ messages: mailbox.search(args).map(summary) }) },
      ],
    }),
  );
  server.registerTool(
    "get_message",
    {
      description: "Read one message, including its full body.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const message = mailbox.get(id);
      return message
        ? { content: [{ type: "text", text: JSON.stringify(message) }] }
        : { isError: true, content: [{ type: "text", text: `No message with id ${id}` }] };
    },
  );
  return server;
}

/** Stateless streamable-HTTP handler (a fresh server and transport per request, JSON responses). */
export async function handleFakeMailMcp(mailbox: FakeMailbox, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await buildFakeMailMcp(mailbox).connect(transport);
  return transport.handleRequest(request);
}

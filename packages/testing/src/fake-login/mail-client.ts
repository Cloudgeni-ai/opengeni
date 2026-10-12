import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { MailMessage } from "./mailbox";

/** Reads the fake mailbox through its MCP surface, as a connected agent would. */
export async function withFakeMailMcp<T>(
  mcpUrl: string,
  run: (mail: {
    toolNames: string[];
    search: (args: {
      to?: string;
      from?: string;
      query?: string;
      limit?: number;
    }) => Promise<
      {
        id: string;
        to: string;
        from: string;
        subject: string;
        snippet: string;
        receivedAt: string;
      }[]
    >;
    get: (id: string) => Promise<MailMessage>;
  }) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "fake-mail-client", version: "1.0.0" });
  // The SDK transport class is not assignable under exactOptionalPropertyTypes (sessionId).
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)) as unknown as Transport);
  try {
    const text = (result: unknown) =>
      (result as { content: { text: string }[] }).content[0]?.text ?? "{}";
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    return await run({
      toolNames,
      search: async (args) =>
        (
          JSON.parse(text(await client.callTool({ name: "search_messages", arguments: args }))) as {
            messages: never[];
          }
        ).messages,
      get: async (id) =>
        JSON.parse(
          text(await client.callTool({ name: "get_message", arguments: { id } })),
        ) as MailMessage,
    });
  } finally {
    await client.close();
  }
}

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY, type AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";

import { PolicyMcpServer } from "../src/mcp/server";
import { ToolArgumentError } from "../src/mcp/tool-argument-error";

const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "user:test",
  principalKind: "human_session",
  permissions: ["files:read", "files:upload"],
};

const failures: Record<string, () => Error> = {
  argument: () => new ToolArgumentError("Pass exactly one of path or artifactId."),
  badRequest: () => new HTTPException(400, { message: "sandbox artifact path must name a file" }),
  unprocessable: () => new HTTPException(422, { message: "sandbox artifact file is empty" }),
  wrappedBadRequest: () => {
    const cause = new HTTPException(400, { message: "The format is not valid" });
    return new Error(cause.message, { cause });
  },
  unavailable: () => new HTTPException(503, { message: "object storage is not configured" }),
  conflict: () => new HTTPException(409, { message: "sandbox not available" }),
  internal: () => new Error("database connection lost"),
};

/** The same tool on the first-party server and on a plain SDK server. */
async function connect(server: McpServer) {
  server.registerTool(
    "sandbox_file_publish",
    {
      description: "Publish one file.",
      inputSchema: { path: z4.string().min(1).describe("The file.") },
    },
    async ({ path }) => {
      throw failures[path]!();
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "argument-rejection", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("first-party argument rejections", () => {
  test("are marked, with exactly the error result the SDK would give", async () => {
    const policy = await connect(new PolicyMcpServer(grant, crypto.randomUUID(), null));
    const plain = await connect(new McpServer({ name: "plain", version: "1" }));
    const rejected = new Set(["argument", "badRequest", "unprocessable", "wrappedBadRequest"]);
    const calls: Array<Record<string, unknown>> = [
      ...Object.keys(failures).map((path) => ({ path })),
      // The SDK's own refusal of arguments that do not match the schema.
      { path: 42 },
      {},
    ];
    for (const args of calls) {
      const call = { name: "sandbox_file_publish", arguments: args };
      const marked = await policy.callTool(call);
      const unmarked = await plain.callTool(call);
      const { _meta, ...visible } = marked;
      // What the caller sees does not change.
      expect(visible).toEqual(unmarked);
      expect(marked.isError).toBe(true);
      const isRejection = typeof args.path !== "string" || rejected.has(args.path);
      expect(_meta?.[FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY] === true).toBe(isRejection);
    }
    // A tool the server does not have is not an argument rejection.
    const unknown = await policy.callTool({ name: "no_such_tool", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown._meta).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/index";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = {
  operationKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  updates: [
    {
      id: "external",
      expectedCredentialVersion: 1,
      expectedServerUrl: "https://tools.example.test/mcp",
      headers: { Authorization: "Bearer synthetic-rotation-secret" },
    },
  ],
};

describe("standalone session MCP credential rotation", () => {
  test("uses the dedicated operation without sending a message or enqueueing work", async () => {
    const calls: Request[] = [];
    const receipt = {
      operationKey: request.operationKey,
      sessionId,
      servers: [{ id: "external", credentialVersion: 2 }],
      appliedAt: "2026-01-01T00:00:00.000Z",
    };
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "synthetic-api-key",
      fetch: (async (url, init) => {
        calls.push(new Request(url, init));
        return Response.json(receipt);
      }) as typeof fetch,
    });
    expect(await client.rotateSessionMcpCredentials(workspaceId, sessionId, request)).toEqual(
      receipt,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${workspaceId}/sessions/${sessionId}/mcp-credentials/rotate`,
    );
    expect(await calls[0]!.json()).toEqual(request);
    expect(JSON.stringify(receipt)).not.toContain("synthetic-rotation-secret");
  });

  test("does not automatically retry an ambiguous mutation transport failure", async () => {
    let calls = 0;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "synthetic-api-key",
      fetch: (async () => {
        calls += 1;
        throw new Error("connection lost");
      }) as unknown as typeof fetch,
    });
    await expect(
      client.rotateSessionMcpCredentials(workspaceId, sessionId, request),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

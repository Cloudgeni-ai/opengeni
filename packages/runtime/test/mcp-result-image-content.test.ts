import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { sdkModelOutputForServer } from "../src/mcp-result-custom-data";

describe("MCP result model projection", () => {
  test("preserves non-text content even when the server prefers structured content", () => {
    const server = { useStructuredContent: true } as MCPServer;
    const content = [
      { type: "text" as const, text: "observation" },
      { type: "image" as const, data: "/9j/2Q==", mimeType: "image/jpeg" },
    ];
    expect(
      sdkModelOutputForServer(server, {
        content,
        structuredContent: { frameId: "frame-1" },
      }),
    ).toEqual(content);
  });
});

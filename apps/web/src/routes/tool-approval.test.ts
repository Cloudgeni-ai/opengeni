import { describe, expect, test } from "bun:test";
import { parsePendingToolCall } from "./tool-approval";

const encode = (value: unknown) => `#${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

describe("tool approval link", () => {
  const call = {
    serverId: "cap-linear",
    toolName: "save_issue",
    arguments: { title: "Ünïcode ✓" },
    operationId: "0b0f3c8e-6f7a-4a8e-9a43-6f1f4a3c2d10",
  };

  test("reads the call the MCP server encoded", () => {
    expect(parsePendingToolCall(encode(call))).toEqual(call);
  });

  test("rejects anything else", () => {
    expect(parsePendingToolCall("")).toBeNull();
    expect(parsePendingToolCall("#not-json")).toBeNull();
    expect(parsePendingToolCall(encode({ ...call, operationId: "x" }))).toBeNull();
    expect(parsePendingToolCall(encode({ ...call, arguments: [] }))).toBeNull();
  });
});

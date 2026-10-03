import { expect, test } from "bun:test";
import { UpdateConnectorToolPermissionsRequest } from "../src/connector-tool-permissions";

test("an explicit permission update can name the full catalog allowance", () => {
  const request = {
    connectionId: "connection",
    target: "tools",
    permission: "ask",
    toolNames: Array.from({ length: 4096 }, (_, index) => `tool_${index}`),
  };
  expect(UpdateConnectorToolPermissionsRequest.safeParse(request).success).toBe(true);
  expect(
    UpdateConnectorToolPermissionsRequest.safeParse({
      ...request,
      toolNames: [...request.toolNames, "extra"],
    }).success,
  ).toBe(false);
});

test("connector defaults require an explicit target and cannot be named as tool overrides", () => {
  const common = { connectionId: "connection", permission: "allow" };
  expect(
    UpdateConnectorToolPermissionsRequest.safeParse({ ...common, target: "default" }).success,
  ).toBe(true);
  expect(
    UpdateConnectorToolPermissionsRequest.safeParse({
      ...common,
      target: "tools",
      toolNames: ["read_item"],
    }).success,
  ).toBe(true);
  for (const selection of [
    { toolNames: ["*"] },
    { target: "tools", toolNames: [" * "] },
    { target: "tools", toolNames: ["\t*\n"] },
    { target: "tools", toolNames: [" read_item "] },
    { target: "tools", toolNames: ["*"] },
    { target: "tools", toolNames: ["read_item", "*"] },
    { target: "default", toolNames: ["read_item"] },
    { target: "default", toolNames: ["*"] },
  ]) {
    expect(
      UpdateConnectorToolPermissionsRequest.safeParse({ ...common, ...selection }).success,
    ).toBe(false);
  }
});

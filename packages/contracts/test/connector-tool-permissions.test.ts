import { expect, test } from "bun:test";
import { UpdateConnectorToolPermissionsRequest } from "../src/connector-tool-permissions";

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

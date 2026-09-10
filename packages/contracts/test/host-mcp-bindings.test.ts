import { expect, test } from "bun:test";
import { CreateHostMcpBindingRequest } from "../src/host-mcp-bindings";

test("durable host binding registration accepts only explicit, bounded credential-free authority", () => {
  const definition = {
    serverId: "server",
    destinationUrl: "https://MCP.example:443/tools",
    connectionRef: {
      authoritySource: "host",
      connectionId: "opaque-account",
      providerDomain: "mcp.example",
    },
  };
  const request = { operationId: crypto.randomUUID(), definition };
  expect(CreateHostMcpBindingRequest.parse(request).definition.destinationUrl).toBe(
    "https://mcp.example/tools",
  );
  for (const destinationUrl of [
    "http://mcp.example/tools",
    "https://secret@mcp.example/tools",
    "https://mcp.example/tools#fragment",
  ]) {
    expect(
      CreateHostMcpBindingRequest.safeParse({
        ...request,
        definition: { ...definition, destinationUrl },
      }).success,
    ).toBe(false);
  }
  for (const connectionRef of [
    { connectionId: "opaque-account", providerDomain: "mcp.example" },
    { authoritySource: "host", providerDomain: "mcp.example" },
    { ...definition.connectionRef, headers: { authorization: "not-a-reference" } },
    { ...definition.connectionRef, connectionId: "x".repeat(70_000) },
  ])
    expect(
      CreateHostMcpBindingRequest.safeParse({
        ...request,
        definition: { ...definition, connectionRef },
      }).success,
    ).toBe(false);
  expect(
    CreateHostMcpBindingRequest.safeParse({ ...request, ownerSubjectId: "user:forged" }).success,
  ).toBe(false);
});

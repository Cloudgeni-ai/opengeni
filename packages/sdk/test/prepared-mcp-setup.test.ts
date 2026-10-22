import { expect, test } from "bun:test";
import { CustomMcpSetupRequest } from "@opengeni/contracts/prepared-mcp-setup";
import { parseCustomMcpSetupRequest } from "../src/prepared-mcp-setup";

const setup = {
  name: "Records",
  endpointUrl: "https://records.example.test/mcp",
  headers: [
    { name: "X-Tenant", value: "example" },
    { name: "Authorization", secret: "key", prefix: "Bearer " },
  ],
  secretFields: [{ id: "key", label: "API key" }],
};
const legacy = {
  kind: "mcp",
  name: setup.name,
  endpointUrl: setup.endpointUrl,
  rationale: "Read records",
};
const request = { ...legacy, ownership: "personal", mcpSetup: setup };

test("lightweight MCP setup parser agrees with the wire contract", () => {
  for (const value of [
    null,
    [],
    {},
    legacy,
    request,
    { ...request, ownership: "workspace" },
    { ...request, name: "Different" },
    { ...request, ownership: undefined },
    { ...request, mcpSetup: undefined },
    { ...request, endpointUrl: "http://example.test" },
    { ...request, endpointUrl: "https://key@example.test" },
    { ...request, endpointUrl: "https://example.test?key=value" },
    { ...request, endpointUrl: "https://example.test#secret" },
    { ...request, rationale: "" },
    { ...request, unrecognized: "field" },
    ...[
      { headers: [] },
      { secretFields: [] },
      { headers: [{ name: "Authorization", value: "literal-secret" }], secretFields: [] },
      { headers: [{ name: "X-Fixed", value: "safe" }], secretFields: [] },
      { headers: [{ name: "Authorization", secret: "missing" }] },
      { headers: [{ name: "Authorization", secret: "key", prefix: "Bearer\r\nInjected: " }] },
      { headers: [...setup.headers, { name: "authorization", secret: "key" }] },
      { secretFields: [...setup.secretFields, { id: "unused", label: "Unused" }] },
      { secretFields: [...setup.secretFields, ...setup.secretFields] },
      { secretFields: [{ id: "key", label: "  API key  " }] },
      { values: { key: "must-not-project" } },
    ].map((change) => ({ ...request, mcpSetup: { ...setup, ...change } })),
  ]) {
    const canonical = CustomMcpSetupRequest.safeParse(value);
    expect(parseCustomMcpSetupRequest(value)).toEqual(canonical.success ? canonical.data : null);
  }
});

import { expect, test } from "bun:test";
import {
  createWorkspaceToolGateway,
  ToolGatewayInputValidationError,
  ToolGatewaySchemaCompilationError,
  type ToolGatewayDefinition,
} from "../src";

function fixture(changes: Partial<ToolGatewayDefinition> = {}) {
  let executions = 0;
  let authorizations = 0;
  const definition: ToolGatewayDefinition = {
    identity: { serverId: "fixture", toolName: "lookup" },
    modelName: "fixture__lookup",
    description: "Look up a value",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { ok: { const: true } }, required: ["ok"] },
    source: "docs",
    approval: "none",
    execute: async () => {
      executions++;
      return { content: [], structuredContent: { ok: true } };
    },
    ...changes,
  };
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    definitions: [
      definition,
      {
        ...definition,
        identity: { serverId: "fixture", toolName: "other" },
        modelName: "fixture__other",
        inputSchema: { type: "object" },
        outputSchema: undefined,
      },
    ],
    authorize: () => {
      authorizations++;
    },
  });
  const call = (
    modelName = definition.modelName,
    args: Record<string, unknown> = { query: "ok" },
  ) => gateway.callModel({ modelName, arguments: args, subjectId: "human:fixture" });
  return { definition, catalog, call, counts: () => ({ executions, authorizations }) };
}

test.each(["inputSchema", "outputSchema"] as const)(
  "an invalid %s does not compile unused tools and fails before side effects",
  async (field) => {
    const { call, catalog, counts } = fixture({ [field]: { type: "invalid-schema-type" } });
    const before = JSON.stringify(catalog);
    await call("fixture__other");
    expect(counts()).toEqual({ executions: 1, authorizations: 1 });
    const error = await call().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ToolGatewaySchemaCompilationError);
    expect(error).not.toBeInstanceOf(ToolGatewayInputValidationError);
    expect(await call().catch((reason: unknown) => reason)).toBe(error);
    expect(counts()).toEqual({ executions: 1, authorizations: 1 });
    expect(JSON.stringify(catalog)).toBe(before);
  },
);

test("lazy validators retain preparation-time schemas even if the caller mutates them", async () => {
  const inputSchema = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  };
  const outputSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const { call, counts } = fixture({ inputSchema, outputSchema });
  inputSchema.properties.query.type = "number";
  outputSchema.properties.ok.type = "string";
  await call();
  expect(counts()).toEqual({ executions: 1, authorizations: 1 });
  await expect(call("fixture__lookup", { query: 123 })).rejects.toBeInstanceOf(
    ToolGatewayInputValidationError,
  );
  expect(counts()).toEqual({ executions: 1, authorizations: 1 });
});

test.each([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
])("first-use compilation preserves repair and rejection for %s", async ($schema) => {
  const { call, counts } = fixture({
    inputSchema: {
      $schema,
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
      required: ["count"],
      additionalProperties: false,
    },
  });
  await call("fixture__lookup", { count: "2" });
  await expect(call("fixture__lookup", { count: "no" })).rejects.toBeInstanceOf(
    ToolGatewayInputValidationError,
  );
  await call("fixture__lookup", { count: 3 });
  expect(counts()).toEqual({ executions: 2, authorizations: 2 });
});

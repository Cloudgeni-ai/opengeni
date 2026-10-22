import { describe, expect, test } from "bun:test";
import {
  ToolGatewayApprovalRequiredError,
  createWorkspaceToolGateway,
  type ToolGatewayArgumentResolver,
  type ToolGatewayDefinition,
} from "../src";

const REF = "{{secret:Private/GitHub/password}}";
const VALUE = "canary-resolved-value";

function baseDefinition(
  observed: Array<Record<string, unknown>>,
  overrides: Partial<ToolGatewayDefinition> = {},
): ToolGatewayDefinition {
  return {
    identity: { serverId: "crm", toolName: "create" },
    modelName: "crm__create",
    description: "Create",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        nested: { type: "object", properties: { list: { type: "array" } } },
      },
      required: ["token"],
    },
    source: "mcp",
    approval: "none",
    execute: (args) => {
      observed.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
    ...overrides,
  };
}

const literal: ToolGatewayArgumentResolver = ({ arguments: args }) => {
  const walk = (value: unknown): unknown =>
    typeof value === "string"
      ? value.split(REF).join(VALUE)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
          : value;
  return walk(args) as Record<string, unknown>;
};

function gatewayFor(
  definition: ToolGatewayDefinition,
  resolveArguments?: ToolGatewayArgumentResolver,
) {
  return createWorkspaceToolGateway({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    definitions: [definition],
    ...(resolveArguments ? { resolveArguments } : {}),
  });
}

function callFor(catalogDigest: string, args: Record<string, unknown>) {
  return {
    operationId: crypto.randomUUID(),
    catalogDigest,
    identity: { serverId: "crm", toolName: "create" },
    arguments: args,
    caller: { kind: "http" as const, subjectId: "human:test" },
  };
}

describe("ToolGateway resolveArguments", () => {
  test("passes resolved values only to the executor; call, lifecycle and approval keep references", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const lifecycleArgs: unknown[] = [];
    const order: string[] = [];
    const definition = baseDefinition(observed, {
      lifecycle: {
        prepare: ({ call }) => {
          lifecycleArgs.push(structuredClone(call.arguments));
          order.push("prepare");
          return {
            begin: () => {
              order.push("begin");
            },
            complete: () => {
              order.push("complete");
            },
          };
        },
      },
    });
    const { catalog, gateway } = gatewayFor(definition, (input) => {
      order.push("resolve");
      return literal(input);
    });
    const original = { token: `Bearer ${REF}`, nested: { list: [REF, 1] } };
    const call = callFor(catalog.digest, original);
    const prepared = await gateway.prepareCall(call);
    const digestBefore = prepared.approvalAuthorityDigest;
    expect(order).toEqual(["prepare"]);
    await prepared.execute();
    expect(order).toEqual(["prepare", "resolve", "begin", "complete"]);
    expect(observed[0]).toEqual({ token: `Bearer ${VALUE}`, nested: { list: [VALUE, 1] } });
    expect(prepared.call.arguments).toEqual({ token: `Bearer ${REF}`, nested: { list: [REF, 1] } });
    expect(original).toEqual({ token: `Bearer ${REF}`, nested: { list: [REF, 1] } });
    expect(lifecycleArgs).toEqual([{ token: `Bearer ${REF}`, nested: { list: [REF, 1] } }]);
    expect(prepared.approvalAuthorityDigest).toBe(digestBefore);
    expect(JSON.stringify(prepared.call)).not.toContain(VALUE);
  });

  test("resolver receives a deep copy, so in-place mutation never leaks into the call", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { catalog, gateway } = gatewayFor(baseDefinition(observed), ({ arguments: args }) => {
      args.token = VALUE;
      (args.nested as { list: unknown[] }).list[0] = VALUE;
      return args;
    });
    const prepared = await gateway.prepareCall(
      callFor(catalog.digest, { token: REF, nested: { list: [REF] } }),
    );
    await prepared.execute();
    expect(observed[0]).toEqual({ token: VALUE, nested: { list: [VALUE] } });
    expect(prepared.call.arguments).toEqual({ token: REF, nested: { list: [REF] } });
  });

  test("a call waiting for approval resolves nothing (GW-5)", async () => {
    const observed: Array<Record<string, unknown>> = [];
    let resolutions = 0;
    const definition = baseDefinition(observed, {
      lifecycle: {
        prepare: () => ({ waitingForApproval: { requestId: "r1", actionFingerprint: "f1" } }),
      },
    });
    const { catalog, gateway } = gatewayFor(definition, (input) => {
      resolutions++;
      return literal(input);
    });
    const prepared = await gateway.prepareCall(callFor(catalog.digest, { token: REF }));
    await expect(prepared.execute()).rejects.toBeInstanceOf(ToolGatewayApprovalRequiredError);
    expect(resolutions).toBe(0);
    expect(observed).toHaveLength(0);
  });

  test("an unapproved human-approval call never reaches the resolver (GW-5)", async () => {
    const observed: Array<Record<string, unknown>> = [];
    let resolutions = 0;
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [baseDefinition(observed, { approval: "human" })],
      requireApproval: () => true,
      resolveApproval: () => "ask",
      resolveArguments: (input) => {
        resolutions++;
        return literal(input);
      },
    });
    await expect(gateway.call(callFor(catalog.digest, { token: REF }))).rejects.toBeInstanceOf(
      ToolGatewayApprovalRequiredError,
    );
    expect(resolutions).toBe(0);
    expect(observed).toHaveLength(0);
  });

  test("a resolver failure prevents begin and execution and surfaces the typed error", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    class MissingReference extends Error {}
    const definition = baseDefinition(observed, {
      lifecycle: {
        prepare: () => ({
          begin: () => {
            order.push("begin");
          },
          complete: () => {
            order.push("complete");
          },
        }),
      },
    });
    const { catalog, gateway } = gatewayFor(definition, () => {
      throw new MissingReference("missing");
    });
    await expect(gateway.call(callFor(catalog.digest, { token: REF }))).rejects.toBeInstanceOf(
      MissingReference,
    );
    expect(order).toEqual([]);
    expect(observed).toHaveLength(0);
  });

  test("without a resolver, references pass through literally", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { catalog, gateway } = gatewayFor(baseDefinition(observed));
    await gateway.call(callFor(catalog.digest, { token: REF }));
    expect(observed[0]).toEqual({ token: REF });
  });
});

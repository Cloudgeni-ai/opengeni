import { describe, expect, test } from "bun:test";
import {
  buildMissingSecretAskCard,
  isSecretReferenceError,
  referenceKey,
  SecretReferenceError,
  type ResolvedSecretValue,
  type SecretReferenceFailure,
  type SecretResolver,
  type SecretUseContext,
} from "@opengeni/contracts";
import { createWorkspaceToolGateway, type ToolGatewayDefinition } from "@opengeni/tool-gateway";
import { createSecretArgumentResolver, mcpToolErrorOutput, secretArgumentMode } from "../src/index";

const VALUE = "canary-w2-gateway-0f3a";

function fakeResolver(values: Record<string, string>, enabled = true) {
  const calls: Array<{ refs: string[]; use: SecretUseContext }> = [];
  const resolver: SecretResolver = {
    principal: {
      kind: "attempt",
      accountId: "a",
      workspaceId: "w",
      sessionId: "s",
      turnId: "t",
      attemptId: "x",
      executionGeneration: 1,
    },
    enabled,
    async resolve(refs, use) {
      calls.push({ refs: refs.map((ref) => ref.raw), use });
      const out = new Map<string, ResolvedSecretValue>();
      const failures: SecretReferenceFailure[] = [];
      for (const ref of refs) {
        const path = ref.target.form === "path" ? ref.target.segments.join("/") : "";
        const value = values[path];
        if (value === undefined) {
          failures.push({ raw: ref.raw, code: "not_found", message: `no secret named ${path}` });
          continue;
        }
        out.set(referenceKey(ref), {
          key: referenceKey(ref),
          reference: ref,
          source: "opengeni",
          vaultId: "v",
          vaultName: "Private",
          itemId: "i",
          itemName: path,
          fieldId: null,
          fieldName: "password",
          version: 1,
          material: { type: "text", value },
        });
      }
      if (failures.length > 0) {
        throw new SecretReferenceError(
          failures,
          buildMissingSecretAskCard(failures, { hasActingHuman: true }),
        );
      }
      return out;
    },
  };
  return { resolver, calls };
}

function definition(
  source: ToolGatewayDefinition["source"],
  seen: Array<Record<string, unknown>>,
): ToolGatewayDefinition {
  return {
    identity: { serverId: source === "mcp" ? "crm" : source, toolName: "call" },
    modelName: `${source}__call`,
    description: "Call",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    source,
    approval: "none",
    execute: (args) => {
      seen.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

async function run(
  source: ToolGatewayDefinition["source"],
  text: string,
  resolver: SecretResolver,
  callerKind: "model" | "codemode" | "http" = "http",
) {
  const seen: Array<Record<string, unknown>> = [];
  const resolveArguments = createSecretArgumentResolver({ resolver });
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    definitions: [definition(source, seen)],
    ...(resolveArguments ? { resolveArguments } : {}),
  });
  const prepared = await gateway.prepareCall({
    operationId: crypto.randomUUID(),
    catalogDigest: catalog.digest,
    identity: catalog.entries[0]!.identity,
    arguments: { text },
    caller: { kind: callerKind, subjectId: "subject" },
  });
  await prepared.execute();
  return { seen, call: prepared.call };
}

describe("secret argument resolution (GW-1, GW-2, AG-4)", () => {
  test("modes: remote MCP and Codex apps resolve; first-party and interaction preserve", () => {
    expect(secretArgumentMode("mcp")).toBe("literal");
    expect(secretArgumentMode("codex_apps")).toBe("literal");
    for (const source of ["opengeni", "files", "docs", "interaction"] as const) {
      expect(secretArgumentMode(source)).toBe("preserve");
    }
  });

  test("an MCP call gets the value; the persisted call keeps the reference", async () => {
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
    const { seen, call } = await run("mcp", "Bearer {{secret:GitHub/token}}", resolver);
    expect(seen[0]).toEqual({ text: `Bearer ${VALUE}` });
    expect(call.arguments).toEqual({ text: "Bearer {{secret:GitHub/token}}" });
    expect(calls[0]?.use.surface).toBe("mcp");
    expect(calls[0]?.use.toolName).toBe("mcp__call");
  });

  test("a Codemode caller resolves with the codemode surface (GW-3)", async () => {
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
    const { seen } = await run("codex_apps", "{{secret:GitHub/token}}", resolver, "codemode");
    expect(seen[0]).toEqual({ text: VALUE });
    expect(calls[0]?.use.surface).toBe("codemode");
  });

  test("first-party and interaction tools receive the reference verbatim", async () => {
    for (const source of ["opengeni", "interaction"] as const) {
      const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
      const { seen } = await run(source, "{{secret:GitHub/token}}", resolver);
      expect(seen[0]).toEqual({ text: "{{secret:GitHub/token}}" });
      expect(calls).toHaveLength(0);
    }
  });

  test("capability off: no hook, references pass through literally", async () => {
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE }, false);
    expect(createSecretArgumentResolver({ resolver })).toBeUndefined();
    expect(createSecretArgumentResolver({ resolver: null })).toBeUndefined();
    const { seen } = await run("mcp", "{{secret:GitHub/token}}", resolver);
    expect(seen[0]).toEqual({ text: "{{secret:GitHub/token}}" });
    expect(calls).toHaveLength(0);
  });

  test("escaped references reach the tool as literal text without resolution", async () => {
    const { resolver, calls } = fakeResolver({});
    const { seen } = await run("mcp", "write \\{{secret:Docs}} here", resolver);
    expect(seen[0]).toEqual({ text: "write {{secret:Docs}} here" });
    expect(calls).toHaveLength(0);
  });

  test("secretfile references are rejected before resolution", async () => {
    const { resolver, calls } = fakeResolver({ Key: VALUE });
    const error = await run("mcp", "{{secretfile:Key}}", resolver).catch((caught) => caught);
    expect(isSecretReferenceError(error)).toBe(true);
    expect((error as SecretReferenceError).failures[0]?.code).toBe("secretfile_not_allowed");
    expect(calls).toHaveLength(0);
  });

  test("a missing secret fails with a ready ask card and never runs the tool", async () => {
    const { resolver } = fakeResolver({});
    const seen: Array<Record<string, unknown>> = [];
    const error = await run("mcp", "{{secret:Stripe/api_key}}", resolver).catch((caught) => caught);
    expect(seen).toHaveLength(0);
    const output = mcpToolErrorOutput(error);
    expect(output.isError).toBe(true);
    const parsed = JSON.parse(output.content[0].text) as {
      error: string;
      askCard: { questions: Array<{ kind: string; secret: { item: string; field: string } }> };
      hint: string;
    };
    expect(parsed.error).toBe("secret_reference_error");
    expect(parsed.askCard.questions[0]?.kind).toBe("secret");
    expect(parsed.askCard.questions[0]?.secret).toMatchObject({ item: "Stripe", field: "api_key" });
    expect(parsed.hint).toContain("request_human_input");
  });
});

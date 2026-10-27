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
import {
  createSecretArgumentResolver,
  handOffSecretArguments,
  mcpToolErrorOutput,
  secretArgumentMode,
} from "../src/index";
import { prepareSecretExec, secretExecEnvironment } from "../src/sandbox/secret-delivery";

const VALUE = "canary-w2-gateway-0f3a";
const brace = "{";
/** Builds reference text without writing the marker literally in this file. */
const ref = (path: string, kind: "secret" | "secretfile" = "secret") =>
  `${brace}${brace}${kind}:${path}}}`;

/** Opengeni tools that store text or hand it to other work (incident 2 and its siblings). */
const HAND_OFF_TOOLS = [
  "session_create",
  "session_send_message",
  "session_steer",
  "goal_set",
  "goal_update",
  "goal_progress",
  "scheduled_tasks_create",
  "scheduled_tasks_update",
  "task_note_save",
  "task_note_replace",
  "knowledge_save",
  "instruction_policy_save",
  "notify_user",
  "artifacts_create",
  "editable_artifact_apply",
  "site_data_write",
  "slack_bot_post_message",
  "rig_propose_change",
  "a_tool_added_later",
] as const;

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
      calls.push({ refs: refs.map((item) => item.raw), use });
      const out = new Map<string, ResolvedSecretValue>();
      const failures: SecretReferenceFailure[] = [];
      for (const item of refs) {
        const path = item.target.form === "path" ? item.target.segments.join("/") : "";
        const value = values[path];
        if (value === undefined) {
          failures.push({ raw: item.raw, code: "not_found", message: `no secret named ${path}` });
          continue;
        }
        out.set(referenceKey(item), {
          key: referenceKey(item),
          reference: item,
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
  toolName = "call",
): ToolGatewayDefinition {
  return {
    identity: { serverId: source === "mcp" ? "crm" : source, toolName },
    modelName: `${source}__${toolName}`,
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
  toolName = "call",
) {
  return runCall(source, { text }, resolver, callerKind, toolName);
}

async function runCall(
  source: ToolGatewayDefinition["source"],
  args: Record<string, unknown>,
  resolver: SecretResolver,
  callerKind: "model" | "codemode" | "http" = "http",
  toolName = "call",
) {
  const seen: Array<Record<string, unknown>> = [];
  const resolveArguments = createSecretArgumentResolver({ resolver });
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    definitions: [definition(source, seen, toolName)],
    ...(resolveArguments ? { resolveArguments } : {}),
  });
  const prepared = await gateway.prepareCall({
    operationId: crypto.randomUUID(),
    catalogDigest: catalog.digest,
    identity: catalog.entries[0]!.identity,
    arguments: args,
    caller: { kind: callerKind, subjectId: "subject" },
  });
  await prepared.execute();
  return { seen, call: prepared.call };
}

describe("secret argument resolution (GW-1, GW-2, AG-4)", () => {
  test("modes: delivery boundaries and secret tools preserve references", () => {
    const entry = (source: ToolGatewayDefinition["source"], toolName = "call") => ({
      source,
      identity: { serverId: source, toolName },
    });
    for (const source of ["mcp", "codex_apps"] as const) {
      expect(secretArgumentMode(entry(source))).toBe("literal");
    }
    // Every first-party tool is a hand-off tool unless it is on the short literal list.
    for (const source of ["opengeni", "files", "docs"] as const) {
      expect(secretArgumentMode(entry(source))).toBe("handoff");
    }
    for (const toolName of HAND_OFF_TOOLS) {
      expect(secretArgumentMode(entry("opengeni", toolName))).toBe("handoff");
    }
    expect(secretArgumentMode(entry("opengeni", "excel_run"))).toBe("literal");
    expect(secretArgumentMode(entry("interaction"))).toBe("preserve");
    for (const toolName of [
      "secret_save",
      "secret_move",
      "secret_delete",
      "secret_get",
      "run_on",
    ]) {
      expect(secretArgumentMode(entry("opengeni", toolName))).toBe("preserve");
    }
    // Only Opengeni's own secret tools are exempt, not a connector's tool that happens to share the prefix.
    expect(secretArgumentMode(entry("mcp", "secret_save"))).toBe("literal");
    expect(secretArgumentMode(entry("mcp", "run_on"))).toBe("literal");
    // A connector tool that shares a hand-off tool's name still gets values.
    expect(secretArgumentMode(entry("mcp", "session_create"))).toBe("literal");
    expect(secretArgumentMode(entry("files", "excel_run"))).toBe("handoff");
  });

  test("admin_action_call gets values only for a request field the action marks as a credential", () => {
    const entry = {
      source: "opengeni" as const,
      identity: { serverId: "opengeni", toolName: "admin_action_call" },
    };
    expect(
      secretArgumentMode(entry, {
        id: "connectClaudeSubscriptionSetupToken",
        pathParameters: { workspaceId: "w" },
        body: { token: ref("Claude/token") },
      }),
    ).toBe("literal");
    expect(
      secretArgumentMode(entry, {
        id: "createSession",
        pathParameters: { workspaceId: "w" },
        body: { initialMessage: `use ${ref("GitHub/token")}` },
      }),
    ).toBe("handoff");
    expect(secretArgumentMode(entry)).toBe("handoff");
    expect(secretArgumentMode(entry, { id: "noSuchAction", body: { token: "x" } })).toBe("handoff");
    expect(secretArgumentMode(entry, "not an object")).toBe("handoff");
    // Actions that return a secret rather than take one hand off, including
    // invoking another workspace tool (incident 2 one hop away).
    expect(
      secretArgumentMode(entry, {
        id: "POST /v1/workspaces/:workspaceId/tools/invoke",
        pathParameters: { workspaceId: "w" },
        body: { name: "session_create", arguments: { initialMessage: ref("GitHub/token") } },
      }),
    ).toBe("handoff");
    expect(
      secretArgumentMode(entry, {
        id: "createOrganizationWebhook",
        pathParameters: { organizationId: "o" },
        body: { url: `https://hooks.test/${ref("GitHub/token")}` },
      }),
    ).toBe("handoff");
    // Creating or updating a vault item keeps its body in the vault.
    expect(
      secretArgumentMode(entry, {
        id: "POST /v1/workspaces/:workspaceId/vaults/:vaultId/items",
        pathParameters: { workspaceId: "w", vaultId: "v" },
        body: { title: "Copy", fields: [{ name: "password", value: ref("GitHub/token") }] },
      }),
    ).toBe("literal");
  });

  test("admin_action_call resolves only the credential field and hands off the rest of the body", async () => {
    const { resolver, calls } = fakeResolver({ "Mcp/key": VALUE, "GitHub/token": "other" });
    const args = {
      id: "createSession",
      pathParameters: { workspaceId: "w" },
      body: {
        initialMessage: `use ${ref("GitHub/token")} and \\${ref("Mcp/key")}`,
        mcpServers: [{ id: "a", headers: { Authorization: `Bearer ${ref("Mcp/key")}` } }],
      },
    };
    const { seen, call } = await runCall("opengeni", args, resolver, "model", "admin_action_call");
    expect(seen[0]).toEqual({
      ...args,
      body: {
        initialMessage: `use ${ref("GitHub/token")} and ${ref("Mcp/key")}`,
        mcpServers: [{ id: "a", headers: { Authorization: `Bearer ${VALUE}` } }],
      },
    });
    expect(JSON.stringify(call.arguments)).not.toContain(VALUE);
    expect(calls.map((item) => item.refs)).toEqual([[ref("Mcp/key")]]);

    // A Steer with credential updates: the message stays reference text.
    const steer = {
      id: "rotateSessionMcpCredentials",
      pathParameters: { workspaceId: "w", sessionId: "s" },
      body: {
        note: ref("GitHub/token"),
        updates: [{ id: "a", headers: { "x-key": ref("Mcp/key") } }],
      },
    };
    const steered = await runCall("opengeni", steer, resolver, "codemode", "admin_action_call");
    expect(steered.seen[0]).toEqual({
      ...steer,
      body: { note: ref("GitHub/token"), updates: [{ id: "a", headers: { "x-key": VALUE } }] },
    });

    // tools/invoke wrapping session_create resolves nothing (incident 2, one hop away).
    const before = calls.length;
    const invoke = {
      id: "POST /v1/workspaces/:workspaceId/tools/invoke",
      pathParameters: { workspaceId: "w" },
      body: { name: "session_create", arguments: { initialMessage: ref("GitHub/token") } },
    };
    const invoked = await runCall("opengeni", invoke, resolver, "model", "admin_action_call");
    expect(invoked.seen[0]).toEqual(invoke);
    expect(calls.length).toBe(before);
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

  test("incident 2: hand-off tools receive reference text and never resolve", async () => {
    for (const toolName of HAND_OFF_TOOLS) {
      for (const callerKind of ["model", "codemode", "http"] as const) {
        const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
        const text = `export GH_TOKEN=${ref("GitHub/token")} and run`;
        const { seen, call } = await run("opengeni", text, resolver, callerKind, toolName);
        expect(seen[0]).toEqual({ text });
        expect(JSON.stringify(seen)).not.toContain(VALUE);
        expect(call.arguments).toEqual({ text });
        expect(calls).toHaveLength(0);
      }
    }
  });

  test("hand-off unescapes escaped references and keeps secretfile and malformed text", async () => {
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
    const escaped = await run(
      "opengeni",
      `run with \\${ref("GitHub/token")}`,
      resolver,
      "model",
      "scheduled_tasks_create",
    );
    expect(escaped.seen[0]).toEqual({ text: `run with ${ref("GitHub/token")}` });
    const mixed = `${ref("Key", "secretfile")} ${brace}${brace}secret:bad name}} ${ref("Missing/item")}`;
    const kept = await run("opengeni", mixed, resolver, "model", "session_send_message");
    expect(kept.seen[0]).toEqual({ text: mixed });
    expect(calls).toHaveLength(0);
    // The helper is lenient on nested structures too.
    expect(
      handOffSecretArguments({ a: [`\\${ref("X")}`, { b: ref("Y", "secretfile") }], n: 1 }),
    ).toEqual({ a: [ref("X"), { b: ref("Y", "secretfile") }], n: 1 });
  });

  test("an allowlisted Opengeni tool still receives the value", async () => {
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
    const used = await run("opengeni", ref("GitHub/token"), resolver, "model", "excel_run");
    expect(used.seen[0]).toEqual({ text: VALUE });
    expect(used.call.arguments).toEqual({ text: ref("GitHub/token") });
    expect(calls).toHaveLength(1);
  });

  test("a literal connector call still receives the value next to a hand-off call", async () => {
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
    const used = await run("mcp", ref("GitHub/token"), resolver, "model", "session_send_message");
    expect(used.seen[0]).toEqual({ text: VALUE });
    expect(used.call.arguments).toEqual({ text: ref("GitHub/token") });
    expect(calls).toHaveLength(1);
    const handedOn = await run(
      "opengeni",
      `run with ${ref("GitHub/token")}`,
      resolver,
      "model",
      "session_send_message",
    );
    expect(handedOn.seen[0]).toEqual({ text: `run with ${ref("GitHub/token")}` });
    expect(calls).toHaveLength(1);
  });

  test("the receiving work's exec command still resolves the handed-on reference", async () => {
    // A child got this text from session_create; its own shell command uses it.
    const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
    const handedOn = await run(
      "opengeni",
      `GH_TOKEN=${ref("GitHub/token")} git push`,
      resolver,
      "model",
      "session_create",
    );
    expect(calls).toHaveLength(0);
    const command = String(handedOn.seen[0]!.text);
    const prepared = await prepareSecretExec(command, {
      resolver,
      dialect: "posix",
      use: { surface: "shell", toolName: "exec_command" },
    });
    expect(calls).toHaveLength(1);
    expect(prepared!.text).not.toContain(VALUE);
    const carry = prepared!.carry!;
    const env = await secretExecEnvironment(carry, carry.spliced!, null);
    expect(Object.values(env)).toEqual([VALUE]);
  });

  test("delivery boundaries and secret tools receive the reference verbatim", async () => {
    const token = ref("GitHub/token");
    for (const [source, toolName] of [
      ["interaction", "call"],
      ["opengeni", "secret_save"],
      ["opengeni", "run_on"],
    ] as const) {
      const { resolver, calls } = fakeResolver({ "GitHub/token": VALUE });
      const { seen } = await run(source, token, resolver, "http", toolName);
      expect(seen[0]).toEqual({ text: token });
      expect(calls).toHaveLength(0);
    }
  });

  test("run_on preserves references, file references and escapes without resolving", async () => {
    const refs = [ref("Key"), ref("Key", "secretfile"), `\\${ref("Missing")}`];
    for (const written of refs) {
      const { resolver, calls } = fakeResolver({ Key: VALUE });
      const { seen } = await run("opengeni", written, resolver, "model", "run_on");
      expect(seen[0]).toEqual({ text: written });
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

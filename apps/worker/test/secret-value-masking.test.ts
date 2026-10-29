import { describe, expect, test } from "bun:test";
import { RunContext, tool } from "@openai/agents";
import { parseSecretReference } from "@opengeni/contracts";
import { maskSecretValuesForStorage } from "@opengeni/db";
import {
  installToolResultSecretMasking,
  secretValueModelInputFilter,
  withAttemptSecretValues,
} from "@opengeni/runtime";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { z } from "zod";
import {
  createAttemptSecretValueMemory,
  currentAttemptSecretValues,
  rememberAttemptCredential,
  rememberRunCredentialMaterial,
  rememberingAttemptSecretResolver,
  runWithAttemptSecretValues,
} from "../src/activities/agent-turn/secret-values";

// References are assembled so no tool on the way resolves them.
const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;
const DB_REF = ref("Fake Vault/fake-db/password");
const FAKE_SECRET = "fake-db-Pa55word-not-real-42";
const FAKE_CODEMODE_TOKEN = "ogc_fake_codemode_bearer_0123456789abcdef";

/** A stand-in for exec_command: prints whatever the command would. */
function fakeExecTool(output: () => string) {
  return tool({
    name: "exec_command",
    description: "fake exec",
    parameters: z.object({ cmd: z.string() }),
    execute: async () => output(),
  });
}

function fakeAgent(tools: ReturnType<typeof fakeExecTool>[]) {
  return {
    getAllTools: async (_runContext: unknown) => tools as never[],
    clone(): ReturnType<typeof fakeAgent> {
      return fakeAgent(tools);
    },
  };
}

async function invokeFirst(agent: ReturnType<typeof fakeAgent>) {
  const [listed] = (await agent.getAllTools(new RunContext())) as unknown as Array<
    ReturnType<typeof fakeExecTool>
  >;
  return await listed!.invoke(new RunContext(), JSON.stringify({ cmd: "echo" }));
}

describe("attempt secret-value masking", () => {
  test("an exec that echoes a resolved secret shows and stores the reference", async () => {
    const memory = createAttemptSecretValueMemory();
    await runWithAttemptSecretValues(memory, async () => {
      // The exec boundary resolves the reference through the attempt resolver.
      const resolver = rememberingAttemptSecretResolver(
        createStaticSecretResolver({ "Fake Vault/fake-db/password": FAKE_SECRET }),
      );
      await resolver.resolve([parseSecretReference(DB_REF)], {
        surface: "shell",
        toolName: "exec_command",
      });
      const printed = [
        `plain: ${FAKE_SECRET}`,
        `base64: ${Buffer.from(FAKE_SECRET).toString("base64")}`,
        `json: ${JSON.stringify({ password: FAKE_SECRET })}`,
      ].join("\n");
      const agent = fakeAgent([fakeExecTool(() => printed)]);
      installToolResultSecretMasking(agent, memory);
      const shown = String(await invokeFirst(agent));
      expect(shown).not.toContain(FAKE_SECRET);
      expect(shown).not.toContain(Buffer.from(FAKE_SECRET).toString("base64"));
      expect(shown).toBe(
        [`plain: ${DB_REF}`, `base64: ${DB_REF}`, `json: {"password":"${DB_REF}"}`].join("\n"),
      );
      // A clone (the sandbox runtime resolves tools on one) masks too.
      expect(String(await invokeFirst(agent.clone()))).toBe(shown);
      // The storage backstop applies the same memory to what is written.
      const stored = maskSecretValuesForStorage(
        { type: "function_call_result", output: { type: "text", text: printed } },
        "history_append",
      );
      expect(JSON.stringify(stored)).not.toContain(FAKE_SECRET);
      expect(JSON.stringify(stored)).toContain("fake-db/password");
    });
  });

  test("an env-style dump with the Codemode bearer is masked", async () => {
    const memory = createAttemptSecretValueMemory();
    rememberAttemptCredential(memory, FAKE_CODEMODE_TOKEN, "codemode token");
    rememberRunCredentialMaterial(memory, {
      environment: { FAKE_API_TOKEN: "fake-run-credential-value-1", AWS_REGION: "us-east-1-x" },
      mcp: [
        {
          headers: {
            Authorization: "Bearer fake-mcp-header-token-77",
            Accept: "application/json-extended",
            "X-Org": "acme-corporation",
          },
        },
      ],
    });
    const dump = [
      "HOME=/workspace",
      `OPENGENI_CODEMODE_TOKEN=${FAKE_CODEMODE_TOKEN}`,
      "FAKE_API_TOKEN=fake-run-credential-value-1",
      "AWS_REGION=us-east-1-x",
      "MCP=fake-mcp-header-token-77",
      "ORG=acme-corporation accepts application/json-extended",
    ].join("\n");
    const agent = fakeAgent([fakeExecTool(() => dump)]);
    installToolResultSecretMasking(agent, memory);
    const shown = String(await invokeFirst(agent));
    expect(shown).toBe(
      [
        "HOME=/workspace",
        "OPENGENI_CODEMODE_TOKEN=[opengeni credential: codemode token]",
        "FAKE_API_TOKEN=[opengeni credential: run credential FAKE_API_TOKEN]",
        // Not secret by name: left as is.
        "AWS_REGION=us-east-1-x",
        "MCP=[opengeni credential: mcp header]",
        // Headers whose names do not say they carry credentials are not secret.
        "ORG=acme-corporation accepts application/json-extended",
      ].join("\n"),
    );
  });

  test("a tool error message is masked too", async () => {
    const memory = createAttemptSecretValueMemory();
    memory.remember(FAKE_SECRET, DB_REF);
    const failing = tool({
      name: "exec_command",
      description: "fake exec",
      parameters: z.object({ cmd: z.string() }),
      execute: async () => {
        throw new Error(`failed with ${FAKE_SECRET}`);
      },
      errorFunction: null,
    });
    const agent = fakeAgent([failing as never]);
    installToolResultSecretMasking(agent, memory);
    const [listed] = (await agent.getAllTools(new RunContext())) as unknown as Array<
      typeof failing
    >;
    const error = await listed!
      .invoke(new RunContext(), JSON.stringify({ cmd: "x" }))
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    expect(error?.message ?? "").not.toContain(FAKE_SECRET);
  });

  test("the model input filter masks values that reached history another way", async () => {
    const memory = createAttemptSecretValueMemory();
    memory.remember(FAKE_SECRET, DB_REF);
    const filter = secretValueModelInputFilter(memory);
    const item = { role: "user", content: `the password is ${FAKE_SECRET}` };
    const untouched = { role: "assistant", content: "ok" };
    const result = await filter({
      modelData: { input: [item, untouched] as never[], instructions: "" },
      agent: {} as never,
      context: undefined,
    });
    expect(JSON.stringify(result.input)).not.toContain(FAKE_SECRET);
    expect(result.input[1]).toBe(untouched as never);
  });

  test("the memory is active for the attempt and absent outside it", async () => {
    const memory = createAttemptSecretValueMemory();
    expect(currentAttemptSecretValues()).toBeUndefined();
    await runWithAttemptSecretValues(memory, async () => {
      await Promise.resolve();
      expect(currentAttemptSecretValues()).toBe(memory);
    });
    expect(withAttemptSecretValues(null, () => currentAttemptSecretValues())).toBeUndefined();
    expect(maskSecretValuesForStorage(`x ${FAKE_SECRET}`)).toBe(`x ${FAKE_SECRET}`);
  });
});

describe("secret-shaped values in tool output", () => {
  const FAKE_DB_PASSWORD = "FAKE-db-pw-0000-not-real";
  const kubectl = [
    "OPENGENI_BASE_URL=https://example.test",
    `OPENGENI_DATABASE_URL=postgres://user:${FAKE_DB_PASSWORD}@host:5432/db?sslmode=require`,
  ].join("\n");
  const TASK_REF = ref("Task/url-password-0123456789abcdef/password");

  test("incident 1: a printed database URL is captured and shown and stored by reference", async () => {
    const memory = createAttemptSecretValueMemory();
    const captured: string[] = [];
    memory.setShapeCapturer(async (matches) => {
      captured.push(...matches.map((match) => match.kind));
      return new Map(matches.map((match) => [match.value, TASK_REF]));
    });
    await runWithAttemptSecretValues(memory, async () => {
      const agent = fakeAgent([fakeExecTool(() => kubectl)]);
      installToolResultSecretMasking(agent, memory);
      const shown = String(await invokeFirst(agent));
      expect(captured).toEqual(["url-password"]);
      expect(shown).not.toContain(FAKE_DB_PASSWORD);
      expect(shown).toContain(`postgres://user:${TASK_REF}@host:5432/db?sslmode=require`);
      expect(shown).toContain("OPENGENI_BASE_URL=https://example.test");
      // Stored copies (history, events, command output) use the same reference.
      expect(maskSecretValuesForStorage({ output: kubectl })).toEqual({ output: shown });
    });
  });

  test("without capture the password is replaced by a marker and the tool still succeeds", async () => {
    const memory = createAttemptSecretValueMemory();
    memory.setShapeCapturer(async () => {
      throw new Error("vault unavailable");
    });
    await runWithAttemptSecretValues(memory, async () => {
      const agent = fakeAgent([fakeExecTool(() => kubectl)]);
      installToolResultSecretMasking(agent, memory);
      const shown = String(await invokeFirst(agent));
      expect(shown).toContain("postgres://user:[masked url password]@host:5432/db");
    });
  });
});

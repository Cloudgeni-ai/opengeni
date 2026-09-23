import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { BrowserAction, BrowserActionBatch } from "@opengeni/contracts";
import { jsonSchemaToTypeScript } from "@opengeni/tool-gateway";
import { z } from "zod";
import { browserActionInputJsonSchema } from "../src/browser-action-json-schema";

describe("browser action model schema", () => {
  test("reuses repeated shapes while gateway validation and declarations work", async () => {
    const input = z
      .object({
        browserSessionId: z.string().uuid(),
        targetId: z.string().min(1).max(512),
        action: z.union([BrowserAction, BrowserActionBatch]),
      })
      .strict();
    const schema = browserActionInputJsonSchema(input);
    const serialized = JSON.stringify(schema);
    const declaration = jsonSchemaToTypeScript(schema);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(16 * 1024);
    expect(schema.$defs).toBeDefined();
    expect(serialized).toContain('"$ref"');
    expect(declaration).toContain('"click"');
    expect(declaration).toContain('"batch"');
    expect(declaration).toContain("browserSessionId");

    let executed = 0;
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions: [
        {
          identity: { serverId: "interaction", toolName: "browser_act" },
          modelName: "interaction__browser_act",
          codemodePath: ["interaction", "browser", "act"],
          inputSchema: schema,
          source: "interaction",
          approval: "none",
          execute: async () => {
            executed += 1;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ],
    });
    const base = {
      modelName: "interaction__browser_act",
      subjectId: "model:test",
      arguments: {
        browserSessionId: "66666666-6666-4666-8666-666666666666",
        targetId: "tab-1",
        action: { type: "click", locator: { kind: "role", role: "button", name: "Continue" } },
      },
    };
    await environment.callModel({ ...base, operationId: "77777777-7777-4777-8777-777777777777" });
    expect(executed).toBe(1);
    await expect(
      environment.callModel({
        ...base,
        operationId: "88888888-8888-4888-8888-888888888888",
        arguments: {
          ...base.arguments,
          action: { type: "click", locator: { kind: "role", name: "Continue" } },
        },
      }),
    ).rejects.toThrow();
    expect(executed).toBe(1);
  });
});

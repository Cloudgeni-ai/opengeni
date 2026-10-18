import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { BrowserAction, BrowserActionBatch } from "@opengeni/contracts";
import { jsonSchemaToTypeScript } from "@opengeni/tool-gateway";
import { z } from "zod";
import {
  describeInvalidToolArguments,
  interactionToolInputJsonSchema,
} from "../src/interaction-tool-json-schema";

describe("interaction tool model schema", () => {
  test("shows each tagged union once while gateway validation and declarations work", async () => {
    const input = z
      .object({
        browserSessionId: z.string().uuid(),
        targetId: z.string().min(1).max(512),
        action: z.union([BrowserAction, BrowserActionBatch]),
      })
      .strict();
    const schema = interactionToolInputJsonSchema(input);
    const serialized = JSON.stringify(schema);
    const declaration = jsonSchemaToTypeScript(schema);

    // Providers expand references, so the shown size is the whole size.
    expect(serialized).not.toContain('"$ref"');
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(10 * 1024);
    // Validation-only limits stay in the Zod schema.
    expect(serialized).not.toContain("minLength");
    expect(serialized).not.toContain("[0-9a-fA-F]");
    const action = (schema.properties as Record<string, Record<string, unknown>>).action!;
    expect(action.type).toBe("object");
    expect(action.required).toEqual(["type"]);
    const actionProperties = action.properties as Record<string, Record<string, unknown>>;
    expect(actionProperties.type!.enum).toContain("click");
    expect(actionProperties.type!.enum).toContain("batch");
    expect(String(action.description)).toContain("click: locator, button?");
    expect(String(action.description)).toContain("batch: actions, fenceEachAction?");
    expect(actionProperties.locator!.properties).toMatchObject({
      kind: {
        type: "string",
        enum: ["ref", "role", "label", "text", "placeholder", "test_id", "css"],
      },
    });
    expect(String(actionProperties.locator!.description)).toContain("role: role, name?, exact?");
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
        arguments: { ...base.arguments, action: { locator: { kind: "role", role: "button" } } },
      }),
    ).rejects.toThrow();
    expect(executed).toBe(1);
  });

  test("invalid arguments name the exact field of the variant they chose", () => {
    const input = z
      .object({
        browserSessionId: z.string().uuid(),
        targetId: z.string().min(1).max(512),
        action: z.union([BrowserAction, BrowserActionBatch]),
      })
      .strict();
    const explain = (action: unknown): string => {
      const parsed = input.safeParse({
        browserSessionId: "66666666-6666-4666-8666-666666666666",
        targetId: "tab-1",
        action,
      });
      if (parsed.success) throw new Error("expected invalid arguments");
      return describeInvalidToolArguments(parsed.error);
    };
    expect(explain({ type: "click", locator: { kind: "role", name: "Continue" } })).toBe(
      "Interaction tool arguments are invalid: action.locator.role: expected string, received undefined.",
    );
    expect(explain({ type: "fill", locator: { kind: "label", text: "Name" } })).toBe(
      "Interaction tool arguments are invalid: action.value: expected string, received undefined.",
    );
    expect(explain({ type: "click", locator: { kind: "label", text: "x" }, value: "y" })).toBe(
      "Interaction tool arguments are invalid: action: unexpected field value.",
    );
    expect(
      explain({
        type: "batch",
        actions: [
          { type: "fill", locator: { kind: "label", text: "a" }, value: "b" },
          { type: "press" },
        ],
      }),
    ).toBe(
      "Interaction tool arguments are invalid: action.actions.1.key: expected string, received undefined.",
    );
    expect(explain({ type: "teleport" })).toContain("action.type: Invalid discriminator value.");
  });
});

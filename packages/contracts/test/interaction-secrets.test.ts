import { describe, expect, test } from "bun:test";
import {
  BrowserAction,
  BrowserActionCommand,
  BrowserActionRequest,
  BrowserPasskeyEvent,
  BrowserPasskeySyncRequest,
  ComputerActionRequest,
  ComputerNativeCallRequest,
  ComputerNativeCommand,
  INTERACTION_REDACTED_SECRET,
  InteractionSecretValueError,
  browserActionSecretTexts,
  computerActionSecretTexts,
  materializeBrowserActionSecrets,
  materializeComputerActionSecrets,
  materializeComputerNativeSecrets,
  parseSecretReference,
  redactInteractionSecretValues,
  referenceKey,
  substituteSecretText,
  withoutInteractionSecretValues,
} from "../src";

const PASSWORD = "Correct-Horse-Battery-9";
const passwordKey = referenceKey(parseSecretReference("{{secret:Acme/password}}"));
const otpKey = referenceKey(parseSecretReference("{{secret:Acme/otp}}"));
const values = { [passwordKey]: PASSWORD, [otpKey]: "123456" };

const browserCommand = {
  protocolVersion: 1 as const,
  operationId: "22222222-2222-4222-8222-000000000001",
  browserSessionId: "11111111-1111-4111-8111-111111111111",
  controllerGeneration: "controller-1",
  targetId: "target-1",
  expectedTargetGeneration: "target-1",
  expectedDocumentGeneration: "document-1",
  expectedFrameId: "frame-1",
  actor: { kind: "agent" as const, subjectId: "agent:fixture" },
};

describe("substituteSecretText", () => {
  test("replaces references, keeps literal text and removes escapes", () => {
    expect(substituteSecretText("pw={{secret:Acme/password}}!", values)).toBe(`pw=${PASSWORD}!`);
    expect(substituteSecretText("{{secret:acme/PASSWORD}}", values)).toBe(PASSWORD);
    expect(substituteSecretText("\\{{secret:Acme/password}}", values)).toBe(
      "{{secret:Acme/password}}",
    );
    expect(substituteSecretText("no references", {})).toBe("no references");
  });

  test("fails without echoing any value when a reference has no value", () => {
    let caught: unknown;
    try {
      substituteSecretText("{{secret:Other/password}}", values);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InteractionSecretValueError);
    expect(String((caught as Error).message)).toContain("{{secret:Other/password}}");
    expect(String((caught as Error).message)).not.toContain(PASSWORD);
    expect(() => substituteSecretText("{{secret:}}", values)).toThrow(InteractionSecretValueError);
  });
});

describe("browser actions", () => {
  test("keys typing mode is opt-in and validated", () => {
    expect(BrowserAction.parse({ type: "type", text: "123456", mode: "keys" })).toEqual({
      type: "type",
      text: "123456",
      mode: "keys",
    });
    expect(() => BrowserAction.parse({ type: "type", text: "1", mode: "paste" })).toThrow();
  });

  test("secret texts cover fill, type and clipboard write, including batches", () => {
    expect(
      browserActionSecretTexts({
        type: "batch",
        actions: [
          { type: "fill", locator: { kind: "ref", ref: "e1" }, value: "a" },
          { type: "type", text: "b" },
          { type: "clipboard", operation: "write", text: "c" },
          { type: "click", locator: { kind: "ref", ref: "e2" } },
          { type: "press", key: "Enter" },
        ],
      }),
    ).toEqual(["a", "b", "c"]);
  });

  test("materialization substitutes only with a side map", () => {
    const action = {
      type: "batch" as const,
      actions: [
        {
          type: "fill" as const,
          locator: { kind: "ref" as const, ref: "e1" },
          value: "{{secret:Acme/password}}",
        },
        { type: "type" as const, text: "{{secret:Acme/otp}}", mode: "keys" as const },
        { type: "clipboard" as const, operation: "write" as const, text: "x{{secret:Acme/otp}}" },
      ],
    };
    expect(materializeBrowserActionSecrets({ action })).toBe(action);
    expect(materializeBrowserActionSecrets({ action, secretValues: values })).toEqual({
      type: "batch",
      actions: [
        { type: "fill", locator: { kind: "ref", ref: "e1" }, value: PASSWORD },
        { type: "type", text: "123456", mode: "keys" },
        { type: "clipboard", operation: "write", text: "x123456" },
      ],
    });
    // The original command still carries only references.
    expect(JSON.stringify(action)).not.toContain(PASSWORD);
  });

  test("the side map is private: commands accept it, public requests reject it", () => {
    const command = BrowserActionCommand.parse({
      ...browserCommand,
      action: { type: "type", text: "{{secret:Acme/password}}" },
      secretValues: values,
    });
    expect(command.secretValues).toEqual(values);
    expect(withoutInteractionSecretValues(command)).not.toHaveProperty("secretValues");
    expect(JSON.stringify(withoutInteractionSecretValues(command))).not.toContain(PASSWORD);
    expect(
      BrowserActionRequest.safeParse({
        operationId: browserCommand.operationId,
        targetId: "target-1",
        expectedTargetGeneration: "target-1",
        expectedDocumentGeneration: null,
        expectedFrameId: null,
        action: { type: "type", text: "x" },
        secretValues: values,
      }).success,
    ).toBe(false);
    expect(
      ComputerActionRequest.safeParse({
        operationId: browserCommand.operationId,
        targetId: "t",
        expectedTargetGeneration: "g",
        expectedObservationId: null,
        action: { type: "keyboard", action: "type", value: "x" },
        secretValues: values,
      }).success,
    ).toBe(false);
    expect(
      ComputerNativeCallRequest.safeParse({
        operationId: browserCommand.operationId,
        tool: "type_text",
        arguments: { text: "x" },
        secretValues: values,
      }).success,
    ).toBe(false);
  });
});

describe("computer actions", () => {
  test("keyboard type, set_value and clipboard write carry references", () => {
    expect(computerActionSecretTexts({ type: "keyboard", action: "type", value: "a" })).toEqual([
      "a",
    ]);
    expect(
      computerActionSecretTexts({ type: "keyboard", action: "press", value: "Enter" }),
    ).toEqual([]);
    expect(
      materializeComputerActionSecrets({
        action: {
          type: "semantic",
          locator: { kind: "ref", ref: "n1" },
          action: "set_value",
          value: "{{secret:Acme/password}}",
        },
        secretValues: values,
      }),
    ).toEqual({
      type: "semantic",
      locator: { kind: "ref", ref: "n1" },
      action: "set_value",
      value: PASSWORD,
    });
  });

  test("native arguments are replaced deeply", () => {
    const command = ComputerNativeCommand.parse({
      operationId: browserCommand.operationId,
      tool: "type_text",
      arguments: { text: "{{secret:Acme/password}}", nested: ["{{secret:Acme/otp}}", 3] },
      protocolVersion: 1,
      computerSessionId: browserCommand.browserSessionId,
      controllerGeneration: "controller-1",
      targetId: null,
      actor: { kind: "agent", subjectId: "agent:fixture" },
      secretValues: values,
    });
    expect(materializeComputerNativeSecrets(command)).toEqual({
      text: PASSWORD,
      nested: ["123456", 3],
    });
    expect(materializeComputerNativeSecrets({ arguments: command.arguments })).toBe(
      command.arguments,
    );
  });
});

describe("redactInteractionSecretValues", () => {
  test("removes values from text but keeps identifiers and short values", () => {
    const result = redactInteractionSecretValues(
      {
        content: [{ type: "text", text: `Typed ${PASSWORD} and 123456` }],
        ref: "123456",
        targetId: "123456",
        data: `base64${PASSWORD}`,
        nested: { name: `x${PASSWORD}`, short: "ab" },
      },
      { ...values, short: "ab" },
    );
    expect(result.content[0]!.text).toBe(
      `Typed ${INTERACTION_REDACTED_SECRET} and ${INTERACTION_REDACTED_SECRET}`,
    );
    expect(result.ref).toBe("123456");
    expect(result.targetId).toBe("123456");
    expect(result.data).toBe(`base64${PASSWORD}`);
    expect(result.nested).toEqual({ name: `x${INTERACTION_REDACTED_SECRET}`, short: "ab" });
    expect(redactInteractionSecretValues("plain", undefined)).toBe("plain");
  });
});

describe("passkey sync contracts", () => {
  test("events and requests are bounded and strict", () => {
    const credential = {
      rpId: "localhost",
      credentialId: "AAECAw==",
      userHandle: "dXNlcg",
      userName: "alice",
      userDisplayName: null,
      privateKey: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg",
      signCount: 3,
    };
    expect(
      BrowserPasskeyEvent.parse({
        type: "registered",
        eventId: "66666666-6666-4666-8666-666666666666",
        occurredAt: "2026-10-12T20:00:00.000Z",
        targetId: "target-1",
        origin: "http://localhost:47420",
        credential,
      }).type,
    ).toBe("registered");
    expect(
      BrowserPasskeySyncRequest.safeParse({
        protocolVersion: 1,
        browserSessionId: browserCommand.browserSessionId,
        controllerGeneration: "controller-1",
        credentials: [{ ...credential, itemId: "77777777-7777-4777-8777-777777777777" }],
        acknowledgeEventIds: [],
      }).success,
    ).toBe(true);
    expect(
      BrowserPasskeySyncRequest.safeParse({
        protocolVersion: 1,
        browserSessionId: browserCommand.browserSessionId,
        controllerGeneration: "controller-1",
        credentials: [{ ...credential, itemId: "77777777-7777-4777-8777-777777777777", extra: 1 }],
        acknowledgeEventIds: [],
      }).success,
    ).toBe(false);
  });
});

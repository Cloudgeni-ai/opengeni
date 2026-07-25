import { describe, expect, test } from "bun:test";
import { sessionPromptPayloadIdentity } from "../src/session-queue-commands";

const base = {
  delivery: "send" as const,
  text: "hello",
  resources: [],
  tools: [],
  toolsProvided: false,
  source: "user" as const,
};

describe("session prompt payload identity", () => {
  test("is stable while excluding credential values", () => {
    const left = sessionPromptPayloadIdentity({
      ...base,
      credentialUpdates: [
        {
          id: "private",
          headers: { "X-Session": "secondary-left", Authorization: "secret-left" },
        },
      ],
    });
    const right = sessionPromptPayloadIdentity({
      ...base,
      credentialUpdates: [
        {
          id: "private",
          headers: { Authorization: "secret-right", "X-Session": "secondary-right" },
        },
      ],
    });

    expect(left).toEqual(right);
    expect(left).toEqual({ version: 2, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(left)).not.toContain("secret-left");
    expect(JSON.stringify(left)).not.toContain("secret-right");
    expect(JSON.stringify(left)).not.toContain("secondary-left");
    expect(JSON.stringify(left)).not.toContain("secondary-right");
  });

  test("binds credential shape and absent-versus-explicit tools", () => {
    const absent = sessionPromptPayloadIdentity({ ...base, credentialUpdates: [] });
    const explicit = sessionPromptPayloadIdentity({
      ...base,
      toolsProvided: true,
      credentialUpdates: [],
    });
    const credentialShape = sessionPromptPayloadIdentity({
      ...base,
      credentialUpdates: [{ id: "private", headers: { Authorization: "secret" } }],
    });

    expect(explicit.hash).not.toBe(absent.hash);
    expect(credentialShape.hash).not.toBe(absent.hash);
  });

  test("keeps Send and Steer action identities distinct", () => {
    const send = sessionPromptPayloadIdentity({ ...base, credentialUpdates: [] });
    const steer = sessionPromptPayloadIdentity({
      ...base,
      delivery: "steer",
      credentialUpdates: [],
    });

    expect(steer.hash).not.toBe(send.hash);
  });
});

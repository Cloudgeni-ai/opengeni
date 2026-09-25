import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceWebhookRequest,
  CredentialProviderResponse,
  resolveWorkspaceDefaultSandboxImage,
  signOpenGeniPayload,
  UpdateWorkspaceSettingsRequest,
  verifyOpenGeniSignature,
} from "../src/index";

describe("OpenGeni signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "event", type: "turn.completed" });

  test("round-trips and binds the timestamp and exact body", async () => {
    const signature = await signOpenGeniPayload(secret, body, 1_700_000_000);
    expect(signature).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(
      await verifyOpenGeniSignature({ secret, body, signature, nowSeconds: 1_700_000_010 }),
    ).toBe(true);
    expect(
      await verifyOpenGeniSignature({
        secret,
        body: `${body} `,
        signature,
        nowSeconds: 1_700_000_010,
      }),
    ).toBe(false);
    expect(
      await verifyOpenGeniSignature({
        secret: "other",
        body,
        signature,
        nowSeconds: 1_700_000_010,
      }),
    ).toBe(false);
    const forgedTime = signature.replace("t=1700000000", "t=1700000005");
    expect(
      await verifyOpenGeniSignature({
        secret,
        body,
        signature: forgedTime,
        nowSeconds: 1_700_000_010,
      }),
    ).toBe(false);
  });

  test("rejects stale, malformed, and missing signatures", async () => {
    const signature = await signOpenGeniPayload(secret, body, 1_700_000_000);
    expect(
      await verifyOpenGeniSignature({ secret, body, signature, nowSeconds: 1_700_000_301 }),
    ).toBe(false);
    for (const bad of [null, "", "v1=abc", "t=1700000000", "t=x,v1=00"]) {
      expect(await verifyOpenGeniSignature({ secret, body, signature: bad })).toBe(false);
    }
  });
});

describe("workspace integration contracts", () => {
  test("webhook event types are a closed set and deduplicated", () => {
    expect(
      CreateWorkspaceWebhookRequest.parse({
        url: "https://receiver.example/hook",
        eventTypes: ["turn.completed", "turn.completed", "turn.failed"],
      }).eventTypes,
    ).toEqual(["turn.completed", "turn.failed"]);
    expect(
      CreateWorkspaceWebhookRequest.safeParse({
        url: "https://receiver.example/hook",
        eventTypes: ["agent.message.delta"],
      }).success,
    ).toBe(false);
  });

  test("credential provider git hosts must be bare hostnames", () => {
    expect(
      CredentialProviderResponse.safeParse({
        status: "ok",
        git: [{ host: "github.com", password: "token" }],
      }).success,
    ).toBe(true);
    expect(
      CredentialProviderResponse.safeParse({
        status: "ok",
        git: [{ host: "evil.example/path@github.com", password: "token" }],
      }).success,
    ).toBe(false);
  });

  test("default sandbox image is an optional settings field", () => {
    expect(resolveWorkspaceDefaultSandboxImage({ defaultSandboxImage: "ghcr.io/a/b:1" })).toBe(
      "ghcr.io/a/b:1",
    );
    expect(resolveWorkspaceDefaultSandboxImage({})).toBeNull();
    expect(UpdateWorkspaceSettingsRequest.safeParse({ defaultSandboxImage: "a b" }).success).toBe(
      false,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ defaultSandboxImage: null }).success).toBe(
      true,
    );
  });
});

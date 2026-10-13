import { describe, expect, test } from "bun:test";
import { encryptEnvironmentValue } from "@opengeni/db";
import {
  decryptVideoGenerationCredential,
  decryptVideoGenerationApiKey,
  encryptVideoGenerationApiKey,
  encryptVideoGenerationConnectionReference,
} from "../src/activities/video-generation-credential";

describe("video generation credential envelope", () => {
  const key = Buffer.alloc(32, 7);

  test("round-trips one shared API-key envelope", () => {
    const encrypted = encryptVideoGenerationApiKey(key, "gateway-secret");
    expect(encrypted).not.toContain("gateway-secret");
    expect(decryptVideoGenerationApiKey(key, encrypted)).toBe("gateway-secret");
  });

  test("never echoes malformed decrypted plaintext", () => {
    const secret = "secret-that-must-never-enter-an-error";
    const encrypted = encryptEnvironmentValue(key, secret);
    let message = "";
    try {
      decryptVideoGenerationApiKey(key, encrypted);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Video provider credential lease is malformed");
    expect(message).not.toContain(secret);
  });

  test("round-trips a subscription connection reference without token material", () => {
    const encrypted = encryptVideoGenerationConnectionReference(key, {
      provider: "xai",
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(decryptVideoGenerationCredential(key, encrypted)).toEqual({
      kind: "subscription-connection",
      provider: "xai",
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("refuses a retired SuperGrok token envelope without echoing its tokens", () => {
    // The legacy SuperGrok runtime (deleted in M4 X4) froze tokens into the
    // envelope; nothing decodes that shape any more.
    const encrypted = encryptEnvironmentValue(
      key,
      JSON.stringify({
        kind: "xai-subscription",
        accessToken: "xai-access",
        refreshToken: "xai-refresh",
        userId: "xai-user",
        credentialId: "11111111-1111-4111-8111-111111111111",
        subjectId: "user:owner",
        authoritySnapshot: { version: 1, scope: "workspace" },
      }),
    );
    let message = "";
    try {
      decryptVideoGenerationCredential(key, encrypted);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Video provider credential lease is malformed");
    expect(message).not.toContain("xai-refresh");
  });
});

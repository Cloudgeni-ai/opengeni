import { describe, expect, test } from "bun:test";
import { WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1 } from "@opengeni/contracts";
import { encryptEnvironmentValue } from "@opengeni/db";
import {
  decryptVideoGenerationCredential,
  decryptVideoGenerationApiKey,
  encryptVideoGenerationApiKey,
  encryptVideoGenerationXaiCredential,
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

  test("freezes a complete refreshable SuperGrok lease", () => {
    const encrypted = encryptVideoGenerationXaiCredential(key, {
      accessToken: "xai-access",
      refreshToken: "xai-refresh",
      userId: "xai-user",
      credentialId: "11111111-1111-4111-8111-111111111111",
      subjectId: "user:owner",
      authoritySnapshot: WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
    });
    expect(encrypted).not.toContain("xai-refresh");
    expect(decryptVideoGenerationCredential(key, encrypted)).toEqual({
      kind: "xai-subscription",
      accessToken: "xai-access",
      refreshToken: "xai-refresh",
      userId: "xai-user",
      credentialId: "11111111-1111-4111-8111-111111111111",
      subjectId: "user:owner",
      authoritySnapshot: WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
    });
  });
});

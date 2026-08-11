import { describe, expect, test } from "bun:test";
import { encryptEnvironmentValue } from "@opengeni/db";
import {
  decryptVideoGenerationApiKey,
  encryptVideoGenerationApiKey,
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
});

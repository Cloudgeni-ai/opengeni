import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { assertAllowedEnvironmentVariableName, requireEnvironmentEncryption } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";

describe("environment variable name policy", () => {
  test("rejects platform-managed exact names", () => {
    for (const name of [
      "HOME",
      "PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "AZURE_DEVOPS_EXT_PAT",
      "GIT_ASKPASS",
      "GIT_TERMINAL_PROMPT",
      "BASH_ENV",
      "ENV",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "IFS",
    ]) {
      expect(() => assertAllowedEnvironmentVariableName(name)).toThrow(
        `reserved environment variable name: ${name}`,
      );
    }
  });

  test("rejects reserved prefixes", () => {
    for (const name of [
      "OPENGENI_DATABASE_URL",
      "GIT_CONFIG_COUNT",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(() => assertAllowedEnvironmentVariableName(name)).toThrow(
        `reserved environment variable name: ${name}`,
      );
    }
  });

  test("allows ordinary uppercase names", () => {
    for (const name of ["DATABASE_URL", "STRIPE_API_KEY", "AZURE_CLIENT_ID", "MY_APP_TOKEN_2"]) {
      expect(() => assertAllowedEnvironmentVariableName(name)).not.toThrow();
    }
  });
});

describe("environment encryption guard", () => {
  test("returns 503 when the deployment has no encryption key", () => {
    try {
      requireEnvironmentEncryption(testSettings());
      throw new Error("expected requireEnvironmentEncryption to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(503);
      expect((error as HTTPException).message).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
    }
  });

  test("returns the 32-byte key when configured", () => {
    const key = requireEnvironmentEncryption(
      testSettings({
        environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      }),
    );
    expect(key.length).toBe(32);
  });
});

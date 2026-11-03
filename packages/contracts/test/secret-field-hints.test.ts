/**
 * The save-time nudge (docs/secrets.md, Field kinds): plain values and field
 * names that look like a secret. Every value here is fake and assembled at
 * runtime.
 */
import { describe, expect, test } from "bun:test";
import { credentialNameSaysSecret, looksRandomSecret, plainFieldSecretHint } from "../src";

const mixed = (length: number) => "Ab1Cd2Ef3Gh4Jk5Lm6Np7Qr8St9Uv0Wx".repeat(4).slice(0, length);

describe("plain field hints", () => {
  test("a known token format is named", () => {
    expect(plainFieldSecretHint("note", `ghp_${mixed(36)}`)).toEqual({
      reason: "format",
      message: "Looks like a GitHub token.",
    });
    expect(plainFieldSecretHint("value", `sk-${mixed(40)}`)?.message).toBe(
      "Looks like an OpenAI key.",
    );
    expect(plainFieldSecretHint("website", `https://app:${mixed(20)}@db.example.com/x`)).toEqual({
      reason: "format",
      message: "Contains a URL password.",
    });
  });

  test("a long random value is a key or password", () => {
    expect(plainFieldSecretHint("username", `${mixed(30)}!`)?.reason).toBe("random");
    expect(looksRandomSecret(`${mixed(30)}!`)).toBe(true);
  });

  test("a field name that says secret", () => {
    expect(plainFieldSecretHint("api token", "anything")?.reason).toBe("name");
    expect(plainFieldSecretHint("client_secret", "anything")?.reason).toBe("name");
  });

  test("ordinary plain values and names give no hint", () => {
    for (const [name, value] of [
      ["username", "deploy-bot"],
      ["email", "someone@example.com"],
      ["host", "db.internal.example.com"],
      ["website", "https://example.com/login"],
      ["account", "f47ac10b-58cc-4372-a567-0e02b2c3d479"],
      ["public key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFake user@host"],
      ["api key id", "id-0001"],
      ["region", "eu-west-1"],
      ["note", "Rotate this every quarter"],
      ["path", "/srv/app/releases/2026-11-03/current"],
      ["username", ""],
    ] as const) {
      expect([name, plainFieldSecretHint(name, value)]).toEqual([name, null]);
    }
  });
});

describe("credential names", () => {
  test("names that hold a credential", () => {
    for (const name of [
      "PGPASSWORD",
      "GH_AUTH_TOKEN",
      "Authorization",
      "x-api-key",
      "clientSecret",
      "AWS_SECRET_ACCESS_KEY",
      "COOKIE",
    ]) {
      expect([name, credentialNameSaysSecret(name)]).toEqual([name, true]);
    }
  });

  test("names that only contain a credential word's letters, or describe one", () => {
    for (const name of [
      "GIT_AUTHOR_NAME",
      "SESSION_NAME",
      "TOKEN_ENDPOINT",
      "KEY_ALGORITHM",
      "AUTH_METHOD",
      "keycloak-realm",
      "Accept",
    ]) {
      expect([name, credentialNameSaysSecret(name)]).toEqual([name, false]);
    }
  });
});

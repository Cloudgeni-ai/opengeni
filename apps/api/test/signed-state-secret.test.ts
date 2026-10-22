import { describe, expect, test } from "bun:test";
import { createSignedState, readSignedState } from "@opengeni/github";
import { resolveSignedStateSecret } from "../src/signed-state-secret";

const none = {
  githubAppManifestStateSecret: undefined,
  integrationsStateSecret: undefined,
  betterAuthSecret: undefined,
  environmentsEncryptionKey: undefined,
};

describe("resolveSignedStateSecret", () => {
  test("an explicit manifest state secret is used unchanged", () => {
    const resolved = resolveSignedStateSecret({
      ...none,
      githubAppManifestStateSecret: "explicit-secret",
      integrationsStateSecret: "integrations-secret",
    });
    expect(resolved).toEqual({ secret: "explicit-secret", source: "explicit" });
  });

  test("without one, every replica derives the same key from a stable deployment secret", () => {
    const config = { ...none, integrationsStateSecret: "integrations-secret" };
    const replicaA = resolveSignedStateSecret(config);
    const replicaB = resolveSignedStateSecret(config);
    expect(replicaA.source).toBe("integrations_state_secret");
    expect(replicaB.secret).toBe(replicaA.secret);
    // Derived, never the source secret itself.
    expect(replicaA.secret).not.toBe("integrations-secret");
    const state = createSignedState(replicaA.secret, { purpose: "round-trip" });
    expect(readSignedState(state, replicaB.secret)?.purpose).toBe("round-trip");
  });

  test("falls back through better-auth and the environments key in order", () => {
    expect(
      resolveSignedStateSecret({
        ...none,
        betterAuthSecret: "auth",
        environmentsEncryptionKey: "k",
      }).source,
    ).toBe("better_auth_secret");
    expect(resolveSignedStateSecret({ ...none, environmentsEncryptionKey: "k" }).source).toBe(
      "environments_encryption_key",
    );
  });

  test("blank values are treated as unset", () => {
    expect(
      resolveSignedStateSecret({
        ...none,
        githubAppManifestStateSecret: "  ",
        integrationsStateSecret: "integrations-secret",
      }).source,
    ).toBe("integrations_state_secret");
  });

  test("only a deployment with no stable secret gets a per-process key", () => {
    const a = resolveSignedStateSecret(none);
    const b = resolveSignedStateSecret(none);
    expect(a.source).toBe("process_random");
    expect(a.secret).not.toBe(b.secret);
  });
});

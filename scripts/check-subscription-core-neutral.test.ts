import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkSubscriptionCoreNeutral,
  findViolations,
  sharedCoreFiles,
  sqlRegistryProviders,
} from "./check-subscription-core-neutral";

const root = join(import.meta.dir, "..");

describe("subscription-core neutrality guard", () => {
  test("the repository's shared core modules are provider-neutral and the registries agree", async () => {
    expect(await checkSubscriptionCoreNeutral(root)).toEqual([]);
    const files = sharedCoreFiles(root);
    expect(files).toContain("packages/db/src/subscription-core/turns.ts");
    expect(files).toContain("packages/db/src/subscription-core-placement-world.ts");
    expect(files).toContain("packages/subscriptions/src/eligibility.ts");
    expect(files).toContain("packages/subscriptions/src/adapter.ts");
    expect(files.some((path) => path.includes("codex"))).toBe(false);
    expect(sqlRegistryProviders(root)).toEqual(["codex"]);
  }, 60_000);

  test("provider names are refused in code, SQL text and comments", () => {
    for (const line of [
      'import { refreshCodexToken } from "@opengeni/codex";',
      "// Claude reports model-specific limits",
      "where provider_state->>'isFedramp' = 'true'",
      "const grokRealtime = true;",
      "xai_primary_connection_id",
      "XaiSubscription",
      "the xAI realtime API",
      "XAI_API_KEY",
      "OpenRouter spend budget",
    ]) {
      expect(findViolations("x.ts", line)).toHaveLength(1);
    }
  });

  test("provider conditionals are refused even for unknown providers", () => {
    for (const line of [
      'if (connection.provider === "acme") return;',
      "if (providerId !== 'acme') return;",
      "sql`where provider = 'acme'`",
      "and provider in ('acme', 'other')",
      'if ("acme" === providerId) return;',
      "switch (providerId) {",
      "switch (connection.provider) {",
      '["acme"].includes(providerId)',
      "const enabled = { acme: true }[providerId];",
      'if (providerId.startsWith("ac")) return;',
      "if (providerId === ACME_ID) return;",
      "where provider = any('{acme}')",
      "where provider is distinct from 'acme'",
      "where provider_id = 'acme'",
    ]) {
      expect(findViolations("x.ts", line)).toEqual([
        expect.objectContaining({ rule: "provider conditional" }),
      ]);
    }
  });

  test("data-driven provider use passes", () => {
    for (const line of [
      "where provider = ${providerId}",
      "if (row.provider !== providerId) throw new Error();",
      "const maxAttempts = 3;",
      "provider.adapter.displayName",
      "const maxAiTokens = taxAid;",
      "quotaStaleAfterMs?.[connection.provider]",
      'case "turn":',
      "values.providers?.[id]",
    ]) {
      expect(findViolations("x.ts", line)).toEqual([]);
    }
  });
});

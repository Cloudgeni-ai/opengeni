import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTION_KIND_MAPPING,
  checkSubscriptionCoreNeutral,
  findViolations,
  sharedCoreFiles,
  sqlRegistryConnectionKinds,
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
    expect(sqlRegistryConnectionKinds(root)).toEqual({ codex: "subscription" });
  }, 60_000);

  test("registry rows are read with their connection kind (default subscription)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "neutral-registry-"));
    try {
      mkdirSync(join(scratch, "packages/db/drizzle"), { recursive: true });
      writeFileSync(
        join(scratch, "packages/db/drizzle/0001_a.sql"),
        "INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits)\n" +
          "VALUES ('acme', true), ('other', false);\n",
      );
      writeFileSync(
        join(scratch, "packages/db/drizzle/0002_b.sql"),
        "INSERT INTO opengeni_private.subscription_core_providers\n" +
          "  (provider, primary_setting_column, connection_kind, extra_credits)\n" +
          "VALUES ('gateway', NULL, 'api_key', false);\n",
      );
      writeFileSync(
        join(scratch, "packages/db/drizzle/0003_c.sql"),
        "INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits, connection_kind)\n" +
          "VALUES ('router', false, 'api_key') ON CONFLICT (provider) DO NOTHING;\n",
      );
      expect(sqlRegistryConnectionKinds(scratch)).toEqual({
        acme: "subscription",
        other: "subscription",
        gateway: "api_key",
        router: "api_key",
      });
      expect(sqlRegistryProviders(scratch)).toEqual(["acme", "gateway", "other", "router"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

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

  test("connection kinds are never named by a literal outside union types", () => {
    for (const line of [
      "and connection.kind = 'subscription'",
      "sql`where kind = 'api_key'`",
      "and kind <> 'subscription'",
      "and kind in ('subscription', 'api_key')",
      "and connection.kind is distinct from 'subscription'",
      'if (connection.kind === "subscription") return;',
      "if (row.kind !== 'api_key') return;",
      'if ("api_key" === connection.kind) return;',
      "values ($1, $2, 'subscription', $3)",
      'const connectionKind = "subscription";',
      'const row = { provider: providerId, kind: "api_key" };',
      "  connectionKind: 'api_key',",
      '  connectionKind: "api_key",',
      'if (connectionKind === "api_key") return;',
      'case "api_key":',
      'return "subscription";',
      'and kind = ${"api_key"}',
      'writeRow(tx, providerId, "api_key", input);',
      'credentialKind === "api_key" ? "api_key" : "subscription"',
      'if (connectionKind === "api_key" || refreshless) return 1;',
      'const k = row.kind || "subscription";',
      "where kind = 'subscription' || ${x}",
      '/* legacy */ if (kind === "api_key") return 1;',
      '  * (kind === "api_key" ? 2 : 1)',
      'return "api_key"; // the kind',
      // Comment markers inside regular-expression literals are not comments.
      'const url = /https?:\\/\\//; const kind = "api_key";',
      'const slashes = /\\/*/; if (kind === "api_key") return 1;',
      'const marks = /[/*]/; const k = "subscription";',
      'if (/\\/\\//.test(x)) return "api_key";',
    ]) {
      expect(findViolations("x.ts", line)).toEqual([
        expect.objectContaining({ rule: "connection kind literal" }),
      ]);
    }
    for (const line of [
      "and connection.kind = ${subscriptionCoreConnectionKind(provider)}",
      "and connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)",
      'kind: "subscription" | "api_key";',
      'export type ConnectionKind = "subscription" | "api_key";',
      '): "subscription" | "api_key" {',
      '// a "subscription" connection',
      'const label = "rows"; // never "api_key" here',
      'const id = run(/* "subscription" */ value);',
      'if (outcome.kind === "rate_limited") return;',
      "and lease.kind = 'turn'",
      "resource_kind = 'subscription_connection'",
      // A division is not a regular expression, so the comment after it is one.
      'const half = total / 2; // "api_key" here',
      'const ratio = (a + b) / c / d; /* "subscription" */',
    ]) {
      expect(findViolations("x.ts", line)).toEqual([]);
    }
    // Kind words inside block comments, and comment markers inside strings
    // and template literals, are read as such across lines.
    expect(
      findViolations(
        "x.ts",
        [
          "/**",
          " * else \"subscription\"; an 'api_key' adapter's rows",
          " */",
          'const url = "https://example.test"; const kind = "api_key";',
          "const query = sql`select 1 /* ${providerId} */ where kind = 'api_key'`;",
        ].join("\n"),
      ).map((violation) => violation.line),
    ).toEqual([4, 5]);
    // The one mapping from the adapter's credential kind, in its own module only.
    expect(
      findViolations(CONNECTION_KIND_MAPPING.path, `  ${CONNECTION_KIND_MAPPING.text}`),
    ).toEqual([]);
  });
});

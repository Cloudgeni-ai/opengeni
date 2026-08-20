import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Session-visibility contract stabilization (organization-tenancy slice 10).
//
// Migration 0303 activates the hardened database prerequisite behind two
// privileged SECURITY DEFINER lifecycle surfaces -
// `transition_session_visibility` and `fork_session_content` - plus a matching
// `@opengeni/db/session-tenancy` adapter, two `SessionAuthorizationOperation`
// literals, and a `session.visibility.changed` event type. The surrounding
// database authority (owner derivation on insert, the capability-fenced direct
// write guard, and the restrictive `session_visibility_isolation` policies) is
// ACTIVE for organizations carrying the durable activation receipt. Product
// callers remain deliberately absent: no API route, core domain function,
// worker activity, MCP tool, SDK call, or UI reaches either adapter yet.
//
// That is a decision, not an accident. Personal visibility cannot be exposed to
// humans until the later product slice in `docs/organization-tenancy.md`
// ("Session-visibility and fork surfaces: database activated, product callers
// pending") lands.
//
// These tests pin that boundary so a future caller has to arrive through that
// decision on purpose. If you are adding the first real caller, update the doc
// section and this file in the same change.
// ---------------------------------------------------------------------------

const repo = join(import.meta.dir, "..");

const SQL_ENTRY_POINTS = ["transition_session_visibility", "fork_session_content"] as const;
const ADAPTER_ENTRY_POINTS = ["transitionSessionVisibility", "forkSessionContent"] as const;
const AUTHORIZATION_OPERATIONS = ["session.visibility.write", "session.fork.create"] as const;

/** Files allowed to name the SQL entry points: origin definition, later body
 * replacements that only copy newly required session columns, grants, posture,
 * adapter. Product callers remain forbidden. */
const SQL_ENTRY_POINT_ALLOWLIST = new Set([
  "packages/db/drizzle/0225_session_visibility_fork_activation.sql",
  "packages/db/drizzle/0289_session_composer_policy_authority.sql",
  "packages/db/drizzle/0303_session_tenancy_product_activation.sql",
  "packages/db/src/session-tenancy.ts",
  "packages/db/src/provision-roles.ts",
  "packages/db/src/runtime-posture.ts",
]);

async function sourceFiles(root: string, pattern = "**/*.{ts,tsx}"): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: join(repo, root) })) {
    files.push(join(root, path));
  }
  return files.sort();
}

describe("session visibility and fork database contract is activated without product callers", () => {
  test("no product package reaches either lifecycle entry point", async () => {
    const roots = [
      "apps/api/src",
      "apps/worker/src",
      "apps/web/src",
      "packages/core/src",
      "packages/runtime/src",
      "packages/sdk/src",
      "packages/react/src",
      "packages/contracts/src",
    ];
    const forbidden = [...SQL_ENTRY_POINTS, ...ADAPTER_ENTRY_POINTS];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const content = await readFile(join(repo, file), "utf8");
        for (const marker of forbidden) {
          expect(
            content.includes(marker),
            `${file} must not reach ${marker}: the session-tenancy database prerequisite is activated, but product callers remain out of scope. See docs/organization-tenancy.md "Session-visibility and fork surfaces: database activated, product callers pending".`,
          ).toBe(false);
        }
      }
    }
  });

  test("the SQL entry points are named only by their definition, grants, posture, and adapter", async () => {
    for (const file of [
      ...(await sourceFiles("packages/db/src")),
      ...(await sourceFiles("packages/db/drizzle", "*.sql")),
    ]) {
      if (SQL_ENTRY_POINT_ALLOWLIST.has(file)) continue;
      const content = await readFile(join(repo, file), "utf8");
      for (const marker of SQL_ENTRY_POINTS) {
        expect(
          content.includes(marker),
          `${file} must not name ${marker}; 0225 remains the origin definition, allowlisted migrations may replace the fenced database contract, and packages/db/src/session-tenancy.ts remains the sole adapter.`,
        ).toBe(false);
      }
    }
  });

  test("the adapter still exists so the db test lane keeps proving the fenced behaviour", async () => {
    const adapter = await readFile(join(repo, "packages/db/src/session-tenancy.ts"), "utf8");
    for (const marker of [...SQL_ENTRY_POINTS, ...ADAPTER_ENTRY_POINTS]) {
      expect(adapter).toContain(marker);
    }
    const posture = await readFile(join(repo, "packages/db/src/runtime-posture.ts"), "utf8");
    for (const marker of SQL_ENTRY_POINTS) {
      expect(posture).toContain(marker);
    }
    expect(adapter).toContain("const SESSION_TENANCY_ACTIVATION_VERSION = 1");
    expect(adapter.match(/\$\{SESSION_TENANCY_ACTIVATION_VERSION\}/gu)).toHaveLength(2);
  });

  test("the sole later-migration direct caller supplies the durable receipt and exact version", async () => {
    const regression = await readFile(
      join(repo, "packages/db/test/migration-0241-atomic-personal-resource-delegation.test.ts"),
      "utf8",
    );
    expect(regression).toContain("insert into session_tenancy_activations");
    expect(regression).toMatch(/transition_session_visibility\([\s\S]*?'a{64}',\s*1\s*\)/u);
  });

  test("the two authorization operations remain declarations with no enforcement", async () => {
    const contracts = await readFile(join(repo, "packages/contracts/src/index.ts"), "utf8");
    for (const operation of AUTHORIZATION_OPERATIONS) {
      expect(contracts).toContain(operation);
    }
    const roots = [
      "apps/api/src",
      "apps/worker/src",
      "apps/web/src",
      "packages/core/src",
      "packages/runtime/src",
      "packages/sdk/src",
      "packages/react/src",
    ];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const content = await readFile(join(repo, file), "utf8");
        for (const operation of AUTHORIZATION_OPERATIONS) {
          expect(
            content.includes(operation),
            `${file} must not authorize ${operation} while the surface is inert.`,
          ).toBe(false);
        }
      }
    }
  });

  test("the decision stays recorded next to the tenancy activation phases", async () => {
    const doc = await readFile(join(repo, "docs/organization-tenancy.md"), "utf8");
    expect(doc).toContain(
      "## Session-visibility and fork surfaces: database activated, product callers pending",
    );
    expect(doc).toContain("transition_session_visibility");
    expect(doc).toContain("fork_session_content");
    expect(doc).toContain("session_list_snapshots");
  });
});

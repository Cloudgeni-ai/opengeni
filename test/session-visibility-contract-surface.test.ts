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
// ACTIVE for organizations carrying the durable activation receipt. The first
// public caller is deliberately narrow: one core application service reached
// by the two HTTP routes and the framework-neutral SDK, with the activation-
// gated web control using only that SDK boundary. Worker, MCP, runtime, React,
// cross-workspace, attachment, and personal-grant callers remain forbidden.
// ---------------------------------------------------------------------------

const repo = join(import.meta.dir, "..");

const SQL_ENTRY_POINTS = [
  "transition_session_visibility",
  "fork_session_content",
  // `replay_applied_session_fork` answers a fork's committed destination
  // WITHOUT consulting mutable source-session authorization. That is exactly
  // why it must stay pinned to the same narrow boundary as the two lifecycle
  // functions: it is granted to `opengeni_app`, so any new importer would
  // otherwise pass every guard in the tree.
  "replay_applied_session_fork",
] as const;
const ADAPTER_ENTRY_POINTS = [
  "transitionSessionVisibility",
  "forkSessionContent",
  "replayAppliedSessionFork",
] as const;
const AUTHORIZATION_OPERATIONS = ["session.visibility.write", "session.fork.create"] as const;
const ADAPTER_CALLER_ALLOWLIST = new Set(["packages/core/src/application/session-tenancy.ts"]);
const AUTHORIZATION_CALLER_ALLOWLIST = new Set([
  "packages/core/src/application/session-tenancy.ts",
  "apps/api/src/routes/sessions.ts",
]);

/** Files allowed to name the SQL entry points: origin definition, later body
 * replacements that only copy newly required session columns, grants, posture,
 * adapter. Product callers remain forbidden. */
const SQL_ENTRY_POINT_ALLOWLIST = new Set([
  "packages/db/drizzle/0225_session_visibility_fork_activation.sql",
  "packages/db/drizzle/0289_session_composer_policy_authority.sql",
  "packages/db/drizzle/0303_session_tenancy_product_activation.sql",
  "packages/db/drizzle/0336_atomic_session_fork_visibility.sql",
  "packages/db/drizzle/0345_tenant_scoped_session_tenancy_fence.sql",
  "packages/db/drizzle/0349_session_variable_set_attachments.sql",
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

describe("session visibility and fork product activation stays on its exact public boundary", () => {
  test("only the core application boundary reaches the database adapter", async () => {
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
        if (ADAPTER_CALLER_ALLOWLIST.has(file)) continue;
        const content = await readFile(join(repo, file), "utf8");
        for (const marker of forbidden) {
          expect(
            content.includes(marker),
            `${file} must not reach ${marker}; the first product activation is API/core/SDK-only and packages/core/src/application/session-tenancy.ts is the sole adapter caller.`,
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
    // One probe plus the exact version supplied to visibility transition, the
    // base and runtime-configured fork paths, and both applied-fork receipt
    // recovery paths.
    expect(adapter.match(/\$\{SESSION_TENANCY_ACTIVATION_VERSION\}/gu)).toHaveLength(6);
  });

  test("the sole later-migration direct caller supplies the durable receipt and exact version", async () => {
    const regression = await readFile(
      join(repo, "packages/db/test/migration-0241-atomic-personal-resource-delegation.test.ts"),
      "utf8",
    );
    expect(regression).toContain("insert into session_tenancy_activations");
    expect(regression).toMatch(/transition_session_visibility\([\s\S]*?'a{64}',\s*1\s*\)/u);
  });

  test("the two authorization operations are enforced only by core and the HTTP classifier", async () => {
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
        if (AUTHORIZATION_CALLER_ALLOWLIST.has(file)) continue;
        const content = await readFile(join(repo, file), "utf8");
        for (const operation of AUTHORIZATION_OPERATIONS) {
          expect(
            content.includes(operation),
            `${file} must not authorize ${operation}; worker, MCP, runtime, SDK implementation, React, and web remain out of scope.`,
          ).toBe(false);
        }
      }
    }
  });

  test("the decision stays recorded next to the tenancy activation phases", async () => {
    const doc = await readFile(join(repo, "docs/organization-tenancy.md"), "utf8");
    expect(doc).toContain("## Session-visibility and fork public activation");
    expect(doc).toContain("transition_session_visibility");
    expect(doc).toContain("fork_session_content");
    expect(doc).toContain("session_list_snapshots");
  });
});

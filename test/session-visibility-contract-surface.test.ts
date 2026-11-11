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
// ACTIVE for every organization: rolling migration 0611 retired the
// per-organization activation receipt prerequisite. The first public caller is
// deliberately narrow: one core application service reached by the two HTTP
// routes and the framework-neutral SDK, with the web control using only that
// SDK boundary. Worker, MCP, runtime, React,
// cross-workspace, attachment, and personal-grant callers remain forbidden.
// ---------------------------------------------------------------------------

const repo = join(import.meta.dir, "..");

/** Owner-only preview reads, named by the visibility-work reader instead of the adapter. */
const OWNER_PREVIEW_ROUTINES = [
  // 0768's preview of a standing block; since 0769 it always answers NULL and
  // stays granted only for older releases.
  "session_visibility_change_blocker",
  // Owner-only counts of other people's access a private change drops (0769).
  "session_visibility_foreign_authority_items",
] as const;
const SQL_ENTRY_POINTS = [
  "transition_session_visibility",
  "fork_session_content",
  // `replay_applied_session_fork` answers a fork's committed destination
  // WITHOUT consulting mutable source-session authorization. That is exactly
  // why it must stay pinned to the same narrow boundary as the two lifecycle
  // functions: it is granted to `opengeni_app`, so any new importer would
  // otherwise pass every guard in the tree.
  "replay_applied_session_fork",
  ...OWNER_PREVIEW_ROUTINES,
] as const;
const ADAPTER_ENTRY_POINTS = [
  "transitionSessionVisibility",
  "forkSessionContent",
  "replayAppliedSessionFork",
  "inspectSessionVisibilityChange",
  "stopSessionWorkForVisibilityChange",
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

  test("the adapter still exists so the db test lane keeps proving the fenced behaviour", async () => {
    const adapter = await readFile(join(repo, "packages/db/src/session-tenancy.ts"), "utf8");
    const previews = new Set<string>(OWNER_PREVIEW_ROUTINES);
    for (const marker of [...SQL_ENTRY_POINTS, ...ADAPTER_ENTRY_POINTS]) {
      if (!previews.has(marker)) expect(adapter).toContain(marker);
    }
    const workReader = await readFile(
      join(repo, "packages/db/src/session-visibility-work.ts"),
      "utf8",
    );
    expect(workReader).toContain("session_visibility_foreign_authority_items");
    const posture = await readFile(join(repo, "packages/db/src/runtime-posture.ts"), "utf8");
    for (const marker of SQL_ENTRY_POINTS) {
      expect(posture).toContain(marker);
    }
    expect(adapter).toContain("const SESSION_TENANCY_ACTIVATION_VERSION = 1");
    // The exact frozen protocol version supplied to visibility transition, the
    // base and runtime-configured fork paths, and both applied-fork receipt
    // recovery paths. There is no activation probe since 0611.
    expect(adapter.match(/\$\{SESSION_TENANCY_ACTIVATION_VERSION\}/gu)).toHaveLength(5);
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

test("Teams message admission and private creation have exactly one trusted product caller", async () => {
  const permitted = new Map([
    [
      "teamsConversation",
      new Set(["apps/api/src/integrations/teams-bot.ts", "packages/core/src/domain/sessions.ts"]),
    ],
    [
      "authorizeTeamsConversationAdmission",
      new Set([
        "packages/core/src/application/teams-private-session.ts",
        "packages/core/src/domain/sessions.ts",
      ]),
    ],
    [
      "requireTeamsConversationProof",
      new Set([
        "packages/core/src/application/teams-private-session.ts",
        "packages/db/src/teams-private-session.ts",
      ]),
    ],
  ]);
  for (const root of [
    "apps/api/src",
    "apps/worker/src",
    "apps/web/src",
    "packages/core/src",
    "packages/db/src",
    "packages/contracts/src",
    "packages/sdk/src",
    "packages/runtime/src",
  ]) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(join(repo, file), "utf8");
      for (const [marker, allowed] of permitted) {
        if (source.includes(marker))
          expect(
            allowed.has(file),
            `${file} expands the trusted Teams private-creation seam through ${marker}`,
          ).toBe(true);
      }
    }
  }
});

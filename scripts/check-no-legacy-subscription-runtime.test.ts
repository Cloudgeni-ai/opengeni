import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkLegacySubscriptionSource } from "./check-no-legacy-subscription-runtime";
import {
  LEGACY_CLAUDE_RUNTIME,
  LEGACY_CODEX_RUNTIME,
  LEGACY_SUBSCRIPTION_RETIREMENTS,
  LEGACY_XAI_RUNTIME,
  type LegacySubscriptionRetirement,
} from "./legacy-subscription-runtime";

const codex = (file: string, code: string) =>
  checkLegacySubscriptionSource(file, code, [LEGACY_CODEX_RUNTIME]);
const xai = (file: string, code: string) =>
  checkLegacySubscriptionSource(file, code, [LEGACY_XAI_RUNTIME]);
const claude = (file: string, code: string) =>
  checkLegacySubscriptionSource(file, code, [LEGACY_CLAUDE_RUNTIME]);

describe("no-legacy subscription runtime guard: engine", () => {
  test("the engine names no provider; every provider is a registered entry", () => {
    const engine = readFileSync(
      new URL("./check-no-legacy-subscription-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(engine).not.toMatch(/codex|xai|supergrok|claude/i);
    expect(LEGACY_SUBSCRIPTION_RETIREMENTS.map((entry) => entry.id)).toEqual([
      "codex",
      "xai",
      "claude",
    ]);
    expect(LEGACY_SUBSCRIPTION_RETIREMENTS.map((runtime) => runtime.name)).toEqual([
      "Codex (M3 PR4)",
      "SuperGrok (M4 X4)",
      "Claude (M4 C4)",
    ]);
  });
  test("a new entry is enforced without changing the engine", () => {
    const retired: LegacySubscriptionRetirement = {
      id: "pool",
      name: "Example",
      identifiers: ["example_legacy_table"],
      patterns: [{ pattern: /mintExampleSubject\(\)/, message: "Retired example subject" }],
      deletedModules: [/example-producer(?:\.[cm]?[jt]s)?$/],
      testFixtures: /legacy-example/,
      exceptions: {
        "packages/db/src/schema.ts": { declarations: ["exampleTable"], reason: "schema" },
      },
    };
    const check = (file: string, code: string) =>
      checkLegacySubscriptionSource(file, code, [retired]);
    expect(check("packages/db/src/index.ts", "sql`select * from example_legacy_table`;")).toEqual([
      {
        file: "packages/db/src/index.ts",
        line: 1,
        message: "Retired Example decision state example_legacy_table",
      },
    ]);
    expect(check("apps/worker/src/run.ts", "const subject = mintExampleSubject();")).toHaveLength(
      1,
    );
    expect(check("apps/worker/src/run.ts", 'import "./example-producer";')).toHaveLength(1);
    expect(
      check("apps/worker/src/run.ts", 'import "../test/fixtures/legacy-example";'),
    ).toHaveLength(1);
    expect(
      check("packages/db/src/schema.ts", 'export const exampleTable = "example_legacy_table";'),
    ).toEqual([]);
  });
  test("a destructured declaration is excused only when every binding is declared", () => {
    expect(
      xai(
        "packages/db/src/schema.ts",
        "export const { credentials: xaiSubscriptionCredentials, capacityWaiters: xaiCapacityWaiters } = tables;",
      ),
    ).toEqual([]);
    expect(
      xai(
        "packages/db/src/schema.ts",
        "export const { credentials: xaiSubscriptionCredentials, reader: leakXaiRows } = { credentials: 1, reader: () => sql`select * from xai_capacity_waiters` };",
      ),
    ).toHaveLength(2);
  });
  test("one provider's exception never excuses another provider's identifiers", () => {
    // RUNTIME_READ_ONLY_TABLES is a Codex exception in runtime-posture.ts, not a SuperGrok one.
    const code =
      'export const RUNTIME_READ_ONLY_TABLES = ["codex_turn_source_bindings", "xai_capacity_waiters"];';
    expect(checkLegacySubscriptionSource("packages/db/src/runtime-posture.ts", code)).toEqual([
      {
        file: "packages/db/src/runtime-posture.ts",
        line: 1,
        message:
          "Retired SuperGrok (M4 X4) decision state xai_capacity_waiters in RUNTIME_READ_ONLY_TABLES",
      },
    ]);
  });
});

describe("M3 PR4 Codex entry", () => {
  test("rejects raw SQL, schema access and dynamic table constants", () => {
    for (const code of [
      "const query = sql`select * from codex_capacity_waiters`;",
      "db.select().from(schema.codexSubscriptionCredentials);",
      'const table = "organization_codex_rotation_settings"; sql.identifier(table);',
      "const query = sql`select resolve_workspace_codex_subscription_source($1,$2)`;",
      "const query = sql`select capture_legacy_codex_turn_sources($1,$2)`;",
    ])
      expect(codex("packages/db/src/index.ts", code)).toHaveLength(1);
  });
  test("posture routine signatures cannot authorize decision calls", () => {
    expect(
      codex(
        "packages/db/src/provision-roles.ts",
        'const routines = ["capture_legacy_codex_turn_sources(uuid,uuid)"];',
      ),
    ).toEqual([]);
    expect(
      codex(
        "packages/db/src/provision-roles.ts",
        "const query = sql`select capture_legacy_codex_turn_sources($1,$2)`;",
      ),
    ).toHaveLength(1);
    expect(
      codex(
        "packages/db/src/index.ts",
        'const routines = ["capture_legacy_codex_turn_sources(uuid,uuid)"];',
      ),
    ).toHaveLength(1);
  });
  test("exceptions authorize only exact declarations, not other queries in their files", () => {
    expect(
      codex(
        "packages/db/src/runtime-posture.ts",
        'export const FORCE_RLS_TABLES = ["codex_capacity_waiters"];',
      ),
    ).toEqual([]);
    expect(
      codex(
        "packages/db/src/runtime-posture.ts",
        "function read() { return sql`select * from codex_capacity_waiters`; }",
      ),
    ).toHaveLength(1);
    expect(
      codex(
        "packages/db/src/codex-subscription-core-cutover.ts",
        "function fallback() { return sql`select * from codex_subscription_credentials`; }",
      ),
    ).toHaveLength(1);
  });
  test("blocks production imports of historical fixtures and deleted producers", () => {
    for (const code of [
      'import { peekSessionWork } from "../test/fixtures/legacy-codex";',
      'export * from "@opengeni/db/test/fixtures/legacy-codex";',
      'const fixture = await import("../../test/fixtures/legacy-codex");',
      'const retired = require("./codex-rotation");',
    ])
      expect(codex("apps/worker/src/run.ts", code)).toHaveLength(1);
  });
  test("retains ledger, aliases, Temporal names and historical event decoding", () => {
    expect(
      codex(
        "packages/db/src/index.ts",
        `
      // codex_capacity_waiters is retired, not an executable query.
      const row = schema.codexResetRedemptionAttempts;
      const event = "codex.fleet.decision";
      const activity = "getCodexCapacityWait";
      const signal = "codexCapacityChanged";
    `,
      ),
    ).toEqual([]);
  });
});

describe("M4 X4 SuperGrok entry", () => {
  test("rejects the factory tables, the legacy routines and dynamic table names", () => {
    for (const code of [
      "db.select().from(schema.xaiSubscriptionCredentials);",
      "db.update(schema.xaiCapacityWaiters).set({ status: 'superseded' });",
      "const query = sql`select * from xai_credential_leases`;",
      'const table = "xai_session_account_pins"; sql.identifier(table);',
      "tables: { rotationSettings: schema.xaiRotationSettings }",
      "const query = sql`select opengeni_private.resolve_xai_authority_pool($1, $2)`;",
      "const query = sql`select revalidate_xai_subscription_authority($1)`;",
      "const query = sql`select create_xai_subscription_credential($1)`;",
      "const query = sql`select disconnect_xai_subscription_credential($1)`;",
      "const query = sql`select xai_subscription_authority_live($1)`;",
      "const query = sql`select xai_subscription_pool_visible($1)`;",
    ])
      expect(xai("packages/db/src/index.ts", code)).toHaveLength(1);
  });
  test("rejects minting the synthetic SuperGrok pool subject, not recognizing others", () => {
    expect(
      xai("packages/db/src/index.ts", 'const subject = subscriptionPoolWorkerSubject("xai");'),
    ).toHaveLength(1);
    expect(xai("packages/db/src/index.ts", 'const subject = "worker:xai-workspace";')).toHaveLength(
      1,
    );
    expect(
      xai("packages/db/src/index.ts", 'const subject = subscriptionPoolWorkerSubject("claude");'),
    ).toEqual([]);
    expect(
      xai("packages/db/src/index.ts", "const pool = isSubscriptionPoolWorkerSubject(subjectId);"),
    ).toEqual([]);
  });
  test("schema, posture and the 0719 codec stage are exact exceptions", () => {
    expect(
      xai(
        "packages/db/src/schema.ts",
        "export const xaiCapacityWaiters = pgTable('xai_capacity_waiters', {});",
      ),
    ).toEqual([]);
    expect(
      xai(
        "packages/db/src/runtime-posture.ts",
        'export const SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES = { xai: ["xai_capacity_waiters"] };',
      ),
    ).toEqual([]);
    expect(
      xai(
        "packages/db/src/xai-subscription-core-cutover.ts",
        "export async function migrateXaiSubscriptionCoreCredentials() { return sql`select * from xai_subscription_credentials`; }",
      ),
    ).toEqual([]);
    expect(
      xai(
        "packages/db/src/xai-subscription-core-cutover.ts",
        "export async function fallback() { return sql`select * from xai_subscription_credentials`; }",
      ),
    ).toHaveLength(1);
    expect(
      xai(
        "packages/db/src/runtime-posture.ts",
        "function read() { return sql`select * from xai_capacity_waiters`; }",
      ),
    ).toHaveLength(1);
  });
  test("comments, core identifiers and the shared provider id are not legacy state", () => {
    expect(
      xai(
        "packages/db/src/index.ts",
        `
      // xai_capacity_waiters rows are read-only after the 0719 receipt.
      const provider = "xai";
      const waiters = schema.subscriptionCapacityWaiters;
      const route = "supergrok-subscription";
    `,
      ),
    ).toEqual([]);
  });
});

describe("M4 C4 Claude entry", () => {
  test("rejects the pool tables, the usage table, the legacy routines and dynamic table names", () => {
    for (const code of [
      "db.select().from(schema.claudeSubscriptionCredentials);",
      "db.update(schema.claudeCapacityWaiters).set({ status: 'superseded' });",
      "db.select().from(schema.claudeSubscriptionAccountUsage);",
      "const query = sql`select * from claude_credential_leases`;",
      'const table = "claude_session_account_pins"; sql.identifier(table);',
      "tables: { rotationSettings: schema.claudeRotationSettings }",
      "const query = sql`delete from claude_subscription_account_usage`;",
      "const query = sql`select opengeni_private.resolve_claude_authority_pool($1, $2)`;",
      "const query = sql`select revalidate_claude_subscription_authority($1)`;",
      "const query = sql`select create_claude_subscription_credential($1)`;",
      "const query = sql`select disconnect_claude_subscription_credential($1)`;",
      "const query = sql`select claude_subscription_authority_live($1)`;",
      "const query = sql`select claude_subscription_pool_visible($1)`;",
    ])
      expect(claude("packages/db/src/index.ts", code)).toHaveLength(1);
  });
  test("rejects the turn-local auth recovery state and connection-based usage", () => {
    expect(
      claude(
        "apps/worker/src/activities/agent-turn/claim.ts",
        "const recovery = turn.metadata.claudeAuthRecovery;",
      ),
    ).toHaveLength(1);
    expect(
      claude(
        "packages/db/src/index.ts",
        "await requestSessionTurnRecovery(db, workspaceId, { claudeAuthRecovery: { attempts: 1 } });",
      ),
    ).toHaveLength(1);
    expect(
      claude(
        "packages/db/src/index.ts",
        "db.update(schema.connections).set({ claudeUsageSnapshot: null });",
      ),
    ).toHaveLength(1);
    expect(
      claude(
        "packages/db/src/index.ts",
        "const query = sql`select claude_usage_snapshot from connections`;",
      ),
    ).toHaveLength(1);
  });
  test("rejects minting the synthetic Claude pool subject, not recognizing others", () => {
    expect(
      claude(
        "packages/db/src/index.ts",
        'const subject = subscriptionPoolWorkerSubject("claude");',
      ),
    ).toHaveLength(1);
    expect(
      claude("packages/db/src/index.ts", 'const subject = "worker:claude-workspace";'),
    ).toHaveLength(1);
    expect(
      claude("packages/db/src/index.ts", 'const subject = subscriptionPoolWorkerSubject("xai");'),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/index.ts",
        "const pool = isSubscriptionPoolWorkerSubject(subjectId);",
      ),
    ).toEqual([]);
  });
  test("blocks imports of the deleted producers, not the kept usage contract modules", () => {
    for (const specifier of [
      "./claude-subscription-accounts",
      "./claude-subscription-account-usage",
      "./claude-subscription-account-tokens",
      "../../db/src/claude-subscription-tokens.ts",
      "../claude-subscription-account-conflicts",
    ])
      expect(claude("apps/worker/src/run.ts", `import { x } from "${specifier}";`)).toHaveLength(1);
    for (const specifier of [
      "./claude-subscription-usage",
      "@opengeni/contracts/claude-subscription-usage",
      "./subscription-core-claude-oauth",
      "./claude-subscription-core-cutover",
      // The fail-closed api routes stay until C2a/C2b replace them.
      "./routes/claude-subscription-accounts",
      "./routes/claude-subscription-oauth",
    ])
      expect(claude("apps/api/src/app.ts", `import { x } from "${specifier}";`)).toEqual([]);
  });
  test("blocks production imports of the legacy Claude test fixture", () => {
    for (const code of [
      'import { x } from "../test/fixtures/legacy-claude/accounts";',
      'export * from "@opengeni/db/test/fixtures/legacy-claude/account-usage";',
      'const fixture = await import("../../test/fixtures/legacy-claude/account-tokens");',
    ])
      expect(claude("packages/db/src/index.ts", code)).toHaveLength(1);
    expect(
      claude("packages/db/src/index.ts", 'import { x } from "./subscription-core-claude-adapter";'),
    ).toEqual([]);
  });
  test("the shared lease heartbeat admits no Claude lease table", () => {
    expect(
      claude(
        "packages/db/src/subscription-credential-leases.ts",
        'type LeaseTable = "xai_credential_leases" | "claude_credential_leases";',
      ),
    ).toHaveLength(1);
  });
  test("schema, posture and the 0598 and 0720 codec stages are exact exceptions", () => {
    expect(
      claude(
        "packages/db/src/schema.ts",
        "export const claudeCapacityWaiters = pgTable('claude_capacity_waiters', {});",
      ),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/schema.ts",
        "export const connections = pgTable('connections', { claudeUsageSnapshot: jsonb('claude_usage_snapshot') });",
      ),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/runtime-posture.ts",
        'export const SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES = { claude: ["claude_capacity_waiters"] };',
      ),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/runtime-posture.ts",
        'export const CLAUDE_AUTHORITY_ROUTINES = ["resolve_claude_authority_pool(uuid, text)"];',
      ),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/claude-subscription-pool-migration.ts",
        "export async function migrateClaudeSubscriptionPoolCredentials() { return sql`select * from claude_subscription_credentials`; }",
      ),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/claude-subscription-core-cutover.ts",
        "export async function migrateClaudeSubscriptionCoreCredentials() { return sql`select * from claude_subscription_credentials`; }",
      ),
    ).toEqual([]);
    expect(
      claude(
        "packages/db/src/claude-subscription-core-cutover.ts",
        "export async function fallback() { return sql`select * from claude_subscription_credentials`; }",
      ),
    ).toHaveLength(1);
    expect(
      claude(
        "packages/db/src/runtime-posture.ts",
        "function read() { return sql`select * from claude_capacity_waiters`; }",
      ),
    ).toHaveLength(1);
    // The schema exception covers declarations, never a query in schema.ts.
    expect(
      claude(
        "packages/db/src/schema.ts",
        "export function leak() { return sql`select * from claude_credential_leases`; }",
      ),
    ).toHaveLength(1);
  });
  test("comments, core identifiers and the shared provider id are not legacy state", () => {
    expect(
      claude(
        "packages/db/src/index.ts",
        `
      // claude_capacity_waiters rows are read-only after the 0720 receipt; the
      // claudeAuthRecovery marker became subscription_turn_failures rows.
      const provider = "claude";
      const waiters = schema.subscriptionCapacityWaiters;
      const route = "claude-subscription";
      const snapshot = turn.claudeProviderAccountAuthoritySnapshot;
      const recovery = turn.metadata.claudeRequestSizeRecoveryUsed;
    `,
      ),
    ).toEqual([]);
  });
});

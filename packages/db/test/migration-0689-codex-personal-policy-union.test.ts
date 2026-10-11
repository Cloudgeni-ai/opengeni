import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  canServe,
  type PlacementInput,
  type SubscriptionConnection,
} from "@opengeni/subscriptions";
import { createDb, rawRows, withRlsContext, withSessionRlsActorContext } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { encryptEnvironmentValue } from "../src/environment-crypto";

const migration = "0689_subscription_core_codex_cutover.sql";
// 0712 requires the committed 0689 cutover, so it is held back with it.
const precursor = "0712_subscription_core_generic_precursor.sql";
// 0713 keys and redefines objects 0689 creates: held back and replayed right
// after it.
const providerKeyedReach = "0713_subscription_core_provider_keyed_reach.sql";
// 0714 builds on 0712's receipts and patches its helpers; it follows 0712.
const compat = "0714_subscription_authority_compat.sql";
const key = Buffer.alloc(32, 87);
const cases: Array<{
  name: string;
  sources: Array<{ enabled: boolean; models: string[] | null }>;
  enabled: boolean;
  models: string[] | null;
}> = [
  {
    name: "paused-unrestricted",
    sources: [
      { enabled: false, models: null },
      { enabled: true, models: ["codex/b"] },
    ],
    enabled: true,
    models: ["codex/b"],
  },
  {
    name: "all-paused",
    sources: [
      { enabled: false, models: ["codex/a"] },
      { enabled: false, models: ["codex/b"] },
    ],
    enabled: false,
    models: ["codex/a", "codex/b"],
  },
  {
    name: "enabled-union",
    sources: [
      { enabled: true, models: ["codex/a"] },
      { enabled: true, models: ["codex/b"] },
    ],
    enabled: true,
    models: ["codex/a", "codex/b"],
  },
];

for (const shape of ["workspace-workspace", "workspace-user"] as const) {
  test(`personal duplicate policy migration preserves and replays ${shape} active unions`, async () => {
    const owned = await acquireOwnerMigratedTestDatabase("codex-personal-policy-union");
    if (!owned) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
      return;
    }
    const owner = postgres(owned.ownerUrl, { max: 1 });
    let app: ReturnType<typeof createDb> | undefined;
    const account = randomUUID(),
      personal = randomUUID(),
      shared = randomUUID(),
      membership = randomUUID();
    const subject = "user:personal-policy-union";
    const groups = cases.map((scenario) => ({
      ...scenario,
      ids: [randomUUID(), randomUUID()] as const,
      authority: randomUUID(),
    }));
    try {
      await owner`CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await owner`INSERT INTO schema_migrations(name) VALUES (${migration}), (${precursor}), (${providerKeyedReach}), (${compat})`;
      await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
      await owner`DELETE FROM schema_migrations WHERE name IN (${migration}, ${precursor}, ${providerKeyedReach}, ${compat})`;
      const seedTables = [
        "managed_accounts",
        "workspaces",
        "organization_memberships",
        "codex_subscription_credentials",
      ];
      for (const table of seedTables)
        await owned.admin.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      try {
        await owned.admin`INSERT INTO managed_accounts(id, name) VALUES (${account}, 'Personal policy upgrade')`;
        await owned.admin`INSERT INTO workspaces(id, account_id, name) VALUES
          (${personal}, ${account}, 'Personal'), (${shared}, ${account}, 'Shared')`;
        await owned.admin`INSERT INTO organization_memberships(id, account_id, subject_id, status, personal_workspace_id, role)
          VALUES (${membership}, ${account}, ${subject}, 'active', ${personal}, 'owner')`;
        for (const group of groups) {
          const token = `header.${Buffer.from(
            JSON.stringify({
              "https://api.openai.com/auth": {
                chatgpt_account_id: group.name,
                chatgpt_user_id: "same-person",
              },
            }),
          ).toString("base64url")}.signature`;
          const encrypted = encryptEnvironmentValue(
            key,
            JSON.stringify({
              access_token: "fixture-access",
              refresh_token: "fixture-refresh",
              id_token: token,
            }),
          );
          if (shape === "workspace-user")
            await owned.admin`INSERT INTO organization_user_resource_authorities(
            id, account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id, generation)
            VALUES (${group.authority}, ${account}, ${membership}, 'codex_subscription', ${group.ids[1]}, ${shared}, 1)`;
          for (const [index, policy] of group.sources.entries()) {
            const user = shape === "workspace-user" && index === 1;
            await owned.admin`INSERT INTO codex_subscription_credentials(id, account_id, workspace_id, authority_scope,
              credential_encrypted, chatgpt_account_id, plan_type, status, allocator_enabled, allowed_model_ids,
              owner_organization_membership_id, organization_user_resource_authority_id,
              organization_user_resource_kind, organization_user_resource_authority_generation, last_refresh_at)
              VALUES (${group.ids[index]!}, ${account}, ${user ? shared : personal}, ${user ? "user" : "workspace"},
              ${encrypted}, ${user ? group.name : null}, 'pro', 'active', ${policy.enabled}, ${policy.models}::text[],
              ${user ? membership : null}, ${user ? group.authority : null}, ${user ? "codex_subscription" : null},
              ${user ? 1 : null}, ${index === 1 ? "2026-02-01T00:00:00Z" : null}::timestamptz)`;
          }
        }
      } finally {
        for (const table of seedTables)
          await owned.admin.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
      const options = {
        applicationDatabaseRoles: ["opengeni_app"],
        environmentsEncryptionKey: key,
      };
      await migrate(owned.ownerUrl, undefined, options);
      const beforeReplay =
        await owned.admin`SELECT id, allocator_enabled, allowed_model_ids, credential_encrypted
        FROM subscription_connections WHERE account_id = ${account} ORDER BY id`;
      await migrate(owned.ownerUrl, undefined, options);
      const afterReplay =
        await owned.admin`SELECT id, allocator_enabled, allowed_model_ids, credential_encrypted
        FROM subscription_connections WHERE account_id = ${account} ORDER BY id`;
      expect(afterReplay).toEqual(beforeReplay);
      expect(afterReplay).toHaveLength(groups.length);
      await provisionRoles(owned.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owned.appPassword,
      });
      const roles = await owned.admin`SELECT rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname IN (${owned.ownerRole}, 'opengeni_app')`;
      expect(roles).toHaveLength(2);
      expect(roles.every((r) => !r.rolsuper && !r.rolbypassrls)).toBe(true);
      const url = new URL(owned.ownerUrl);
      url.username = "opengeni_app";
      url.password = owned.appPassword;
      app = createDb(url.toString());
      const read = (actor: string) =>
        withSessionRlsActorContext({ subjectId: actor }, () =>
          withRlsContext(app!.db, { accountId: account, workspaceId: personal }, (tx) =>
            rawRows<{
              id: string;
              allocator_enabled: boolean;
              allowed_model_ids: string[] | null;
            }>(
              tx,
              sql`SELECT id, allocator_enabled, allowed_model_ids
          FROM opengeni_private.subscription_codex_personal_connections(${account}::uuid, ${personal}::uuid, ${actor})`,
            ),
          ),
        );
      expect(await read("user:not-the-owner")).toEqual([]);
      const projected = await read(subject);
      expect(projected).toHaveLength(groups.length);
      for (const group of groups) {
        const current = projected.find((r) => r.id === group.ids[1]);
        expect(current).toMatchObject({
          allocator_enabled: group.enabled,
          allowed_model_ids: group.models,
        });
        const connection: SubscriptionConnection = {
          id: current!.id,
          provider: "codex",
          kind: "subscription",
          health: "healthy",
          ownership: { kind: "personal", ownerMembershipId: membership },
          allocatorEnabled: current!.allocator_enabled,
          allowedModelIds: current!.allowed_model_ids,
          entitledModelIds: null,
          excludedModelIds: [],
          refreshGeneration: 1,
          quota: null,
        };
        const world: PlacementInput = {
          now: Date.now(),
          workspace: {
            id: personal,
            kind: "personal",
            ownerMembershipId: membership,
            allowedModelIds: null,
          },
          session: {
            id: "policy-proof",
            workspaceId: personal,
            visibility: "private",
            ownerMembershipId: membership,
            preferredModelId: "codex/a",
            reasoningLevel: "medium",
            binding: null,
            onlyThisModel: true,
            reselectionPoints: [],
            personalAuthority: [{ provider: "codex", ownerMembershipId: membership }],
            compactionProviderLock: null,
          },
          settings: {
            rotation: {},
            providers: {},
            crossProviderFailover: false,
            fallbackOrder: {},
            personalConnectionsAllowed: true,
            personalFallbackAllowed: true,
          },
          people: [{ membershipId: membership, active: true, personalFallbackOptIn: true }],
          models: ["codex/a", "codex/b", "codex/c"].map((id) => ({
            id,
            provider: "codex",
            reasoningLevels: ["medium"],
          })),
          connections: [connection],
          cacheFacts: {},
        };
        for (const model of world.models)
          expect(canServe(world, connection, model.id)).toBe(
            group.sources.some((source) =>
              canServe(
                world,
                { ...connection, allocatorEnabled: source.enabled, allowedModelIds: source.models },
                model.id,
              ),
            ),
          );
        const aliases =
          await owned.admin`SELECT alias_connection_id, connection_id FROM subscription_connection_aliases
          WHERE account_id = ${account} AND alias_connection_id = ${group.ids[0]}`;
        expect([...aliases]).toEqual([
          { alias_connection_id: group.ids[0], connection_id: group.ids[1] },
        ]);
      }
      const [parity] = await owned.admin`SELECT legacy_count::int, core_count::int
        FROM opengeni_private.subscription_codex_cutover_report
        WHERE account_id = ${account} AND metric = 'connection_model_policies'`;
      expect(parity).toEqual({ legacy_count: groups.length, core_count: groups.length });
    } finally {
      await app?.close();
      await owner.end();
      await owned.release();
    }
  }, 600_000);
}

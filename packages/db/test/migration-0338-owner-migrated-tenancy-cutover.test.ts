// Migration 0338 under the PRODUCTION database posture.
//
// `acquireSharedTestDatabase` hands out the container superuser, for whom
// `FORCE ROW LEVEL SECURITY` never engages, so every existing 0338 test drives
// the classify -> backfill -> activate chain through a principal that cannot
// observe this defect class at all. OpenGeni migrates and runs its SECURITY
// DEFINER routines as a NON-superuser owner without `BYPASSRLS`
// (`docs/force-rls-migration-backfills.md`), where the owner is policy-bound
// like everybody else - and a `SELECT ... FOR SHARE` additionally needs the
// UPDATE/ALL policy USING clause, not just a `FOR SELECT` one.
//
// `acquireOwnerMigratedTestDatabase` is that boundary. This file therefore
// covers, in one run against it:
//
//   * a NEW personal connection whose subject holds a live organization
//     membership actually reaching `authority_scope = 'user'` (before AND after
//     activation) rather than silently degrading to `legacy_user` - which after
//     activation is a hard `42501` that permanently removes personal
//     Gmail/Slack/MCP connect from every activated organization;
//   * migration 0290's two read-only membership seams seeing their rows at all
//     - 0305 restated the shared lifecycle policy's marker list and dropped
//     0290's entry, so phase D's membership backfill has been blind since;
//   * the bounded `legacy_user -> user` upgrader converging a deterministic
//     candidate instead of raising `42501 connection backfill membership
//     authority is unavailable` on every one of them; and
//   * the whole cutover the issue exists to deliver, committing for real: six
//     settled backfill receipts, `check_tenancy_backfill_activation_evidence`
//     `ready`, clean parity gates and lanes, and a durable
//     `session_tenancy_activations` receipt - whose INSERT was itself denied
//     `42501` by 0303's `FOR SELECT`-only policy on a FORCE-RLS table.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { nestedPostgresSqlState } from "../src";
import { migrate } from "../src/migrate";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

/** Byte-identical to `scripts/activate-session-tenancy.ts` and to the SQL
 *  `opengeni_private.tenancy_activation_canonical_json`. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

type ConnectionRow = {
  id: string;
  scope: string;
  membershipId: string | null;
  authorityId: string | null;
  generation: number;
};

let owned: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0338-owner-cutover");
  if (!owned) {
    if (requireRealDatabase) {
      throw new Error("[migration-0338-owner] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is absent");
    }
    return;
  }
  await migrate(owned.ownerUrl);
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await owned?.release();
}, 180_000);

describe("migration 0338 under a NOSUPERUSER NOBYPASSRLS migration owner", () => {
  test("mints, converges, and activates the connection lane through the real posture", async () => {
    if (!owned || !owner) return;
    const { admin, ownerRole } = owned;
    const ownerSql = owner;

    // ---- the harness really is the production boundary --------------------
    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });
    const forced = await admin<Array<{ relation: string; forced: boolean }>>`
      select relation.relname::text as relation, relation.relforcerowsecurity as forced
      from pg_class relation
      where relation.oid in (
        'organization_memberships'::regclass,
        'organization_user_resource_authorities'::regclass,
        'connections'::regclass
      )
      order by relation`;
    expect(Array.from(forced)).toEqual([
      { relation: "connections", forced: true },
      { relation: "organization_memberships", forced: true },
      { relation: "organization_user_resource_authorities", forced: true },
    ]);

    const accountId = crypto.randomUUID();
    const sharedWorkspaceId = crypto.randomUUID();
    const anchoredPersonalWorkspaceId = crypto.randomUUID();
    const legacyPersonalWorkspaceId = crypto.randomUUID();
    const anchoredSubject = `user:anchored-${crypto.randomUUID()}`;
    const legacySubject = `user:legacy-${crypto.randomUUID()}`;
    const strangerSubject = `user:stranger-${crypto.randomUUID()}`;

    await admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'ope-204 owner cutover', 'better-auth:user', ${accountId})`;
    for (const [workspaceId, name] of [
      [sharedWorkspaceId, "shared"],
      [anchoredPersonalWorkspaceId, "anchored personal"],
      [legacyPersonalWorkspaceId, "legacy personal"],
    ] as const) {
      await admin`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, ${`ope-204 ${name}`})`;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
    }
    const [anchoredMembership] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${accountId}, ${anchoredSubject}, 'active', ${anchoredPersonalWorkspaceId})
      returning id`;
    expect(anchoredMembership?.id).toBeString();

    const mintConnection = async (
      subjectId: string,
      workspaceId: string,
      providerDomain: string,
    ): Promise<ConnectionRow> =>
      await ownerSql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<ConnectionRow[]>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${accountId}, ${workspaceId}, ${subjectId}, ${providerDomain}, 'api_key',
            'ciphertext'
          )
          returning id, authority_scope as scope,
            owner_organization_membership_id as "membershipId",
            authority_id as "authorityId", authority_generation::int as generation`;
        return row!;
      });

    // ---- B2: a live membership must actually reach `user` authority -------
    // Blind under FORCE RLS this silently becomes `legacy_user`, and after
    // activation the same blindness is a hard 42501 that removes personal
    // connect from a greenfield organization forever.
    const minted = await mintConnection(anchoredSubject, sharedWorkspaceId, "minted.example");
    expect(minted).toMatchObject({
      scope: "user",
      membershipId: anchoredMembership!.id,
      generation: 1,
    });
    expect(minted.authorityId).toBeString();
    const [mintedAuthority] = await admin<Array<{ resourceId: string; status: string }>>`
      select resource_id as "resourceId", status
      from organization_user_resource_authorities where id = ${minted.authorityId}`;
    expect(mintedAuthority).toEqual({ resourceId: minted.id, status: "active" });

    // ---- B1: a legacy row with an exact live membership must converge -----
    const legacy = await mintConnection(legacySubject, sharedWorkspaceId, "legacy.example");
    expect(legacy).toMatchObject({ scope: "legacy_user", membershipId: null, authorityId: null });
    await admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${accountId}, ${legacySubject}, 'active', ${legacyPersonalWorkspaceId})`;

    // `postgres`' `begin` unwraps array results, so a generic payload is boxed.
    const runInAccount = async <T>(
      run: (tx: postgres.TransactionSql) => Promise<T>,
    ): Promise<T> => {
      const boxed = (await ownerSql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
        return { value: await run(tx as postgres.TransactionSql) };
      })) as unknown as { value: T };
      return boxed.value;
    };

    const classify = async (runKey: string | null): Promise<Record<string, any>> =>
      await runInAccount(async (tx) => {
        const [row] = await tx<Array<{ report: Record<string, any> }>>`
          select classify_organization_connection_authority(
            ${accountId}::uuid, ${runKey}::text
          ) as report`;
        return row!.report;
      });

    const before = await classify(`connections-before-${crypto.randomUUID()}`);
    expect(before.connections).toEqual({
      total: 2,
      workspaceOwned: 0,
      userOwned: 1,
      deterministicRepairPending: 1,
      unresolved: 1,
    });

    const applied = await runInAccount(async (tx) => {
      const [row] = await tx<Array<{ report: Record<string, any> }>>`
        select backfill_organization_connection_authority(
          ${accountId}::uuid, 100, false
        ) as report`;
      return row!.report;
    });
    expect(applied).toMatchObject({ dryRun: false, candidates: 1, upgraded: 1 });

    const [converged] = await admin<ConnectionRow[]>`
      select id, authority_scope as scope,
        owner_organization_membership_id as "membershipId",
        authority_id as "authorityId", authority_generation::int as generation
      from connections where id = ${legacy.id}`;
    expect(converged).toMatchObject({ scope: "user", generation: 2 });
    expect(converged!.membershipId).toBeString();

    const after = await classify(`connections-after-${crypto.randomUUID()}`);
    expect(after.connections).toEqual({
      total: 2,
      workspaceOwned: 0,
      userOwned: 2,
      deterministicRepairPending: 0,
      unresolved: 0,
    });

    // ---- the remaining five families, then the evidence gate --------------
    await runInAccount(async (tx) => {
      await tx`select verify_organization_resource_classification(
        ${accountId}::uuid, ${`resources-${crypto.randomUUID()}`}::text)`;
      await tx`select classify_organization_session_ownership(
        ${accountId}::uuid, ${`sessions-${crypto.randomUUID()}`}::text)`;
      const [receipt] = await tx<Array<{ id: string }>>`
        select open_tenancy_backfill_receipt(
          ${accountId}::uuid, 'organization_memberships',
          ${`memberships-${crypto.randomUUID()}`}
        ) as id`;
      await tx`select complete_tenancy_backfill_receipt(
        ${receipt!.id}::uuid, 0::bigint, 0::bigint, 'completed')`;
    });

    const evidence = await runInAccount(async (tx) => {
      const [row] = await tx<Array<{ report: Record<string, any> }>>`
        select check_tenancy_backfill_activation_evidence(${accountId}::uuid) as report`;
      return row!.report;
    });
    expect(evidence).toMatchObject({ schemaVersion: 1, organizationId: accountId, ready: true });
    expect(evidence.blockers).toEqual([]);
    expect(Array.isArray(evidence.receiptIds) ? evidence.receiptIds.length : 0).toBe(6);

    // ---- the cutover itself ----------------------------------------------
    // The activation must actually COMMIT its receipt under this posture.
    // Migration 0303 gave `session_tenancy_activations` FORCE RLS with a
    // `FOR SELECT`-only policy and no INSERT policy at all, so this write was
    // denied `42501` after every gate had already passed; 0338 re-opens exactly
    // that one command behind an owner-only marker.
    const receiptIds: string[] = evidence.receiptIds;
    const activation = await runInAccount(async (tx) => {
      const [inventoryRow] = await tx<Array<{ report: unknown }>>`
        select inventory_organization_tenancy(${accountId}::uuid) as report`;
      const [parityRow] = await tx<Array<{ report: Record<string, any> }>>`
        select check_organization_tenancy_parity(${accountId}::uuid, 10, 30) as report`;
      const parity = parityRow!.report;
      expect(
        Object.entries(parity.gates as Record<string, { violations: number }>).filter(
          ([, gate]) => gate.violations !== 0,
        ),
      ).toEqual([]);
      expect(
        Object.entries(parity.lanes as Record<string, number>).filter(([, count]) => count !== 0),
      ).toEqual([]);
      const [row] = await tx<
        Array<{ accountId: string; activationVersion: number; replay: boolean }>
      >`
        select account_id as "accountId", activation_version as "activationVersion", replay
        from activate_session_tenancy_product(
          ${accountId}::uuid, ${digest(inventoryRow!.report)}, ${digest(parity)},
          'ope-204 owner-migrated test', ${["opengeni_app"]}::text[]
        )`;
      return row!;
    });
    expect(activation).toEqual({ accountId, activationVersion: 1, replay: false });

    const [receipt] = await admin<
      Array<{ receipts: string[]; activatedBy: string; version: number }>
    >`
      select backfill_receipt_ids::text[] as receipts, activated_by as "activatedBy",
        activation_version::int as version
      from session_tenancy_activations where account_id = ${accountId}`;
    expect(receipt).toEqual({
      receipts: receiptIds,
      activatedBy: "ope-204 owner-migrated test",
      version: 1,
    });

    // The marker the receipt policy gates on must not survive the call, and the
    // policy must not have opened the table to anything else.
    const [leaked] = await ownerSql<Array<{ marker: string }>>`
      select current_setting('opengeni.organization_tenancy_lifecycle', true) as marker`;
    expect(leaked?.marker ?? "").toBe("");

    // Replay is idempotent for the identical evidence, and must not append.
    const replayed = await runInAccount(async (tx) => {
      const [inventoryRow] = await tx<Array<{ report: unknown }>>`
        select inventory_organization_tenancy(${accountId}::uuid) as report`;
      const [parityRow] = await tx<Array<{ report: unknown }>>`
        select check_organization_tenancy_parity(${accountId}::uuid, 10, 30) as report`;
      const [row] = await tx<Array<{ replay: boolean }>>`
        select replay from activate_session_tenancy_product(
          ${accountId}::uuid, ${digest(inventoryRow!.report)}, ${digest(parityRow!.report)},
          'ope-204 owner-migrated test', ${["opengeni_app"]}::text[]
        )`;
      return row!.replay;
    });
    expect(replayed).toBe(true);

    // ---- after that real activation the mint path must still work ---------
    const postActivation = await mintConnection(
      anchoredSubject,
      anchoredPersonalWorkspaceId,
      "post-activation.example",
    );
    expect(postActivation).toMatchObject({
      scope: "user",
      membershipId: anchoredMembership!.id,
      generation: 1,
    });

    // ...and only for a subject that actually holds one.
    let strangerFailure: unknown;
    try {
      await mintConnection(strangerSubject, sharedWorkspaceId, "stranger.example");
    } catch (error) {
      strangerFailure = error;
    }
    expect(nestedPostgresSqlState(strangerFailure)).toBe("42501");
  }, 900_000);

  test("0290's membership backfill seams see their own rows under this posture", async () => {
    if (!owned || !owner) return;
    const { admin } = owned;
    const ownerSql = owner;

    const accountId = crypto.randomUUID();
    const anchoredWorkspaceId = crypto.randomUUID();
    const anchoredSubject = `user:anchored-${crypto.randomUUID()}`;
    const pendingSubject = `user:pending-${crypto.randomUUID()}`;
    await admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'ope-204 membership seams', 'better-auth:user', ${accountId})`;
    await admin`
      insert into workspaces (id, account_id, name)
      values (${anchoredWorkspaceId}, ${accountId}, 'ope-204 anchored personal')`;
    const [anchored] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${accountId}, ${anchoredSubject}, 'active', ${anchoredWorkspaceId})
      returning id`;
    // The actual backfill target population: a membership that carries no
    // personal workspace yet. `organization_memberships_active_personal_workspace_check`
    // reserves the NULL pointer for the `provisioning` status, which is exactly
    // what 0290's seam enumerates alongside `active`.
    const [pending] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (account_id, subject_id, status)
      values (${accountId}, ${pendingSubject}, 'provisioning')
      returning id`;

    const inAccount = async <T>(run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
      const boxed = (await ownerSql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
        return { value: await run(tx as postgres.TransactionSql) };
      })) as unknown as { value: T };
      return boxed.value;
    };

    const anchors = await inAccount(async (tx) => {
      const [row] = await tx<Array<{ anchors: Array<Record<string, unknown>> }>>`
        select list_organization_membership_backfill_anchors(
          ${accountId}::uuid, ${[anchoredSubject, pendingSubject]}::text[]
        ) as anchors`;
      return row!.anchors;
    });
    expect(anchors).toEqual([
      {
        subjectId: anchoredSubject,
        membershipId: anchored!.id,
        status: "active",
        personalWorkspaceId: anchoredWorkspaceId,
      },
      {
        subjectId: pendingSubject,
        membershipId: pending!.id,
        status: "provisioning",
        personalWorkspaceId: null,
      },
    ]);

    const withoutPersonalWorkspace = await inAccount(async (tx) => {
      const [row] = await tx<Array<{ pending: Array<Record<string, unknown>> }>>`
        select list_organization_memberships_without_personal_workspace(
          ${accountId}::uuid, 25, null
        ) as pending`;
      return row!.pending;
    });
    expect(withoutPersonalWorkspace).toEqual([
      {
        subjectId: pendingSubject,
        membershipId: pending!.id,
        status: "provisioning",
        personalWorkspaceId: null,
      },
    ]);

    // The seam restores the marker, and it is scoped to its own organization.
    const [leaked] = await ownerSql<Array<{ marker: string }>>`
      select current_setting('opengeni.organization_tenancy_lifecycle', true) as marker`;
    expect(leaked?.marker ?? "").toBe("");
    const foreign = await inAccount(async (tx) => {
      const [row] = await tx<Array<{ anchors: unknown[] }>>`
        select list_organization_membership_backfill_anchors(
          ${accountId}::uuid, ${[`user:absent-${crypto.randomUUID()}`]}::text[]
        ) as anchors`;
      return row!.anchors;
    });
    expect(foreign).toEqual([]);
  }, 900_000);
});

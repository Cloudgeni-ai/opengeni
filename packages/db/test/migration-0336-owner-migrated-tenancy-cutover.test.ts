// Migration 0336 under the PRODUCTION database posture.
//
// `acquireSharedTestDatabase` hands out the container superuser, for whom
// `FORCE ROW LEVEL SECURITY` never engages, so every existing 0336 test drives
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
//   * the bounded `legacy_user -> user` upgrader converging a deterministic
//     candidate instead of raising `42501 connection backfill membership
//     authority is unavailable` on every one of them; and
//   * the whole cutover the issue exists to deliver: six settled backfill
//     receipts, `check_tenancy_backfill_activation_evidence(...).ready`, clean
//     parity gates and lanes, and the exact remaining boundary - migration
//     0303's own FORCE-RLS `session_tenancy_activations` write, which is a
//     separate defect this migration does not own and which is pinned here
//     rather than worked around.
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
  owned = await acquireOwnerMigratedTestDatabase("migration-0336-owner-cutover");
  if (!owned) {
    if (requireRealDatabase) {
      throw new Error("[migration-0336-owner] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is absent");
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

describe("migration 0336 under a NOSUPERUSER NOBYPASSRLS migration owner", () => {
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
    // Everything 0336 owns is clean here: every parity gate and lane is zero
    // and the six receipts are settled. `activate_session_tenancy_product`
    // nonetheless cannot commit under this posture, and the reason is OUTSIDE
    // this migration: migration 0303 gave `session_tenancy_activations` FORCE
    // RLS plus a `FOR SELECT`-only policy, so the activation's own INSERT is
    // blinded for the non-superuser migration owner exactly the way every other
    // FORCE-RLS write is (`docs/force-rls-migration-backfills.md`). Pinned
    // here as the exact remaining boundary rather than worked around: when
    // 0303's write posture is repaired this expectation must flip to a real
    // receipt.
    const receiptIds: string[] = evidence.receiptIds;
    const digests = await runInAccount(async (tx) => {
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
      return { inventory: digest(inventoryRow!.report), parity: digest(parity) };
    });

    let activationFailure: unknown;
    try {
      await runInAccount(async (tx) => {
        await tx`
          select * from activate_session_tenancy_product(
            ${accountId}::uuid, ${digests.inventory}, ${digests.parity},
            'ope-204 owner-migrated test', ${["opengeni_app"]}::text[]
          )`;
      });
    } catch (error) {
      activationFailure = error;
    }
    expect(nestedPostgresSqlState(activationFailure)).toBe("42501");
    expect(String((activationFailure as Error).message)).toContain("session_tenancy_activations");

    // The durable receipt an activation leaves behind, seeded as the superuser
    // so the rest of the chain is exercised. Six exact receipt ids is what the
    // 0336 constraint now admits, so this also proves the ledger binding.
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest,
        activated_by, backfill_receipt_ids
      ) values (
        ${accountId}, 1, ${digests.inventory}, ${digests.parity},
        'ope-204 owner-migrated test', ${receiptIds}::uuid[]
      )`;
    const [receipt] = await admin<Array<{ receipts: number }>>`
      select cardinality(backfill_receipt_ids) as receipts
      from session_tenancy_activations where account_id = ${accountId}`;
    expect(receipt).toEqual({ receipts: 6 });

    // ---- after activation the mint path must still work -------------------
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
});

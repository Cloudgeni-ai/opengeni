// Migration 0290 + the Phase D membership/personal-workspace backfill driver:
// an idempotent, resumable, concurrency-safe operator pass that provisions the
// organization-membership anchor and deterministic personal workspace for
// humans who held workspace access before 0219 and never re-authenticated,
// through the exact existing lifecycle seam - and records everything it cannot
// prove deterministically as unresolved rather than guessing it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createDb,
  drainOrganizationMembershipBackfill,
  listOrganizationMembershipBackfillCandidates,
  runOrganizationMembershipBackfill,
  type Database,
  type DbClient,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";

const migrationUrl = new URL(
  "../drizzle/0290_organization_membership_backfill.sql",
  import.meta.url,
);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0290-membership-backfill");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/**
 * The exact pre-0219 legacy shape: a Better Auth human who owns their own
 * organization and workspace but has NO organization_memberships anchor,
 * because the provisioning hook has never run for them.
 */
async function legacyOrganization(options?: {
  withLoginIdentity?: boolean;
  ownerRole?: string;
  userId?: string;
}): Promise<{ organizationId: string; workspaceId: string; userId: string; subjectId: string }> {
  const userId = options?.userId ?? crypto.randomUUID();
  const subjectId = `user:${userId}`;
  if (options?.withLoginIdentity !== false) {
    await admin`
      insert into auth_users (id, name, email)
      values (${userId}, 'legacy human', ${`${userId}@example.test`})`;
  }
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name, external_source, external_id)
    values ('legacy org', 'better-auth:user', ${userId})
    returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'legacy workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${account!.id}, ${workspace!.id}, ${subjectId}, ${options?.ownerRole ?? "owner"})`;
  return { organizationId: account!.id, workspaceId: workspace!.id, userId, subjectId };
}

async function anchorRows(
  organizationId: string,
): Promise<Array<{ subject_id: string; status: string; personal_workspace_id: string | null }>> {
  return await admin<
    Array<{ subject_id: string; status: string; personal_workspace_id: string | null }>
  >`
    select subject_id, status, personal_workspace_id
    from organization_memberships
    where account_id = ${organizationId}
    order by subject_id`;
}

describe("migration 0290 organization membership backfill", () => {
  test("declares one rolling, read-only enumeration seam that can never write", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION list_organization_membership_backfill_anchors(",
    );
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION list_organization_memberships_without_personal_workspace(",
    );
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("'membership backfill scope mismatch'");
    // No new tables and no new authority: this migration only adds read-only
    // enumeration over an existing FORCE-RLS table.
    expect(source).not.toContain("CREATE TABLE");
    // The new marker is added to USING only. WITH CHECK keeps exactly the three
    // pre-existing write markers, so the backfill marker is structurally
    // incapable of authorizing a write to organization_memberships.
    const usingClause = source.slice(
      source.indexOf("CREATE POLICY organization_tenancy_lifecycle"),
      source.indexOf("WITH CHECK (current_setting"),
    );
    const withCheckClause = source.slice(source.indexOf("WITH CHECK (current_setting"));
    expect(usingClause).toContain("'organization_membership_backfill'");
    expect(withCheckClause.slice(0, withCheckClause.indexOf(";"))).not.toContain(
      "'organization_membership_backfill'",
    );
    // The definer bodies never mutate anything.
    const bodies = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION list_organization_membership_backfill_anchors("),
    );
    for (const verb of ["INSERT INTO", "UPDATE ", "DELETE FROM", "DROP ", "CREATE POLICY"]) {
      expect(bodies).not.toContain(verb);
    }
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION\n  list_organization_membership_backfill_anchors(uuid, text[]) FROM PUBLIC",
    );
  });

  test("dry run classifies without writing anything, then provisioning converges idempotently", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();

    const preview = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: true,
    });
    expect(preview.counts).toMatchObject({ inspected: 1, provisioned: 0, unresolved: 0 });
    expect(preview.candidates[0]).toMatchObject({
      subjectId: legacy.subjectId,
      resolution: "provisionable",
      reasonCode: null,
    });
    // --dry-run writes NOTHING: no anchor and no personal workspace.
    expect(await anchorRows(legacy.organizationId)).toEqual([]);
    expect(
      await admin<Array<{ id: string }>>`
        select id from workspaces where account_id = ${legacy.organizationId}
          and external_source = 'opengeni:organization-membership'`,
    ).toHaveLength(0);

    const first = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(first.counts).toMatchObject({ provisioned: 1, unresolved: 0, failed: 0 });
    const afterFirst = await anchorRows(legacy.organizationId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.subject_id).toBe(legacy.subjectId);
    expect(afterFirst[0]!.status).toBe("active");
    expect(afterFirst[0]!.personal_workspace_id).not.toBeNull();

    // The personal workspace carries the deterministic identity plus its normal
    // control row, and deliberately has NO workspace_memberships row.
    const [personal] = await admin<
      Array<{ id: string; external_source: string; external_id: string; account_id: string }>
    >`
      select id, external_source, external_id, account_id from workspaces
      where id = ${afterFirst[0]!.personal_workspace_id}`;
    expect(personal!.external_source).toBe("opengeni:organization-membership");
    expect(personal!.external_id).toBe(`${legacy.organizationId}:${legacy.subjectId}`);
    expect(personal!.account_id).toBe(legacy.organizationId);
    const [control] = await admin<Array<{ workspace_id: string }>>`
      select workspace_id from workspace_inference_controls where workspace_id = ${personal!.id}`;
    expect(control).toBeDefined();
    const personalAccess = await admin<Array<{ id: string }>>`
      select id from workspace_memberships where workspace_id = ${personal!.id}`;
    expect(personalAccess).toHaveLength(0);

    // Running it again provisions nothing new.
    const second = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(second.counts).toMatchObject({ provisioned: 0, alreadyAnchored: 1, failed: 0 });
    const afterSecond = await anchorRows(legacy.organizationId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.personal_workspace_id).toBe(afterFirst[0]!.personal_workspace_id);
  }, 180_000);

  test("a human with no deterministic login identity is recorded unresolved, never guessed", async () => {
    if (!available) return;
    const legacy = await legacyOrganization({ withLoginIdentity: false });
    const report = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(report.counts).toMatchObject({ inspected: 1, provisioned: 0, unresolved: 1 });
    expect(report.results[0]).toEqual({
      subjectId: legacy.subjectId,
      outcome: "unresolved",
      reasonCode: "missing_login_identity",
    });
    // Nothing was written for the row it could not prove.
    expect(await anchorRows(legacy.organizationId)).toEqual([]);
  }, 180_000);

  test("workspace access alone never becomes ownership authority", async () => {
    if (!available) return;
    // The organization owner has full deterministic evidence; a second human
    // merely holds access. Phase D forbids inferring authority from current
    // access, so only the owner is provisionable.
    const legacy = await legacyOrganization();
    const otherUserId = crypto.randomUUID();
    const otherSubject = `user:${otherUserId}`;
    await admin`
      insert into auth_users (id, name, email)
      values (${otherUserId}, 'colleague', ${`${otherUserId}@example.test`})`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${legacy.organizationId}, ${legacy.workspaceId}, ${otherSubject}, 'member')`;

    const report = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(report.counts.inspected).toBe(2);
    const bySubject = new Map(report.results.map((result) => [result.subjectId, result]));
    expect(bySubject.get(legacy.subjectId)).toMatchObject({ outcome: "provisioned" });
    // The colleague's organization is not their own identity, so no
    // operator-runnable lifecycle operation exists for them at all.
    expect(bySubject.get(otherSubject)).toEqual({
      subjectId: otherSubject,
      outcome: "unresolved",
      reasonCode: "organization_identity_mismatch",
    });
    const anchors = await anchorRows(legacy.organizationId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.subject_id).toBe(legacy.subjectId);
  }, 180_000);

  test("a subject without an owner-role workspace membership is unresolved", async () => {
    if (!available) return;
    const legacy = await legacyOrganization({ ownerRole: "member" });
    const page = await listOrganizationMembershipBackfillCandidates(db, {
      organizationId: legacy.organizationId,
      limit: 25,
    });
    expect(page).toEqual({
      nextCursor: null,
      candidates: [
        {
          subjectId: legacy.subjectId,
          resolution: "unresolved",
          reasonCode: "missing_owner_workspace_membership",
          organizationMembershipId: null,
          personalWorkspaceId: null,
        },
      ],
    });
    await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(await anchorRows(legacy.organizationId)).toEqual([]);
  }, 180_000);

  test("a suspended anchor is reported, never silently reactivated", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();
    await admin`
      select set_config('opengeni.organization_tenancy_lifecycle', 'managed_human_provisioning', false)`;
    await admin`
      insert into organization_memberships (account_id, subject_id, status, role)
      values (${legacy.organizationId}, ${legacy.subjectId}, 'suspended', 'owner')`;
    await admin`select set_config('opengeni.organization_tenancy_lifecycle', '', false)`;

    const report = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(report.results[0]).toEqual({
      subjectId: legacy.subjectId,
      outcome: "unresolved",
      reasonCode: "membership_terminal_status",
    });
    const anchors = await anchorRows(legacy.organizationId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.status).toBe("suspended");
    expect(anchors[0]!.personal_workspace_id).toBeNull();
  }, 180_000);

  test("concurrent runs never double-provision", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        runOrganizationMembershipBackfill(db, {
          organizationId: legacy.organizationId,
          limit: 25,
          dryRun: false,
        }),
      ),
    );
    for (const run of runs) expect(run.counts.failed).toBe(0);
    // Exactly one durable anchor and one personal workspace, regardless of how
    // the four passes interleaved (provisioned / already_anchored / contended
    // are all correct individual outcomes).
    const anchors = await anchorRows(legacy.organizationId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.personal_workspace_id).not.toBeNull();
    const personalWorkspaces = await admin<Array<{ id: string }>>`
      select id from workspaces
      where external_source = 'opengeni:organization-membership'
        and external_id = ${`${legacy.organizationId}:${legacy.subjectId}`}`;
    expect(personalWorkspaces).toHaveLength(1);
  }, 180_000);

  test("a held claim row is skipped, not blocked on, and the next pass resumes it", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();
    // Hold the exact claim row this candidate needs, exactly as a peer run in
    // the middle of provisioning would.
    const holder = postgres(shared!.appUrl, { max: 1 });
    let releaseHolder: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    // The peer must actually own the row lock before the backfill runs;
    // starting its transaction is not the same as holding the lock, and racing
    // the two makes this assertion nondeterministic.
    let markHeld: (() => void) | null = null;
    const holderAcquired = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const holderTransaction = holder.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${legacy.organizationId}, true)`;
      await tx`
        select access.id from workspace_memberships access
        where access.account_id = ${legacy.organizationId}
          and access.subject_id = ${legacy.subjectId}
          and access.role = 'owner'
        for update`;
      markHeld!();
      await held;
    });
    try {
      await holderAcquired;
      const contendedRun = await runOrganizationMembershipBackfill(db, {
        organizationId: legacy.organizationId,
        limit: 25,
        dryRun: false,
      });
      // SKIP LOCKED: reported as contended instead of waiting on the peer.
      expect(contendedRun.counts).toMatchObject({ contended: 1, provisioned: 0, failed: 0 });
      expect(await anchorRows(legacy.organizationId)).toEqual([]);
    } finally {
      releaseHolder!();
      await holderTransaction;
      await holder.end();
    }
    // Resumability: the very next pass picks the skipped candidate back up.
    const resumed = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: false,
    });
    expect(resumed.counts).toMatchObject({ provisioned: 1, contended: 0, failed: 0 });
    expect(await anchorRows(legacy.organizationId)).toHaveLength(1);
  }, 180_000);

  test("--limit bounds one resumable pass and repeated passes drain the rest", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();
    // Four more humans with access, deterministically ordered after/around the
    // owner. The pass must never inspect more than --limit of them.
    for (let index = 0; index < 4; index += 1) {
      const extraId = crypto.randomUUID();
      await admin`
        insert into auth_users (id, name, email)
        values (${extraId}, 'extra', ${`${extraId}@example.test`})`;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${legacy.organizationId}, ${legacy.workspaceId}, ${`user:${extraId}`}, 'member')`;
    }
    const bounded = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: true,
    });
    expect(bounded.counts.inspected).toBe(2);
    // A bounded pass that did not reach the end hands back the cursor that
    // resumes it - the whole reason repeated passes converge.
    expect(bounded.startCursor).toBeNull();
    expect(bounded.nextCursor).toBe(bounded.candidates[1]!.subjectId);
    const full = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 25,
      dryRun: true,
    });
    expect(full.counts.inspected).toBe(5);
    // A pass that saw the whole stream reports no cursor: that is what stops
    // a drain instead of it re-reading one window forever.
    expect(full.nextCursor).toBeNull();
  }, 180_000);

  test("repeated passes reach a subject that sorts behind the whole --limit window", async () => {
    if (!available) return;
    // The exact non-convergence shape: MORE subjects than --limit, with the one
    // subject that is actually provisionable sorting LAST. A fixed `limit`
    // window with no cursor returns the same first two subjects on every pass,
    // so the owner is never even inspected, let alone provisioned.
    const tag = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const ownerUserId = `${tag}zzz00`;
    const legacy = await legacyOrganization({ userId: ownerUserId });
    const extraSubjects: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const extraId = `${tag}aaa${String(index).padStart(2, "0")}`;
      extraSubjects.push(`user:${extraId}`);
      await admin`
        insert into auth_users (id, name, email)
        values (${extraId}, 'extra', ${`${extraId}@example.test`})`;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${legacy.organizationId}, ${legacy.workspaceId}, ${`user:${extraId}`}, 'member')`;
    }
    const everySubject = [...extraSubjects, legacy.subjectId].sort();
    expect(everySubject[everySubject.length - 1]).toBe(legacy.subjectId);

    // Non-vacuity: with --limit 2 the owner is genuinely outside the first
    // window, so this test can only pass if the cursor actually advances.
    const firstWindow = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: true,
    });
    expect(firstWindow.candidates.map((candidate) => candidate.subjectId)).not.toContain(
      legacy.subjectId,
    );
    expect(firstWindow.nextCursor).not.toBeNull();

    // Chained bounded passes: strictly increasing, disjoint, and complete.
    const windows: string[][] = [];
    let cursor: string | null = null;
    for (let pass = 0; pass < 20; pass += 1) {
      const report: Awaited<ReturnType<typeof runOrganizationMembershipBackfill>> =
        await runOrganizationMembershipBackfill(db, {
          organizationId: legacy.organizationId,
          limit: 2,
          dryRun: true,
          afterSubjectId: cursor,
        });
      expect(report.startCursor).toBe(cursor);
      expect(report.counts.inspected).toBeLessThanOrEqual(2);
      windows.push(report.candidates.map((candidate) => candidate.subjectId));
      cursor = report.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    const walked = windows.flat();
    expect(walked).toEqual(everySubject);
    expect(new Set(walked).size).toBe(walked.length);
    expect(windows.length).toBeGreaterThan(1);

    // And the write path converges the same way: one drain provisions the
    // owner that a fixed window could never have reached.
    const drain = await drainOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: false,
    });
    expect(drain.drained).toBe(true);
    expect(drain.lastCursor).toBeNull();
    expect(drain.counts).toMatchObject({ inspected: 8, provisioned: 1, failed: 0 });
    // The seven access-only humans are recorded, never guessed.
    expect(drain.unresolved).toHaveLength(7);
    const anchors = await anchorRows(legacy.organizationId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.subject_id).toBe(legacy.subjectId);
    expect(anchors[0]!.personal_workspace_id).not.toBeNull();

    // Idempotent: a second drain converges to already_anchored, provisions
    // nothing, and still terminates.
    const again = await drainOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: false,
    });
    expect(again.drained).toBe(true);
    expect(again.counts).toMatchObject({
      inspected: 8,
      provisioned: 0,
      alreadyAnchored: 1,
      failed: 0,
    });
    expect(await anchorRows(legacy.organizationId)).toHaveLength(1);
  }, 180_000);

  test("a membership-only subject behind the window is never starved by workspace access", async () => {
    if (!available) return;
    // Population 2 (an anchor with no personal workspace and no workspace
    // access at all) sorts behind a full --limit window of population 1. The
    // old merge took `sort().slice(0, limit)` over a set already at `limit`,
    // which dropped this subject on every pass forever.
    const tag = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const legacy = await legacyOrganization({ userId: `${tag}zzz00` });
    for (let index = 0; index < 4; index += 1) {
      const extraId = `${tag}aaa${String(index).padStart(2, "0")}`;
      await admin`
        insert into auth_users (id, name, email)
        values (${extraId}, 'extra', ${`${extraId}@example.test`})`;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${legacy.organizationId}, ${legacy.workspaceId}, ${`user:${extraId}`}, 'member')`;
    }
    const pendingUserId = `${tag}mmm00`;
    const pendingSubject = `user:${pendingUserId}`;
    await admin`
      insert into auth_users (id, name, email)
      values (${pendingUserId}, 'pending', ${`${pendingUserId}@example.test`})`;
    await admin`
      select set_config('opengeni.organization_tenancy_lifecycle', 'managed_human_provisioning', false)`;
    const [pendingAnchor] = await admin<{ id: string }[]>`
      insert into organization_memberships (account_id, subject_id, status, role)
      values (${legacy.organizationId}, ${pendingSubject}, 'provisioning', 'member')
      returning id`;
    await admin`select set_config('opengeni.organization_tenancy_lifecycle', '', false)`;

    // Non-vacuity: the first --limit 2 window is pure population 1, so the
    // membership-only subject is provably outside it.
    const firstWindow = await runOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: true,
    });
    expect(firstWindow.candidates.map((candidate) => candidate.subjectId)).toEqual([
      `user:${tag}aaa00`,
      `user:${tag}aaa01`,
    ]);

    const seen: Array<{ subjectId: string; organizationMembershipId: string | null }> = [];
    let cursor: string | null = null;
    for (let pass = 0; pass < 20; pass += 1) {
      const report: Awaited<ReturnType<typeof runOrganizationMembershipBackfill>> =
        await runOrganizationMembershipBackfill(db, {
          organizationId: legacy.organizationId,
          limit: 2,
          dryRun: true,
          afterSubjectId: cursor,
        });
      for (const candidate of report.candidates) {
        seen.push({
          subjectId: candidate.subjectId,
          organizationMembershipId: candidate.organizationMembershipId,
        });
      }
      cursor = report.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen.map((entry) => entry.subjectId)).toEqual(
      [`user:${tag}aaa00`, `user:${tag}aaa01`, `user:${tag}aaa02`, `user:${tag}aaa03`,
        pendingSubject, legacy.subjectId].sort(),
    );
    expect(seen.find((entry) => entry.subjectId === pendingSubject)).toEqual({
      subjectId: pendingSubject,
      organizationMembershipId: pendingAnchor!.id,
    });
  }, 180_000);

  test("a walk stopped by --max-passes resumes exactly where it stopped", async () => {
    if (!available) return;
    const tag = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const legacy = await legacyOrganization({ userId: `${tag}zzz00` });
    for (let index = 0; index < 5; index += 1) {
      const extraId = `${tag}aaa${String(index).padStart(2, "0")}`;
      await admin`
        insert into auth_users (id, name, email)
        values (${extraId}, 'extra', ${`${extraId}@example.test`})`;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${legacy.organizationId}, ${legacy.workspaceId}, ${`user:${extraId}`}, 'member')`;
    }
    const stopped = await drainOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: true,
      maxPasses: 2,
    });
    expect(stopped).toMatchObject({ passes: 2, drained: false });
    expect(stopped.counts.inspected).toBe(4);
    expect(stopped.lastCursor).toBe(`user:${tag}aaa03`);

    const resumed = await drainOrganizationMembershipBackfill(db, {
      organizationId: legacy.organizationId,
      limit: 2,
      dryRun: true,
      afterSubjectId: stopped.lastCursor,
    });
    expect(resumed.drained).toBe(true);
    expect(resumed.counts.inspected).toBe(2);
  }, 180_000);

  test("the enumeration seam rejects a cursor that is not a user subject", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();
    let driverFailure: unknown = null;
    try {
      await listOrganizationMembershipBackfillCandidates(db, {
        organizationId: legacy.organizationId,
        limit: 25,
        afterSubjectId: "api_key:nope",
      });
    } catch (error) {
      driverFailure = error;
    }
    expect(String(driverFailure)).toContain("cursor must be a 'user:' subject id");

    // The SQL seam refuses it independently of the driver's own guard.
    let seamFailure: unknown = null;
    try {
      await withRlsContext(
        db,
        { accountId: legacy.organizationId, workspaceId: null },
        async (scopedDb) => {
          await rawRows(
            scopedDb,
            sql`select list_organization_memberships_without_personal_workspace(
              ${legacy.organizationId}, 25, ${"api_key:nope"}::text
            )`,
          );
        },
      );
    } catch (error) {
      seamFailure = error;
    }
    expect(seamFailure).not.toBeNull();
    const cause = (seamFailure as { cause?: { message?: string } }).cause;
    expect(cause?.message ?? String(seamFailure)).toContain("membership backfill cursor is invalid");
  }, 180_000);

  test("the enumeration seam rejects a cross-organization scope", async () => {
    if (!available) return;
    const legacy = await legacyOrganization();
    const other = await legacyOrganization();
    let failure: unknown = null;
    try {
      await withRlsContext(
        db,
        { accountId: legacy.organizationId, workspaceId: null },
        async (scopedDb) => {
          await rawRows(
            scopedDb,
            sql`select list_organization_membership_backfill_anchors(
              ${other.organizationId}, ARRAY[${other.subjectId}::text]::text[]
            )`,
          );
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBeNull();
    const cause = (failure as { cause?: { message?: string } }).cause;
    expect(cause?.message ?? String(failure)).toContain("membership backfill scope mismatch");
  }, 180_000);
});

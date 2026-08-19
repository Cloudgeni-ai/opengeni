/**
 * Phase D (docs/organization-tenancy.md) membership and personal-workspace
 * backfill driver.
 *
 * The population this drains is the one 0285's inventory counts as
 * `workspaceMemberSubjectsWithoutMembershipAnchor`: humans who held workspace
 * access before migration 0219 and never re-authenticated afterwards, so the
 * Better Auth managed-access hook never ran the provisioning seam for them and
 * they have no `organization_memberships` anchor at all. It also drains
 * `organizationMemberships.activeWithoutPersonalWorkspace`.
 *
 * Three rules shape everything here:
 *
 * 1. **Reuse the lifecycle seam.** Provisioning goes through
 *    `ensureManagedHumanPersonalWorkspace`, the single shared implementation
 *    over 0219's `ensure_managed_human_personal_workspace` SECURITY DEFINER
 *    capability - the same call the Better Auth hook makes. This driver holds
 *    no authority logic of its own and never writes an organization-tenancy
 *    table directly; the seam fails closed on every identity it cannot prove.
 *
 * 2. **Never infer authority.** Phase D forbids inferring user authority from
 *    `created_by`, connection attribution, a default workspace, a resource
 *    name, or current access. This driver acts only on deterministic evidence:
 *    a live Better Auth login identity for the exact subject, an organization
 *    whose own external identity IS that human, and a persisted owner-role
 *    workspace membership. Anything short of that is recorded unresolved with
 *    a reason code and left untouched - never guessed, never widened.
 *
 * 3. **Idempotent, resumable, concurrency-safe.** Each candidate is claimed
 *    independently with `FOR UPDATE SKIP LOCKED` on its exact owner workspace
 *    membership, so two operators running at once take disjoint work and
 *    neither double-provisions; the seam's own row locks are the final
 *    authority. Running the command again converges rather than duplicating,
 *    and `--dry-run` writes nothing at all.
 *
 * 4. **A bounded pass is a keyset window, never a fixed window.** Both
 *    populations are ordered by `subject_id`, and a pass reads only subjects
 *    strictly greater than `afterSubjectId`. This is what makes repeated passes
 *    *converge* rather than re-read: a subject the driver cannot resolve stays
 *    in its population forever (a missing login identity is not going to
 *    appear because we looked again), so a fixed `LIMIT n` window over an
 *    organization with more than `n` subjects would return the same first `n`
 *    rows on every pass and never reach subject `n + 1`. Each source is read
 *    `limit`-deep from the same cursor before the merge, so the merged window
 *    is a true prefix of the merged ordered stream and one population can
 *    never starve the other.
 */
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setRlsContext, withRlsContext } from "./database";
import { ensureManagedHumanPersonalWorkspace } from "./managed-human-provisioning";

/** Why a candidate cannot be provisioned from deterministic evidence alone. */
export type OrganizationMembershipBackfillUnresolvedReason =
  /** No Better Auth login identity exists for this subject: the `user:<id>`
   *  subject is a persisted string with nothing behind it. Guessing an
   *  identity here would be exactly the inference Phase D forbids. */
  | "missing_login_identity"
  /** The organization's own external identity is not this human. 0219's seam
   *  provisions only a managed human's self-owned organization, and 0263's
   *  invitation acceptance is bound to the invited human's own authenticated
   *  session - so no operator-runnable idempotent lifecycle operation exists
   *  for this row. It needs a human act, not a backfill. */
  | "organization_identity_mismatch"
  /** The subject has workspace access in this organization but holds no
   *  owner-role workspace membership, which the lifecycle seam requires as
   *  proof of ownership. Promoting them would manufacture authority. */
  | "missing_owner_workspace_membership"
  /** An anchor exists but is suspended or revoked. Reactivation is an explicit
   *  owner-authorized 0263 lifecycle action; a backfill must never perform it. */
  | "membership_terminal_status";

export type OrganizationMembershipBackfillCandidate = {
  subjectId: string;
  resolution: "provisionable" | "already_anchored" | "unresolved";
  reasonCode: OrganizationMembershipBackfillUnresolvedReason | null;
  organizationMembershipId: string | null;
  personalWorkspaceId: string | null;
};

export type OrganizationMembershipBackfillOutcome =
  | {
      subjectId: string;
      outcome: "provisioned";
      organizationMembershipId: string;
      personalWorkspaceId: string;
    }
  | {
      subjectId: string;
      outcome: "already_anchored";
      organizationMembershipId: string;
      personalWorkspaceId: string | null;
    }
  | {
      subjectId: string;
      outcome: "unresolved";
      reasonCode: OrganizationMembershipBackfillUnresolvedReason;
    }
  /** Another concurrent run holds this candidate's claim row. Deliberately not
   *  a failure: the next pass picks it up, which is what resumability means. */
  | { subjectId: string; outcome: "contended" }
  | { subjectId: string; outcome: "failed"; reasonCode: string };

export type OrganizationMembershipBackfillCounts = {
  inspected: number;
  provisioned: number;
  alreadyAnchored: number;
  unresolved: number;
  contended: number;
  failed: number;
};

export type OrganizationMembershipBackfillReport = {
  organizationId: string;
  dryRun: boolean;
  /** The exclusive keyset cursor this pass started after (`null` = from the
   *  beginning of the ordered subject stream). */
  startCursor: string | null;
  /** Feed this back as `afterSubjectId` to continue. `null` means this pass
   *  reached the end of the ordered stream: the organization is drained. */
  nextCursor: string | null;
  candidates: OrganizationMembershipBackfillCandidate[];
  results: OrganizationMembershipBackfillOutcome[];
  counts: OrganizationMembershipBackfillCounts;
};

/** One full walk of an organization: repeated bounded passes, cursor-chained. */
export type OrganizationMembershipBackfillDrainReport = {
  organizationId: string;
  dryRun: boolean;
  limit: number;
  passes: number;
  /** True when the walk reached the end of the ordered stream. False only when
   *  `maxPasses` stopped it first, and then `lastCursor` resumes it. */
  drained: boolean;
  lastCursor: string | null;
  counts: OrganizationMembershipBackfillCounts;
  unresolved: Array<{
    subjectId: string;
    reasonCode: OrganizationMembershipBackfillUnresolvedReason;
  }>;
  /** Claimed by a peer run during this walk. Not a failure and not skipped
   *  work: re-running the command from the start converges them. */
  contended: string[];
  failed: Array<{ subjectId: string; reasonCode: string }>;
};

export type OrganizationMembershipBackfillPage = {
  candidates: OrganizationMembershipBackfillCandidate[];
  nextCursor: string | null;
};

type AnchorRow = {
  subjectId: string;
  membershipId: string;
  status: string;
  personalWorkspaceId: string | null;
};

const SUBJECT_PREFIX = "user:";

function subjectUserId(subjectId: string): string {
  return subjectId.slice(SUBJECT_PREFIX.length);
}

/** Drizzle expands a bare JS array into a parameter list, not a Postgres
 *  array, so every `= any(...)` / `text[]` argument is built explicitly. */
function textArray(values: readonly string[]) {
  return values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}::text`),
        sql`, `,
      )}]::text[]`;
}

/**
 * The single subject-id order this driver uses, on BOTH sides of the seam.
 *
 * Both source queries page with `COLLATE "C"`, which compares the UTF-8 bytes -
 * i.e. code point order. This comparator reproduces exactly that in JavaScript.
 * The default `Array#sort` comparator would very nearly do it, but it compares
 * UTF-16 *code units*, so a supplementary-plane subject id (encoded as a
 * surrogate pair, `0xD800..0xDFFF`) sorts below `U+E000..U+FFFF` in JavaScript
 * and above it in the database. The guards here admit arbitrary 1024-character
 * `user:` text, so that disagreement is reachable; a keyset cursor taken from a
 * merged order that disagrees with the database silently skips subjects and
 * still reports a drained population.
 */
function compareSubjectIds(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length;) {
    const leftPoint = left.codePointAt(index)!;
    const rightPoint = right.codePointAt(index)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    index += leftPoint > 0xffff ? 2 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function assertCursor(afterSubjectId: string | null | undefined): string | null {
  if (afterSubjectId === null || afterSubjectId === undefined) return null;
  if (
    afterSubjectId !== afterSubjectId.trim() ||
    afterSubjectId.length < 1 ||
    afterSubjectId.length > 1024 ||
    !afterSubjectId.startsWith(SUBJECT_PREFIX)
  ) {
    throw new Error("Organization membership backfill cursor must be a 'user:' subject id");
  }
  return afterSubjectId;
}

/**
 * Enumerate one bounded, deterministically ordered, keyset-paged backfill
 * candidate window for one organization and classify each candidate. Strictly
 * read-only: safe to call repeatedly, and the exact query `--dry-run` reports.
 *
 * The window is the first `limit` subjects strictly greater than
 * `afterSubjectId` in the merge of both populations. `nextCursor` is the last
 * subject of that window when more may remain, and `null` once the stream is
 * exhausted - which is the only thing that makes repeated passes terminate on
 * a drained organization instead of re-reading one window forever.
 */
export async function listOrganizationMembershipBackfillCandidates(
  db: Database,
  input: { organizationId: string; limit: number; afterSubjectId?: string | null },
): Promise<OrganizationMembershipBackfillPage> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Organization membership backfill limit must be an integer from 1 to 100");
  }
  const afterSubjectId = assertCursor(input.afterSubjectId);
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      // Population 1: humans with persisted workspace access in this
      // organization. Ordinary account-scoped application-role reads - no
      // widened visibility, no organization-tenancy table touched.
      const accessRows = await rawRows<{ subject_id: string; owner_membership_id: string | null }>(
        scopedDb,
        sql`
          select
            access.subject_id as subject_id,
            max(case when access.role = 'owner' then access.id::text else null end)
              as owner_membership_id
          from workspace_memberships access
          inner join workspaces workspace
            on workspace.id = access.workspace_id
           and workspace.account_id = access.account_id
          where access.account_id = ${input.organizationId}
            and access.subject_id like ${`${SUBJECT_PREFIX}%`}
            and (
              ${afterSubjectId}::text is null
              or access.subject_id collate "C" > ${afterSubjectId}::text collate "C"
            )
          group by access.subject_id
          order by access.subject_id collate "C"
          limit ${input.limit}
        `,
      );
      const ownerMembershipBySubject = new Map<string, string | null>(
        accessRows.map((row) => [row.subject_id, row.owner_membership_id]),
      );

      // Population 2: existing memberships that carry no personal workspace.
      // organization_memberships is FORCE-RLS with zero direct application
      // privileges, so this is the 0290 read-only definer seam.
      const [pendingResult] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`
          select list_organization_memberships_without_personal_workspace(
            ${input.organizationId}, ${input.limit}, ${afterSubjectId}::text
          ) as result
        `,
      );
      const pendingRows = (pendingResult?.result ?? []) as Array<{
        subjectId: string;
        membershipId: string;
        status: string;
      }>;
      for (const row of pendingRows) {
        if (!ownerMembershipBySubject.has(row.subjectId)) {
          ownerMembershipBySubject.set(row.subjectId, null);
        }
      }

      // Both sources were read `limit`-deep from the SAME cursor, so the first
      // `limit` of their sorted union is exactly the first `limit` of the
      // merged ordered stream: anything the slice drops sorts strictly after
      // the kept tail and is reached by the next pass under `nextCursor`.
      // Neither population can therefore starve the other.
      //
      // That argument only holds while this merge order and the two source
      // orders are the SAME order. Both sources page with `COLLATE "C"`; this
      // reproduces it exactly. See `compareSubjectIds`.
      const merged = [...ownerMembershipBySubject.keys()].sort(compareSubjectIds);
      const subjectIds = merged.slice(0, input.limit);
      // More may remain when the merge was truncated, or when either source
      // filled its own window (there may be a `limit + 1`-th row behind it).
      const mayHaveMore =
        merged.length > input.limit ||
        accessRows.length >= input.limit ||
        pendingRows.length >= input.limit;
      const nextCursor =
        mayHaveMore && subjectIds.length > 0 ? subjectIds[subjectIds.length - 1]! : null;
      if (subjectIds.length === 0) return { candidates: [], nextCursor: null };

      // Owner-role proof for any subject that entered only through population 2.
      const missingOwnerProof = subjectIds.filter(
        (subjectId) => ownerMembershipBySubject.get(subjectId) == null,
      );
      if (missingOwnerProof.length > 0) {
        const ownerRows = await rawRows<{ subject_id: string; id: string }>(
          scopedDb,
          sql`
            select access.subject_id as subject_id, access.id::text as id
            from workspace_memberships access
            inner join workspaces workspace
              on workspace.id = access.workspace_id
             and workspace.account_id = access.account_id
            where access.account_id = ${input.organizationId}
              and access.role = 'owner'
              and access.subject_id = any(${textArray(missingOwnerProof)})
          `,
        );
        for (const row of ownerRows) ownerMembershipBySubject.set(row.subject_id, row.id);
      }

      const [anchorResult] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`
          select list_organization_membership_backfill_anchors(
            ${input.organizationId}, ${textArray(subjectIds)}
          ) as result
        `,
      );
      const anchorBySubject = new Map<string, AnchorRow>(
        ((anchorResult?.result ?? []) as AnchorRow[]).map((row) => [row.subjectId, row]),
      );

      // Deterministic login-identity evidence. `auth_users` is the Better Auth
      // user table; a subject with no row behind it is exactly the case Phase D
      // says must be recorded, not guessed.
      const userIds = subjectIds.map(subjectUserId);
      const identityRows = await rawRows<{ id: string }>(
        scopedDb,
        sql`select id from auth_users where id = any(${textArray(userIds)})`,
      );
      const knownUserIds = new Set(identityRows.map((row) => row.id));

      // The organization's own external identity. 0219's seam provisions only
      // a managed human's self-owned organization.
      const organizationRows = await rawRows<{
        external_source: string | null;
        external_id: string | null;
      }>(
        scopedDb,
        sql`
          select external_source, external_id
          from managed_accounts
          where id = ${input.organizationId}
        `,
      );
      const organization = organizationRows[0] ?? null;

      const candidates = subjectIds.map((subjectId): OrganizationMembershipBackfillCandidate => {
        const anchor = anchorBySubject.get(subjectId) ?? null;
        if (anchor && (anchor.status === "suspended" || anchor.status === "revoked")) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "membership_terminal_status",
            organizationMembershipId: anchor.membershipId,
            personalWorkspaceId: anchor.personalWorkspaceId,
          };
        }
        if (anchor && anchor.personalWorkspaceId !== null) {
          return {
            subjectId,
            resolution: "already_anchored",
            reasonCode: null,
            organizationMembershipId: anchor.membershipId,
            personalWorkspaceId: anchor.personalWorkspaceId,
          };
        }
        if (!knownUserIds.has(subjectUserId(subjectId))) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "missing_login_identity",
            organizationMembershipId: anchor?.membershipId ?? null,
            personalWorkspaceId: null,
          };
        }
        if (
          !organization ||
          organization.external_source !== "better-auth:user" ||
          organization.external_id !== subjectUserId(subjectId)
        ) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "organization_identity_mismatch",
            organizationMembershipId: anchor?.membershipId ?? null,
            personalWorkspaceId: null,
          };
        }
        if (ownerMembershipBySubject.get(subjectId) == null) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "missing_owner_workspace_membership",
            organizationMembershipId: anchor?.membershipId ?? null,
            personalWorkspaceId: null,
          };
        }
        return {
          subjectId,
          resolution: "provisionable",
          reasonCode: null,
          organizationMembershipId: anchor?.membershipId ?? null,
          personalWorkspaceId: null,
        };
      });
      return { candidates, nextCursor };
    },
  );
}

/**
 * Provision exactly one candidate inside one transaction.
 *
 * The transaction first claims the candidate's owner workspace membership with
 * `FOR UPDATE SKIP LOCKED`. That row is the natural claim: it is the exact
 * evidence the lifecycle seam validates, so holding it for the duration also
 * stops a concurrent workspace-membership removal from racing the anchor we are
 * writing. A skipped claim means a peer run owns this candidate right now -
 * reported as `contended`, picked up by the next pass.
 */
export async function provisionOrganizationMembershipBackfillCandidate(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<OrganizationMembershipBackfillOutcome> {
  return await db.transaction(async (tx) => {
    const scopedTx = tx as unknown as Database;
    await setRlsContext(scopedTx, { accountId: input.organizationId, workspaceId: null });
    const claimed = await rawRows<{ id: string }>(
      scopedTx,
      sql`
        select access.id::text as id
        from workspace_memberships access
        inner join workspaces workspace
          on workspace.id = access.workspace_id
         and workspace.account_id = access.account_id
        where access.account_id = ${input.organizationId}
          and access.subject_id = ${input.subjectId}
          and access.role = 'owner'
        order by access.id
        limit 1
        for update of access skip locked
      `,
    );
    if (claimed.length === 0) {
      // Either a peer run holds the claim, or the owner membership vanished
      // between enumeration and now. Both are safe to retry; neither may be
      // resolved by relaxing the evidence requirement.
      return { subjectId: input.subjectId, outcome: "contended" as const };
    }
    const provisioned = await ensureManagedHumanPersonalWorkspace(scopedTx, {
      accountId: input.organizationId,
      subjectId: input.subjectId,
    });
    return {
      subjectId: input.subjectId,
      outcome: "provisioned" as const,
      organizationMembershipId: provisioned.organizationMembershipId,
      personalWorkspaceId: provisioned.personalWorkspaceId,
    };
  });
}

/**
 * Run one bounded backfill pass over an organization. Safe to run repeatedly
 * and concurrently; `dryRun` inspects and classifies without writing anything.
 *
 * One pass is one keyset window. Chain `report.nextCursor` back in as
 * `afterSubjectId` to walk the whole organization, or call
 * `drainOrganizationMembershipBackfill` which does exactly that.
 */
export async function runOrganizationMembershipBackfill(
  db: Database,
  input: {
    organizationId: string;
    limit: number;
    dryRun: boolean;
    afterSubjectId?: string | null;
  },
): Promise<OrganizationMembershipBackfillReport> {
  const startCursor = assertCursor(input.afterSubjectId);
  const { candidates, nextCursor } = await listOrganizationMembershipBackfillCandidates(db, {
    organizationId: input.organizationId,
    limit: input.limit,
    afterSubjectId: startCursor,
  });
  const results: OrganizationMembershipBackfillOutcome[] = [];
  for (const candidate of candidates) {
    if (candidate.resolution === "unresolved") {
      results.push({
        subjectId: candidate.subjectId,
        outcome: "unresolved",
        reasonCode: candidate.reasonCode!,
      });
      continue;
    }
    if (candidate.resolution === "already_anchored") {
      results.push({
        subjectId: candidate.subjectId,
        outcome: "already_anchored",
        organizationMembershipId: candidate.organizationMembershipId!,
        personalWorkspaceId: candidate.personalWorkspaceId,
      });
      continue;
    }
    if (input.dryRun) continue;
    try {
      results.push(
        await provisionOrganizationMembershipBackfillCandidate(db, {
          organizationId: input.organizationId,
          subjectId: candidate.subjectId,
        }),
      );
    } catch (error) {
      // One candidate's failure must never roll back or hide the rest. The
      // reason is a bounded code; the exact diagnostic stays in the operator's
      // logs rather than becoming a stored blob.
      results.push({
        subjectId: candidate.subjectId,
        outcome: "failed",
        reasonCode:
          error instanceof Error && error.message.length > 0
            ? "lifecycle_seam_rejected"
            : "unknown_failure",
      });
    }
  }
  const countOf = (outcome: OrganizationMembershipBackfillOutcome["outcome"]): number =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    organizationId: input.organizationId,
    dryRun: input.dryRun,
    startCursor,
    nextCursor,
    candidates,
    results,
    counts: {
      inspected: candidates.length,
      provisioned: countOf("provisioned"),
      alreadyAnchored: countOf("already_anchored"),
      unresolved: countOf("unresolved"),
      contended: countOf("contended"),
      failed: countOf("failed"),
    },
  };
}

/**
 * Walk an entire organization by chaining bounded passes on the keyset cursor
 * until the ordered stream is exhausted.
 *
 * `maxPasses` is a safety stop, not the termination condition: a walk that hits
 * it reports `drained: false` and a `lastCursor` that resumes it exactly where
 * it stopped. Because the cursor is strictly increasing, this terminates on
 * every organization - including one whose first `limit` subjects are all
 * permanently unresolvable, which is precisely the shape a fixed window could
 * never get past.
 */
export async function drainOrganizationMembershipBackfill(
  db: Database,
  input: {
    organizationId: string;
    limit: number;
    dryRun: boolean;
    maxPasses?: number;
    afterSubjectId?: string | null;
  },
): Promise<OrganizationMembershipBackfillDrainReport> {
  const maxPasses = input.maxPasses ?? 1000;
  if (!Number.isInteger(maxPasses) || maxPasses < 1) {
    throw new Error("Organization membership backfill maxPasses must be a positive integer");
  }
  const counts: OrganizationMembershipBackfillCounts = {
    inspected: 0,
    provisioned: 0,
    alreadyAnchored: 0,
    unresolved: 0,
    contended: 0,
    failed: 0,
  };
  const unresolved: OrganizationMembershipBackfillDrainReport["unresolved"] = [];
  const contended: string[] = [];
  const failed: OrganizationMembershipBackfillDrainReport["failed"] = [];
  let cursor = assertCursor(input.afterSubjectId);
  let passes = 0;
  let drained = false;
  while (passes < maxPasses) {
    const report = await runOrganizationMembershipBackfill(db, {
      organizationId: input.organizationId,
      limit: input.limit,
      dryRun: input.dryRun,
      afterSubjectId: cursor,
    });
    passes += 1;
    for (const key of Object.keys(counts) as Array<keyof OrganizationMembershipBackfillCounts>) {
      counts[key] += report.counts[key];
    }
    for (const result of report.results) {
      if (result.outcome === "unresolved") {
        unresolved.push({ subjectId: result.subjectId, reasonCode: result.reasonCode });
      } else if (result.outcome === "contended") {
        contended.push(result.subjectId);
      } else if (result.outcome === "failed") {
        failed.push({ subjectId: result.subjectId, reasonCode: result.reasonCode });
      }
    }
    cursor = report.nextCursor;
    if (cursor === null) {
      drained = true;
      break;
    }
  }
  return {
    organizationId: input.organizationId,
    dryRun: input.dryRun,
    limit: input.limit,
    passes,
    drained,
    lastCursor: cursor,
    counts,
    unresolved,
    contended,
    failed,
  };
}

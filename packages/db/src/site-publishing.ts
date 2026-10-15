import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import type { Permission } from "@opengeni/contracts";
import { normalizeWorkspaceMembershipPermissions } from "./workspace-membership-permissions";
import { lockSessionEventWriteRows } from "./session-control";
import { sessionQueueIsEmptyInTransaction } from "./empty-session-queue";

/**
 * Published Sites storage (migration 0782). Every read and write runs in the
 * Site's workspace RLS context, except the hostname lane: a label lookup that
 * names exactly one row of `site_hostnames` (and of `site_hostname_holds`)
 * through the `opengeni.site_hostname_label` setting (the api_keys hash
 * pattern; a row-level policy, not a SECURITY DEFINER function). The API
 * decides who may do what; these functions enforce shapes, uniqueness, the
 * release hold, platform holds, single use and the spend reservations.
 *
 * Everything that claims, releases or publishes one hostname runs under a
 * transaction advisory lock on that label, so edge writes for a hostname
 * happen in generation order.
 */

export type SitePublishingScope = { accountId: string; workspaceId: string };

export type SitePublishingErrorCode =
  | "not_found"
  | "taken"
  | "held"
  | "reserved"
  | "conflict"
  | "forbidden"
  | "validation";

export class SitePublishingError extends Error {
  constructor(
    readonly code: SitePublishingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SitePublishingError";
  }
}

export type SitePublicationAccess = "members" | "invited" | "public";
export type SitePublicationStatusValue = "active" | "unpublished" | "suspended";
export type SiteSuspendedBy = "owner" | "admin" | "platform";
/** Public `standard` retains the stored spelling `free` for previous-release readers. */
export type SiteLimitProfileKindValue = "standard" | "free" | "credits" | "unlimited" | "custom";
export type SiteViewerKindValue = "member" | "invited" | "user";

export type StoredSiteLimitProfile = {
  kind: SiteLimitProfileKindValue;
  overrides: Record<string, unknown> | null;
};

export type SitePublicationRecord = {
  siteId: string;
  accountId: string;
  workspaceId: string;
  label: string;
  access: SitePublicationAccess;
  status: SitePublicationStatusValue;
  noindex: boolean;
  agent: {
    enabled: boolean;
    model: string | null;
    instructions: string | null;
    tools: string[] | null;
    /** Anonymous guests' conversations get `tools` too (an admin's opt-in). */
    guestTools: boolean;
  };
  /** The Site's own profile; null inherits the workspace default. */
  limitProfile: StoredSiteLimitProfile | null;
  invitedEmails: string[];
  suspendedAt: Date | null;
  suspendedBy: SiteSuspendedBy | null;
  suspendedReason: string | null;
  suspendedBySubject: string | null;
  generation: number;
  edgeSyncedGeneration: number;
  scanStatus: "none" | "clean" | "flagged" | "error";
  scanFindings: unknown[] | null;
  scannedVersionId: string | null;
  scannedAt: Date | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The Site behind a publication, as published Sites need it. */
export type PublishedSiteRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  title: string;
  status: "active" | "archived";
  visibility: "workspace_shared" | "user_private";
  ownerSubjectId: string | null;
  createdBySubjectId: string;
  currentVersionId: string | null;
};

export type SiteHostnameRecord = {
  label: string;
  accountId: string;
  workspaceId: string;
  siteId: string;
  createdAt: Date;
  releasedAt: Date | null;
};

/**
 * A hold on a label. `platform`: a taken-down label no workspace may claim
 * until the operator lifts it. `release`: the label of a deleted Site or
 * workspace, kept for that workspace until `expiresAt` (written by the
 * database when the hostname row is deleted).
 */
export type SiteHostnameHoldRecord = {
  label: string;
  siteId: string;
  workspaceId: string;
  reason: string;
  heldBy: string;
  kind: "platform" | "release";
  expiresAt: Date | null;
  createdAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LABEL = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
/** The database floor for the release hold; settings may only lengthen it. */
export const SITE_HOSTNAME_MIN_HOLD_DAYS = 30;

export function isSitePublishingUuid(value: string): boolean {
  return UUID.test(value);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

type PublicationRow = {
  site_id: string;
  account_id: string;
  workspace_id: string;
  label: string;
  access: SitePublicationAccess;
  status: SitePublicationStatusValue;
  noindex: boolean;
  agent_enabled: boolean;
  agent_model: string | null;
  agent_instructions: string | null;
  agent_tools: unknown;
  agent_guest_tools: boolean;
  limit_profile_kind: SiteLimitProfileKindValue | null;
  limit_overrides: unknown;
  invited_emails: unknown;
  suspended_at: unknown;
  suspended_by: SiteSuspendedBy | null;
  suspended_reason: string | null;
  suspended_by_subject: string | null;
  generation: string | number;
  edge_synced_generation: string | number;
  scan_status: SitePublicationRecord["scanStatus"];
  scan_findings: unknown;
  scanned_version_id: string | null;
  scanned_at: unknown;
  created_by: string;
  updated_by: string;
  created_at: unknown;
  updated_at: unknown;
};

function toPublication(row: PublicationRow): SitePublicationRecord {
  const tools = row.agent_tools === null ? null : jsonValue<string[]>(row.agent_tools);
  return {
    siteId: row.site_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    label: row.label,
    access: row.access,
    status: row.status,
    noindex: row.noindex,
    agent: {
      enabled: row.agent_enabled,
      model: row.agent_model,
      instructions: row.agent_instructions,
      tools,
      guestTools: row.agent_guest_tools,
    },
    limitProfile: row.limit_profile_kind
      ? {
          kind: row.limit_profile_kind,
          overrides:
            row.limit_overrides === null
              ? null
              : jsonValue<Record<string, unknown>>(row.limit_overrides),
        }
      : null,
    invitedEmails: jsonValue<string[]>(row.invited_emails) ?? [],
    suspendedAt: nullableDate(row.suspended_at),
    suspendedBy: row.suspended_by,
    suspendedReason: row.suspended_reason,
    suspendedBySubject: row.suspended_by_subject,
    generation: Number(row.generation),
    edgeSyncedGeneration: Number(row.edge_synced_generation),
    scanStatus: row.scan_status,
    scanFindings: row.scan_findings === null ? null : jsonValue<unknown[]>(row.scan_findings),
    scannedVersionId: row.scanned_version_id,
    scannedAt: nullableDate(row.scanned_at),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

type HostnameRow = {
  label: string;
  account_id: string;
  workspace_id: string;
  site_id: string;
  created_at: unknown;
  released_at: unknown;
};

function toHostname(row: HostnameRow): SiteHostnameRecord {
  return {
    label: row.label,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    siteId: row.site_id,
    createdAt: date(row.created_at),
    releasedAt: nullableDate(row.released_at),
  };
}

async function setHostnameLane(tx: Database, label: string): Promise<void> {
  await tx.execute(sql`select set_config('opengeni.site_hostname_label', ${label}, true)`);
}

/**
 * Serialize work on one hostname for the rest of the transaction: claims,
 * releases, platform holds and edge sync all take it.
 */
async function lockHostnameLabel(tx: Database, label: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`opengeni.site_hostname:${label}`}, 0))`,
  );
}

type HoldRow = {
  label: string;
  site_id: string;
  workspace_id: string;
  reason: string;
  held_by: string;
  kind: "platform" | "release";
  expires_at: unknown;
  created_at: unknown;
};

const HOLD_COLUMNS = sql`label, site_id, workspace_id, reason, held_by, kind, expires_at, created_at`;

function toHold(row: HoldRow): SiteHostnameHoldRecord {
  return {
    label: row.label,
    siteId: row.site_id,
    workspaceId: row.workspace_id,
    reason: row.reason,
    heldBy: row.held_by,
    kind: row.kind,
    expiresAt: nullableDate(row.expires_at),
    createdAt: date(row.created_at),
  };
}

/** Read the hostname row and platform hold of the label the lane names (lane already set). */
async function laneState(
  tx: Database,
  label: string,
): Promise<{ hostname: SiteHostnameRecord | null; hold: SiteHostnameHoldRecord | null }> {
  const [row] = await rawRows<HostnameRow>(
    tx,
    sql`select label, account_id, workspace_id, site_id, created_at, released_at
      from site_hostnames where label = ${label}`,
  );
  const [hold] = await rawRows<HoldRow>(
    tx,
    sql`select ${HOLD_COLUMNS} from site_hostname_holds where label = ${label}`,
  );
  return { hostname: row ? toHostname(row) : null, hold: hold ? toHold(hold) : null };
}

/**
 * Find a hostname row and its platform hold by label across every workspace
 * (the hostname lane). Only the named rows are visible; nothing else about
 * any workspace is.
 */
export async function findSiteHostnameState(
  db: Database,
  label: string,
): Promise<{ hostname: SiteHostnameRecord | null; hold: SiteHostnameHoldRecord | null }> {
  if (!LABEL.test(label)) return { hostname: null, hold: null };
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await setHostnameLane(tx, label);
    return await laneState(tx, label);
  });
}

/** Find a hostname row by label across every workspace (the hostname lane). */
export async function findSiteHostname(
  db: Database,
  label: string,
): Promise<SiteHostnameRecord | null> {
  return (await findSiteHostnameState(db, label)).hostname;
}

/**
 * Lift a hold by label (operator only, as the schema owner: the application
 * role cannot write holds, and the Site and workspace may be gone). Returns
 * whether a hold existed.
 */
export async function liftSiteHostnameHold(db: Database, label: string): Promise<boolean> {
  if (!LABEL.test(label)) return false;
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockHostnameLabel(tx, label);
    await setHostnameLane(tx, label);
    const rows = await rawRows<{ label: string }>(
      tx,
      sql`delete from site_hostname_holds where label = ${label} returning label`,
    );
    return rows.length > 0;
  });
}

/** Whether `label` may be claimed by `siteId` in this workspace. */
export type SiteHostnameClaimCheck =
  | { available: true }
  | { available: false; problem: "taken" | "held" | "reserved" };

function claimCheck(
  existing: SiteHostnameRecord | null,
  hold: SiteHostnameHoldRecord | null,
  scope: SitePublishingScope,
  siteId: string | null,
  holdDays: number,
  now: Date,
): SiteHostnameClaimCheck {
  // A platform hold reserves the label for good, except for the live row of
  // the Site that holds it (its own label, frozen while taken down).
  const ownLive =
    existing !== null &&
    existing.releasedAt === null &&
    existing.workspaceId === scope.workspaceId &&
    existing.siteId === siteId;
  if (hold?.kind === "platform" && !ownLive) return { available: false, problem: "reserved" };
  // A deleted Site's (or workspace's) label stays its workspace's until the
  // release hold ends, like a released row.
  if (
    hold?.kind === "release" &&
    hold.workspaceId !== scope.workspaceId &&
    (hold.expiresAt?.getTime() ?? 0) > now.getTime()
  )
    return { available: false, problem: "held" };
  if (!existing) return { available: true };
  if (existing.workspaceId === scope.workspaceId) {
    if (existing.releasedAt !== null) return { available: true };
    return existing.siteId === siteId
      ? { available: true }
      : { available: false, problem: "taken" };
  }
  if (existing.releasedAt === null) return { available: false, problem: "taken" };
  const holdMs = Math.max(holdDays, SITE_HOSTNAME_MIN_HOLD_DAYS) * 86_400_000;
  return existing.releasedAt.getTime() + holdMs > now.getTime()
    ? { available: false, problem: "held" }
    : { available: true };
}

/** Availability of a label for a Site (or any Site, when siteId is null) in this workspace. */
export async function checkSiteHostnameClaim(
  db: Database,
  scope: SitePublishingScope,
  label: string,
  siteId: string | null,
  holdDays: number,
  now: Date = new Date(),
): Promise<SiteHostnameClaimCheck> {
  const state = await findSiteHostnameState(db, label);
  return claimCheck(state.hostname, state.hold, scope, siteId, holdDays, now);
}

const PUBLICATION_COLUMNS = sql`site_id, account_id, workspace_id, label, access, status, noindex,
  agent_enabled, agent_model, agent_instructions, agent_tools, agent_guest_tools, limit_profile_kind,
  limit_overrides,
  invited_emails, suspended_at, suspended_by, suspended_reason, suspended_by_subject, generation,
  edge_synced_generation, scan_status, scan_findings, scanned_version_id, scanned_at, created_by,
  updated_by, created_at, updated_at`;

async function publicationRow(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  lock = false,
): Promise<SitePublicationRecord | null> {
  const [row] = await rawRows<PublicationRow>(
    tx,
    sql`select ${PUBLICATION_COLUMNS} from site_publications
      where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
      ${lock ? sql`for update` : sql``}`,
  );
  return row ? toPublication(row) : null;
}

export async function getSitePublication(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<SitePublicationRecord | null> {
  if (!UUID.test(siteId)) return null;
  return await withRlsContext(db, scope, (tx) => publicationRow(tx, scope, siteId));
}

/**
 * Whether an agent in `sessionId`'s session tree created the artifact: its
 * first version records a source session with the same root session as
 * `sessionId`. False when there is no such version or either session cannot
 * be read (artifacts created over HTTP record no source session).
 */
export async function artifactCreatedInSessionTree(
  db: Database,
  scope: SitePublishingScope,
  artifactId: string,
  sessionId: string,
): Promise<boolean> {
  if (!UUID.test(artifactId) || !UUID.test(sessionId)) return false;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ same_tree: boolean }>(
      tx,
      sql`select source.root_session_id = agent.root_session_id as same_tree
            from (select v.source_session_id
                    from workspace_artifact_versions v
                   where v.workspace_id = ${scope.workspaceId} and v.artifact_id = ${artifactId}
                   order by v.revision asc
                   limit 1) first_version
            join sessions source
              on source.workspace_id = ${scope.workspaceId} and source.id = first_version.source_session_id
            join sessions agent
              on agent.workspace_id = ${scope.workspaceId} and agent.id = ${sessionId}`,
    );
    return row?.same_tree === true;
  });
}

/** The Site itself (any audience); callers decide whether it may be published or served. */
export async function getPublishedSite(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<PublishedSiteRecord | null> {
  if (!UUID.test(siteId)) return null;
  return await withRlsContext(db, scope, (tx) => siteRow(tx, scope, siteId));
}

async function siteRow(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<PublishedSiteRecord | null> {
  {
    const [row] = await rawRows<{
      id: string;
      account_id: string;
      workspace_id: string;
      title: string;
      status: "active" | "archived";
      visibility: "workspace_shared" | "user_private";
      owner_subject_id: string | null;
      created_by_subject_id: string;
      current_version_id: string | null;
    }>(
      tx,
      sql`select id, account_id, workspace_id, title, status, visibility, owner_subject_id,
          created_by_subject_id, current_version_id
        from workspace_artifacts where workspace_id = ${scope.workspaceId} and id = ${siteId}`,
    );
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          title: row.title,
          status: row.status,
          visibility: row.visibility,
          ownerSubjectId: row.owner_subject_id,
          createdBySubjectId: row.created_by_subject_id,
          currentVersionId: row.current_version_id,
        }
      : null;
  }
}

/** A version of this Site (never another Site's), with its stored content key. */
export async function getPublishedSiteVersion(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
  versionId: string,
): Promise<{
  id: string;
  contentKey: string;
  contentSha256: string | null;
  sizeBytes: number;
  requestedTools: Array<{ serverId: string; toolName: string }>;
} | null> {
  if (!UUID.test(siteId) || !UUID.test(versionId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{
      id: string;
      content_key: string;
      content_sha256: string | null;
      size_bytes: string | number;
      requested_tools: unknown;
    }>(
      tx,
      sql`select id, content_key, content_sha256, size_bytes, requested_tools
        from workspace_artifact_versions
        where workspace_id = ${scope.workspaceId} and artifact_id = ${siteId} and id = ${versionId}`,
    );
    return row
      ? {
          id: row.id,
          contentKey: row.content_key,
          contentSha256: row.content_sha256,
          sizeBytes: Number(row.size_bytes),
          requestedTools: Array.isArray(row.requested_tools)
            ? (row.requested_tools as Array<{ serverId: string; toolName: string }>)
            : [],
        }
      : null;
  });
}

/**
 * A version a published Site may still serve: its current version, or one
 * that a publish or rollback replaced within `graceSeconds` (pages already
 * open keep loading their assets). Any other version, even of this Site, is
 * not served.
 */
export async function getServableSiteVersion(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; versionId: string; currentVersionId: string; graceSeconds: number },
): Promise<{
  id: string;
  contentKey: string;
  contentSha256: string | null;
  sizeBytes: number;
  requestedTools: Array<{ serverId: string; toolName: string }>;
} | null> {
  if (!UUID.test(input.siteId) || !UUID.test(input.versionId)) return null;
  if (input.versionId !== input.currentVersionId) {
    const replaced = await withRlsContext(db, scope, async (tx) =>
      rawRows<{ one: number }>(
        tx,
        sql`select 1 as one from workspace_artifact_events
          where workspace_id = ${scope.workspaceId} and artifact_id = ${input.siteId}
            and from_version_id = ${input.versionId}
            and type in ('published', 'rolled_back')
            and created_at > now() - make_interval(secs => ${Math.max(0, input.graceSeconds)})
          limit 1`,
      ),
    );
    if (replaced.length === 0) return null;
  }
  return await getPublishedSiteVersion(db, scope, input.siteId, input.versionId);
}

/** Claim `label` for `siteId` inside the caller's transaction; throws taken, held or reserved. */
async function claimLabel(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  label: string,
  holdDays: number,
): Promise<void> {
  if (!LABEL.test(label)) throw new SitePublishingError("validation", "Invalid hostname label");
  await lockHostnameLabel(tx, label);
  // The lane setting is transaction-local: on an error the transaction aborts
  // and takes it along, so it is cleared only on success.
  await setHostnameLane(tx, label);
  await claimInLane(tx, scope, siteId, label, holdDays);
  await setHostnameLane(tx, "");
}

async function claimInLane(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  label: string,
  holdDays: number,
): Promise<void> {
  {
    const [row] = await rawRows<HostnameRow & { now: unknown }>(
      tx,
      sql`select label, account_id, workspace_id, site_id, created_at, released_at, now() as now
        from site_hostnames where label = ${label}`,
    );
    const existing = row ? toHostname(row) : null;
    const now = row ? date(row.now) : new Date();
    const [hold] = await rawRows<HoldRow>(
      tx,
      sql`select ${HOLD_COLUMNS} from site_hostname_holds where label = ${label}`,
    );
    const check = claimCheck(existing, hold ? toHold(hold) : null, scope, siteId, holdDays, now);
    if (!check.available)
      throw new SitePublishingError(
        check.problem,
        check.problem === "held"
          ? "This name was released recently and is held for its previous owner"
          : check.problem === "reserved"
            ? "This name is reserved"
            : "This name is already taken",
      );
    if (existing && existing.workspaceId === scope.workspaceId) {
      if (existing.siteId === siteId && existing.releasedAt === null) return;
      // Our own released (held) row: move it to this Site.
      const moved = await rawRows<{ label: string }>(
        tx,
        sql`update site_hostnames set site_id = ${siteId}, released_at = null, created_at = now()
          where workspace_id = ${scope.workspaceId} and label = ${label} and released_at is not null
          returning label`,
      );
      if (moved.length !== 1) throw new SitePublishingError("taken", "This name is already taken");
      return;
    }
    if (existing) {
      // Another workspace's released row past its hold: the lane removes exactly it.
      await tx.execute(
        sql`delete from site_hostnames where label = ${label} and released_at is not null
          and released_at < now() - make_interval(days => ${Math.max(holdDays, SITE_HOSTNAME_MIN_HOLD_DAYS)})`,
      );
    }
    const inserted = await rawRows<{ label: string }>(
      tx,
      sql`insert into site_hostnames (label, account_id, workspace_id, site_id)
        values (${label}, ${scope.accountId}, ${scope.workspaceId}, ${siteId})
        on conflict (label) do nothing returning label`,
    );
    if (inserted.length !== 1) throw new SitePublishingError("taken", "This name is already taken");
  }
}

export type SitePublicationChanges = {
  label?: string;
  access?: SitePublicationAccess;
  status?: "active" | "unpublished";
  noindex?: boolean;
  agent?: Partial<SitePublicationRecord["agent"]>;
  /** undefined keeps the current profile; null inherits the workspace default. */
  limitProfile?: StoredSiteLimitProfile | null;
  invitedEmails?: string[];
};

export type UpsertSitePublicationResult = {
  publication: SitePublicationRecord;
  created: boolean;
  previousLabel: string | null;
};

/**
 * Create or change a Site's publication in one transaction: claim a new label
 * (globally unique, honouring the release hold), release the previous one,
 * and advance the generation. A suspended publication keeps its status; only
 * restore reactivates it.
 */
export async function upsertSitePublication(
  db: Database,
  scope: SitePublishingScope,
  input: {
    siteId: string;
    /** Used when the publication is new and no label is given. */
    defaultLabel: string;
    changes: SitePublicationChanges;
    actor: string;
    holdDays: number;
    /** Defaults for a new publication. */
    defaults: { access: SitePublicationAccess; noindex: boolean };
  },
): Promise<UpsertSitePublicationResult> {
  if (!UUID.test(input.siteId)) throw new SitePublishingError("not_found", "Site not found");
  return await withRlsContext(db, scope, async (tx) => {
    const existing = await publicationRow(tx, scope, input.siteId, true);
    const { changes } = input;
    if (existing?.status === "suspended" && changes.status !== undefined)
      throw new SitePublishingError(
        "forbidden",
        "This Site was taken down; restore it before publishing it again",
      );
    // A taken-down Site keeps its hostname: moving it would put the same Site
    // back online under a new name.
    if (
      existing?.status === "suspended" &&
      changes.label !== undefined &&
      changes.label !== existing.label
    )
      throw new SitePublishingError(
        "forbidden",
        "This Site was taken down; its hostname cannot change until it is restored",
      );
    const label = changes.label ?? existing?.label ?? input.defaultLabel;
    const previousLabel = existing && existing.label !== label ? existing.label : null;
    // Both hostnames, in one global order (no deadlocks between two moves).
    for (const name of [label, previousLabel].filter((n): n is string => n !== null).sort())
      if (LABEL.test(name)) await lockHostnameLabel(tx, name);
    // Release the previous label first: a Site holds one active label at a
    // time. A refused claim rolls the release back with everything else.
    if (previousLabel)
      await tx.execute(
        sql`update site_hostnames set released_at = now()
          where workspace_id = ${scope.workspaceId} and label = ${previousLabel}
            and site_id = ${input.siteId} and released_at is null`,
      );
    if (!existing || previousLabel)
      await claimLabel(tx, scope, input.siteId, label, input.holdDays);
    const agent = {
      ...(existing?.agent ?? defaultAgent()),
      ...stripUndefined(changes.agent ?? {}),
    };
    const limitProfile =
      changes.limitProfile === undefined ? (existing?.limitProfile ?? null) : changes.limitProfile;
    const invited = changes.invitedEmails ?? existing?.invitedEmails ?? [];
    const access = changes.access ?? existing?.access ?? input.defaults.access;
    const noindex = changes.noindex ?? existing?.noindex ?? input.defaults.noindex;
    const status =
      existing?.status === "suspended"
        ? "suspended"
        : (changes.status ?? existing?.status ?? "active");
    const toolsJson = agent.tools === null ? null : JSON.stringify(agent.tools);
    const overridesJson =
      limitProfile?.overrides === null || limitProfile?.overrides === undefined
        ? null
        : JSON.stringify(
            changes.limitProfile === undefined
              ? limitProfile.overrides
              : { ...limitProfile.overrides, __siteLimitsVersion: 2 },
          );
    const [row] = existing
      ? await rawRows<PublicationRow>(
          tx,
          sql`update site_publications set label = ${label}, access = ${access}, status = ${status},
              noindex = ${noindex}, agent_enabled = ${agent.enabled}, agent_model = ${agent.model},
              agent_instructions = ${agent.instructions}, agent_tools = ${toolsJson}::jsonb,
              agent_guest_tools = ${agent.guestTools},
              limit_profile_kind = ${storedSiteLimitKind(limitProfile?.kind ?? null)},
              limit_overrides = ${overridesJson}::jsonb,
              invited_emails = ${JSON.stringify(invited)}::jsonb,
              generation = nextval('site_host_generation_seq'), updated_by = ${input.actor},
              updated_at = now()
            where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            returning ${PUBLICATION_COLUMNS}`,
        )
      : await rawRows<PublicationRow>(
          tx,
          sql`insert into site_publications (site_id, account_id, workspace_id, label, access, status,
              noindex, agent_enabled, agent_model, agent_instructions, agent_tools, agent_guest_tools,
              limit_profile_kind, limit_overrides, invited_emails, created_by, updated_by)
            values (${input.siteId}, ${scope.accountId}, ${scope.workspaceId}, ${label}, ${access},
              ${status}, ${noindex}, ${agent.enabled}, ${agent.model}, ${agent.instructions},
              ${toolsJson}::jsonb, ${agent.guestTools}, ${storedSiteLimitKind(limitProfile?.kind ?? null)},
              ${overridesJson}::jsonb,
              ${JSON.stringify(invited)}::jsonb, ${input.actor}, ${input.actor})
            returning ${PUBLICATION_COLUMNS}`,
        );
    return { publication: toPublication(row!), created: !existing, previousLabel };
  });
}

function defaultAgent(): SitePublicationRecord["agent"] {
  return { enabled: true, model: null, instructions: null, tools: null, guestTools: false };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * Take a Site down at once. A platform takedown is never replaced by an
 * owner's or admin's, and also places a platform hold on the label: no
 * workspace may claim it while the hold lasts, even after the Site or its
 * workspace is deleted.
 */
export async function suspendSitePublication(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
  input: { by: SiteSuspendedBy; reason: string; subject: string },
): Promise<SitePublicationRecord> {
  if (!UUID.test(siteId)) throw new SitePublishingError("not_found", "Site not published");
  return await withRlsContext(db, scope, async (tx) => {
    const existing = await publicationRow(tx, scope, siteId, true);
    if (!existing) throw new SitePublishingError("not_found", "Site not published");
    if (
      existing.status === "suspended" &&
      (existing.suspendedBy === "platform" ||
        (existing.suspendedBy === "admin" && input.by === "owner")) &&
      input.by !== "platform"
    )
      return existing;
    const [row] = await rawRows<PublicationRow>(
      tx,
      sql`update site_publications set status = 'suspended', suspended_at = now(),
          suspended_by = ${input.by}, suspended_reason = ${input.reason.slice(0, 2000)},
          suspended_by_subject = ${input.subject},
          generation = nextval('site_host_generation_seq'),
          updated_by = ${input.subject}, updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        returning ${PUBLICATION_COLUMNS}`,
    );
    if (input.by === "platform") {
      await lockHostnameLabel(tx, existing.label);
      await setHostnameLane(tx, existing.label);
      await tx.execute(
        sql`insert into site_hostname_holds (label, site_id, workspace_id, reason, held_by, kind)
          values (${existing.label}, ${siteId}, ${scope.workspaceId},
            ${input.reason.trim().slice(0, 2000) || "Taken down"}, ${input.subject.slice(0, 300)},
            'platform')
          on conflict (label) do update set site_id = excluded.site_id,
            workspace_id = excluded.workspace_id, reason = excluded.reason,
            held_by = excluded.held_by, kind = 'platform', expires_at = null,
            created_at = now()`,
      );
      await setHostnameLane(tx, "");
    }
    return toPublication(row!);
  });
}

/**
 * Restore a taken-down Site. Only the platform restores a platform takedown
 * (and lifts its hostname hold); an owner cannot lift an admin's takedown.
 */
export async function restoreSitePublication(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
  input: { by: SiteSuspendedBy; subject: string },
): Promise<SitePublicationRecord> {
  if (!UUID.test(siteId)) throw new SitePublishingError("not_found", "Site not published");
  return await withRlsContext(db, scope, async (tx) => {
    const existing = await publicationRow(tx, scope, siteId, true);
    if (!existing) throw new SitePublishingError("not_found", "Site not published");
    if (existing.status !== "suspended")
      throw new SitePublishingError("conflict", "This Site is not taken down");
    if (existing.suspendedBy === "platform" && input.by !== "platform")
      throw new SitePublishingError(
        "forbidden",
        "This Site was taken down by the platform; contact support to restore it",
      );
    if (existing.suspendedBy === "admin" && input.by === "owner")
      throw new SitePublishingError(
        "forbidden",
        "A workspace admin took this Site down; only a workspace admin can restore it",
      );
    const [row] = await rawRows<PublicationRow>(
      tx,
      sql`update site_publications set status = 'active', suspended_at = null, suspended_by = null,
          suspended_reason = null, suspended_by_subject = null,
          generation = nextval('site_host_generation_seq'),
          updated_by = ${input.subject}, updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        returning ${PUBLICATION_COLUMNS}`,
    );
    if (input.by === "platform") {
      await lockHostnameLabel(tx, existing.label);
      await setHostnameLane(tx, existing.label);
      await tx.execute(sql`delete from site_hostname_holds where label = ${existing.label}`);
      await setHostnameLane(tx, "");
    }
    return toPublication(row!);
  });
}

/** Advance the generation (a new version became current, or the Site changed). */
export async function bumpSitePublicationGeneration(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<SitePublicationRecord | null> {
  if (!UUID.test(siteId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<PublicationRow>(
      tx,
      sql`update site_publications set generation = nextval('site_host_generation_seq'),
          updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        returning ${PUBLICATION_COLUMNS}`,
    );
    return row ? toPublication(row) : null;
  });
}

/** Record that the edge holds `generation` (never moves backwards). */
export async function markSitePublicationEdgeSynced(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
  generation: number,
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await tx.execute(
      sql`update site_publications
        set edge_synced_generation = greatest(edge_synced_generation, ${generation})
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}`,
    );
  });
}

/** What the edge should hold for one hostname, read under that hostname's lock. */
export type SiteHostnameEdgeState = {
  label: string;
  /** The hostname row (live or released), or null when no row exists. */
  hostname: SiteHostnameRecord | null;
  hold: SiteHostnameHoldRecord | null;
  /** The live Site that owns this label, with its publication. */
  live: { publication: SitePublicationRecord; site: PublishedSiteRecord } | null;
  /** A fresh generation for a tombstone when no Site is live on the label. */
  tombstoneGeneration: number | null;
};

/**
 * Read the edge state of one hostname under that hostname's advisory lock,
 * allocate a fresh tombstone generation when no Site is live on it, and
 * commit. The caller writes the edge after this returns, outside any
 * transaction: the lock orders the reads (and generations) against claims,
 * releases and takedowns, and the edge writer never replaces a newer
 * generation. The live Site is read in the workspace that owns the label,
 * wherever it moved.
 */
export async function readSiteHostnameEdgeState(
  db: Database,
  label: string,
): Promise<SiteHostnameEdgeState> {
  if (!LABEL.test(label)) throw new SitePublishingError("validation", "Invalid hostname label");
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockHostnameLabel(tx, label);
    await setHostnameLane(tx, label);
    const { hostname, hold } = await laneState(tx, label);
    await setHostnameLane(tx, "");
    let live: SiteHostnameEdgeState["live"] = null;
    if (hostname && hostname.releasedAt === null) {
      const scope = { accountId: hostname.accountId, workspaceId: hostname.workspaceId };
      live = await withRlsContext(
        tx,
        scope,
        async (scoped) => {
          const publication = await publicationRow(scoped, scope, hostname.siteId);
          const site = await siteRow(scoped, scope, hostname.siteId);
          return publication && site && publication.label === label ? { publication, site } : null;
        },
        undefined,
        "none",
      );
    }
    let tombstoneGeneration: number | null = null;
    if (!live) {
      const [next] = await rawRows<{ generation: string | number }>(
        tx,
        sql`select nextval('site_host_generation_seq') as generation`,
      );
      tombstoneGeneration = Number(next!.generation);
    }
    return { label, hostname, hold, live, tombstoneGeneration };
  });
}

/**
 * Cheap re-read after an edge write: the generation of the Site live on the
 * label now (null when none is), with no lock and no new generation. The
 * writer compares it with what it wrote and syncs again when it moved.
 */
export async function readSiteHostnameLiveGeneration(
  db: Database,
  label: string,
): Promise<{ siteId: string; generation: number } | null> {
  if (!LABEL.test(label)) return null;
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await setHostnameLane(tx, label);
    const { hostname } = await laneState(tx, label);
    await setHostnameLane(tx, "");
    if (!hostname || hostname.releasedAt !== null) return null;
    const scope = { accountId: hostname.accountId, workspaceId: hostname.workspaceId };
    return await withRlsContext(
      tx,
      scope,
      async (scoped) => {
        const [row] = await rawRows<{ generation: string | number; label: string }>(
          scoped,
          sql`select generation, label from site_publications
            where workspace_id = ${scope.workspaceId} and site_id = ${hostname.siteId}`,
        );
        return row && row.label === label
          ? { siteId: hostname.siteId, generation: Number(row.generation) }
          : null;
      },
      undefined,
      "none",
    );
  }, READ_ONLY);
}

export async function recordSitePublicationScan(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
  input: {
    versionId: string;
    status: "none" | "clean" | "flagged" | "error";
    findings: unknown[];
  },
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await tx.execute(
      sql`update site_publications set scan_status = ${input.status},
          scan_findings = ${JSON.stringify(input.findings.slice(0, 100))}::jsonb,
          scanned_version_id = ${input.versionId}, scanned_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}`,
    );
  });
}

// --- viewer sign-in ------------------------------------------------------------

export type SiteViewerIdentity = {
  subjectId: string;
  kind: SiteViewerKindValue;
  email: string | null;
  displayName: string | null;
};

export async function createSiteAuthCode(
  db: Database,
  scope: SitePublishingScope,
  input: SiteViewerIdentity & {
    siteId: string;
    codeHash: string;
    hostname: string;
    codeChallenge: string;
    redirectUri: string;
    ttlSeconds: number;
  },
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    // Codes live seconds; old ones of this Site go as new ones arrive.
    await tx.execute(
      sql`delete from site_auth_codes where workspace_id = ${scope.workspaceId}
        and site_id = ${input.siteId} and expires_at < now() - interval '10 minutes'`,
    );
    await tx.execute(
      sql`insert into site_auth_codes (account_id, workspace_id, site_id, code_hash, hostname,
          code_challenge, redirect_uri, subject_id, viewer_kind, email, display_name, expires_at)
        values (${scope.accountId}, ${scope.workspaceId}, ${input.siteId}, ${input.codeHash},
          ${input.hostname}, ${input.codeChallenge}, ${input.redirectUri}, ${input.subjectId},
          ${input.kind}, ${input.email}, ${input.displayName},
          now() + make_interval(secs => ${input.ttlSeconds}))`,
    );
  });
}

/**
 * Consume a sign-in code exactly once. Returns the code's binding when it was
 * unused, unexpired and minted for this Site and host; null otherwise. A code
 * presented once is spent whatever the caller does next.
 */
export async function consumeSiteAuthCode(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; codeHash: string; hostname: string },
): Promise<(SiteViewerIdentity & { codeChallenge: string; redirectUri: string }) | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{
      subject_id: string;
      viewer_kind: SiteViewerKindValue;
      email: string | null;
      display_name: string | null;
      code_challenge: string;
      redirect_uri: string;
      hostname: string;
      site_id: string;
      fresh: boolean;
    }>(
      tx,
      sql`update site_auth_codes set consumed_at = now()
        where workspace_id = ${scope.workspaceId} and code_hash = ${input.codeHash}
          and consumed_at is null
        returning subject_id, viewer_kind, email, display_name, code_challenge, redirect_uri,
          hostname, site_id, (expires_at > now()) as fresh`,
    );
    if (!row || !row.fresh || row.site_id !== input.siteId || row.hostname !== input.hostname)
      return null;
    return {
      subjectId: row.subject_id,
      kind: row.viewer_kind,
      email: row.email,
      displayName: row.display_name,
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
    };
  });
}

export type SiteViewerSessionRecord = SiteViewerIdentity & {
  id: string;
  siteId: string;
  expiresAt: Date;
  /** The role the owner previews the Site as ("View as visitor"); null when not previewing. */
  viewAs?: SiteViewAsValue | null;
};

export type SiteViewAsValue = "invited" | "public";

export async function createSiteViewerSession(
  db: Database,
  scope: SitePublishingScope,
  input: SiteViewerIdentity & { siteId: string; tokenHash: string; absoluteSeconds: number },
): Promise<SiteViewerSessionRecord> {
  return await withRlsContext(db, scope, async (tx) => {
    // Bounded cleanup on the write path: this Site's expired or long-revoked sessions.
    await tx.execute(
      sql`delete from site_viewer_sessions where ctid = any(array(
          select ctid from site_viewer_sessions
          where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            and (expires_at < now() or revoked_at < now() - interval '1 day')
          limit 100))`,
    );
    const [row] = await rawRows<{ id: string; expires_at: unknown }>(
      tx,
      sql`insert into site_viewer_sessions (account_id, workspace_id, site_id, token_hash, subject_id,
          viewer_kind, email, display_name, expires_at)
        values (${scope.accountId}, ${scope.workspaceId}, ${input.siteId}, ${input.tokenHash},
          ${input.subjectId}, ${input.kind}, ${input.email}, ${input.displayName},
          now() + make_interval(secs => ${input.absoluteSeconds}))
        returning id, expires_at`,
    );
    return {
      id: row!.id,
      siteId: input.siteId,
      subjectId: input.subjectId,
      kind: input.kind,
      email: input.email,
      displayName: input.displayName,
      expiresAt: date(row!.expires_at),
    };
  });
}

/**
 * A live site-session of this Site by token hash: not revoked, before its
 * absolute expiry and used within the idle window. Marks it used at most once
 * a minute, so steady traffic costs no writes.
 */
export async function findSiteViewerSession(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; tokenHash: string; idleSeconds: number },
): Promise<SiteViewerSessionRecord | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{
      id: string;
      site_id: string;
      subject_id: string;
      viewer_kind: SiteViewerKindValue;
      email: string | null;
      display_name: string | null;
      expires_at: unknown;
      view_as: SiteViewAsValue | null;
      stale: boolean;
    }>(
      tx,
      sql`select id, site_id, subject_id, viewer_kind, email, display_name, expires_at, view_as,
          last_used_at < now() - interval '1 minute' as stale
        from site_viewer_sessions
        where workspace_id = ${scope.workspaceId} and token_hash = ${input.tokenHash}
          and site_id = ${input.siteId} and revoked_at is null and expires_at > now()
          and last_used_at > now() - make_interval(secs => ${input.idleSeconds})`,
    );
    if (!row) return null;
    if (row.stale)
      await tx.execute(
        sql`update site_viewer_sessions set last_used_at = now()
          where workspace_id = ${scope.workspaceId} and id = ${row.id}`,
      );
    return {
      id: row.id,
      siteId: row.site_id,
      subjectId: row.subject_id,
      kind: row.viewer_kind,
      email: row.email,
      displayName: row.display_name,
      expiresAt: date(row.expires_at),
      viewAs: row.view_as ?? null,
    };
  });
}

/**
 * Start (`invited`, `public`) or end (null) previewing a Site as another
 * role on one live viewer session. The API applies it only while the
 * session's person is a workspace member, and only to see less.
 */
export async function setSiteViewerSessionViewAs(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; sessionId: string; viewAs: SiteViewAsValue | null },
): Promise<boolean> {
  if (!UUID.test(input.siteId) || !UUID.test(input.sessionId)) return false;
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`update site_viewer_sessions set view_as = ${input.viewAs}
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
          and id = ${input.sessionId} and revoked_at is null
        returning id`,
    );
    return rows.length > 0;
  });
}

export async function revokeSiteViewerSession(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; tokenHash: string },
): Promise<boolean> {
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`update site_viewer_sessions set revoked_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
          and token_hash = ${input.tokenHash} and revoked_at is null
        returning id`,
    );
    return rows.length > 0;
  });
}

/** Revoke every live site-session of a Site (takedown, unpublish, narrower access). */
export async function revokeSiteViewerSessions(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<number> {
  if (!UUID.test(siteId)) return 0;
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`update site_viewer_sessions set revoked_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
          and revoked_at is null and expires_at > now()
        returning id`,
    );
    return rows.length;
  });
}

/** Whether the subject holds a membership in this workspace (re-checked on every runtime call). */
export async function isSiteWorkspaceMember(
  db: Database,
  scope: SitePublishingScope,
  subjectId: string,
): Promise<boolean> {
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ one: number }>(
      tx,
      sql`select 1 as one from workspace_memberships
        where workspace_id = ${scope.workspaceId} and subject_id = ${subjectId} limit 1`,
    );
    return rows.length > 0;
  });
}

/**
 * The subject's workspace permissions (normalized), or null when they hold
 * no membership. A Site conversation of a member gets only the Site's tools
 * that member may use themselves.
 */
export async function getSiteWorkspaceMemberPermissions(
  db: Database,
  scope: SitePublishingScope,
  subjectId: string,
): Promise<Permission[] | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ permissions: unknown }>(
      tx,
      sql`select permissions from workspace_memberships
        where workspace_id = ${scope.workspaceId} and subject_id = ${subjectId} limit 1`,
    );
    return row
      ? normalizeWorkspaceMembershipPermissions(jsonValue<unknown>(row.permissions))
      : null;
  });
}

// --- limit profiles --------------------------------------------------------------

/** Keep the on-disk spelling readable by the previous release during rollout. */
function storedSiteLimitKind(kind: SiteLimitProfileKindValue | null) {
  return kind === "standard" ? "free" : kind;
}

export async function getWorkspaceSiteLimitProfile(
  db: Database,
  scope: SitePublishingScope,
): Promise<StoredSiteLimitProfile | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ kind: SiteLimitProfileKindValue; overrides: unknown }>(
      tx,
      sql`select kind, overrides from site_limit_profiles where workspace_id = ${scope.workspaceId}`,
    );
    return row
      ? {
          kind: row.kind,
          overrides:
            row.overrides === null ? null : jsonValue<Record<string, unknown>>(row.overrides),
        }
      : null;
  });
}

export async function putWorkspaceSiteLimitProfile(
  db: Database,
  scope: SitePublishingScope,
  profile: StoredSiteLimitProfile,
  actor: string,
): Promise<StoredSiteLimitProfile> {
  await withRlsContext(db, scope, async (tx) => {
    const overrides =
      profile.overrides === null
        ? null
        : JSON.stringify({ ...profile.overrides, __siteLimitsVersion: 2 });
    await tx.execute(
      sql`insert into site_limit_profiles (workspace_id, account_id, kind, overrides, updated_by)
        values (${scope.workspaceId}, ${scope.accountId}, ${storedSiteLimitKind(profile.kind)}, ${overrides}::jsonb, ${actor})
        on conflict (workspace_id) do update set kind = excluded.kind,
          overrides = excluded.overrides, updated_by = excluded.updated_by, updated_at = now()`,
    );
  });
  return profile;
}

// --- conversations and budgets ---------------------------------------------------

/** Verified identity retained at start; legacy conversations use a matching signed-in Site session. */
export async function siteRuntimeConversationViewerEmail(
  db: Database,
  scope: SitePublishingScope,
  sessionId: string,
): Promise<string | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ email: string | null }>(
      tx,
      sql`
      select coalesce(c.viewer_email, (
        select v.email from site_viewer_sessions v
        where v.workspace_id = c.workspace_id and v.site_id = c.site_id
          and 'user:' || v.subject_id = c.viewer_principal
        order by v.created_at desc limit 1
      )) as email from site_runtime_conversations c
      where c.workspace_id = ${scope.workspaceId} and c.session_id = ${sessionId}`,
    );
    return row?.email ?? null;
  });
}

/** Who started a Site conversation, as the Site saw them then. */
export type SiteRuntimeConversationViewerKind = "member" | "invited" | "user" | "guest";

export type SiteRuntimeConversationRecord = {
  sessionId: string;
  siteId: string;
  viewerPrincipal: string;
  viewerKind: SiteRuntimeConversationViewerKind;
  /** The workspace tools (MCP connection ids) the conversation was started with. */
  toolIds: string[];
  /**
   * The Site-wide usage windows it counts in: `*` for viewers outside the
   * workspace (the Site's budgets), `*members` for workspace members.
   */
  budgetKey: string;
  versionId: string | null;
  turns: number;
  meteredMicros: number;
  /** The conversation's total spend cap; execution receives only funded increments. */
  limitMicros: number | null;
  reservedMicros: number;
  /** Work admitted so far (start, messages, steering, resumes). */
  admissions: number;
  createdAt: Date;
  /** Last admitted work or counted spend. */
  updatedAt: Date;
};

type ConversationRow = {
  session_id: string;
  site_id: string;
  viewer_principal: string;
  viewer_kind: string;
  tool_ids: unknown;
  budget_key: string | null;
  version_id: string | null;
  turns: number;
  metered_micros: string | number;
  limit_micros: string | number | null;
  reserved_micros: string | number;
  reserved_day: unknown;
  reserved_month: unknown;
  reservation_windows_complete: boolean;
  pending_admission_id: string | null;
  pending_admission_until: unknown;
  admissions: string | number;
  created_at: unknown;
  updated_at: unknown;
};

const CONVERSATION_COLUMNS = sql`session_id, site_id, viewer_principal, viewer_kind, tool_ids,
  budget_key, version_id, turns,
  metered_micros, limit_micros, reserved_micros, reserved_day::text as reserved_day,
  reserved_month::text as reserved_month, reservation_windows_complete,
  pending_admission_id, pending_admission_until, admissions, created_at, updated_at`;

/** A timeout is only permission to reconcile, never proof that enqueue failed. */
const SITE_ADMISSION_RECOVERY_MS = 10 * 60 * 1000;

/** Caller holds the conversation lock, before the canonical session lock. */
async function conversationCanRelease(
  tx: Database,
  scope: SitePublishingScope,
  row: ConversationRow,
  now: Date,
): Promise<boolean> {
  if (row.pending_admission_id !== null) {
    if (new Date(String(row.pending_admission_until)).getTime() > now.getTime()) return false;
    // Revocation and queue reconciliation are atomic with release. A dispatch
    // that has not committed must acquire this row and will reject the old token.
    await tx.execute(sql`update site_runtime_conversations
      set pending_admission_id = null, pending_admission_until = null
      where workspace_id = ${scope.workspaceId} and session_id = ${row.session_id}`);
  }
  const locks = await lockSessionEventWriteRows(tx, {
    workspaceId: scope.workspaceId,
    sessionIds: [row.session_id],
    controlLock: "none",
  });
  return (
    locks.sessions.length === 0 ||
    (await sessionQueueIsEmptyInTransaction(tx, scope.workspaceId, row.session_id))
  );
}

/** A returned dispatch has finished; exceptions retain the pending marker for reconciliation. */
export async function finishSiteRuntimeAdmission(
  db: Database,
  scope: SitePublishingScope,
  input: { sessionId: string; admissionId: string },
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await tx.execute(sql`update site_runtime_conversations
      set pending_admission_id = null, pending_admission_until = null
      where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
        and pending_admission_id = ${input.admissionId}::uuid`);
  });
}

/** Previous-release writers reserved all windows except viewer-month. */
function conversationReservedInWindow(
  row: ConversationRow,
  window: { principal: string; period: "day" | "month" },
): boolean {
  return (
    row.reservation_windows_complete ||
    window.principal !== row.viewer_principal ||
    window.period === "day"
  );
}

function toConversation(row: ConversationRow): SiteRuntimeConversationRecord {
  return {
    sessionId: row.session_id,
    siteId: row.site_id,
    viewerPrincipal: row.viewer_principal,
    viewerKind: row.viewer_kind as SiteRuntimeConversationViewerKind,
    toolIds: jsonValue<string[] | null>(row.tool_ids) ?? [],
    budgetKey: row.budget_key ?? SITE_RUNTIME_SITE_PRINCIPAL,
    versionId: row.version_id,
    turns: Number(row.turns),
    meteredMicros: Number(row.metered_micros),
    limitMicros: row.limit_micros === null ? null : Number(row.limit_micros),
    reservedMicros: Number(row.reserved_micros),
    admissions: Number(row.admissions),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

/** The conversation when it belongs to this Site and viewer; null otherwise. */
export async function getOwnedSiteRuntimeConversation(
  db: Database,
  scope: SitePublishingScope,
  input: { sessionId: string; siteId: string; viewerPrincipal: string },
): Promise<SiteRuntimeConversationRecord | null> {
  if (!UUID.test(input.sessionId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<ConversationRow>(
      tx,
      sql`select ${CONVERSATION_COLUMNS} from site_runtime_conversations
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
          and site_id = ${input.siteId} and viewer_principal = ${input.viewerPrincipal}`,
    );
    return row ? toConversation(row) : null;
  });
}

/**
 * Whether an agent session belongs to a published Site's agent, and which
 * conversation (Site and viewer) it serves. A session tree whose root was
 * started by a Site's service principal (`site:<siteId>`) is a Site agent;
 * its conversation row names the viewer. `siteAgent` without a conversation
 * (a row that is gone or never written) must fail closed. A session that
 * cannot be read is reported as a Site agent without a conversation too.
 */
export async function findSiteRuntimeAgentConversation(
  db: Database,
  scope: SitePublishingScope,
  sessionId: string,
): Promise<{ siteAgent: boolean; conversation: SiteRuntimeConversationRecord | null }> {
  if (!UUID.test(sessionId)) return { siteAgent: true, conversation: null };
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<
      { root_creator: string | null; root_id: string | null } & Partial<ConversationRow>
    >(
      tx,
      sql`select r.created_by_subject_id as root_creator, r.id as root_id,
            c.session_id, c.site_id, c.viewer_principal, c.viewer_kind, c.tool_ids,
            c.budget_key, c.version_id, c.turns, c.metered_micros, c.limit_micros,
            c.reserved_micros, c.reserved_day::text as reserved_day,
            c.reserved_month::text as reserved_month, c.admissions, c.created_at, c.updated_at
          from sessions s
          left join sessions r on r.workspace_id = s.workspace_id
            and r.id = coalesce(s.root_session_id, s.id)
          left join site_runtime_conversations c on c.workspace_id = s.workspace_id
            and c.session_id = r.id
          where s.workspace_id = ${scope.workspaceId} and s.id = ${sessionId}`,
    );
    if (!row || !row.root_id) return { siteAgent: true, conversation: null };
    const conversation = row.session_id ? toConversation(row as ConversationRow) : null;
    const siteAgent = conversation !== null || (row.root_creator ?? "").startsWith("site:");
    return { siteAgent, conversation };
  });
}

export async function listOwnedSiteRuntimeConversations(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; viewerPrincipal: string; limit: number },
): Promise<SiteRuntimeConversationRecord[]> {
  return await withRlsContext(db, scope, async (tx) =>
    (
      await rawRows<ConversationRow>(
        tx,
        sql`select ${CONVERSATION_COLUMNS} from site_runtime_conversations
          where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            and viewer_principal = ${input.viewerPrincipal}
          order by created_at desc limit ${Math.max(1, Math.min(input.limit, 100))}`,
      )
    ).map(toConversation),
  );
}

/** Statuses of a session with no turn running or queued. */
const IDLE_SESSION_STATUSES = ["idle", "failed", "cancelled"];
/** Age triggers reconciliation; the canonical queue still decides whether funding can be released. */
export const SITE_RUNTIME_RESERVATION_MAX_IDLE_HOURS = 6;
/** A sweep revisits a conversation at most this often. */
const SWEEP_REVISIT_SECONDS = 30;
/** A start whose session has not appeared after this long failed before its create committed. */
export const SITE_RUNTIME_ABANDONED_START_MINUTES = 10;

export type SiteRuntimeSweepCandidate = SiteRuntimeConversationRecord & {
  /** No admitted work or counted spend for `SITE_RUNTIME_RESERVATION_MAX_IDLE_HOURS`. */
  aged: boolean;
};

/**
 * Claim up to `limit` of the Site's conversations whose reservation can
 * likely be released, and mark them visited: those whose session is idle,
 * failed or cancelled, starts whose session never appeared, and
 * reservations inactive for `SITE_RUNTIME_RESERVATION_MAX_IDLE_HOURS`.
 * Least recently visited first, each at most every 30 seconds, so repeated
 * sweeps move through the Site instead of revisiting the same rows.
 * Running conversations are not candidates: settling them would only move
 * reserved spend into counted spend, freeing nothing.
 */
export async function claimSiteRuntimeReservationSweep(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; limit: number; now?: Date },
): Promise<SiteRuntimeSweepCandidate[]> {
  if (!UUID.test(input.siteId)) return [];
  const now = (input.now ?? new Date()).toISOString();
  return await withRlsContext(db, scope, async (tx) =>
    (
      await rawRows<ConversationRow & { aged: boolean }>(
        tx,
        sql`with picked as (
            select c.session_id as picked_id from site_runtime_conversations c
            left join sessions s on s.workspace_id = c.workspace_id and s.id = c.session_id
            where c.workspace_id = ${scope.workspaceId} and c.site_id = ${input.siteId}
              and c.reserved_micros > 0
              and (c.swept_at is null
                or c.swept_at < ${now}::timestamptz - make_interval(secs => ${SWEEP_REVISIT_SECONDS}))
              and (s.status in (${sql.join(
                IDLE_SESSION_STATUSES.map((status) => sql`${status}`),
                sql`, `,
              )})
                or (s.id is null and c.created_at < ${now}::timestamptz
                  - make_interval(mins => ${SITE_RUNTIME_ABANDONED_START_MINUTES}))
                or c.pending_admission_until <= ${now}::timestamptz
                or c.updated_at < ${now}::timestamptz
                  - make_interval(hours => ${SITE_RUNTIME_RESERVATION_MAX_IDLE_HOURS}))
            order by c.swept_at asc nulls first, c.updated_at asc
            limit ${Math.max(1, Math.min(input.limit, 100))}
            for update of c skip locked
          )
          update site_runtime_conversations c set swept_at = ${now}::timestamptz
          from picked
          where c.workspace_id = ${scope.workspaceId} and c.session_id = picked.picked_id
          returning ${CONVERSATION_COLUMNS}, c.updated_at < ${now}::timestamptz
            - make_interval(hours => ${SITE_RUNTIME_RESERVATION_MAX_IDLE_HOURS}) as aged`,
      )
    ).map((row) => ({ ...toConversation(row), aged: row.aged === true })),
  );
}
/** Statuses of a session that may still run or queue agent work. */
const ACTIVE_SESSION_STATUSES = [
  "queued",
  "running",
  "requires_action",
  "recovering",
  "waiting_capacity",
];

/**
 * The Site's conversations whose session may still be working, among those
 * active in the last two days (bounded: at most `limit`, newest first).
 */
export async function listActiveSiteRuntimeConversations(
  db: Database,
  scope: SitePublishingScope,
  input: {
    siteId: string;
    limit: number;
    /**
     * Only conversations holding workspace tools the Site no longer gives
     * them: a tool outside `tools`, or any tool for a viewer outside the
     * workspace once `everyoneTools` is off.
     */
    toolsNarrowedTo?: { tools: readonly string[]; everyoneTools: boolean };
  },
): Promise<string[]> {
  if (!UUID.test(input.siteId)) return [];
  const narrowed = input.toolsNarrowedTo;
  const toolFilter = narrowed
    ? sql`and (not (c.tool_ids <@ ${JSON.stringify(narrowed.tools)}::jsonb)
        or (${!narrowed.everyoneTools} and jsonb_array_length(c.tool_ids) > 0
          and c.viewer_kind in ('user', 'guest')))`
    : sql``;
  return await withRlsContext(db, scope, async (tx) =>
    (
      await rawRows<{ session_id: string }>(
        tx,
        sql`select c.session_id from site_runtime_conversations c
          join sessions s on s.workspace_id = c.workspace_id and s.id = c.session_id
          where c.workspace_id = ${scope.workspaceId} and c.site_id = ${input.siteId}
            and c.updated_at > now() - interval '2 days' ${toolFilter}
            and s.status in (${sql.join(
              ACTIVE_SESSION_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )})
          order by c.updated_at desc limit ${Math.max(1, Math.min(input.limit, 500))}`,
      )
    ).map((row) => row.session_id),
  );
}

export type SiteRuntimeUsageSnapshot = {
  visitorDay: { conversations: number; agentMicros: number; reservedMicros: number };
  visitorMonth: { conversations: number; agentMicros: number; reservedMicros: number };
  siteDay: { conversations: number; agentMicros: number; reservedMicros: number };
  siteMonth: { conversations: number; agentMicros: number; reservedMicros: number };
};

/** The Site-wide principal key in usage windows. */
export const SITE_RUNTIME_SITE_PRINCIPAL = "*";
/** The Site-wide key of workspace members' conversations (apart from the Site's budgets). */
export const SITE_RUNTIME_MEMBERS_PRINCIPAL = "*members";

function periodStarts(now: Date): { day: string; month: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), month: `${iso.slice(0, 7)}-01` };
}

/** Current-period counters for a viewer and the Site, from three primary-key rows. */
export async function readSiteRuntimeUsage(
  db: Database,
  scope: SitePublishingScope,
  input: {
    siteId: string;
    viewerPrincipal: string;
    /** The Site-wide key to read (default `*`, the Site's budgets). */
    sitePrincipal?: string;
    now?: Date;
  },
): Promise<SiteRuntimeUsageSnapshot> {
  const periods = periodStarts(input.now ?? new Date());
  const sitePrincipal = input.sitePrincipal ?? SITE_RUNTIME_SITE_PRINCIPAL;
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<UsageRow & { principal_key: string; period: "day" | "month" }>(
      tx,
      sql`select principal_key, period, period_start::text as period_start, conversations,
          agent_micros, reserved_micros
        from site_runtime_usage
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
          and principal_key in (${input.viewerPrincipal}, ${sitePrincipal})`,
    );
    const pick = (principal: string, period: "day" | "month") => {
      const row = rows.find(
        (candidate) =>
          candidate.principal_key === principal &&
          candidate.period === period &&
          String(candidate.period_start).slice(0, 10) === periods[period],
      );
      return {
        conversations: row ? Number(row.conversations) : 0,
        agentMicros: row ? Number(row.agent_micros) : 0,
        reservedMicros: row ? Number(row.reserved_micros) : 0,
      };
    };
    return {
      visitorDay: pick(input.viewerPrincipal, "day"),
      visitorMonth: pick(input.viewerPrincipal, "month"),
      siteDay: pick(sitePrincipal, "day"),
      siteMonth: pick(sitePrincipal, "month"),
    };
  });
}

type UsageRow = {
  period_start: unknown;
  conversations: number;
  agent_micros: string | number;
  reserved_micros: string | number;
};

type UsageWindow = {
  principal: string;
  period: "day" | "month";
  periodStart: string;
  conversations: number;
  agentMicros: number;
  reservedMicros: number;
};

/**
 * Lock one usage window row for this transaction, creating it or rolling it
 * to the current period first (a new period starts from zero, reservations
 * included). Locks are always taken visitor-day, visitor-month, Site-day,
 * Site-month (lockConversationWindows).
 */
async function lockUsageWindow(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  principal: string,
  period: "day" | "month",
  periodStart: string,
): Promise<UsageWindow> {
  const [row] = await rawRows<UsageRow>(
    tx,
    sql`insert into site_runtime_usage (account_id, workspace_id, site_id, principal_key, period,
        period_start, conversations, agent_micros, reserved_micros)
      values (${scope.accountId}, ${scope.workspaceId}, ${siteId}, ${principal}, ${period},
        ${periodStart}::date, 0, 0, 0)
      on conflict (workspace_id, site_id, principal_key, period) do update set
        conversations = case when site_runtime_usage.period_start < excluded.period_start
          then 0 else site_runtime_usage.conversations end,
        agent_micros = case when site_runtime_usage.period_start < excluded.period_start
          then 0 else site_runtime_usage.agent_micros end,
        reserved_micros = case when site_runtime_usage.period_start < excluded.period_start
          then 0 else site_runtime_usage.reserved_micros end,
        period_start = greatest(site_runtime_usage.period_start, excluded.period_start),
        updated_at = now()
      returning period_start::text as period_start, conversations, agent_micros, reserved_micros`,
  );
  return {
    principal,
    period,
    periodStart: String(row!.period_start).slice(0, 10),
    conversations: Number(row!.conversations),
    agentMicros: Number(row!.agent_micros),
    reservedMicros: Number(row!.reserved_micros),
  };
}

/** Add to a locked window's counters (only while it is still in `periodStart`). */
async function adjustUsageWindow(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  window: { principal: string; period: "day" | "month"; periodStart: string },
  change: { conversations?: number; agentMicros?: number; reservedMicros?: number },
): Promise<void> {
  const conversations = Math.trunc(change.conversations ?? 0);
  const micros = Math.trunc(change.agentMicros ?? 0);
  const reserved = Math.trunc(change.reservedMicros ?? 0);
  if (conversations === 0 && micros === 0 && reserved === 0) return;
  await tx.execute(
    sql`update site_runtime_usage set
        conversations = greatest(0, conversations + ${conversations}),
        agent_micros = greatest(0, agent_micros + ${micros}),
        reserved_micros = greatest(0, reserved_micros + ${reserved}),
        updated_at = now()
      where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        and principal_key = ${window.principal} and period = ${window.period}
        and period_start = ${window.periodStart}::date`,
  );
}

type ConversationWindows = {
  visitorDay: UsageWindow;
  visitorMonth: UsageWindow;
  siteDay: UsageWindow;
  siteMonth: UsageWindow;
};

/** Lock a conversation's four usage windows in the one fixed order. */
async function lockConversationWindows(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  viewerPrincipal: string,
  budgetKey: string,
  periods: { day: string; month: string },
): Promise<ConversationWindows> {
  const visitorDay = await lockUsageWindow(tx, scope, siteId, viewerPrincipal, "day", periods.day);
  const visitorMonth = await lockUsageWindow(
    tx,
    scope,
    siteId,
    viewerPrincipal,
    "month",
    periods.month,
  );
  const siteDay = await lockUsageWindow(tx, scope, siteId, budgetKey, "day", periods.day);
  const siteMonth = await lockUsageWindow(tx, scope, siteId, budgetKey, "month", periods.month);
  return { visitorDay, visitorMonth, siteDay, siteMonth };
}

/** The spend budgets with the window each one is counted in, in check order. */
function spendBudgets(
  limits: SiteRuntimeBudgetLimits,
  windows: ConversationWindows,
): Array<{ budget: SiteRuntimeBudget; limit: number | null; window: UsageWindow }> {
  return [
    {
      budget: "agent_micros_per_visitor_per_day",
      limit: limits.agentMicrosPerVisitorPerDay,
      window: windows.visitorDay,
    },
    {
      budget: "agent_micros_per_visitor_per_month",
      limit: limits.agentMicrosPerVisitorPerMonth ?? null,
      window: windows.visitorMonth,
    },
    {
      budget: "agent_micros_per_site_per_day",
      limit: limits.agentMicrosPerSitePerDay ?? null,
      window: windows.siteDay,
    },
    {
      budget: "agent_micros_per_site_per_month",
      limit: limits.agentMicrosPerSitePerMonth,
      window: windows.siteMonth,
    },
  ];
}

/** The budgets a reservation is checked against (the Site's effective limits). */
export type SiteRuntimeBudgetLimits = {
  conversationsPerVisitorPerDay: number | null;
  conversationsPerSitePerDay: number | null;
  turnsPerConversation: number | null;
  agentMicrosPerConversation: number | null;
  agentMicrosPerVisitorPerDay: number | null;
  agentMicrosPerVisitorPerMonth?: number | null;
  agentMicrosPerSitePerDay?: number | null;
  agentMicrosPerSitePerMonth: number | null;
  /**
   * What one turn holds against the spend budgets while it runs (its actual
   * spend replaces it when settled), at most the conversation's own cap.
   * Unset: the whole cap.
   */
  turnReservationMicros?: number | null;
};

export type SiteRuntimeBudget =
  | "conversations_per_visitor_per_day"
  | "conversations_per_site_per_day"
  | "turns_per_conversation"
  | "agent_micros_per_conversation"
  | "agent_micros_per_visitor_per_day"
  | "agent_micros_per_visitor_per_month"
  | "agent_micros_per_site_per_day"
  | "agent_micros_per_site_per_month";

export type SiteRuntimeReservation =
  | {
      ok: true;
      limitMicros: number | null;
      executionLimitMicros: number | null;
      reservedMicros: number;
      /** A keyed Start was initialized while its repair request was being prepared. */
      alreadyStarted?: boolean;
    }
  | {
      ok: false;
      budget: SiteRuntimeBudget;
      /**
       * Only what running conversations hold refuses it: the budget has room
       * once their spend settles, so a retry shortly may succeed.
       */
      busy?: boolean;
    };

/** Hold the reservation row while its funded execution ceiling is stamped. */
export async function siteRuntimeFundedLimitInTransaction(
  tx: Database,
  scope: SitePublishingScope,
  sessionId: string,
): Promise<number | null> {
  const [row] = await rawRows<ConversationRow>(
    tx,
    sql`
    select ${CONVERSATION_COLUMNS} from site_runtime_conversations
    where workspace_id = ${scope.workspaceId} and session_id = ${sessionId} for update`,
  );
  if (!row) throw new SitePublishingError("not_found", "Conversation not found");
  return row.limit_micros === null
    ? null
    : Math.min(Number(row.limit_micros), Number(row.metered_micros) + Number(row.reserved_micros));
}

/** A conversation is not started on less than this (or its cap, when smaller). */
export const SITE_RUNTIME_MIN_RESERVATION_MICROS = 1_000;

const remaining = (limit: number | null, window: UsageWindow) =>
  limit === null ? Number.POSITIVE_INFINITY : limit - window.agentMicros - window.reservedMicros;
/** What a budget has left counting settled spend only (no reservations). */
const unspent = (limit: number | null, window: UsageWindow) =>
  limit === null ? Number.POSITIVE_INFINITY : limit - window.agentMicros;
/** One turn's reservation: the per-turn estimate, within what the conversation may still spend. */
const turnReservation = (limits: SiteRuntimeBudgetLimits, mayStillSpend: number) =>
  Math.max(
    0,
    Math.floor(Math.min(mayStillSpend, limits.turnReservationMicros ?? Number.POSITIVE_INFINITY)),
  );

/**
 * Start a conversation: in one transaction, count the start against the
 * visitor's and the Site's daily starts, and reserve its first turn (the
 * per-turn estimate, at most its cap) in the visitor's day and month and the
 * Site's day and month, refusing when any budget would be exceeded (`busy`
 * when only other running conversations' reservations are in the way). The
 * cap is the per-conversation limit, lowered to what the budgets still have;
 * the separate executionLimitMicros funds only this first increment.
 * The conversation row records the owner (Site and viewer) before the
 * session exists; `releaseSiteRuntimeConversationStart` undoes all of it.
 */
export async function reserveSiteRuntimeConversationStart(
  db: Database,
  scope: SitePublishingScope,
  input: {
    sessionId: string;
    siteId: string;
    viewerPrincipal: string;
    viewerKind: SiteRuntimeConversationViewerKind;
    /** Verified at sign-in, never taken from tool arguments. */
    viewerEmail?: string | null;
    toolIds: readonly string[];
    versionId: string | null;
    limits: SiteRuntimeBudgetLimits;
    /** The Site-wide windows to count in (default `*`; members use `*members`). */
    budgetKey?: string;
    admissionId?: string;
    now?: Date;
  },
): Promise<SiteRuntimeReservation> {
  if (!UUID.test(input.sessionId) || !UUID.test(input.siteId))
    throw new SitePublishingError("validation", "Invalid conversation");
  const periods = periodStarts(input.now ?? new Date());
  const { limits } = input;
  const budgetKey = input.budgetKey ?? SITE_RUNTIME_SITE_PRINCIPAL;
  return await withRlsContext(db, scope, async (tx) => {
    const windows = await lockConversationWindows(
      tx,
      scope,
      input.siteId,
      input.viewerPrincipal,
      budgetKey,
      periods,
    );
    if (
      limits.conversationsPerVisitorPerDay !== null &&
      windows.visitorDay.conversations >= limits.conversationsPerVisitorPerDay
    )
      return { ok: false, budget: "conversations_per_visitor_per_day" } as const;
    if (
      limits.conversationsPerSitePerDay !== null &&
      windows.siteDay.conversations >= limits.conversationsPerSitePerDay
    )
      return { ok: false, budget: "conversations_per_site_per_day" } as const;
    const cap = limits.agentMicrosPerConversation;
    const floor =
      cap === null ? 1 : Math.max(1, Math.min(cap, SITE_RUNTIME_MIN_RESERVATION_MICROS));
    let left = Number.POSITIVE_INFINITY;
    for (const budget of spendBudgets(limits, windows)) {
      const budgetLeft = remaining(budget.limit, budget.window);
      if (budgetLeft < floor)
        return {
          ok: false,
          budget: budget.budget,
          ...(unspent(budget.limit, budget.window) >= floor ? { busy: true } : {}),
        } as const;
      left = Math.min(left, budgetLeft);
    }
    const limitMicros = cap === null ? null : Math.max(0, Math.floor(Math.min(cap, left)));
    const reserve = limitMicros === null ? 0 : turnReservation(limits, limitMicros);
    await tx.execute(
      sql`insert into site_runtime_conversations (session_id, account_id, workspace_id, site_id,
          viewer_principal, viewer_kind, tool_ids, budget_key, version_id, turns, limit_micros,
          reserved_micros, reserved_day, reserved_month, admissions, reservation_windows_complete, viewer_email,
          pending_admission_id, pending_admission_until)
        values (${input.sessionId}, ${scope.accountId}, ${scope.workspaceId}, ${input.siteId},
          ${input.viewerPrincipal}, ${input.viewerKind}, ${JSON.stringify(input.toolIds)}::jsonb,
          ${budgetKey}, ${input.versionId}, 1, ${limitMicros}, ${reserve}, ${periods.day}::date,
          ${periods.month}::date, 1, true, ${input.viewerEmail ?? null},
          ${input.admissionId ?? null}::uuid,
          ${input.admissionId ? new Date(Date.now() + SITE_ADMISSION_RECOVERY_MS).toISOString() : null}::timestamptz)`,
    );
    for (const window of Object.values(windows))
      await adjustUsageWindow(tx, scope, input.siteId, window, {
        conversations: 1,
        reservedMicros: reserve,
      });
    // Bounded cleanup on the write path: usage rows of earlier periods.
    await tx.execute(
      sql`delete from site_runtime_usage where ctid = any(array(
          select ctid from site_runtime_usage
          where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            and ((period = 'day' and period_start < ${periods.day}::date - 1)
              or (period = 'month' and period_start < (${periods.month}::date - interval '1 month')::date))
          limit 100))`,
    );
    return {
      ok: true,
      limitMicros,
      executionLimitMicros: limitMicros === null ? null : reserve,
      reservedMicros: reserve,
    } as const;
  });
}

/**
 * Undo a conversation start whose session was never created: release its
 * reservation, uncount the start and forget the conversation.
 */
export async function releaseSiteRuntimeConversationStart(
  db: Database,
  scope: SitePublishingScope,
  input: { sessionId: string },
): Promise<void> {
  if (!UUID.test(input.sessionId)) return;
  await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<ConversationRow>(
      tx,
      sql`select ${CONVERSATION_COLUMNS} from site_runtime_conversations
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
        for update`,
    );
    if (!row) return;
    if (!(await conversationCanRelease(tx, scope, row, new Date()))) return;
    await tx.execute(sql`delete from site_runtime_conversations
      where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}`);
    const reserved = Number(row.reserved_micros);
    const day = String(row.reserved_day ?? "").slice(0, 10);
    const month = String(row.reserved_month ?? "").slice(0, 10);
    const budgetKey = row.budget_key ?? SITE_RUNTIME_SITE_PRINCIPAL;
    const windows = [
      { principal: row.viewer_principal, period: "day" as const, periodStart: day },
      { principal: row.viewer_principal, period: "month" as const, periodStart: month },
      { principal: budgetKey, period: "day" as const, periodStart: day },
      { principal: budgetKey, period: "month" as const, periodStart: month },
    ];
    for (const window of windows)
      if (window.periodStart && conversationReservedInWindow(row, window))
        await adjustUsageWindow(tx, scope, row.site_id, window, {
          conversations: -1,
          reservedMicros: -reserved,
        });
  });
}

/**
 * Admit agent work in an existing conversation (a new message when
 * `newTurn`, else steering, resuming or running a queued message): under the
 * turn cap and its own spend cap, and set its reservation to one turn's
 * estimate (at most what the conversation may still spend), refusing when a
 * budget cannot hold it (`busy` when only other conversations' reservations
 * are in the way). A per-conversation limit lowered since the start lowers
 * the conversation's cap (returned as `limitMicros`; the caller stamps only
 * executionLimitMicros, cumulative spend plus funding, before work). `uncapped` (a workspace
 * member's conversation, including one started before members were uncapped)
 * drops the conversation's own cap and holds no reservation.
 */
export async function reserveSiteRuntimeConversationWork(
  db: Database,
  scope: SitePublishingScope,
  input: {
    sessionId: string;
    limits: SiteRuntimeBudgetLimits;
    newTurn: boolean;
    uncapped?: boolean;
    admissionId?: string;
    /** Repair only the first Start; do not fund a replay that already initialized. */
    repairStart?: boolean;
    now?: Date;
  },
): Promise<SiteRuntimeReservation> {
  if (!UUID.test(input.sessionId)) throw new SitePublishingError("not_found", "Not found");
  const periods = periodStarts(input.now ?? new Date());
  const { limits } = input;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<ConversationRow>(
      tx,
      sql`select ${CONVERSATION_COLUMNS} from site_runtime_conversations
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
        for update`,
    );
    if (!row) throw new SitePublishingError("not_found", "Conversation not found");
    const conversation = toConversation(row);
    if (input.repairStart) {
      // Initial enqueue takes this same conversation lock through commit. Check
      // its canonical marker here, not just at the earlier HTTP read boundary.
      const [initialized] = await rawRows<{ started: boolean }>(
        tx,
        sql`select exists (
        select 1 from session_events where workspace_id = ${scope.workspaceId}
          and session_id = ${input.sessionId} and type = 'session.created'
      ) as started`,
      );
      if (initialized?.started)
        return {
          ok: true,
          alreadyStarted: true,
          limitMicros: conversation.limitMicros,
          executionLimitMicros:
            conversation.limitMicros === null
              ? null
              : Math.min(
                  conversation.limitMicros,
                  conversation.meteredMicros + conversation.reservedMicros,
                ),
          reservedMicros: conversation.reservedMicros,
        } as const;
    }
    if (row.pending_admission_id !== null)
      return { ok: false, budget: "agent_micros_per_conversation", busy: true } as const;
    if (
      input.newTurn &&
      limits.turnsPerConversation !== null &&
      conversation.turns >= limits.turnsPerConversation
    )
      return { ok: false, budget: "turns_per_conversation" } as const;
    const cap = input.uncapped
      ? null
      : conversation.limitMicros === null
        ? limits.agentMicrosPerConversation
        : limits.agentMicrosPerConversation === null
          ? conversation.limitMicros
          : Math.min(conversation.limitMicros, limits.agentMicrosPerConversation);
    if (cap !== null && conversation.meteredMicros >= cap)
      return { ok: false, budget: "agent_micros_per_conversation" } as const;
    let target = cap === null ? 0 : turnReservation(limits, cap - conversation.meteredMicros);
    const windows = await lockConversationWindows(
      tx,
      scope,
      conversation.siteId,
      conversation.viewerPrincipal,
      conversation.budgetKey,
      periods,
    );
    const reservedDay = String(row.reserved_day ?? "").slice(0, 10);
    const reservedMonth = String(row.reserved_month ?? "").slice(0, 10);
    // A reservation counted in an earlier period vanished when that window rolled.
    const ownReservation = (window: UsageWindow) =>
      conversationReservedInWindow(row, window) &&
      (window.period === "day" ? reservedDay === periods.day : reservedMonth === periods.month)
        ? conversation.reservedMicros
        : 0;
    const budgets = spendBudgets(limits, windows);
    const floor = Math.min(SITE_RUNTIME_MIN_RESERVATION_MICROS, target);
    // Reserve the estimate capped by what remains, including this conversation's
    // own existing reservation, rather than refusing a smaller last turn.
    for (const budget of budgets) {
      const room = remaining(budget.limit, budget.window) + ownReservation(budget.window);
      if (room < floor)
        return {
          ok: false,
          budget: budget.budget,
          // Settled spend alone leaves room for this turn: others' reservations refuse it.
          ...(unspent(budget.limit, budget.window) >= floor ? { busy: true } : {}),
        } as const;
      target = Math.min(target, Math.max(0, room));
    }
    for (const budget of budgets)
      if (budget.limit !== null && budget.window.agentMicros >= budget.limit)
        return { ok: false, budget: budget.budget } as const;
    for (const window of Object.values(windows))
      await adjustUsageWindow(tx, scope, conversation.siteId, window, {
        reservedMicros: target - ownReservation(window),
      });
    await tx.execute(
      sql`update site_runtime_conversations set reserved_micros = ${target},
          reserved_day = ${periods.day}::date, reserved_month = ${periods.month}::date,
          limit_micros = ${cap}, turns = turns + ${input.newTurn ? 1 : 0},
          admissions = admissions + 1, reservation_windows_complete = true, updated_at = now(),
          pending_admission_id = ${input.admissionId ?? null}::uuid,
          pending_admission_until = ${input.admissionId ? new Date(Date.now() + SITE_ADMISSION_RECOVERY_MS).toISOString() : null}::timestamptz
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}`,
    );
    return {
      ok: true,
      limitMicros: cap,
      executionLimitMicros: cap === null ? null : conversation.meteredMicros + target,
      reservedMicros: target,
    } as const;
  });
}

/**
 * Bring a conversation's counted spend up to `usedMicros` (its session usage
 * so far): add the difference to the viewer's day and the Site's day and
 * month, and release that much of its reservation. When the session is
 * `idle` (no turn running or queued) the whole reservation is released, but
 * only if no work was admitted since `expected` was read (its `admissions`
 * counter moves with every admission, even one that leaves the reservation
 * as it was). Never counts the same micro twice; spend never goes down.
 * Returns the spend added.
 */
export async function settleSiteRuntimeConversationSpend(
  db: Database,
  scope: SitePublishingScope,
  input: {
    sessionId: string;
    usedMicros: number;
    idle?: boolean;
    /** The conversation as read before the session status (guards the idle release). */
    expected?: Pick<SiteRuntimeConversationRecord, "admissions">;
    now?: Date;
  },
): Promise<number> {
  if (!UUID.test(input.sessionId)) return 0;
  const periods = periodStarts(input.now ?? new Date());
  const used = Math.max(0, Math.floor(input.usedMicros));
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<ConversationRow>(
      tx,
      sql`select ${CONVERSATION_COLUMNS} from site_runtime_conversations
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
        for update`,
    );
    if (!row) return 0;
    const conversation = toConversation(row);
    const delta = Math.max(0, used - conversation.meteredMicros);
    const unchanged =
      input.expected === undefined || input.expected.admissions === conversation.admissions;
    // Even an aged reservation or an idle status can have queued work. Pending
    // admission and the locked canonical queue, not those hints, decide release.
    const expiredAdmission =
      row.pending_admission_id !== null &&
      new Date(String(row.pending_admission_until)).getTime() <=
        (input.now ?? new Date()).getTime();
    const canRelease =
      ((input.idle && unchanged) || expiredAdmission) &&
      (await conversationCanRelease(tx, scope, row, input.now ?? new Date()));
    const release = canRelease
      ? conversation.reservedMicros
      : Math.min(conversation.reservedMicros, delta);
    if (delta === 0 && release === 0) return 0;
    const reservedDay = String(row.reserved_day ?? "").slice(0, 10);
    const reservedMonth = String(row.reserved_month ?? "").slice(0, 10);
    const windows = [
      { principal: conversation.viewerPrincipal, period: "day" as const, reservedIn: reservedDay },
      {
        principal: conversation.viewerPrincipal,
        period: "month" as const,
        reservedIn: reservedMonth,
      },
      { principal: conversation.budgetKey, period: "day" as const, reservedIn: reservedDay },
      {
        principal: conversation.budgetKey,
        period: "month" as const,
        reservedIn: reservedMonth,
      },
    ];
    // Legacy member rows retain the original reservation key for safe release,
    // but their newly settled spend must never consume the non-member budget.
    const legacyMember =
      conversation.viewerKind === "member" &&
      conversation.budgetKey === SITE_RUNTIME_SITE_PRINCIPAL;
    for (const window of windows) {
      const current = await lockUsageWindow(
        tx,
        scope,
        conversation.siteId,
        window.principal,
        window.period,
        periods[window.period],
      );
      // Spend lands in the current period; the release only in the period the
      // reservation was counted in (gone if that window has rolled since).
      await adjustUsageWindow(tx, scope, conversation.siteId, current, {
        agentMicros: legacyMember && window.principal === SITE_RUNTIME_SITE_PRINCIPAL ? 0 : delta,
        reservedMicros:
          current.periodStart === window.reservedIn && conversationReservedInWindow(row, window)
            ? -release
            : 0,
      });
    }
    if (legacyMember && delta > 0) {
      for (const period of ["day", "month"] as const) {
        const memberWindow = await lockUsageWindow(
          tx,
          scope,
          conversation.siteId,
          SITE_RUNTIME_MEMBERS_PRINCIPAL,
          period,
          periods[period],
        );
        await adjustUsageWindow(tx, scope, conversation.siteId, memberWindow, {
          agentMicros: delta,
        });
      }
    }
    await tx.execute(
      sql`update site_runtime_conversations set metered_micros = ${Math.max(
        used,
        conversation.meteredMicros,
      )}, reserved_micros = ${conversation.reservedMicros - release}, updated_at = now()
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}`,
    );
    return delta;
  });
}

export type SiteRuntimeRateBucket = "requests" | "guest_writes" | "reports" | "sign_in";

/**
 * Count one operation in a fixed one-minute window for a principal and
 * bucket. Returns whether it is within `limit` and, when not, the seconds
 * until the window ends.
 */
export async function consumeSiteRuntimeRate(
  db: Database,
  scope: SitePublishingScope,
  input: {
    siteId: string;
    principal: string;
    bucket: SiteRuntimeRateBucket;
    limit: number;
    now?: Date;
    /** Force (or skip) the stale-window cleanup; by default it runs on about 1% of calls. */
    sweep?: boolean;
  },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = input.now ?? new Date();
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const cap = Math.max(0, Math.floor(input.limit));
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ operations: number; inserted: boolean }>(
      tx,
      sql`insert into site_runtime_rate_windows (account_id, workspace_id, site_id, principal_key,
          bucket, window_started_at, operations)
        values (${scope.accountId}, ${scope.workspaceId}, ${input.siteId}, ${input.principal.slice(0, 300)},
          ${input.bucket}, ${window.toISOString()}::timestamptz, 1)
        on conflict (workspace_id, site_id, principal_key, bucket) do update set
          operations = case
            when site_runtime_rate_windows.window_started_at = excluded.window_started_at
              then least(site_runtime_rate_windows.operations + 1, ${cap + 1})
            when site_runtime_rate_windows.window_started_at > excluded.window_started_at
              then least(site_runtime_rate_windows.operations + 1, ${cap + 1})
            else 1 end,
          window_started_at = greatest(site_runtime_rate_windows.window_started_at,
            excluded.window_started_at)
        returning operations, (xmax = 0) as inserted`,
    );
    // Bounded cleanup on the write path, keeping pace with new principals:
    // every new row deletes up to a few of this Site's stale windows, and
    // about 1% of calls delete a larger batch.
    const sweep = input.sweep ?? Math.random() < 0.01;
    if (sweep || row?.inserted === true)
      await tx.execute(
        sql`delete from site_runtime_rate_windows where ctid = any(array(
            select ctid from site_runtime_rate_windows
            where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
              and window_started_at < now() - interval '10 minutes'
            limit ${sweep ? 100 : 4}))`,
      );
    const allowed = Number(row!.operations) <= cap;
    return {
      allowed,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((window.getTime() + 60_000 - now.getTime()) / 1000)),
    };
  });
}

// --- platform moderation (global read) ------------------------------------------------

const READ_ONLY = { accessMode: "read only" } as const;

export type SiteModerationQueueItem = {
  kind: "report" | "flagged_scan";
  accountId: string;
  workspaceId: string;
  siteId: string;
  label: string | null;
  status: SitePublicationStatusValue | null;
  /** Report category, or the scanner's finding count for a flagged scan. */
  detail: string;
  message: string | null;
  contactEmail: string | null;
  reportId: string | null;
  at: Date;
};

/** The database role operator tooling needs for cross-workspace reads. */
export const SITE_OPERATOR_ROLE_REQUIREMENT =
  "the database role that owns the Opengeni schema (the migrations credential, OPENGENI_MIGRATIONS_DATABASE_URL), or a superuser or BYPASSRLS role";

/**
 * Refuse cross-workspace operator reads unless this connection is the schema
 * owner (whose owner-only read policies show every row, migration 0782) or a
 * role that bypasses RLS. The application role is neither, so it gets an
 * error instead of a silently empty list.
 */
async function requireOperatorRole(tx: Database, what: string): Promise<void> {
  const [role] = await rawRows<{ allowed: boolean }>(
    tx,
    sql`select (r.rolsuper or r.rolbypassrls or current_user = pg_catalog.pg_get_userbyid(c.relowner))
        as allowed
      from pg_catalog.pg_roles r, pg_catalog.pg_class c
      where r.rolname = current_user and c.oid = 'site_publications'::regclass`,
  );
  if (!role?.allowed)
    throw new SitePublishingError("forbidden", `${what} needs ${SITE_OPERATOR_ROLE_REQUIREMENT}`);
}

/**
 * The platform's moderation queue across every workspace: open abuse reports
 * and publications whose last content scan was flagged, newest first. For
 * operator tooling only, in a read-only transaction: the schema owner reads
 * through owner-only policies (no BYPASSRLS needed); the application role is
 * refused.
 */
export async function listSiteModerationQueue(
  db: Database,
  input: { limit: number },
): Promise<SiteModerationQueueItem[]> {
  const limit = Math.max(1, Math.min(input.limit, 500));
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`set local statement_timeout = '10s'`);
    await requireOperatorRole(tx, "The moderation queue");
    const reports = await rawRows<{
      account_id: string;
      workspace_id: string;
      site_id: string;
      label: string | null;
      status: SitePublicationStatusValue | null;
      category: string;
      message: string;
      contact_email: string | null;
      id: string;
      created_at: unknown;
    }>(
      tx,
      sql`select r.account_id, r.workspace_id, r.site_id, p.label, p.status, r.category, r.message,
          r.contact_email, r.id, r.created_at
        from site_abuse_reports r
        left join site_publications p on p.workspace_id = r.workspace_id and p.site_id = r.site_id
        where r.status = 'open' order by r.created_at desc limit ${limit}`,
    );
    const flagged = await rawRows<{
      account_id: string;
      workspace_id: string;
      site_id: string;
      label: string;
      status: SitePublicationStatusValue;
      findings: unknown;
      scanned_at: unknown;
    }>(
      tx,
      sql`select account_id, workspace_id, site_id, label, status, scan_findings as findings,
          scanned_at
        from site_publications where scan_status = 'flagged'
        order by scanned_at desc limit ${limit}`,
    );
    const items: SiteModerationQueueItem[] = [
      ...reports.map((row) => ({
        kind: "report" as const,
        accountId: row.account_id,
        workspaceId: row.workspace_id,
        siteId: row.site_id,
        label: row.label,
        status: row.status,
        detail: row.category,
        message: row.message,
        contactEmail: row.contact_email,
        reportId: row.id,
        at: date(row.created_at),
      })),
      ...flagged.map((row) => {
        const findings = row.findings === null ? [] : jsonValue<unknown[]>(row.findings);
        return {
          kind: "flagged_scan" as const,
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          siteId: row.site_id,
          label: row.label,
          status: row.status,
          detail: `${Array.isArray(findings) ? findings.length : 0} finding(s)`,
          message: null,
          contactEmail: null,
          reportId: null,
          at: nullableDate(row.scanned_at) ?? new Date(0),
        };
      }),
    ];
    return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }, READ_ONLY);
}

/**
 * Find a publication by Site id across every workspace (operator tooling,
 * same global-read rules as the moderation queue).
 */
export async function findSitePublicationGlobally(
  db: Database,
  siteId: string,
): Promise<{ accountId: string; workspaceId: string; label: string } | null> {
  if (!UUID.test(siteId)) return null;
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await requireOperatorRole(tx, "Finding a Site by id");
    const [row] = await rawRows<{ account_id: string; workspace_id: string; label: string }>(
      tx,
      sql`select account_id, workspace_id, label from site_publications where site_id = ${siteId}`,
    );
    return row
      ? { accountId: row.account_id, workspaceId: row.workspace_id, label: row.label }
      : null;
  }, READ_ONLY);
}

// --- abuse reports ----------------------------------------------------------------

export type SiteAbuseReportRecord = {
  id: string;
  siteId: string;
  hostname: string;
  category: string;
  message: string;
  contactEmail: string | null;
  status: "open" | "dismissed" | "actioned";
  createdAt: Date;
};

type ReportRow = {
  id: string;
  site_id: string;
  hostname: string;
  category: string;
  message: string;
  contact_email: string | null;
  status: SiteAbuseReportRecord["status"];
  created_at: unknown;
};

function toReport(row: ReportRow): SiteAbuseReportRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    hostname: row.hostname,
    category: row.category,
    message: row.message,
    contactEmail: row.contact_email,
    status: row.status,
    createdAt: date(row.created_at),
  };
}

/** Resolved (dismissed or actioned) reports are kept this long after they were made. */
export const SITE_ABUSE_REPORT_RETENTION_DAYS = 180;

/**
 * Record an abuse report. The write also deletes up to 20 of the Site's
 * resolved reports older than the retention period (a bounded cleanup on the
 * write path); open reports stay until someone resolves them.
 */
export async function createSiteAbuseReport(
  db: Database,
  scope: SitePublishingScope,
  input: {
    siteId: string;
    hostname: string;
    category: string;
    message: string;
    contactEmail: string | null;
    reporterPrincipal: string;
  },
): Promise<SiteAbuseReportRecord> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<ReportRow>(
      tx,
      sql`insert into site_abuse_reports (account_id, workspace_id, site_id, hostname, category,
          message, contact_email, reporter_principal)
        values (${scope.accountId}, ${scope.workspaceId}, ${input.siteId}, ${input.hostname},
          ${input.category}, ${input.message.slice(0, 4000)}, ${input.contactEmail},
          ${input.reporterPrincipal.slice(0, 300)})
        returning id, site_id, hostname, category, message, contact_email, status, created_at`,
    );
    await tx.execute(
      sql`delete from site_abuse_reports where ctid = any(array(
          select ctid from site_abuse_reports
          where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            and status in ('dismissed', 'actioned')
            and created_at < now() - make_interval(days => ${SITE_ABUSE_REPORT_RETENTION_DAYS})
          limit 20))`,
    );
    return toReport(row!);
  });
}

export async function listSiteAbuseReports(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; status?: SiteAbuseReportRecord["status"]; limit: number },
): Promise<SiteAbuseReportRecord[]> {
  return await withRlsContext(db, scope, async (tx) =>
    (
      await rawRows<ReportRow>(
        tx,
        sql`select id, site_id, hostname, category, message, contact_email, status, created_at
          from site_abuse_reports
          where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            ${input.status ? sql`and status = ${input.status}` : sql``}
          order by created_at desc limit ${Math.max(1, Math.min(input.limit, 200))}`,
      )
    ).map(toReport),
  );
}

export async function countOpenSiteAbuseReports(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<number> {
  return await withRlsContext(db, scope, async (tx) => {
    // Bounded: the console shows "100+" past this.
    const [row] = await rawRows<{ count: string | number }>(
      tx,
      sql`select count(*) as count from (select 1 from site_abuse_reports
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId} and status = 'open'
        limit 101) open_reports`,
    );
    return Number(row?.count ?? 0);
  });
}

export async function updateSiteAbuseReportStatus(
  db: Database,
  scope: SitePublishingScope,
  input: {
    siteId: string;
    reportId: string;
    status: SiteAbuseReportRecord["status"];
    actor: string;
  },
): Promise<SiteAbuseReportRecord | null> {
  if (!UUID.test(input.reportId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<ReportRow>(
      tx,
      sql`update site_abuse_reports set status = ${input.status}, resolved_by = ${input.actor},
          updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId} and id = ${input.reportId}
        returning id, site_id, hostname, category, message, contact_email, status, created_at`,
    );
    return row ? toReport(row) : null;
  });
}

/** Mark every open report of a Site actioned (after a takedown). */
export async function actionOpenSiteAbuseReports(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; actor: string },
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await tx.execute(
      sql`update site_abuse_reports set status = 'actioned', resolved_by = ${input.actor},
          updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId} and status = 'open'`,
    );
  });
}

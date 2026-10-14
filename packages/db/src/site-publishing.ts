import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/**
 * Published Sites storage (migration 0778). Every read and write runs in the
 * Site's workspace RLS context, except the hostname lane: a label lookup that
 * names exactly one row of `site_hostnames` through the
 * `opengeni.site_hostname_label` setting (the api_keys hash pattern). The API
 * decides who may do what; these functions enforce shapes, uniqueness, the
 * release hold and single use.
 */

export type SitePublishingScope = { accountId: string; workspaceId: string };

export type SitePublishingErrorCode =
  | "not_found"
  | "taken"
  | "held"
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
export type SiteLimitProfileKindValue = "free" | "credits" | "unlimited" | "custom";
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
 * Find a hostname row by label across every workspace (the hostname lane).
 * Only the named row is visible; nothing else about any workspace is.
 */
export async function findSiteHostname(
  db: Database,
  label: string,
): Promise<SiteHostnameRecord | null> {
  if (!LABEL.test(label)) return null;
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await setHostnameLane(tx, label);
    const [row] = await rawRows<HostnameRow>(
      tx,
      sql`select label, account_id, workspace_id, site_id, created_at, released_at
        from site_hostnames where label = ${label}`,
    );
    return row ? toHostname(row) : null;
  });
}

/** Whether `label` may be claimed by `siteId` in this workspace. */
export type SiteHostnameClaimCheck =
  | { available: true }
  | { available: false; problem: "taken" | "held" };

function claimCheck(
  existing: SiteHostnameRecord | null,
  scope: SitePublishingScope,
  siteId: string | null,
  holdDays: number,
  now: Date,
): SiteHostnameClaimCheck {
  if (!existing) return { available: true };
  if (existing.workspaceId === scope.workspaceId) {
    if (existing.releasedAt !== null) return { available: true };
    return existing.siteId === siteId
      ? { available: true }
      : { available: false, problem: "taken" };
  }
  if (existing.releasedAt === null) return { available: false, problem: "taken" };
  const hold = Math.max(holdDays, SITE_HOSTNAME_MIN_HOLD_DAYS) * 86_400_000;
  return existing.releasedAt.getTime() + hold > now.getTime()
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
  return claimCheck(await findSiteHostname(db, label), scope, siteId, holdDays, now);
}

const PUBLICATION_COLUMNS = sql`site_id, account_id, workspace_id, label, access, status, noindex,
  agent_enabled, agent_model, agent_instructions, agent_tools, limit_profile_kind, limit_overrides,
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

/** The Site itself (any audience); callers decide whether it may be published or served. */
export async function getPublishedSite(
  db: Database,
  scope: SitePublishingScope,
  siteId: string,
): Promise<PublishedSiteRecord | null> {
  if (!UUID.test(siteId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
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
  });
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
} | null> {
  if (!UUID.test(siteId) || !UUID.test(versionId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{
      id: string;
      content_key: string;
      content_sha256: string | null;
      size_bytes: string | number;
    }>(
      tx,
      sql`select id, content_key, content_sha256, size_bytes from workspace_artifact_versions
        where workspace_id = ${scope.workspaceId} and artifact_id = ${siteId} and id = ${versionId}`,
    );
    return row
      ? {
          id: row.id,
          contentKey: row.content_key,
          contentSha256: row.content_sha256,
          sizeBytes: Number(row.size_bytes),
        }
      : null;
  });
}

/** Claim `label` for `siteId` inside the caller's transaction; throws taken or held. */
async function claimLabel(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  label: string,
  holdDays: number,
): Promise<void> {
  if (!LABEL.test(label)) throw new SitePublishingError("validation", "Invalid hostname label");
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
    const check = claimCheck(existing, scope, siteId, holdDays, now);
    if (!check.available)
      throw new SitePublishingError(
        check.problem,
        check.problem === "held"
          ? "This name was released recently and is held for its previous owner"
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
    const label = changes.label ?? existing?.label ?? input.defaultLabel;
    const previousLabel = existing && existing.label !== label ? existing.label : null;
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
        : JSON.stringify(limitProfile.overrides);
    const [row] = existing
      ? await rawRows<PublicationRow>(
          tx,
          sql`update site_publications set label = ${label}, access = ${access}, status = ${status},
              noindex = ${noindex}, agent_enabled = ${agent.enabled}, agent_model = ${agent.model},
              agent_instructions = ${agent.instructions}, agent_tools = ${toolsJson}::jsonb,
              limit_profile_kind = ${limitProfile?.kind ?? null},
              limit_overrides = ${overridesJson}::jsonb,
              invited_emails = ${JSON.stringify(invited)}::jsonb,
              generation = generation + 1, updated_by = ${input.actor}, updated_at = now()
            where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            returning ${PUBLICATION_COLUMNS}`,
        )
      : await rawRows<PublicationRow>(
          tx,
          sql`insert into site_publications (site_id, account_id, workspace_id, label, access, status,
              noindex, agent_enabled, agent_model, agent_instructions, agent_tools, limit_profile_kind,
              limit_overrides, invited_emails, created_by, updated_by)
            values (${input.siteId}, ${scope.accountId}, ${scope.workspaceId}, ${label}, ${access},
              ${status}, ${noindex}, ${agent.enabled}, ${agent.model}, ${agent.instructions},
              ${toolsJson}::jsonb, ${limitProfile?.kind ?? null}, ${overridesJson}::jsonb,
              ${JSON.stringify(invited)}::jsonb, ${input.actor}, ${input.actor})
            returning ${PUBLICATION_COLUMNS}`,
        );
    return { publication: toPublication(row!), created: !existing, previousLabel };
  });
}

function defaultAgent(): SitePublicationRecord["agent"] {
  return { enabled: true, model: null, instructions: null, tools: null };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** Take a Site down at once. A platform takedown is never replaced by an owner's. */
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
      existing.suspendedBy === "platform" &&
      input.by !== "platform"
    )
      return existing;
    const [row] = await rawRows<PublicationRow>(
      tx,
      sql`update site_publications set status = 'suspended', suspended_at = now(),
          suspended_by = ${input.by}, suspended_reason = ${input.reason.slice(0, 2000)},
          suspended_by_subject = ${input.subject}, generation = generation + 1,
          updated_by = ${input.subject}, updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        returning ${PUBLICATION_COLUMNS}`,
    );
    return toPublication(row!);
  });
}

/** Restore a taken-down Site; only the platform restores a platform takedown. */
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
    const [row] = await rawRows<PublicationRow>(
      tx,
      sql`update site_publications set status = 'active', suspended_at = null, suspended_by = null,
          suspended_reason = null, suspended_by_subject = null, generation = generation + 1,
          updated_by = ${input.subject}, updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        returning ${PUBLICATION_COLUMNS}`,
    );
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
      sql`update site_publications set generation = generation + 1, updated_at = now()
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
};

export async function createSiteViewerSession(
  db: Database,
  scope: SitePublishingScope,
  input: SiteViewerIdentity & { siteId: string; tokenHash: string; absoluteSeconds: number },
): Promise<SiteViewerSessionRecord> {
  return await withRlsContext(db, scope, async (tx) => {
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
      stale: boolean;
    }>(
      tx,
      sql`select id, site_id, subject_id, viewer_kind, email, display_name, expires_at,
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
    };
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

// --- limit profiles --------------------------------------------------------------

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
    const overrides = profile.overrides === null ? null : JSON.stringify(profile.overrides);
    await tx.execute(
      sql`insert into site_limit_profiles (workspace_id, account_id, kind, overrides, updated_by)
        values (${scope.workspaceId}, ${scope.accountId}, ${profile.kind}, ${overrides}::jsonb, ${actor})
        on conflict (workspace_id) do update set kind = excluded.kind,
          overrides = excluded.overrides, updated_by = excluded.updated_by, updated_at = now()`,
    );
  });
  return profile;
}

// --- conversations and budgets ---------------------------------------------------

export type SiteRuntimeConversationRecord = {
  sessionId: string;
  siteId: string;
  viewerPrincipal: string;
  versionId: string | null;
  turns: number;
  meteredMicros: number;
  createdAt: Date;
};

type ConversationRow = {
  session_id: string;
  site_id: string;
  viewer_principal: string;
  version_id: string | null;
  turns: number;
  metered_micros: string | number;
  created_at: unknown;
};

function toConversation(row: ConversationRow): SiteRuntimeConversationRecord {
  return {
    sessionId: row.session_id,
    siteId: row.site_id,
    viewerPrincipal: row.viewer_principal,
    versionId: row.version_id,
    turns: Number(row.turns),
    meteredMicros: Number(row.metered_micros),
    createdAt: date(row.created_at),
  };
}

export async function insertSiteRuntimeConversation(
  db: Database,
  scope: SitePublishingScope,
  input: { sessionId: string; siteId: string; viewerPrincipal: string; versionId: string | null },
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await tx.execute(
      sql`insert into site_runtime_conversations (session_id, account_id, workspace_id, site_id,
          viewer_principal, version_id)
        values (${input.sessionId}, ${scope.accountId}, ${scope.workspaceId}, ${input.siteId},
          ${input.viewerPrincipal}, ${input.versionId})`,
    );
  });
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
      sql`select session_id, site_id, viewer_principal, version_id, turns, metered_micros, created_at
        from site_runtime_conversations
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
          and site_id = ${input.siteId} and viewer_principal = ${input.viewerPrincipal}`,
    );
    return row ? toConversation(row) : null;
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
        sql`select session_id, site_id, viewer_principal, version_id, turns, metered_micros, created_at
          from site_runtime_conversations
          where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
            and viewer_principal = ${input.viewerPrincipal}
          order by created_at desc limit ${Math.max(1, Math.min(input.limit, 100))}`,
      )
    ).map(toConversation),
  );
}

/**
 * Count one viewer message in a conversation when it is under `maxTurns`
 * (null: no cap). Returns false when the cap is reached.
 */
export async function admitSiteRuntimeConversationTurn(
  db: Database,
  scope: SitePublishingScope,
  input: { sessionId: string; maxTurns: number | null },
): Promise<boolean> {
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ turns: number }>(
      tx,
      sql`update site_runtime_conversations set turns = turns + 1, updated_at = now()
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
          ${input.maxTurns === null ? sql`` : sql`and turns < ${input.maxTurns}`}
        returning turns`,
    );
    return rows.length === 1;
  });
}

export type SiteRuntimeUsageSnapshot = {
  visitorDay: { conversations: number; agentMicros: number };
  siteDay: { conversations: number; agentMicros: number };
  siteMonth: { conversations: number; agentMicros: number };
};

/** The Site-wide principal key in usage windows. */
export const SITE_RUNTIME_SITE_PRINCIPAL = "*";

function periodStarts(now: Date): { day: string; month: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), month: `${iso.slice(0, 7)}-01` };
}

/** Current-period counters for a viewer and the Site, from three primary-key rows. */
export async function readSiteRuntimeUsage(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; viewerPrincipal: string; now?: Date },
): Promise<SiteRuntimeUsageSnapshot> {
  const periods = periodStarts(input.now ?? new Date());
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{
      principal_key: string;
      period: "day" | "month";
      period_start: unknown;
      conversations: number;
      agent_micros: string | number;
    }>(
      tx,
      sql`select principal_key, period, period_start::text as period_start, conversations, agent_micros
        from site_runtime_usage
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
          and principal_key in (${input.viewerPrincipal}, ${SITE_RUNTIME_SITE_PRINCIPAL})`,
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
      };
    };
    return {
      visitorDay: pick(input.viewerPrincipal, "day"),
      siteDay: pick(SITE_RUNTIME_SITE_PRINCIPAL, "day"),
      siteMonth: pick(SITE_RUNTIME_SITE_PRINCIPAL, "month"),
    };
  });
}

async function addUsage(
  tx: Database,
  scope: SitePublishingScope,
  siteId: string,
  principal: string,
  period: "day" | "month",
  periodStart: string,
  conversations: number,
  micros: number,
): Promise<void> {
  await tx.execute(
    sql`insert into site_runtime_usage (account_id, workspace_id, site_id, principal_key, period,
        period_start, conversations, agent_micros)
      values (${scope.accountId}, ${scope.workspaceId}, ${siteId}, ${principal}, ${period},
        ${periodStart}::date, ${conversations}, ${micros})
      on conflict (workspace_id, site_id, principal_key, period) do update set
        conversations = case
          when site_runtime_usage.period_start = excluded.period_start
            then site_runtime_usage.conversations + excluded.conversations
          when site_runtime_usage.period_start > excluded.period_start
            then site_runtime_usage.conversations
          else excluded.conversations end,
        agent_micros = case
          when site_runtime_usage.period_start = excluded.period_start
            then site_runtime_usage.agent_micros + excluded.agent_micros
          when site_runtime_usage.period_start > excluded.period_start
            then site_runtime_usage.agent_micros
          else excluded.agent_micros end,
        period_start = greatest(site_runtime_usage.period_start, excluded.period_start),
        updated_at = now()`,
  );
}

/** Count a new conversation for the viewer (day) and the Site (day and month). */
export async function countSiteRuntimeConversationStart(
  db: Database,
  scope: SitePublishingScope,
  input: { siteId: string; viewerPrincipal: string; now?: Date },
): Promise<void> {
  const periods = periodStarts(input.now ?? new Date());
  await withRlsContext(db, scope, async (tx) => {
    await addUsage(tx, scope, input.siteId, input.viewerPrincipal, "day", periods.day, 1, 0);
    await addUsage(tx, scope, input.siteId, SITE_RUNTIME_SITE_PRINCIPAL, "day", periods.day, 1, 0);
    await addUsage(
      tx,
      scope,
      input.siteId,
      SITE_RUNTIME_SITE_PRINCIPAL,
      "month",
      periods.month,
      1,
      0,
    );
  });
}

/**
 * Bring a conversation's counted spend up to `usedMicros` (its session usage
 * so far) and add the difference to the viewer's day and the Site's day and
 * month. Never counts the same micro twice; spend never goes down.
 */
export async function settleSiteRuntimeConversationSpend(
  db: Database,
  scope: SitePublishingScope,
  input: { sessionId: string; usedMicros: number; now?: Date },
): Promise<number> {
  const periods = periodStarts(input.now ?? new Date());
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{
      site_id: string;
      viewer_principal: string;
      delta: string | number;
    }>(
      tx,
      sql`with previous as (
          select metered_micros from site_runtime_conversations
          where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
          for update
        )
        update site_runtime_conversations c
          set metered_micros = ${Math.max(0, Math.floor(input.usedMicros))}, updated_at = now()
        from previous
        where c.workspace_id = ${scope.workspaceId} and c.session_id = ${input.sessionId}
          and previous.metered_micros < ${Math.max(0, Math.floor(input.usedMicros))}
        returning c.site_id, c.viewer_principal,
          (${Math.max(0, Math.floor(input.usedMicros))} - previous.metered_micros) as delta`,
    );
    if (!row) return 0;
    const delta = Number(row.delta);
    await addUsage(tx, scope, row.site_id, row.viewer_principal, "day", periods.day, 0, delta);
    await addUsage(
      tx,
      scope,
      row.site_id,
      SITE_RUNTIME_SITE_PRINCIPAL,
      "day",
      periods.day,
      0,
      delta,
    );
    await addUsage(
      tx,
      scope,
      row.site_id,
      SITE_RUNTIME_SITE_PRINCIPAL,
      "month",
      periods.month,
      0,
      delta,
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
  },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = input.now ?? new Date();
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const cap = Math.max(0, Math.floor(input.limit));
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ operations: number }>(
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
        returning operations`,
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

import type { AccessGrant } from "@opengeni/contracts";
import {
  getSession,
  getSiteDataAgentSession,
  SITE_DATA_AGENT_LINEAGE_MAX_DEPTH,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { siteSessionOriginFromMetadata } from "./site-session-origin";

/**
 * Whether an agent acts for a Site page: its session, a spawning ancestor or
 * its root session was started from a Site (a published Site or an inline or
 * preview frame), or its current or a spawning ancestor turn arrived from one.
 * The same evidence the Site Data agent clamp uses
 * (apps/api/src/site-data/service.ts), plus frame origins without a
 * published Site id.
 */
export type SiteAgentClamp = {
  clamped: boolean;
  /** Published Sites in the lineage; empty for frames without a published Site. */
  originSiteIds: string[];
};

function agentSessionIds(grant: AccessGrant): { sessionId: string; turnId: string | null } | null {
  if (grant.principalKind !== "agent_attempt" && grant.metadata?.delegated !== true) return null;
  const sessionId = grant.metadata?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const turnId = grant.metadata?.turnId;
  return { sessionId, turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null };
}

/** Null when the grant is not an agent session. */
export async function siteAgentClamp(
  db: Database,
  grant: AccessGrant,
): Promise<SiteAgentClamp | null> {
  const ids = agentSessionIds(grant);
  if (!ids) return null;
  return await siteSessionClamp(
    db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    ids.sessionId,
    ids.turnId,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** How long an agent turn's clamp is reused (per process). */
const CLAMP_CACHE_MS = 60_000;
const CLAMP_CACHE_LIMIT = 5_000;
const clampCache = new Map<string, { clamp: SiteAgentClamp; at: number }>();

/**
 * The Site clamp of an agent running in `sessionId` (and `turnId`, when
 * known). A turn's clamp is computed once a minute at most per process: the
 * evidence it reads (where the session, its ancestors and that turn came
 * from) does not change during the turn. Without a turn id it is always
 * read fresh.
 */
export async function siteSessionClamp(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  sessionId: string,
  turnId: string | null,
): Promise<SiteAgentClamp> {
  if (turnId === null) return (await readSiteSessionClamp(db, scope, sessionId, null)).clamp;
  const key = `${scope.workspaceId}:${sessionId}:${turnId}`;
  const now = Date.now();
  const cached = clampCache.get(key);
  if (cached && cached.at > now - CLAMP_CACHE_MS) return cached.clamp;
  const { clamp, cacheable } = await readSiteSessionClamp(db, scope, sessionId, turnId);
  if (cacheable) {
    if (clampCache.size >= CLAMP_CACHE_LIMIT) clampCache.clear();
    clampCache.set(key, { clamp, at: now });
  }
  return clamp;
}

async function readSiteSessionClamp(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  sessionId: string,
  turnId: string | null,
): Promise<{ clamp: SiteAgentClamp; cacheable: boolean }> {
  // A session id that is not a UUID names no session.
  const own = UUID.test(sessionId)
    ? await getSession(db, scope.workspaceId, sessionId).catch(() => undefined)
    : null;
  // A read that failed fails closed, as a partial lineage does. Never cached:
  // it may have failed only for now.
  if (own === undefined) return { clamp: { clamped: true, originSiteIds: [] }, cacheable: false };
  // No such session: other checks refuse a caller whose session is gone.
  if (!own) return { clamp: { clamped: false, originSiteIds: [] }, cacheable: false };
  const lineage = await getSiteDataAgentSession(db, scope, sessionId, turnId);
  let frameOrigin = siteSessionOriginFromMetadata(own.metadata) !== null;
  // Frames without a published Site record no Site id; find their origin by walking up.
  let parentId = own.parentSessionId;
  let unread = false;
  const read = (id: string) =>
    getSession(db, scope.workspaceId, id).catch(() => {
      unread = true;
      return null;
    });
  for (let depth = 0; !frameOrigin && parentId && depth < SITE_DATA_AGENT_LINEAGE_MAX_DEPTH;) {
    const parent = await read(parentId);
    if (!parent) break;
    frameOrigin = siteSessionOriginFromMetadata(parent.metadata) !== null;
    parentId = parent.parentSessionId;
    depth += 1;
  }
  if (!frameOrigin && own.rootSessionId && own.rootSessionId !== own.id) {
    const root = await read(own.rootSessionId);
    frameOrigin = siteSessionOriginFromMetadata(root?.metadata) !== null;
  }
  return {
    clamp: {
      // A lineage that cannot be read in full fails closed, as for Site Data.
      clamped:
        frameOrigin || lineage.originSiteIds.length > 0 || lineage.siteTurn || !lineage.complete,
      originSiteIds: lineage.originSiteIds,
    },
    // A partial read (failed closed) is read again next time.
    cacheable: lineage.complete && !unread,
  };
}

/** What a Site-clamped agent may not create or change. */
export type SiteClampedResource =
  | "schedules"
  | "automations"
  | "Site publications"
  | "workspace instructions"
  | "Skills"
  | "Knowledge"
  | "secrets"
  | "workspace members, connections or settings"
  | "the organization profile"
  | "Connected Machines"
  | "sandbox environments"
  | "browser or computer sessions"
  | "workspace settings";

/** The refusal message for a Site-clamped agent. */
export function siteClampedAgentMessage(what: SiteClampedResource): string {
  return `An agent started from a Site page cannot create or change ${what}`;
}

/**
 * The refusal when a Site-clamped agent reaches for compute beyond its own
 * session's: `run_on`, attaching, swapping or provisioning a sandbox, or
 * starting a worker on a chosen machine or another session's sandbox.
 */
export const SITE_AGENT_COMPUTE_MESSAGE =
  "An agent started from a Site page cannot run on, attach, provision or choose sandboxes or Connected Machines";

/** Fields of a session create that choose its compute, which a Site-clamped agent may not send. */
const SITE_AGENT_COMPUTE_FIELDS = ["targetSandboxId", "workingDir"] as const;

/**
 * Refuse a Site-clamped agent's session create that chooses compute: a
 * machine target, a self-hosted backend or another session's sandbox group.
 * Its workers run in its own sandbox (shared) or a new managed one.
 */
export async function assertSiteAgentMayChooseCompute(
  db: Database,
  grant: AccessGrant,
  payload: {
    sandbox?: unknown;
    sandboxBackend?: unknown;
    targetSandboxId?: unknown;
    workingDir?: unknown;
  },
): Promise<void> {
  const choosesCompute =
    SITE_AGENT_COMPUTE_FIELDS.some(
      (field) => payload[field] !== undefined && payload[field] !== null,
    ) ||
    payload.sandboxBackend === "selfhosted" ||
    (payload.sandbox !== undefined &&
      payload.sandbox !== null &&
      typeof payload.sandbox === "object");
  if (!choosesCompute) return;
  if (!(await siteAgentClamp(db, grant))?.clamped) return;
  throw new HTTPException(403, { message: SITE_AGENT_COMPUTE_MESSAGE });
}

/**
 * Refuse a Site-clamped agent: an agent started from a Site page acts with
 * that page's reach and cannot create or change schedules, automations, Site
 * publications, workspace instructions, Skills, Knowledge, secrets,
 * workspace members, connections and settings, the organization profile,
 * Connected Machines, sandbox environments or other workspace settings.
 */
export async function assertNotSiteClampedAgent(
  db: Database,
  grant: AccessGrant,
  what: SiteClampedResource,
): Promise<void> {
  const clamp = await siteAgentClamp(db, grant);
  if (!clamp?.clamped) return;
  throw new HTTPException(403, { message: siteClampedAgentMessage(what) });
}

/**
 * Whether an agent running in `caller` may message, steer or control
 * `targetSessionId`. An unclamped agent is not limited here. A Site-clamped
 * agent reaches only sessions that act for the same Site: clamped themselves
 * (its own lineage, or another session the Site started) and naming no
 * published Site the caller does not.
 */
export async function siteAgentMayReachSession(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  caller: { sessionId: string; turnId: string | null },
  targetSessionId: string,
): Promise<boolean> {
  if (targetSessionId === caller.sessionId) return true;
  const callerClamp = await siteSessionClamp(db, scope, caller.sessionId, caller.turnId);
  if (!callerClamp.clamped) return true;
  const target = await siteSessionClamp(db, scope, targetSessionId, null);
  const callerSites = new Set(callerClamp.originSiteIds);
  return target.clamped && target.originSiteIds.every((siteId) => callerSites.has(siteId));
}

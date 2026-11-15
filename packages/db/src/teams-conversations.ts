import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import { namedSubjectPersonalWorkspaceId } from "./slack-routing-personal-workspace";
import {
  CONNECTION_DISCONNECTED_AUDIT_ACTION,
  insertDisconnectAuditEventInScope,
  type DisconnectAuditActor,
} from "./disconnect-audit";

export type TeamsInstallation = {
  tenant_id: string;
  account_id: string;
  workspace_id: string;
  generation: string;
  active: boolean;
  group_revision: number;
};
export type TeamsGroupAudience = Array<{ actorId: string; subjectId: string }>;
export type TeamsRoute = TeamsInstallation & {
  group_audience: TeamsGroupAudience | null;
  group_active: boolean;
  route_id: string;
  actor_id: string;
  subject_id: string;
  personal: boolean;
  channel_id: string | null;
  conversation_id: string;
  thread_id: string | null;
  service_url: string;
  bot_id: string;
  session_id: string;
  /** Where a 1:1 route's session lives when not in the installation's workspace:
   * the linked person's own Personal workspace, or (with workspace routing) a
   * workspace of the organization they can start work in. Null keeps the
   * installation's. */
  session_workspace_id: string | null;
  /** The agent a 1:1 route's chat runs as, or null for the plain assistant. */
  agent_id?: string | null;
  session_bound: boolean;
  delivered_sequence: number;
  /** The latest reply, request for input or failure event in the route's session. */
  relevant_event_sequence: number;
  lease_token: string | null;
};
export type TeamsInbox = {
  event_id: string;
  route_id: string;
  actor_id: string;
  subject_id: string;
  payload: Record<string, unknown>;
};
export type TeamsOutbox = {
  source_sequence: number;
  operation_id: string;
  payload: {
    text: string;
    notice?: "admission" | "audience_changed";
    /** An agent reply: shown with Teams' AI label and feedback buttons. */
    ai?: true;
    /** The turn an agent reply came from, for feedback about it. */
    turnId?: string;
    /**
     * A notice about the chat's session, shown with a button that opens it.
     * The button's URL is built when the notice is sent. `text` keeps the
     * notice with its URL written out, which is what replicas from before
     * notice cards send during a rolling deploy.
     */
    link?: "session";
    /** The notice as shown on the card, without its URL. */
    cardText?: string;
  };
  route_id: string;
};
const scope = (i: { account_id: string; workspace_id: string }) => ({
  accountId: i.account_id,
  workspaceId: i.workspace_id,
});
export const teamsScoped = <T>(
  db: Database,
  i: TeamsInstallation,
  fn: (tx: Database) => Promise<T>,
) =>
  withRlsContext(db, scope(i), async (tx) => {
    await tx.execute(
      sql`select id from workspaces where id=${i.workspace_id}::uuid and account_id=${i.account_id}::uuid for key share`,
    );
    return fn(tx);
  });
export async function listTeamsInstallations(
  db: Database,
  afterTenantId: string | null = null,
): Promise<TeamsInstallation[]> {
  return rawRows<TeamsInstallation>(
    db,
    sql`select tenant_id,account_id,workspace_id,generation,active,group_revision from teams_bot_installations where active and (${afterTenantId}::uuid is null or tenant_id>${afterTenantId}::uuid) order by tenant_id limit 100`,
  );
}
export async function getTeamsInstallation(
  db: Database,
  tenantId: string,
): Promise<TeamsInstallation | null> {
  return (
    (
      await rawRows<TeamsInstallation>(
        db,
        sql`select tenant_id,account_id,workspace_id,generation,active,group_revision from teams_bot_installations where tenant_id=${tenantId}::uuid limit 1`,
      )
    )[0] ?? null
  );
}
export async function getWorkspaceTeamsInstallation(
  db: Database,
  workspaceId: string,
): Promise<TeamsInstallation | null> {
  return (
    (
      await rawRows<TeamsInstallation>(
        db,
        sql`select tenant_id,account_id,workspace_id,generation,active,group_revision from teams_bot_installations where workspace_id=${workspaceId}::uuid limit 1`,
      )
    )[0] ?? null
  );
}
/**
 * How long a welcomed personal chat isn't welcomed again: long enough to cover
 * every delivery of one install, short enough that reinstalling later welcomes
 * the person afresh.
 */
export const TEAMS_WELCOME_WINDOW_MS = 10 * 60_000;
export type TeamsWelcomeClaim = { scopeHash: string; claimId: string };
/**
 * Claims the welcome for a personal chat, once across every API replica and
 * every delivery of the install. Null when the chat was claimed within
 * `windowMs`. Works before an organization has connected: the row holds only a
 * hash of the tenant and conversation, and grants nothing.
 */
export async function claimTeamsWelcome(
  db: Database,
  input: { tenantId: string; conversationId: string },
  windowMs: number = TEAMS_WELCOME_WINDOW_MS,
): Promise<TeamsWelcomeClaim | null> {
  const scopeHash = createHash("sha256")
    .update(`${input.tenantId.toLowerCase()}\n${input.conversationId.split(";")[0]}`)
    .digest("hex");
  const claimId = randomUUID();
  const rows = await rawRows<{ claim_id: string }>(
    db,
    sql`insert into teams_bot_welcomes(scope_hash,claim_id) values(${scopeHash},${claimId}::uuid) on conflict(scope_hash) do update set claim_id=excluded.claim_id,claimed_at=now() where teams_bot_welcomes.claimed_at<=now()-(${Math.max(0, Math.trunc(windowMs))}*interval '1 millisecond') returning claim_id`,
  );
  return rows.length ? { scopeHash, claimId } : null;
}
/** Gives up a claim whose welcome wasn't sent, unless a newer claim replaced it. */
export async function releaseTeamsWelcome(db: Database, claim: TeamsWelcomeClaim): Promise<void> {
  await db.execute(
    sql`delete from teams_bot_welcomes where scope_hash=${claim.scopeHash} and claim_id=${claim.claimId}::uuid`,
  );
}
/** How long a welcome claim is kept after its window: a day, then it is removed. */
export const TEAMS_WELCOME_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Removes up to `limit` claims older than the retention, so the table holds
 * roughly a day of installs. Returns how many it removed.
 */
export async function pruneTeamsWelcomes(
  db: Database,
  limit = 100,
  retentionMs: number = TEAMS_WELCOME_RETENTION_MS,
): Promise<number> {
  const rows = await rawRows<{ scope_hash: string }>(
    db,
    sql`delete from teams_bot_welcomes where scope_hash in (select scope_hash from teams_bot_welcomes where claimed_at<now()-(${Math.max(TEAMS_WELCOME_WINDOW_MS, Math.trunc(retentionMs))}*interval '1 millisecond') limit ${Math.max(1, Math.trunc(limit))} for update skip locked) returning scope_hash`,
  );
  return rows.length;
}
/**
 * How long an activity the bot answered itself isn't answered again: long
 * enough to cover every redelivery Teams makes of it.
 */
export const TEAMS_REPLY_CLAIM_WINDOW_MS = 10 * 60_000;
export type TeamsReplyClaim = { scopeHash: string; claimId: string };
/**
 * Claims the reply to one Teams activity (help, link, unlink, an onboarding
 * reply or a notice), once across every API replica and every redelivery of
 * the activity. Null when it was claimed within `windowMs`. Works before an
 * organization has connected: the row holds only a hash of the tenant,
 * conversation and activity id, and grants nothing.
 */
export async function claimTeamsReply(
  db: Database,
  input: { tenantId: string; conversationId: string; activityId: string },
  windowMs: number = TEAMS_REPLY_CLAIM_WINDOW_MS,
): Promise<TeamsReplyClaim | null> {
  const scopeHash = createHash("sha256")
    .update(
      `${input.tenantId.toLowerCase()}\n${input.conversationId.split(";")[0]}\n${input.activityId}`,
    )
    .digest("hex");
  const claimId = randomUUID();
  const rows = await rawRows<{ claim_id: string }>(
    db,
    sql`insert into teams_bot_reply_claims(scope_hash,claim_id) values(${scopeHash},${claimId}::uuid) on conflict(scope_hash) do update set claim_id=excluded.claim_id,claimed_at=now() where teams_bot_reply_claims.claimed_at<=now()-(${Math.max(0, Math.trunc(windowMs))}*interval '1 millisecond') returning claim_id`,
  );
  return rows.length ? { scopeHash, claimId } : null;
}
/** Gives up a claim whose reply Teams never received, unless a newer claim replaced it. */
export async function releaseTeamsReply(db: Database, claim: TeamsReplyClaim): Promise<void> {
  await db.execute(
    sql`delete from teams_bot_reply_claims where scope_hash=${claim.scopeHash} and claim_id=${claim.claimId}::uuid`,
  );
}
/** How long a reply claim is kept: a day, then it is removed. */
export const TEAMS_REPLY_CLAIM_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Removes up to `limit` reply claims older than the retention, so the table
 * holds roughly a day of replies. Returns how many it removed.
 */
export async function pruneTeamsReplyClaims(
  db: Database,
  limit = 100,
  retentionMs: number = TEAMS_REPLY_CLAIM_RETENTION_MS,
): Promise<number> {
  const rows = await rawRows<{ scope_hash: string }>(
    db,
    sql`delete from teams_bot_reply_claims where scope_hash in (select scope_hash from teams_bot_reply_claims where claimed_at<now()-(${Math.max(TEAMS_REPLY_CLAIM_WINDOW_MS, Math.trunc(retentionMs))}*interval '1 millisecond') limit ${Math.max(1, Math.trunc(limit))} for update skip locked) returning scope_hash`,
  );
  return rows.length;
}
/**
 * One limit on Teams onboarding replies: at most `max` replies per `spanMs`
 * window for `key` (such as a budget and a person, a tenant or the whole
 * deployment), and none within `cooldownMs` of the last. A window starts with
 * its first reply. Keys are hashed before they are stored.
 */
export type TeamsOnboardingWindow = {
  key: string;
  spanMs: number;
  max: number;
  cooldownMs?: number;
};
/** A granted reservation: when, on the database clock, it was counted. */
export type TeamsOnboardingGrant = { grantedAtMs: number };
type OnboardingLimitRow = {
  scope_hash: string;
  started_ms: number | string;
  count: number | string;
  last_ms: number | string | null;
};
function onboardingHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
function onboardingWindowsByHash(windows: TeamsOnboardingWindow[]) {
  const byHash = new Map<string, TeamsOnboardingWindow>();
  for (const window of windows) byHash.set(onboardingHash(window.key), window);
  // One order for every caller, so concurrent reservations lock rows alike.
  return new Map([...byHash].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
const ONBOARDING_ROW = sql.raw(
  "scope_hash,(extract(epoch from window_start)*1000)::float8 started_ms,count,(extract(epoch from last_at)*1000)::float8 last_ms",
);
const CLOCK_MS = sql.raw("(extract(epoch from clock_timestamp())*1000)::float8");
function onboardingHashes(keyed: Map<string, TeamsOnboardingWindow>) {
  return sql.join(
    [...keyed.keys()].map((hash) => sql`${hash}`),
    sql`,`,
  );
}
/** Whether `row`'s window started before `now` minus its span, so it starts afresh. */
function onboardingWindowEnded(
  row: OnboardingLimitRow,
  window: TeamsOnboardingWindow,
  now: number,
) {
  return now - Number(row.started_ms) >= window.spanMs;
}
/** Whether every window allows one more reply at `now`. Missing rows allow it. */
function onboardingAllowed(
  keyed: Map<string, TeamsOnboardingWindow>,
  rows: OnboardingLimitRow[],
  now: number,
): boolean {
  for (const row of rows) {
    const window = keyed.get(row.scope_hash);
    if (!window || onboardingWindowEnded(row, window, now)) continue;
    const count = Number(row.count);
    if (count >= window.max) return false;
    const last = row.last_ms === null ? null : Number(row.last_ms);
    if (window.cooldownMs && count > 0 && last !== null && now - last < window.cooldownMs)
      return false;
  }
  return true;
}
/**
 * Reserves one onboarding reply when every window allows it, across every API
 * replica; otherwise reserves nothing. A refusal is decided by a read alone,
 * so refused traffic writes nothing and waits on no lock. A grant locks the
 * rows in one order, then reads the database clock, so a reservation that
 * waited for a lock never sees a later reply as being in its future.
 */
export async function reserveTeamsOnboardingReply(
  db: Database,
  windows: TeamsOnboardingWindow[],
): Promise<TeamsOnboardingGrant | null> {
  const keyed = onboardingWindowsByHash(windows);
  if (!keyed.size) return { grantedAtMs: Date.now() };
  const seen = await rawRows<OnboardingLimitRow & { now_ms: number | string }>(
    db,
    sql`select ${ONBOARDING_ROW},${CLOCK_MS} now_ms from teams_bot_onboarding_limits where scope_hash in (${onboardingHashes(keyed)})`,
  );
  const seenNow = seen.length ? Number(seen[0]!.now_ms) : null;
  if (seenNow !== null && !onboardingAllowed(keyed, seen, seenNow)) return null;
  return await db.transaction(async (tx) => {
    // Creates missing rows (with no window yet: the first reply starts it)
    // and locks every row, in one order, without rewriting existing rows: a
    // conflicting row is locked even though `where false` leaves it as is.
    // Locked rows can't be pruned under the reservation.
    await tx.execute(
      sql`insert into teams_bot_onboarding_limits as l(scope_hash) values ${sql.join(
        [...keyed.keys()].map((hash) => sql`(${hash})`),
        sql`,`,
      )} on conflict(scope_hash) do update set count=l.count where false`,
    );
    const rows = await rawRows<OnboardingLimitRow>(
      tx,
      sql`select ${ONBOARDING_ROW} from teams_bot_onboarding_limits where scope_hash in (${onboardingHashes(keyed)})`,
    );
    const [clock] = await rawRows<{ now_ms: number | string }>(tx, sql`select ${CLOCK_MS} now_ms`);
    const now = Number(clock!.now_ms);
    if (!onboardingAllowed(keyed, rows, now)) return null;
    const at = sql`to_timestamp(${now}::float8/1000)`;
    const fresh = rows.flatMap((row) => {
      const window = keyed.get(row.scope_hash);
      return window && onboardingWindowEnded(row, window, now) ? [sql`${row.scope_hash}`] : [];
    });
    const freshSet = fresh.length ? sql.join(fresh, sql`,`) : sql`null`;
    await tx.execute(
      sql`update teams_bot_onboarding_limits set window_start=case when scope_hash in (${freshSet}) then ${at} else window_start end,count=case when scope_hash in (${freshSet}) then 1 else count+1 end,last_at=${at} where scope_hash in (${onboardingHashes(keyed)})`,
    );
    return { grantedAtMs: now };
  });
}
/**
 * Gives back a reservation whose reply Teams clearly never received. Only
 * while `owner` (the person's own window) still holds it: each window is given
 * back only if it is the one the reservation was counted in, not a later one.
 */
export async function releaseTeamsOnboardingReply(
  db: Database,
  grant: TeamsOnboardingGrant,
  owner: TeamsOnboardingWindow,
  windows: TeamsOnboardingWindow[],
): Promise<void> {
  const keyed = onboardingWindowsByHash([owner, ...windows]);
  const ownerHash = onboardingHash(owner.key);
  await db.transaction(async (tx) => {
    const rows = await rawRows<OnboardingLimitRow>(
      tx,
      sql`select ${ONBOARDING_ROW} from teams_bot_onboarding_limits where scope_hash in (${onboardingHashes(keyed)}) order by scope_hash for update`,
    );
    const [clock] = await rawRows<{ now_ms: number | string }>(tx, sql`select ${CLOCK_MS} now_ms`);
    const now = Number(clock!.now_ms);
    const live = rows.filter((row) => {
      const window = keyed.get(row.scope_hash);
      return (
        window &&
        Number(row.count) > 0 &&
        !onboardingWindowEnded(row, window, now) &&
        // Timestamps round-trip through float seconds; allow a millisecond.
        Number(row.started_ms) <= grant.grantedAtMs + 1
      );
    });
    if (!live.some((row) => row.scope_hash === ownerHash)) return;
    await tx.execute(
      // Without a reply in the window, there is no cooldown to wait out.
      sql`update teams_bot_onboarding_limits set count=count-1,last_at=case when count=1 then null else last_at end where scope_hash in (${sql.join(
        live.map((row) => sql`${row.scope_hash}`),
        sql`,`,
      )}) and count>0`,
    );
  });
}
/** How long an onboarding limit row is kept after its window began and its last reply. */
export const TEAMS_ONBOARDING_LIMIT_RETENTION_MS = 2 * 24 * 60 * 60_000;
/**
 * Removes up to `limit` onboarding limit rows whose window began and whose
 * last reply was over `retentionMs` ago. Returns how many it removed.
 */
export async function pruneTeamsOnboardingLimits(
  db: Database,
  limit = 100,
  retentionMs: number = TEAMS_ONBOARDING_LIMIT_RETENTION_MS,
): Promise<number> {
  const cutoff = sql`now()-(${Math.max(0, Math.trunc(retentionMs))}*interval '1 millisecond')`;
  const rows = await rawRows<{ scope_hash: string }>(
    db,
    sql`delete from teams_bot_onboarding_limits where scope_hash in (select scope_hash from teams_bot_onboarding_limits where window_start<${cutoff} and (last_at is null or last_at<${cutoff}) limit ${Math.max(1, Math.trunc(limit))} for update skip locked) returning scope_hash`,
  );
  return rows.length;
}
export async function installTeamsBot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    tenantId: string;
    actorId: string;
    subjectId: string;
    nonce: string;
    /**
     * Self-serve setup connects a new organization or reactivates its own
     * disconnected binding; it never rotates an active installation, even
     * when two setups race.
     */
    requireInactive?: boolean;
    /**
     * A disconnected binding of this tenant in another workspace to remove in
     * the same transaction, so the move either completes or changes nothing.
     */
    replaceInactive?: { installation: TeamsInstallation; audit: DisconnectAuditActor } | null;
  },
) {
  return withRlsContext(db, input, async (tx) => {
    await tx.execute(
      sql`select id from workspaces where id=${input.workspaceId}::uuid and account_id=${input.accountId}::uuid for key share`,
    );
    await tx.execute(
      sql`insert into teams_bot_proofs(account_id,workspace_id,nonce) values(${input.accountId}::uuid,${input.workspaceId}::uuid,${input.nonce}::uuid)`,
    );
    if (input.replaceInactive) {
      const old = input.replaceInactive.installation;
      if (old.tenant_id !== input.tenantId || old.workspace_id === input.workspaceId)
        throw new Error("teams_installation_changed");
      if (!(await releaseInactiveTeamsInstallation(tx, old, input.replaceInactive.audit)))
        throw new Error("teams_installation_changed");
    }
    const rows = await rawRows<TeamsInstallation>(
      tx,
      input.requireInactive
        ? sql`insert into teams_bot_installations(tenant_id,account_id,workspace_id) values(${input.tenantId}::uuid,${input.accountId}::uuid,${input.workspaceId}::uuid)
    on conflict(tenant_id) do update set active=true,generation=gen_random_uuid() where teams_bot_installations.workspace_id=excluded.workspace_id and not teams_bot_installations.active returning *`
        : sql`insert into teams_bot_installations(tenant_id,account_id,workspace_id) values(${input.tenantId}::uuid,${input.accountId}::uuid,${input.workspaceId}::uuid)
    on conflict(tenant_id) do update set active=true,generation=gen_random_uuid() where teams_bot_installations.workspace_id=excluded.workspace_id returning *`,
    );
    if (!rows[0]) {
      const [current] = await rawRows<{ workspace_id: string; active: boolean }>(
        tx,
        sql`select workspace_id,active from teams_bot_installations where tenant_id=${input.tenantId}::uuid`,
      );
      throw new Error(
        current?.workspace_id === input.workspaceId && current.active
          ? "teams_installation_already_active"
          : "teams_tenant_already_bound",
      );
    }
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='installation_replaced' where state='pending' and route_id in(select route_id from teams_bot_routes where tenant_id=${input.tenantId}::uuid and generation<>${rows[0].generation}::uuid)`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='installation_replaced' where state in ('pending','sending') and route_id in(select route_id from teams_bot_routes where tenant_id=${input.tenantId}::uuid and generation<>${rows[0].generation}::uuid)`,
    );
    const linked = await rawRows(
      tx,
      sql`insert into teams_bot_links(account_id,workspace_id,tenant_id,actor_id,subject_id) values(${input.accountId}::uuid,${input.workspaceId}::uuid,${input.tenantId}::uuid,${input.actorId}::uuid,${input.subjectId}) on conflict(tenant_id,actor_id) do update set subject_id=excluded.subject_id where teams_bot_links.subject_id=excluded.subject_id returning actor_id`,
    );
    if (!linked.length) throw new Error("teams_identity_already_linked");
    return rows[0];
  });
}
/**
 * Removes a disconnected tenant binding from its workspace, inside the
 * caller's transaction, so a verified tenant administrator can connect the
 * organization to another workspace. Deleting the installation also deletes
 * its account links, routes and their delivery records (sessions remain). The
 * removal is audited in the old workspace with what it removed. Returns false,
 * changing nothing, when the binding was reactivated or changed after `i` was
 * read.
 */
async function releaseInactiveTeamsInstallation(
  tx: Database,
  i: TeamsInstallation,
  audit: DisconnectAuditActor,
): Promise<boolean> {
  return teamsScoped(tx, i, async (scoped) => {
    const [held] = await rawRows<{ tenant_id: string }>(
      scoped,
      sql`select tenant_id from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid and generation=${i.generation}::uuid and not active for update`,
    );
    if (!held) return false;
    const [counts] = await rawRows<{ links: number; routes: number }>(
      scoped,
      sql`select (select count(*)::int from teams_bot_links where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid) as links,(select count(*)::int from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid) as routes`,
    );
    await scoped.execute(
      sql`delete from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid`,
    );
    await insertDisconnectAuditEventInScope(scoped, {
      accountId: i.account_id,
      workspaceId: i.workspace_id,
      action: CONNECTION_DISCONNECTED_AUDIT_ACTION,
      actor: audit,
      target: { type: "teams_bot_installation", id: i.tenant_id, provider: "microsoft_teams" },
      details: {
        reason: "released_by_tenant_administrator",
        removedLinks: counts?.links ?? 0,
        removedRoutes: counts?.routes ?? 0,
      },
    });
    return true;
  });
}
export async function linkTeamsActor(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string; subjectId: string; nonce: string },
) {
  return teamsScoped(db, i, async (tx) => {
    const active = await rawRows(
      tx,
      sql`select 1 from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and active and generation=${i.generation}::uuid for update`,
    );
    if (!active.length) throw new Error("teams_installation_changed");
    await tx.execute(
      sql`insert into teams_bot_proofs(account_id,workspace_id,nonce) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${input.nonce}::uuid)`,
    );
    const rows = await rawRows(
      tx,
      sql`insert into teams_bot_links(account_id,workspace_id,tenant_id,actor_id,subject_id) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.actorId}::uuid,${input.subjectId}) on conflict(tenant_id,actor_id) do update set subject_id=excluded.subject_id where teams_bot_links.subject_id=excluded.subject_id returning actor_id`,
    );
    if (!rows.length) throw new Error("teams_identity_already_linked");
  });
}
export async function getTeamsActor(
  db: Database,
  i: TeamsInstallation,
  actorId: string,
): Promise<string | null> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<{ subject_id: string }>(
          tx,
          sql`select subject_id from teams_bot_links where tenant_id=${i.tenant_id}::uuid and actor_id=${actorId}::uuid`,
        )
      )[0]?.subject_id ?? null,
  );
}
export async function getOwnTeamsLink(db: Database, i: TeamsInstallation, subjectId: string) {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<{ actor_id: string }>(
          tx,
          sql`select actor_id from teams_bot_links where tenant_id=${i.tenant_id}::uuid and subject_id=${subjectId}`,
        )
      )[0] ?? null,
  );
}
export async function removeTeamsLink(db: Database, i: TeamsInstallation, subjectId: string) {
  return teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`select 1 from teams_bot_installations where tenant_id=${i.tenant_id}::uuid for update`,
    );
    const [link] = await rawRows<{ actor_id: string }>(
      tx,
      sql`select actor_id from teams_bot_links where tenant_id=${i.tenant_id}::uuid and subject_id=${subjectId}`,
    );
    if (!link) return;
    await tx.execute(
      sql`update teams_bot_installations set group_revision=group_revision+1 where tenant_id=${i.tenant_id}::uuid`,
    );
    await tx.execute(
      sql`select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and group_audience @> ${JSON.stringify([{ actorId: link.actor_id, subjectId }])}::jsonb order by route_id for update`,
    );
    await tx.execute(
      sql`update teams_bot_routes set group_active=false where tenant_id=${i.tenant_id}::uuid and group_audience @> ${JSON.stringify([{ actorId: link.actor_id, subjectId }])}::jsonb`,
    );
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='group_audience_changed' where state='pending' and route_id in(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and group_audience @> ${JSON.stringify([{ actorId: link.actor_id, subjectId }])}::jsonb)`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='group_audience_changed' where state in ('pending','sending') and route_id in(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and group_audience @> ${JSON.stringify([{ actorId: link.actor_id, subjectId }])}::jsonb)`,
    );
    await tx.execute(
      sql`select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and (actor_id=${link.actor_id}::uuid or exists(select 1 from teams_bot_inbox inbox where inbox.route_id=teams_bot_routes.route_id and inbox.actor_id=${link.actor_id}::uuid and inbox.state='pending')) order by route_id for update`,
    );
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='actor_unlinked' where workspace_id=${i.workspace_id}::uuid and actor_id=${link.actor_id}::uuid and state='pending'`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='actor_unlinked' where state in ('pending','sending') and route_id in(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and actor_id=${link.actor_id}::uuid)`,
    );
    await tx.execute(
      sql`update teams_bot_routes set delivered_sequence=greatest(delivered_sequence,relevant_event_sequence) where tenant_id=${i.tenant_id}::uuid and actor_id=${link.actor_id}::uuid`,
    );
    await tx.execute(
      sql`delete from teams_bot_links where tenant_id=${i.tenant_id}::uuid and actor_id=${link.actor_id}::uuid and subject_id=${subjectId}`,
    );
  });
}
export async function disconnectTeamsBot(
  db: Database,
  i: TeamsInstallation,
  options: {
    /** Who disconnected the bot: audited in the same transaction when it was active. */
    audit?: DisconnectAuditActor | null;
  } = {},
) {
  return teamsScoped(db, i, async (tx) => {
    const [prior] = await rawRows<{ active: boolean }>(
      tx,
      sql`select active from teams_bot_installations where tenant_id=${i.tenant_id}::uuid for update`,
    );
    await tx.execute(
      sql`update teams_bot_installations set active=false,generation=gen_random_uuid() where tenant_id=${i.tenant_id}::uuid`,
    );
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='installation_disconnected' where workspace_id=${i.workspace_id}::uuid and state='pending'`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='installation_disconnected' where workspace_id=${i.workspace_id}::uuid and state in ('pending','sending')`,
    );
    await tx.execute(
      sql`delete from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid`,
    );
    await tx.execute(
      sql`delete from teams_bot_context_cutoffs where workspace_id=${i.workspace_id}::uuid`,
    );
    // Parked switch-card messages are unusable after the generation changes.
    await tx.execute(
      sql`delete from teams_bot_route_prompts where workspace_id=${i.workspace_id}::uuid`,
    );
    if (options.audit && prior?.active) {
      await insertDisconnectAuditEventInScope(tx, {
        accountId: i.account_id,
        workspaceId: i.workspace_id,
        action: CONNECTION_DISCONNECTED_AUDIT_ACTION,
        actor: options.audit,
        target: { type: "teams_bot_installation", id: i.tenant_id, provider: "microsoft_teams" },
      });
    }
  });
}
export async function enqueueTeamsMessage(
  db: Database,
  i: TeamsInstallation,
  input: {
    routeId: string;
    actorId: string;
    subjectId: string;
    personal: boolean;
    channelId?: string | null;
    groupAudience?: TeamsGroupAudience;
    groupRevision?: number;
    conversationId: string;
    threadId: string | null;
    serviceUrl: string;
    botId: string;
    eventId: string;
    payload: unknown;
    /** A 1:1 route's session in the sender's own Personal workspace. */
    sessionWorkspaceId?: string | null;
    /**
     * The caller's live authority check for a 1:1 route that names another
     * workspace of the organization or an agent, run in the enqueue
     * transaction with `tx` (read everything through it). It replaces the
     * Personal-workspace-only rule and must also confirm the agent may run in
     * that workspace. A route that names an agent is refused without it.
     * Throws `teams_reach_changed` when the organization's Teams reach
     * changed while it ran; the caller may check again.
     */
    authorizeSessionWorkspace?: (
      tx: Database,
      target: { workspaceId: string; agentId: string | null },
    ) => Promise<boolean>;
    /** The agent a 1:1 route's chat runs as. */
    agentId?: string | null;
  },
) {
  if (input.groupAudience && input.groupRevision === undefined)
    throw new Error("teams_group_revision_missing");
  const sessionWorkspaceId = input.sessionWorkspaceId ?? null;
  const agentId = input.agentId ?? null;
  if (
    sessionWorkspaceId &&
    (!input.personal ||
      input.groupAudience ||
      input.channelId ||
      sessionWorkspaceId === i.workspace_id)
  )
    throw new Error("teams_route_unavailable");
  if (agentId && (!input.personal || input.groupAudience || input.channelId))
    throw new Error("teams_route_unavailable");
  return teamsScoped(db, i, async (tx) => {
    // Only the linked person's own Personal workspace, named by their active
    // organization membership, can hold their 1:1 chat, unless workspace
    // routing checks their live access to the workspace (and the agent) here.
    // The check reads the organization's Teams reach; the reach version it
    // saw must still be current once the installation row is locked below,
    // so a reach change committed meanwhile refuses the message instead of
    // racing it (a later one waits for this transaction).
    let checkedReachVersion: string | null = null;
    if (input.authorizeSessionWorkspace && (sessionWorkspaceId || agentId)) {
      const [before] = await rawRows<{ reach_version: string | number }>(
        tx,
        sql`select reach_version from teams_bot_installations where tenant_id=${i.tenant_id}::uuid`,
      );
      if (!before) throw new Error("teams_installation_changed");
      checkedReachVersion = String(before.reach_version);
      if (
        !(await input.authorizeSessionWorkspace(tx, {
          workspaceId: sessionWorkspaceId ?? i.workspace_id,
          agentId,
        }))
      )
        throw new Error("teams_route_unavailable");
    } else if (agentId) throw new Error("teams_route_unavailable");
    else if (
      sessionWorkspaceId &&
      (await namedSubjectPersonalWorkspaceId(tx, {
        accountId: i.account_id,
        subjectId: input.subjectId,
      })) !== sessionWorkspaceId
    )
      throw new Error("teams_route_unavailable");
    const active = await rawRows<{ reach_version: string | number }>(
      tx,
      sql`select reach_version from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and active and generation=${i.generation}::uuid and (${input.groupRevision ?? null}::bigint is null or group_revision=${input.groupRevision ?? null}::bigint) for update`,
    );
    if (!active.length) throw new Error("teams_installation_changed");
    if (checkedReachVersion !== null && String(active[0]!.reach_version) !== checkedReachVersion)
      throw new Error("teams_reach_changed");
    if (input.groupAudience) {
      const [current] = await rawRows<{ route_id: string; group_audience: TeamsGroupAudience }>(
        tx,
        sql`select route_id,group_audience from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and generation=${i.generation}::uuid and conversation_id=${input.conversationId} and group_active and group_audience is not null for update`,
      );
      if (
        current &&
        JSON.stringify(current.group_audience.map((x) => [x.actorId, x.subjectId])) ===
          JSON.stringify(input.groupAudience.map((x) => [x.actorId, x.subjectId]))
      )
        input = { ...input, routeId: current.route_id };
      else {
        await tx.execute(
          sql`update teams_bot_installations set group_revision=group_revision+1 where tenant_id=${i.tenant_id}::uuid`,
        );
        await tx.execute(
          sql`update teams_bot_routes set group_active=false where tenant_id=${i.tenant_id}::uuid and conversation_id=${input.conversationId} and group_audience is not null and group_active`,
        );
        await settleInactiveTeamsGroups(tx, i, input.conversationId);
        input = { ...input, routeId: `teams-group:${randomUUID()}` };
      }
    }
    // A route that names no agent keeps the shape a previous release writes.
    if (agentId)
      await tx.execute(sql`insert into teams_bot_routes(account_id,workspace_id,tenant_id,route_id,generation,actor_id,subject_id,personal,channel_id,conversation_id,thread_id,service_url,bot_id,group_audience,group_active,session_workspace_id,agent_id)
   values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.routeId},${i.generation}::uuid,${input.actorId}::uuid,${input.subjectId},${input.personal},${input.channelId ?? null},${input.conversationId},${input.threadId},${input.serviceUrl},${input.botId},null::jsonb,false,${sessionWorkspaceId}::uuid,${agentId}::uuid) on conflict(route_id) do nothing`);
    else
      await tx.execute(sql`insert into teams_bot_routes(account_id,workspace_id,tenant_id,route_id,generation,actor_id,subject_id,personal,channel_id,conversation_id,thread_id,service_url,bot_id,group_audience,group_active,session_workspace_id)
   values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.routeId},${i.generation}::uuid,${input.actorId}::uuid,${input.subjectId},${input.personal},${input.channelId ?? null},${input.conversationId},${input.threadId},${input.serviceUrl},${input.botId},${input.groupAudience ? JSON.stringify(input.groupAudience) : null}::jsonb,${Boolean(input.groupAudience)},${sessionWorkspaceId}::uuid) on conflict(route_id) do nothing`);
    const [route] = await rawRows<TeamsRoute>(
      tx,
      sql`select * from teams_bot_routes where route_id=${input.routeId}`,
    );
    if (
      !route ||
      route.generation !== i.generation ||
      (route.personal && route.actor_id !== input.actorId) ||
      (route.session_workspace_id ?? null) !== sessionWorkspaceId ||
      (route.agent_id ?? null) !== agentId
    )
      throw new Error("teams_route_unavailable");
    const inserted = await rawRows(
      tx,
      sql`insert into teams_bot_inbox(account_id,workspace_id,event_id,route_id,actor_id,subject_id,payload) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${input.eventId},${input.routeId},${input.actorId}::uuid,${input.subjectId},${JSON.stringify(input.payload)}::jsonb) on conflict(event_id) do nothing returning event_id`,
    );
    return {
      /** The route the message joined, which for a group chat may be a new one. */
      routeId: input.routeId,
      /** False when the event was already queued, as on a redelivery. */
      queued: inserted.length > 0,
      /** The route's reply progress when the message was queued; see `teamsReplyPending`. */
      replySequence: Number(route.relevant_event_sequence),
    };
  });
}
export async function claimTeamsRoute(
  db: Database,
  i: TeamsInstallation,
): Promise<TeamsRoute | null> {
  return teamsScoped(db, i, async (tx) => {
    const token = randomUUID();
    return (
      (
        await rawRows<TeamsRoute>(
          tx,
          sql`update teams_bot_routes set lease_token=${token}::uuid,lease_until=now()+interval '2 minutes',last_claimed_at=clock_timestamp() where route_id=(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and generation=${i.generation}::uuid and (lease_until is null or lease_until<now()) and (
 relevant_event_sequence>delivered_sequence
 or exists(select 1 from teams_bot_inbox inbox where inbox.route_id=teams_bot_routes.route_id and inbox.state='pending')
 or exists(select 1 from teams_bot_outbox outbox where outbox.route_id=teams_bot_routes.route_id and outbox.state='sending')
 or (select outbox.retry_at<=now() from teams_bot_outbox outbox where outbox.route_id=teams_bot_routes.route_id and outbox.state='pending' order by source_sequence,part_index limit 1)
 ) order by last_claimed_at nulls first,route_id for update skip locked limit 1) returning *`,
        )
      )[0] ?? null
    );
  });
}
export async function releaseTeamsRoute(db: Database, i: TeamsInstallation, r: TeamsRoute) {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`update teams_bot_routes set lease_until=now()+interval '2 seconds',lease_token=null where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid`,
    );
  });
}
export async function getTeamsPendingMessage(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
): Promise<TeamsInbox | null> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<TeamsInbox>(
          tx,
          sql`select * from teams_bot_inbox where route_id=${r.route_id} and state='pending' order by created_at,event_id limit 1`,
        )
      )[0] ?? null,
  );
}
export async function settleTeamsMessage(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  eventId: string,
  error: string | null,
  /** The session turn that answers an admitted message, when known. */
  turnId: string | null = null,
) {
  await teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid for update`,
    );
    if (!owned.length) return;
    await tx.execute(
      sql`update teams_bot_inbox set state=${error ? "failed" : "accepted"},error_code=${error},turn_id=${error ? null : turnId}::uuid where event_id=${eventId}`,
    );
    if (!error)
      await tx.execute(
        sql`update teams_bot_routes set session_bound=true where route_id=${r.route_id}`,
      );
  });
}
/**
 * Records that a turn's reply, request for input or failure was queued for
 * Teams, which ends typing for the messages that turn answers.
 */
export async function markTeamsTurnAnswered(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  turnId: string,
) {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`update teams_bot_inbox set replied_at=now() where route_id=${r.route_id} and turn_id=${turnId}::uuid and replied_at is null`,
    );
  });
}
/**
 * The routing notes (`payload.teamsRouting`) of the messages a turn answers,
 * oldest first: what the ingress recorded about where each one was sent.
 */
export async function getTeamsTurnRouting(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  turnId: string,
): Promise<Record<string, unknown>[]> {
  return teamsScoped(db, i, async (tx) =>
    (
      await rawRows<{ routing: unknown }>(
        tx,
        sql`select payload->'teamsRouting' as routing from teams_bot_inbox
          where route_id=${r.route_id} and turn_id=${turnId}::uuid order by created_at,event_id limit 20`,
      )
    )
      .map((row) => row.routing)
      .filter(
        (routing): routing is Record<string, unknown> =>
          typeof routing === "object" && routing !== null && !Array.isArray(routing),
      ),
  );
}
export async function enqueueTeamsOutput(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  sequence: number,
  parts: string[],
  notice?: { eventId: string; kind: "admission" | "audience_changed" },
  reply?: { turnId: string | null },
  card?: { link: "session"; text: string },
) {
  await teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid for update`,
    );
    if (!owned.length) return;
    for (const [index, text] of parts.entries())
      await tx.execute(
        sql`insert into teams_bot_outbox(account_id,workspace_id,operation_id,route_id,source_sequence,part_index,payload) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${`${r.route_id}:${notice ? `notice:${notice.eventId}` : sequence}:${index}`},${r.route_id},${sequence},${index},${JSON.stringify({ text, ...(notice ? { notice: notice.kind } : {}), ...(reply ? { ai: true, ...(reply.turnId ? { turnId: reply.turnId } : {}) } : {}), ...(card ? { link: card.link, cardText: card.text } : {}) })}::jsonb) on conflict(operation_id) do nothing`,
      );
    await tx.execute(
      sql`update teams_bot_routes set delivered_sequence=greatest(delivered_sequence,${sequence}) where route_id=${r.route_id}`,
    );
  });
}
/**
 * Whether the reply to one inbound message is still being produced: the
 * message waits to be admitted, or it was admitted and the turn answering it
 * has had no reply, request for input or failure queued yet. A message
 * admitted without a known turn falls back to its chat: no reply, request
 * or failure since it was queued (`replySequence` from
 * `enqueueTeamsMessage`). Both lookups are by primary key.
 */
export async function teamsReplyPending(
  db: Database,
  i: TeamsInstallation,
  input: { eventId: string; replySequence: number },
): Promise<boolean> {
  return teamsScoped(db, i, async (tx) => {
    const [row] = await rawRows<{
      state: string;
      turn_id: string | null;
      replied_at: unknown;
      progress: string | number;
    }>(
      tx,
      sql`select inbox.state,inbox.turn_id,inbox.replied_at,r.relevant_event_sequence as progress from teams_bot_inbox inbox join teams_bot_routes r on r.route_id=inbox.route_id where inbox.event_id=${input.eventId}`,
    );
    if (!row) return false;
    if (row.state === "pending") return true;
    if (row.state !== "accepted") return false;
    return row.turn_id ? row.replied_at === null : Number(row.progress) <= input.replySequence;
  });
}
/** An agent reply the bot delivered in one Teams conversation, found by its Teams message id. */
export type TeamsDeliveredReply = {
  route_id: string;
  /** The installation's workspace, which holds the route. */
  workspace_id: string;
  subject_id: string;
  actor_id: string;
  personal: boolean;
  session_id: string;
  session_workspace_id: string | null;
  agent_id: string | null;
  turn_id: string | null;
};
export async function getTeamsDeliveredReply(
  db: Database,
  i: TeamsInstallation,
  input: { conversationId: string; providerMessageId: string },
): Promise<TeamsDeliveredReply | null> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<TeamsDeliveredReply>(
          tx,
          sql`select r.route_id,r.workspace_id::text as workspace_id,r.subject_id,r.actor_id::text as actor_id,r.personal,r.session_id,r.session_workspace_id,r.agent_id::text as agent_id,o.payload->>'turnId' as turn_id from teams_bot_routes r join teams_bot_outbox o on o.route_id=r.route_id where r.tenant_id=${i.tenant_id}::uuid and r.generation=${i.generation}::uuid and split_part(r.conversation_id,';',1)=${input.conversationId.split(";")[0]} and r.session_bound and o.state='delivered' and o.provider_message_id=${input.providerMessageId} and o.payload->>'ai'='true' limit 1`,
        )
      )[0] ?? null,
  );
}
export async function claimTeamsOutput(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  noticesOnly = false,
): Promise<TeamsOutbox | null> {
  return teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now() for update`,
    );
    if (!owned.length) return null;
    // A previous sender that lost its lease has an unknown provider outcome.
    // Do not blindly repeat it, even after restart.
    await tx.execute(
      sql`update teams_bot_outbox set state='unknown',error_code='sender_interrupted' where route_id=${r.route_id} and state='sending'`,
    );
    return (
      (
        await rawRows<TeamsOutbox>(
          tx,
          sql`update teams_bot_outbox set state='sending' where operation_id=(select operation_id from teams_bot_outbox where route_id=${r.route_id} and state='pending' and (${noticesOnly}=false or source_sequence=-1) order by source_sequence,created_at,part_index,operation_id for update skip locked limit 1) and retry_at<=now() returning *`,
        )
      )[0] ?? null
    );
  });
}
export async function settleTeamsOutput(
  db: Database,
  i: TeamsInstallation,
  operationId: string,
  result: {
    state: "delivered" | "unknown" | "failed" | "pending";
    providerMessageId?: string;
    error?: string;
    retryMs?: number;
  },
) {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`update teams_bot_outbox set state=${result.state},provider_message_id=${result.providerMessageId ?? null},error_code=${result.error ?? null},retry_at=now()+(${result.retryMs ?? 0}*interval '1 millisecond') where operation_id=${operationId} and state='sending'`,
    );
  });
}

export async function renewTeamsRoute(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
): Promise<boolean> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows(
          tx,
          sql`update teams_bot_routes set lease_until=now()+interval '2 minutes' where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now() returning route_id`,
        )
      ).length === 1,
  );
}
export async function teamsDeliveryStatus(db: Database, i: TeamsInstallation, subjectId: string) {
  return teamsScoped(db, i, async (tx) => {
    const [row] = await rawRows<{ pending: number; unknown: number; failed: number }>(
      tx,
      sql`select count(*) filter(where state in ('pending','sending'))::integer as pending,count(*) filter(where state='unknown')::integer as unknown,count(*) filter(where state='failed')::integer as failed from teams_bot_outbox where route_id in(select route_id from teams_bot_routes where subject_id=${subjectId})`,
    );
    return row ?? { pending: 0, unknown: 0, failed: 0 };
  });
}

export async function refuseTeamsRouteOutputs(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  error: string,
) {
  await teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>clock_timestamp() for update`,
    );
    if (!owned.length) return;

    await tx.execute(
      sql`update teams_bot_outbox set state='failed',error_code=${error} where route_id=${r.route_id} and state='pending' and exists(select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now())`,
    );
    await tx.execute(
      sql`update teams_bot_routes set delivered_sequence=greatest(delivered_sequence,relevant_event_sequence) where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now()`,
    );
  });
}

/** Membership notifications only revoke; a later verified roster creates a new route. */
export async function invalidateTeamsGroup(
  db: Database,
  i: TeamsInstallation,
  conversationId: string,
  expected: { routeId?: string; revision?: number; leaseToken?: string | null } = {},
): Promise<void> {
  return teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`select tenant_id from teams_bot_installations where tenant_id=${i.tenant_id}::uuid for update`,
    );
    const live = await rawRows(
      tx,
      sql`select tenant_id from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and generation=${i.generation}::uuid and active and (${expected.revision ?? null}::bigint is null or group_revision=${expected.revision ?? null}::bigint)`,
    );
    if (!live.length) return;
    if (expected.routeId) {
      const current = await rawRows(
        tx,
        sql`select route_id from teams_bot_routes where route_id=${expected.routeId} and tenant_id=${i.tenant_id}::uuid and generation=${i.generation}::uuid and conversation_id=${conversationId} and group_active and (${expected.leaseToken ?? null}::uuid is null or (lease_token=${expected.leaseToken ?? null}::uuid and lease_until>clock_timestamp())) for update`,
      );
      if (!current.length) return;
    }
    await tx.execute(
      sql`update teams_bot_installations set group_revision=group_revision+1 where tenant_id=${i.tenant_id}::uuid`,
    );
    await tx.execute(
      sql`select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and conversation_id=${conversationId} and group_audience is not null order by route_id for update`,
    );
    await tx.execute(
      sql`update teams_bot_routes set group_active=false where tenant_id=${i.tenant_id}::uuid and conversation_id=${conversationId} and group_audience is not null and group_active`,
    );
    await settleInactiveTeamsGroups(tx, i, conversationId);
  });
}

export async function teamsGroupRouteActive(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
): Promise<boolean> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows(
          tx,
          sql`select route_id from teams_bot_routes where route_id=${r.route_id} and generation=${i.generation}::uuid and group_active and lease_token=${r.lease_token}::uuid and lease_until>clock_timestamp()`,
        )
      ).length === 1,
  );
}

async function settleInactiveTeamsGroups(
  tx: Database,
  i: TeamsInstallation,
  conversationId: string,
): Promise<void> {
  await tx.execute(
    sql`select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and conversation_id=${conversationId} and group_audience is not null and not group_active order by route_id for update`,
  );
  await tx.execute(
    sql`update teams_bot_inbox set state='failed',error_code='group_audience_changed' where state='pending' and route_id in(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and conversation_id=${conversationId} and group_audience is not null and not group_active)`,
  );
  await tx.execute(
    sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='group_audience_changed' where state in ('pending','sending') and route_id in(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and conversation_id=${conversationId} and group_audience is not null and not group_active)`,
  );
}

/** Messages kept per channel thread or group chat, newest first. */
export const TEAMS_CONTEXT_MESSAGES_PER_THREAD = 100;
/** How long a recorded message stays available as context. */
export const TEAMS_CONTEXT_RETENTION_DAYS = 7;

export type TeamsContextRecord = {
  messageId: string;
  actorId: string;
  actorName: string | null;
  text: string;
  hasAttachments: boolean;
  mentioned: boolean;
  occurredAt: Date;
};

/**
 * Keeps one human message from a shared Teams conversation as context for a
 * later mention. Idempotent per message; trims the conversation thread to its
 * newest `TEAMS_CONTEXT_MESSAGES_PER_THREAD` rows and drops the workspace's
 * rows past retention as it goes.
 */
export async function recordTeamsContextMessage(
  db: Database,
  i: TeamsInstallation,
  input: {
    conversationId: string;
    threadId: string | null;
    messageId: string;
    actorId: string;
    actorName: string | null;
    text: string;
    hasAttachments: boolean;
    mentioned: boolean;
    occurredAt: string;
  },
): Promise<void> {
  const thread = input.threadId ?? "";
  await teamsScoped(db, i, async (tx) => {
    // Shares the installation row with disconnect, which deletes every
    // recorded message: a write racing it either lands first and is deleted,
    // or sees the installation inactive and records nothing.
    const [current] = await rawRows<{ ok: number }>(
      tx,
      sql`select 1 as ok from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid and generation=${i.generation}::uuid and active for share`,
    );
    if (!current) return;
    // A message from before people were last added to the chat is never
    // kept, even when Teams delivers it after the cleanup (see
    // clearTeamsContextConversation, which holds this row exclusively).
    await tx.execute(sql`insert into teams_bot_context_messages(account_id,workspace_id,tenant_id,conversation_id,thread_id,message_id,actor_id,actor_name,text,has_attachments,mentioned,occurred_at)
      select ${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.conversationId},${thread},${input.messageId},${input.actorId}::uuid,${input.actorName?.slice(0, 256) ?? null},${input.text.slice(0, 4000)},${input.hasAttachments},${input.mentioned},${input.occurredAt}::timestamptz
      where not exists (select 1 from teams_bot_context_cutoffs where workspace_id=${i.workspace_id}::uuid and conversation_id=${input.conversationId} and cutoff_at>=${input.occurredAt}::timestamptz)
      on conflict(workspace_id,conversation_id,message_id) do nothing`);
    await tx.execute(
      sql`delete from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and conversation_id=${input.conversationId} and thread_id=${thread} and message_id in (select message_id from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and conversation_id=${input.conversationId} and thread_id=${thread} order by occurred_at desc, message_id desc offset ${TEAMS_CONTEXT_MESSAGES_PER_THREAD})`,
    );
    await tx.execute(
      sql`delete from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and (conversation_id,message_id) in (select conversation_id,message_id from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and created_at<now()-make_interval(days=>${TEAMS_CONTEXT_RETENTION_DAYS}) limit 500)`,
    );
  });
}

/**
 * Recorded messages in one channel thread or group chat before a mention,
 * newest first: at most `limit`, excluding the mention itself and anything
 * recorded after it. With `rootPostsOnly`, only channel root posts (a new
 * channel post mentioning Opengeni sees the posts before it).
 */
export async function listTeamsContextMessages(
  db: Database,
  i: TeamsInstallation,
  input: {
    conversationId: string;
    threadId: string | null;
    beforeMessageId: string;
    notAfter: string;
    limit: number;
    rootPostsOnly?: boolean;
  },
): Promise<TeamsContextRecord[]> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit), 200));
  const rows = await teamsScoped(db, i, (tx) =>
    rawRows<{
      message_id: string;
      actor_id: string;
      actor_name: string | null;
      text: string;
      has_attachments: boolean;
      mentioned: boolean;
      occurred_at: Date | string;
    }>(
      tx,
      input.rootPostsOnly
        ? sql`select message_id,actor_id,actor_name,text,has_attachments,mentioned,occurred_at from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and tenant_id=${i.tenant_id}::uuid and conversation_id=${input.conversationId} and thread_id=message_id and message_id<>${input.beforeMessageId} and occurred_at<=${input.notAfter}::timestamptz and created_at>=now()-make_interval(days=>${TEAMS_CONTEXT_RETENTION_DAYS}) and not exists (select 1 from teams_bot_context_cutoffs c where c.workspace_id=${i.workspace_id}::uuid and c.conversation_id=${input.conversationId} and c.cutoff_at>=teams_bot_context_messages.occurred_at) order by occurred_at desc, message_id desc limit ${limit}`
        : sql`select message_id,actor_id,actor_name,text,has_attachments,mentioned,occurred_at from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and tenant_id=${i.tenant_id}::uuid and conversation_id=${input.conversationId} and thread_id=${input.threadId ?? ""} and message_id<>${input.beforeMessageId} and occurred_at<=${input.notAfter}::timestamptz and created_at>=now()-make_interval(days=>${TEAMS_CONTEXT_RETENTION_DAYS}) and not exists (select 1 from teams_bot_context_cutoffs c where c.workspace_id=${i.workspace_id}::uuid and c.conversation_id=${input.conversationId} and c.cutoff_at>=teams_bot_context_messages.occurred_at) order by occurred_at desc, message_id desc limit ${limit}`,
    ),
  );
  return rows.map((row) => ({
    messageId: row.message_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    text: row.text,
    hasAttachments: row.has_attachments,
    mentioned: row.mentioned,
    occurredAt: new Date(row.occurred_at),
  }));
}

/**
 * Marks a recorded message as a mention Opengeni accepted, so a later mention
 * that continues the same chat reads back only to it. Refused mentions stay
 * ordinary context.
 */
export async function markTeamsContextMentionAccepted(
  db: Database,
  i: TeamsInstallation,
  input: { conversationId: string; messageId: string },
): Promise<void> {
  await teamsScoped(db, i, (tx) =>
    tx.execute(
      sql`update teams_bot_context_messages set mentioned=true where workspace_id=${i.workspace_id}::uuid and conversation_id=${input.conversationId} and message_id=${input.messageId}`,
    ),
  );
}

/**
 * Applies a Teams edit or deletion to a recorded message: an edit replaces its
 * text, and a deletion (or an edit that leaves nothing) removes it. Messages
 * never recorded stay unrecorded.
 */
export async function reviseTeamsContextMessage(
  db: Database,
  i: TeamsInstallation,
  input: {
    conversationId: string;
    messageId: string;
    edit: { text: string; hasAttachments: boolean } | null;
  },
): Promise<void> {
  await teamsScoped(db, i, (tx) =>
    input.edit && (input.edit.text || input.edit.hasAttachments)
      ? tx.execute(
          sql`update teams_bot_context_messages set text=${input.edit.text.slice(0, 4000)},has_attachments=${input.edit.hasAttachments} where workspace_id=${i.workspace_id}::uuid and conversation_id=${input.conversationId} and message_id=${input.messageId}`,
        )
      : tx.execute(
          sql`delete from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and conversation_id=${input.conversationId} and message_id=${input.messageId}`,
        ),
  );
}

/**
 * Forgets every recorded message in one conversation and moves its join
 * cutoff to now: when people are added to a group chat, a newcomer must not
 * get answers built from history Teams did not share with them. Holding the
 * installation row exclusively orders this against every context write (which
 * shares it), so a delayed delivery of an older message either lands first and
 * is deleted here, or sees the new cutoff and is not kept.
 */
export async function clearTeamsContextConversation(
  db: Database,
  i: TeamsInstallation,
  conversationId: string,
): Promise<void> {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`select 1 from teams_bot_installations where tenant_id=${i.tenant_id}::uuid for update`,
    );
    await tx.execute(
      sql`insert into teams_bot_context_cutoffs(account_id,workspace_id,tenant_id,conversation_id,cutoff_at)
        values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${conversationId},clock_timestamp())
        on conflict(workspace_id,conversation_id) do update set cutoff_at=greatest(teams_bot_context_cutoffs.cutoff_at,excluded.cutoff_at)`,
    );
    await tx.execute(
      sql`delete from teams_bot_context_messages where workspace_id=${i.workspace_id}::uuid and conversation_id=${conversationId}`,
    );
  });
}

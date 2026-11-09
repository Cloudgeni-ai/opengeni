import { randomUUID } from "node:crypto";
import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import type { ApiRouteDeps } from "@opengeni/core";
import type { AccessContext } from "@opengeni/contracts";
import { hasPermission, managedPersonForAccessContext, requireAccessContext } from "@opengeni/core";
import { getConnectionMetadata, getWorkspace, withAccountRls } from "@opengeni/db";
import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { ApiHttpError } from "../http/api-error";
import { managedPasskeySignInOffered } from "../routes/managed-passkeys";

/* ----------------------------------------------------------------------------
   Admin step-up (CASA 3.3.1). An organization owner or admin, or a workspace
   admin, changing admin settings must have used a passkey in the last ten
   minutes: in this browser session, or, for an agent, native app or personal
   API key acting as them, in any of their sessions. Normal members, personal
   workspaces and programmatic organization or workspace API keys are not
   affected; those keep their own permission checks. Reads never need it.
   -------------------------------------------------------------------------- */

export const ADMIN_STEP_UP_WINDOW_MS = 10 * 60_000;
const STEP_UP_IDENTIFIER_PREFIX = "opengeni-admin-step-up:";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Scope = "organization" | "workspace" | "billing";
type AdminRoute = {
  scope: Scope;
  pattern: RegExp;
  /**
   * Only a shared (workspace or organization) connection is an admin setting:
   * one this request creates, or the existing one it changes.
   */
  shared?: "created" | "existing";
};

const ORG = "/v1/organizations/(?<organizationId>[^/]+)";
const WS = "/v1/workspaces/(?<workspaceId>[^/]+)";
const CONNECTION = "(?<connectionId>[0-9a-fA-F-]{36})";
const route = (scope: Scope, source: string, options: Partial<AdminRoute> = {}): AdminRoute => ({
  scope,
  pattern: new RegExp(`^${source}/?$`, "u"),
  ...options,
});

/**
 * The admin functions, as mutations. Everything under an organization is an
 * admin setting except a person's own API keys and identity lookups; in a
 * workspace, its settings, members, keys, shared integrations and connections.
 */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  route(
    "organization",
    `${ORG}(?!/personal-api-keys(?:/|$)|/external-identities/lookup/?$)(?:/.*)?`,
  ),
  route("workspace", WS),
  route("workspace", `${WS}/settings`),
  route("workspace", `${WS}/(?:members|external-members)(?:/[^/]+)?`),
  route("workspace", `${WS}/api-keys(?:/[^/]+)?`),
  route("workspace", `${WS}/(?:credential-provider|webhooks)(?:/.*)?`),
  route("workspace", `${WS}/(?:model-policy|default-rig|model-account-settings)(?:/.*)?`),
  route("workspace", `${WS}/(?:gateway|openrouter|opper)-custom-models(?:/[^/]+)?`),
  route("workspace", `${WS}/(?:vault-providers|vaults)(?:/.*)?`),
  route("workspace", `${WS}/integrations/(?:install|[^/]+/organization)`),
  route("workspace", `${WS}/integrations/[^/]+/instances/.+`),
  route("workspace", `${WS}/capabilities/[^/]+/(?:enable|disable|installation|tool-permissions)`),
  route("workspace", `${WS}/plugins/(?!preview/?$)[^/]+`),
  route("workspace", `${WS}/github/(?:installations|app-manifest|action-policies)(?:/.*)?`),
  route("workspace", `${WS}/(?:video-generation/policy|site-limit-profile|inference-control)`),
  route("workspace", `${WS}/connections/[^/]+/slack-bot/organization-access`),
  route("workspace", `${WS}/(?:slack-task-policy|agent-policy)(?:/.*)?`),
  route("workspace", `${WS}/(?:.+/)?allowance(?:/.*)?`),
  route(
    "workspace",
    `${WS}/(?:connections|connections/oauth/start|integrations/oauth/start|connect/attempts|connections/(?:slack-bot|1password)/install)`,
    { shared: "created" },
  ),
  route("workspace", `${WS}/connections/${CONNECTION}(?:/.*)?`, { shared: "existing" }),
  route("billing", "/v1/billing/(?:checkout|portal|alerts|subscription/.+|auto-top-up(?:/.*)?)"),
];

export function matchAdminRoute(
  method: string,
  pathname: string,
): {
  route: AdminRoute;
  organizationId?: string;
  workspaceId?: string;
  connectionId?: string;
} | null {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return null;
  for (const candidate of ADMIN_ROUTES) {
    const match = candidate.pattern.exec(pathname);
    if (!match) continue;
    const groups = match.groups ?? {};
    return {
      route: candidate,
      ...(groups.organizationId ? { organizationId: groups.organizationId } : {}),
      ...(groups.workspaceId ? { workspaceId: groups.workspaceId } : {}),
      ...(groups.connectionId ? { connectionId: groups.connectionId } : {}),
    };
  }
  return null;
}

export function adminStepUpEnforced(deps: Pick<ApiRouteDeps, "settings" | "managedAuth">): boolean {
  return (
    deps.settings.adminPasskeyStepUp === "required" &&
    deps.managedAuth !== undefined &&
    deps.managedAuth !== null &&
    managedPasskeySignInOffered(deps)
  );
}

async function rows<T>(
  deps: Pick<ApiRouteDeps, "db">,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await deps.db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Record that this person just used a passkey in this browser session. Stored
 * as a plain identifier (a person and session id, no secret) so it can be
 * looked up per person; the person's lapsed records are removed meanwhile.
 */
export async function recordAdminStepUp(
  deps: Pick<ApiRouteDeps, "db">,
  input: { authUserId: string; authSessionId: string },
): Promise<void> {
  const prefix = `${STEP_UP_IDENTIFIER_PREFIX}${input.authUserId}:`;
  await deps.db.execute(sql`
    with lapsed as (
      delete from auth_verifications
      where starts_with(identifier, ${prefix}) and expires_at <= clock_timestamp()
    )
    insert into auth_verifications (id, identifier, value, expires_at)
    values (${randomUUID()}, ${`${prefix}${input.authSessionId}`}, 'passkey',
      clock_timestamp() + make_interval(secs => ${ADMIN_STEP_UP_WINDOW_MS / 1000}))`);
}

/**
 * Whether this person used a passkey within the window: in this browser
 * session when one is named, otherwise in any of their sessions still signed in.
 */
export async function hasRecentAdminStepUp(
  deps: Pick<ApiRouteDeps, "db">,
  input: { authUserId: string; authSessionId: string | null },
): Promise<boolean> {
  const prefix = `${STEP_UP_IDENTIFIER_PREFIX}${input.authUserId}:`;
  const [found] = await rows<{ fresh: boolean }>(
    deps,
    input.authSessionId
      ? sql`select exists(select 1 from auth_verifications
          where identifier = ${`${prefix}${input.authSessionId}`}
          and expires_at > clock_timestamp()) as fresh`
      : sql`select exists(select 1 from auth_verifications
          v join auth_sessions s on s.user_id = ${input.authUserId}
            and v.identifier = ${prefix} || s.id
          where s.expires_at > clock_timestamp()
          and v.expires_at > clock_timestamp()) as fresh`,
  );
  return found?.fresh === true;
}

async function hasPasskey(deps: Pick<ApiRouteDeps, "db">, authUserId: string): Promise<boolean> {
  const [found] = await rows<{ present: boolean }>(
    deps,
    sql`select exists(select 1 from auth_passkeys where user_id = ${authUserId}) as present`,
  );
  return found?.present === true;
}

type StepUpPerson = { authUserId: string; authSessionId: string | null };

/**
 * The person behind this request, from how access resolution authenticated
 * it: their browser session, or (any of their sessions) an approved native
 * app or an agent or personal API key acting as them. Null for organization
 * and workspace API keys, services, host-signed delegation, external people
 * and anyone not signed in (the route refuses that itself).
 */
function stepUpPerson(context: AccessContext): StepUpPerson | null {
  const person = managedPersonForAccessContext(context);
  if (!person) return null;
  return {
    authUserId: person.authUserId,
    authSessionId: person.via.kind === "browser_session" ? person.via.authSessionId : null,
  };
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!c.req.header("content-type")?.toLowerCase().includes("json")) return null;
  try {
    // A copy: the route reads the body itself.
    const body = (await c.req.raw.clone().json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Every organization this billing request could name, as the routes read it. */
async function billingAccountIds(c: Context, context: AccessContext): Promise<string[]> {
  const body = await jsonBody(c);
  return [c.req.query("accountId"), body?.accountId, context.defaultAccountId].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
}

/**
 * Whether a new connection would be shared with the workspace. The routes
 * create a shared one unless ownership is the person's own ("personal", or
 * "user" for vault providers) or, with no ownership, a subject is named. An
 * omitted ownership may default to personal for some providers; asking an
 * admin then is only an extra confirmation. No JSON body (the Slack bot
 * install takes none) names no person, so it is shared too.
 */
export function createsSharedConnection(body: Record<string, unknown> | null): boolean {
  if (!body) return true;
  if (body.ownership === "personal" || body.ownership === "user") return false;
  if (body.ownership === undefined && typeof body.subjectId === "string") return false;
  return true;
}

async function changesSharedConnection(
  deps: ApiRouteDeps,
  context: AccessContext,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> {
  const existing = await getConnectionMetadata(
    deps.db,
    workspaceId,
    connectionId,
    context.subjectId,
  ).catch(() => null);
  return existing !== null && existing.subjectId === null;
}

/** An owner or admin of this organization (by role, or a literal admin grant). */
function organizationAdmin(context: AccessContext, accountId: string | undefined): boolean {
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (!grant) return false;
  return (
    grant.role === "owner" ||
    grant.role === "admin" ||
    grant.permissions.includes("account:admin") ||
    grant.permissions.includes("members:manage")
  );
}

/**
 * Whether the person administers what this request changes: an owner or
 * admin of its organization, or an admin of its shared workspace. A personal
 * workspace is the person's own, never an admin setting.
 */
async function administers(
  c: Context,
  deps: ApiRouteDeps,
  context: AccessContext,
  matched: NonNullable<ReturnType<typeof matchAdminRoute>>,
): Promise<boolean> {
  if (matched.route.scope === "billing") {
    const accountIds = await billingAccountIds(c, context);
    return accountIds.some((accountId) => organizationAdmin(context, accountId));
  }
  if (matched.workspaceId) {
    const workspaceId = matched.workspaceId;
    const grant = context.workspaceGrants.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    // Its organization: the grant's, or (an organization admin may hold no
    // grant of their own here) one the person administers.
    const accountIds = grant
      ? [grant.accountId]
      : context.accountGrants
          .filter((candidate) => organizationAdmin(context, candidate.accountId))
          .map((candidate) => candidate.accountId);
    let workspace: Awaited<ReturnType<typeof getWorkspace>> = null;
    for (const accountId of accountIds) {
      workspace = await withAccountRls(deps.db, accountId, (tx) =>
        getWorkspace(tx, workspaceId),
      ).catch(() => null);
      if (workspace?.accountId === accountId) break;
      workspace = null;
    }
    if (!workspace || workspace.kind === "personal") return false;
    if (matched.route.shared === "created" && !createsSharedConnection(await jsonBody(c)))
      return false;
    if (
      matched.route.shared === "existing" &&
      !(
        matched.connectionId &&
        (await changesSharedConnection(deps, context, workspaceId, matched.connectionId))
      )
    )
      return false;
    if (grant && hasPermission(grant.permissions, "workspace:admin", grant.permissionMode))
      return true;
    return organizationAdmin(context, workspace.accountId);
  }
  return organizationAdmin(context, matched.organizationId);
}

/**
 * Refuse an admin change by a person who hasn't used a passkey recently, with
 * ADMIN_PASSKEY_STEP_UP_REQUIRED and whether they have a passkey to use.
 */
export function adminStepUpGuard(deps: ApiRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!adminStepUpEnforced(deps)) return await next();
    // The decoded path Hono routes on, so an escaped path can't route to an
    // admin handler without matching here.
    const matched = matchAdminRoute(c.req.method, c.req.path);
    if (!matched) return await next();
    let context: AccessContext;
    try {
      context = await requireAccessContext(c, deps);
    } catch {
      // Not signed in, or refused: the route answers that itself.
      return await next();
    }
    const person = stepUpPerson(context);
    if (!person || !(await administers(c, deps, context, matched))) return await next();
    if (await hasRecentAdminStepUp(deps, person)) return await next();
    const passkeyRegistered = await hasPasskey(deps, person.authUserId);
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: passkeyRegistered
        ? "Confirm it's you with your passkey to change admin settings."
        : "Add a passkey to your account to change admin settings.",
      details: {
        code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE,
        passkeyRegistered,
        browserRequired: person.authSessionId === null,
      },
      retryable: false,
    });
  };
}

import { randomUUID } from "node:crypto";
import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  getManagedSession,
  getNativeAppManagedSession,
  NATIVE_APP_CREDENTIAL_PREFIX,
  requireAccessContext,
  verifiedDelegatedHumanAuthorizationForRequest,
} from "@opengeni/core";
import { getWorkspace } from "@opengeni/db";
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
  /** Only a shared (workspace or organization) connection is an admin setting. */
  sharedOwnershipOnly?: true;
};

const ORG = "/v1/organizations/(?<organizationId>[^/]+)";
const WS = "/v1/workspaces/(?<workspaceId>[^/]+)";
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
  route("workspace", `${WS}/connections/[^/]+/slack-bot/organization-access`),
  route("workspace", `${WS}/(?:slack-task-policy|agent-policy)(?:/.*)?`),
  route("workspace", `${WS}/(?:.+/)?allowance(?:/.*)?`),
  route(
    "workspace",
    `${WS}/(?:connections|connections/oauth/start|integrations/oauth/start|connect/attempts)`,
    { sharedOwnershipOnly: true },
  ),
  route("billing", "/v1/billing/(?:checkout|portal|alerts|subscription/.+|auto-top-up(?:/.*)?)"),
];

export function matchAdminRoute(
  method: string,
  pathname: string,
): { route: AdminRoute; organizationId?: string; workspaceId?: string } | null {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return null;
  for (const candidate of ADMIN_ROUTES) {
    const match = candidate.pattern.exec(pathname);
    if (!match) continue;
    const groups = match.groups ?? {};
    return {
      route: candidate,
      ...(groups.organizationId ? { organizationId: groups.organizationId } : {}),
      ...(groups.workspaceId ? { workspaceId: groups.workspaceId } : {}),
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
 * session when one is named, otherwise in any of their sessions.
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
          where starts_with(identifier, ${prefix})
          and expires_at > clock_timestamp()) as fresh`,
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
 * The person behind this request, or null for a caller step-up does not
 * apply to: an organization or workspace API key, a service, a host-signed
 * delegated token, or nobody signed in (the route refuses that itself).
 */
async function stepUpPerson(c: Context, deps: ApiRouteDeps): Promise<StepUpPerson | null> {
  const delegated = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  if (delegated)
    return { authUserId: delegated.subjectId.slice("user:".length), authSessionId: null };
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    const bearer = /^Bearer\s+(.+)$/iu.exec(authorization)?.[1]?.trim();
    if (!bearer?.startsWith(NATIVE_APP_CREDENTIAL_PREFIX)) return null;
    const session = await getNativeAppManagedSession(deps.managedAuth!, bearer, deps.db);
    return session?.user ? { authUserId: session.user.id, authSessionId: null } : null;
  }
  if (c.req.header("x-opengeni-external-actor") !== undefined) return null;
  const session = await getManagedSession(c, deps.managedAuth!, {
    db: deps.db,
    sessionSetMode: deps.settings.managedAuthSessionSetMode,
    sessionAdapter: deps.managedAuthSessionAdapter,
  });
  const sessionId = (session as { session?: { id?: unknown } } | null)?.session?.id;
  if (!session?.user || typeof sessionId !== "string") return null;
  return { authUserId: session.user.id, authSessionId: sessionId };
}

async function requestedAccountId(c: Context): Promise<string | undefined> {
  const query = c.req.query("accountId");
  if (query) return query;
  if (!c.req.header("content-type")?.includes("application/json")) return undefined;
  try {
    const body = (await c.req.raw.clone().json()) as { accountId?: unknown } | null;
    return typeof body?.accountId === "string" ? body.accountId : undefined;
  } catch {
    return undefined;
  }
}

async function requestsSharedOwnership(c: Context): Promise<boolean> {
  try {
    // A copy: the route reads the body itself.
    const body = (await c.req.raw.clone().json()) as { ownership?: unknown } | null;
    return body?.ownership === "workspace" || body?.ownership === "organization";
  } catch {
    return false;
  }
}

/**
 * Whether the person administers what this request changes: an owner or
 * admin of its organization, or an admin of its shared workspace. A personal
 * workspace is the person's own, never an admin setting.
 */
async function administers(
  c: Context,
  deps: ApiRouteDeps,
  matched: NonNullable<ReturnType<typeof matchAdminRoute>>,
): Promise<boolean> {
  let context: Awaited<ReturnType<typeof requireAccessContext>>;
  try {
    context = await requireAccessContext(c, deps);
  } catch {
    return false;
  }
  const organizationAdmin = (accountId: string | undefined) => {
    const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
    return (
      grant !== undefined &&
      (grant.permissions.includes("members:manage") || grant.permissions.includes("account:admin"))
    );
  };
  if (matched.route.scope === "billing") {
    return organizationAdmin(
      (await requestedAccountId(c)) ?? context.defaultAccountId ?? undefined,
    );
  }
  if (matched.workspaceId) {
    const workspace = await getWorkspace(deps.db, matched.workspaceId).catch(() => null);
    if (!workspace || workspace.kind === "personal") return false;
    if (matched.route.sharedOwnershipOnly && !(await requestsSharedOwnership(c))) return false;
    const grant = context.workspaceGrants.find(
      (candidate) => candidate.workspaceId === matched.workspaceId,
    );
    if (grant?.permissions.includes("workspace:admin")) return true;
    return organizationAdmin(workspace.accountId);
  }
  return organizationAdmin(matched.organizationId);
}

/**
 * Refuse an admin change by a person who hasn't used a passkey recently, with
 * ADMIN_PASSKEY_STEP_UP_REQUIRED and whether they have a passkey to use.
 */
export function adminStepUpGuard(deps: ApiRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!adminStepUpEnforced(deps)) return await next();
    const matched = matchAdminRoute(c.req.method, new URL(c.req.url).pathname);
    if (!matched) return await next();
    const person = await stepUpPerson(c, deps);
    if (!person || !(await administers(c, deps, matched))) return await next();
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

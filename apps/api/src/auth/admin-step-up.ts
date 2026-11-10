import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import type { ApiRouteDeps } from "@opengeni/core";
import type { AccessContext } from "@opengeni/contracts";
import {
  hasPermission,
  holdsOrganizationAdministration,
  managedBrowserSessionForAccessContext,
  requireAccessContext,
} from "@opengeni/core";
import { getConnectionMetadata, getWorkspace, withAccountRls } from "@opengeni/db";
import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { ApiHttpError } from "../http/api-error";
import { managedPasskeySignInOffered } from "../routes/managed-passkeys";

/* ----------------------------------------------------------------------------
   Admin step-up (CASA 3.3.1). An organization owner or admin, or a workspace
   admin, changing admin settings in a browser must be in a session confirmed
   with a passkey: signed in with one, or confirmed with one once in it. The
   mark is on the session row (auth_sessions.mfa_verified_at), so it lasts as
   long as the session and goes with it on sign-out or revocation. Creating a
   personal API key is gated the same way for such an admin.

   Only browser sessions are asked. An approved native app, and an agent or
   personal API key acting as the person, act under the person's existing
   authority; organization and workspace API keys, services and delegation
   keep their own permission checks. Normal members, personal workspaces and
   reads never need it.
   -------------------------------------------------------------------------- */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Scope = "organization" | "workspace" | "billing" | "personal_api_key";
type AdminRoute = {
  scope: Scope;
  /** Only these methods (default: every mutation). */
  methods?: readonly string[];
  pattern: RegExp;
  /**
   * Only a shared (workspace or organization) connection is an admin setting:
   * one this request creates, or the existing one it changes.
   */
  shared?: "created" | "existing";
};

// Every form PostgreSQL reads as a uuid (hyphens optional, braces allowed), so
// an id written differently still matches.
const UUID =
  "\\{?[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\\}?";
const ORG = "/v1/organizations/(?<organizationId>[^/]+)";
const UUID_DIGITS =
  /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/iu;

/**
 * An id in the one form grants and rows carry it (lowercase, hyphenated), so
 * an id written differently in the path compares equal. Anything else as is.
 */
export function canonicalId(value: string): string {
  const parts = UUID_DIGITS.exec(value);
  return parts ? parts.slice(1).join("-").toLowerCase() : value;
}
const WS = `/v1/workspaces/(?<workspaceId>${UUID})`;
const CONNECTION = `(?<connectionId>${UUID})`;
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
    `${WS}/(?:connections|connections/oauth/start|integrations/oauth/start|connect/attempts|connections/(?:slack-bot|1password|fiken)/install|connections/fiken/oauth/start)`,
    { shared: "created" },
  ),
  // An existing connection, also under a provider's own routes
  // (connections/atlassian/<id>/source, connections/google-drive/<id>/lifecycle).
  route("workspace", `${WS}/connections/(?:[^/]+/)?${CONNECTION}(?:/.*)?`, {
    shared: "existing",
  }),
  route("billing", "/v1/billing/(?:checkout|portal|alerts|subscription/.+|auto-top-up(?:/.*)?)"),
  // Creating a key that acts as an admin; using or revoking one isn't asked.
  route("personal_api_key", `${ORG}/personal-api-keys`, { methods: ["POST"] }),
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
  const verb = method.toUpperCase();
  if (!MUTATING_METHODS.has(verb)) return null;
  for (const candidate of ADMIN_ROUTES) {
    if (candidate.methods && !candidate.methods.includes(verb)) continue;
    const match = candidate.pattern.exec(pathname);
    if (!match) continue;
    const groups = match.groups ?? {};
    return {
      route: candidate,
      ...(groups.organizationId ? { organizationId: canonicalId(groups.organizationId) } : {}),
      ...(groups.workspaceId ? { workspaceId: canonicalId(groups.workspaceId) } : {}),
      ...(groups.connectionId ? { connectionId: canonicalId(groups.connectionId) } : {}),
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
 * Mark this browser session as confirmed with a passkey, for as long as it
 * lasts. Only the person's own live session is marked; false when there is
 * none (signed out or expired meanwhile).
 */
export async function recordAdminStepUp(
  deps: Pick<ApiRouteDeps, "db">,
  input: { authUserId: string; authSessionId: string },
): Promise<boolean> {
  const marked = await rows<{ id: string }>(
    deps,
    sql`update auth_sessions set mfa_verified_at = clock_timestamp()
    where id = ${input.authSessionId} and user_id = ${input.authUserId}
      and expires_at > clock_timestamp()
    returning id`,
  );
  return marked.length > 0;
}

/** Whether this browser session is live and was confirmed with a passkey. */
export async function adminStepUpVerified(
  deps: Pick<ApiRouteDeps, "db">,
  input: { authUserId: string; authSessionId: string },
): Promise<boolean> {
  const [found] = await rows<{ verified: boolean }>(
    deps,
    sql`select exists(select 1 from auth_sessions
      where id = ${input.authSessionId} and user_id = ${input.authUserId}
      and expires_at > clock_timestamp() and mfa_verified_at is not null) as verified`,
  );
  return found?.verified === true;
}

async function hasPasskey(deps: Pick<ApiRouteDeps, "db">, authUserId: string): Promise<boolean> {
  const [found] = await rows<{ present: boolean }>(
    deps,
    sql`select exists(select 1 from auth_passkeys where user_id = ${authUserId}) as present`,
  );
  return found?.present === true;
}

type StepUpPerson = {
  authUserId: string;
  authSessionId: string;
  /** The request's own access: a browser session is never narrowed. */
  access: AccessContext;
};

/**
 * The person signed in in this browser session, or null for every other
 * caller: an approved native app, an agent or API key acting as a person,
 * organization and workspace API keys, services, host-signed delegation,
 * external people and anyone not signed in (the route refuses that itself).
 */
function stepUpPerson(context: AccessContext): StepUpPerson | null {
  const session = managedBrowserSessionForAccessContext(context);
  return session ? { ...session, access: context } : null;
}

/** The body as JSON, whatever its content type (routes parse it regardless). */
async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    // A copy: the route reads the body itself.
    const text = await c.req.raw.clone().text();
    if (!text) return null;
    const body = JSON.parse(text) as unknown;
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
  return [c.req.query("accountId"), body?.accountId, context.defaultAccountId]
    .filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    .map(canonicalId);
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
  try {
    const existing = await getConnectionMetadata(
      deps.db,
      workspaceId,
      connectionId,
      context.subjectId,
    );
    return existing !== null && existing.subjectId === null;
  } catch {
    // Can't tell: ask, rather than let a failed lookup skip the check.
    return true;
  }
}

/** An owner or admin of this organization, as the organization routes decide it. */
function organizationAdmin(access: AccessContext, accountId: string | undefined): boolean {
  return accountId !== undefined && holdsOrganizationAdministration(access, accountId);
}

/**
 * Whether the person is an owner or admin of this organization, or an admin
 * of one of its shared workspaces. Every person administers their own
 * personal workspace, so the workspace's kind is read, not assumed.
 */
async function administersInOrganization(
  deps: ApiRouteDeps,
  access: AccessContext,
  organizationId: string | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  if (organizationAdmin(access, organizationId)) return true;
  const adminOf = access.workspaceGrants.filter(
    (grant) =>
      grant.accountId === organizationId &&
      hasPermission(grant.permissions, "workspace:admin", grant.permissionMode),
  );
  if (adminOf.length === 0) return false;
  try {
    return await withAccountRls(deps.db, organizationId, async (tx) => {
      for (const grant of adminOf) {
        const workspace = await getWorkspace(tx, grant.workspaceId);
        if (workspace && workspace.accountId === organizationId && workspace.kind !== "personal")
          return true;
      }
      return false;
    });
  } catch {
    // Can't tell: ask, rather than let a failed lookup skip the check.
    return true;
  }
}

/**
 * Whether the person administers what this request changes: an owner or
 * admin of its organization, or an admin of its shared workspace. A personal
 * workspace is the person's own, never an admin setting. Decided from the
 * person's own membership, so a narrowly scoped key of theirs counts too.
 */
async function administers(
  c: Context,
  deps: ApiRouteDeps,
  context: AccessContext,
  person: StepUpPerson,
  matched: NonNullable<ReturnType<typeof matchAdminRoute>>,
): Promise<boolean> {
  const access = person.access;
  if (matched.route.scope === "personal_api_key") {
    return administersInOrganization(deps, access, matched.organizationId);
  }
  if (matched.route.scope === "billing") {
    const accountIds = await billingAccountIds(c, context);
    return accountIds.some((accountId) => organizationAdmin(access, accountId));
  }
  if (matched.workspaceId) {
    const workspaceId = matched.workspaceId;
    const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
    const workspaceAdmin =
      grant !== undefined &&
      hasPermission(grant.permissions, "workspace:admin", grant.permissionMode);
    // Its organization: the grant's, or (an organization admin may hold no
    // grant of their own here) one the person administers.
    const accountIds = grant
      ? [grant.accountId]
      : access.accountGrants
          .filter((candidate) => organizationAdmin(access, candidate.accountId))
          .map((candidate) => candidate.accountId);
    let workspace: Awaited<ReturnType<typeof getWorkspace>> = null;
    try {
      for (const accountId of accountIds) {
        workspace = await withAccountRls(deps.db, accountId, (tx) => getWorkspace(tx, workspaceId));
        if (workspace?.accountId === accountId) break;
        workspace = null;
      }
    } catch {
      // Can't tell: an admin is asked rather than let a failed lookup skip it.
      return workspaceAdmin || accountIds.some((id) => organizationAdmin(access, id));
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
    return workspaceAdmin || organizationAdmin(access, workspace.accountId);
  }
  return organizationAdmin(access, matched.organizationId);
}

/**
 * Refuse an admin change from a browser session not confirmed with a passkey,
 * with ADMIN_PASSKEY_STEP_UP_REQUIRED and whether they have a passkey to use.
 */
export function adminStepUpGuard(deps: ApiRouteDeps): MiddlewareHandler {
  if (deps.settings.adminPasskeyStepUp === "required" && !adminStepUpEnforced(deps)) {
    // Required, but passkey sign-in isn't offered here (not managed, another
    // session-set mode, or passkeys unavailable): nothing can be confirmed.
    console.warn("admin_passkey_step_up_not_enforced", {
      reason: "OPENGENI_ADMIN_PASSKEY_STEP_UP=required, but passkey sign-in is not offered",
    });
  }
  return async function adminStepUpMiddleware(c, next) {
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
    if (!person || !(await administers(c, deps, context, person, matched))) return await next();
    if (await adminStepUpVerified(deps, person)) return await next();
    const passkeyRegistered = await hasPasskey(deps, person.authUserId);
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: passkeyRegistered
        ? "Confirm it's you with your passkey to change admin settings."
        : "Add a passkey to your account to change admin settings.",
      details: {
        code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE,
        passkeyRegistered,
      },
      retryable: false,
    });
  };
}

import { signupCreditModelIds } from "@opengeni/config";
import { ApiHttpError } from "../http/api-error";
import {
  lookupExternalIdentityForRequest,
  cancelExternalWorkspaceMemberGrantForRequest,
  updateExternalWorkspaceMemberForRequest,
  getOrganizationPrivacySettings,
  OrganizationPrivacyLockedError,
  privacyDeploymentLimits,
  updateOrganizationPrivacySettings,
} from "@opengeni/core";
import {
  type Permission,
  AcceptOrganizationInvitationRequest,
  CreateAdditionalOrganizationRequest,
  CreateAdditionalOrganizationResponse,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  CreateOrganizationWorkspaceRequest,
  CreateOrganizationInvitationRequest,
  ListManagedOrganizationMembershipsResponse,
  ListOrganizationInvitationsPageQuery,
  ListOrganizationInvitationsPageResponse,
  ListOrganizationAdministrationMembersResponse,
  OrganizationAdministrationOverview,
  OrganizationInferenceResidency,
  OrganizationInvitation,
  OrganizationUserSetupDelivery,
  OrganizationMember,
  OrganizationPrivacySettings,
  OrganizationPrivateSessionSettings,
  OrganizationRetentionPolicy,
  OrganizationSummary,
  OrganizationWorkspaceAccess,
  OrganizationWorkspaceAccessMember,
  PutOrganizationWorkspaceMemberRequest,
  RevokeOrganizationInvitationRequest,
  RetryOrganizationUserSetupDeliveryRequest,
  RevokeOrganizationWorkspaceMemberRequest,
  RevokeOrganizationWorkspaceMemberResponse,
  UpdateOrganizationInferenceResidencyRequest,
  UpdateOrganizationMemberRequest,
  UpdateOrganizationNameRequest,
  UpdateOrganizationPrivacySettingsRequest,
  UpdateOrganizationPrivateSessionSettingsRequest,
  UpdateOrganizationRetentionPolicyRequest,
  UpdateOrganizationWorkspaceRequest,
  UpdateWorkspaceSettingsRequest,
  Workspace,
} from "@opengeni/contracts";
import {
  getManagedSession,
  accountScopedApiKeyWorkspaceAuthority,
  organizationWorkspaceInScope,
  hasPermission,
  requireAccessContext,
  organizationMembershipHttpStatus,
  requireCanonicalLocalAccountAdministrator,
  updateExternalIdentityMembershipForRequest,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  bindPendingOrganizationInvitationsForVerifiedEmail,
  claimOrganizationUserSetupDelivery,
  createAdditionalManagedOrganization,
  createManagedOrganization,
  createOrganizationWorkspace,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationAdministrationOverview,
  getOrganizationInferenceResidency,
  InferenceResidencyChangeRefusedError,
  type InferenceResidencyActorKind,
  updateOrganizationInferenceResidency,
  getOrganizationInvitationForAdministration,
  getOrganizationPrivacyPreferences,
  getOrganizationPrivateSessionSettings,
  getSelfOrganizationInvitation,
  getOrganizationRetentionPolicy,
  requireWorkspace,
  listOrganizationAdministrationMembers,
  listOrganizationInvitations,
  listSelfOrganizationInvitations,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  prepareOrganizationUserSetupDelivery,
  revokeOrganizationInvitation,
  settleOrganizationUserSetupDelivery,
  putOrganizationWorkspaceMember,
  revokeOrganizationWorkspaceMember,
  updateOrganizationWorkspace,
  updateOrganizationSharedWorkspaceSettings,
  updateOrganizationMember,
  updateOrganizationName,
  updateOrganizationPrivateSessionSettings,
  updateOrganizationRetentionPolicy,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteWorkspaceForRequest } from "../workspace-deletion";
import { accountContactEmail } from "@opengeni/contracts/passkey-only-account";
import {
  agentActingAsPerson,
  isAgentActingAsPerson,
  organizationSettingsPermission,
} from "../http/acting-person";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { hasRecentManagedSignIn } from "./managed-sign-in-methods";

import {
  assertOrganizationUserSetupDeliveryConfigured,
  resolveOrganizationUserSetupDeliveryEmail,
} from "../auth/organization-user-setup";
import { parseRequestBody, parseRequestQuery, readRequestJson } from "../http/request-body";

const OrganizationId = z.string().uuid();
const WorkspaceId = z.string().uuid();
const MembershipId = z.string().uuid();
const InvitationId = z.string().uuid();

// Organization keys administer settings, not another person's session contents.
// The database independently fences current key authority, including on replay.
async function requirePrivateSessionAdministrator(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<{ subjectId: string }> {
  const agent = agentActingAsPerson(
    context,
    organizationId,
    organizationSettingsPermission(context),
  );
  if (agent) return agent;
  if (!context.req.header("authorization")) return requireManagedHuman(context, deps);
  const access = await requireAccessContext(context, deps);
  const key = accountScopedApiKeyWorkspaceAuthority(access);
  if (!key || key.accountId !== organizationId || !key.permissions.includes("workspace:admin")) {
    throw new HTTPException(403, {
      message: "organization administration required",
    });
  }
  if (
    key.permissionMode === "explicit" &&
    !access.accountGrants.some(
      (grant) => grant.accountId === organizationId && grant.permissions.includes("account:admin"),
    )
  ) {
    throw new HTTPException(403, { message: "organization administration requires account:admin" });
  }
  return { subjectId: access.subjectId };
}

async function requireOrganizationKeyWorkspaceDeletion(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  workspaceId: string,
): Promise<void> {
  const access = await requireAccessContext(context, deps);
  const key = accountScopedApiKeyWorkspaceAuthority(access);
  if (
    !key ||
    key.accountId !== organizationId ||
    !hasPermission(key.permissions, "workspace:admin")
  ) {
    throw new HTTPException(403, {
      message:
        "deleting an organization workspace requires an organization owner session or an organization API key with workspace:admin",
    });
  }
  const workspace = await requireWorkspace(deps.db, workspaceId).catch(() => null);
  if (!workspace || workspace.accountId !== organizationId) {
    throw new HTTPException(404, { message: "workspace not found" });
  }
  if (workspace.kind !== "shared") {
    throw new HTTPException(403, {
      message: "organization API keys cannot delete a Personal workspace",
    });
  }
  if (!organizationWorkspaceInScope(key.workspaceScope, workspaceId))
    throw new HTTPException(403, { message: "workspace is outside organization key scope" });
}

async function requireManagedHuman(context: Context, deps: ApiRouteDeps) {
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !context.req.header("cookie") ||
    context.req.header("authorization")
  ) {
    throw new HTTPException(401, { message: "managed human session required" });
  }
  const session = await getManagedSession(context, deps.managedAuth, {
    db: deps.db,
    sessionAdapter: deps.managedAuthSessionAdapter,
    sessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
  if (!session?.user) {
    throw new HTTPException(401, { message: "managed human session required" });
  }
  return { session, subjectId: `user:${session.user.id}` };
}

/**
 * A person acting in this organization: in their browser, or through an agent
 * acting as them whose access setting includes `permission`. The database
 * still checks the person's own role on every call.
 */
async function requireOrganizationPerson(
  context: Context,
  deps: ApiRouteDeps,
  permission: Permission,
): Promise<{ subjectId: string }> {
  const agent = agentActingAsPerson(context, context.req.param("organizationId") ?? "", permission);
  if (agent) return agent;
  return await requireManagedHuman(context, deps);
}

async function requireOrganizationAdministrator(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<{ subjectId: string }> {
  const agent = agentActingAsPerson(
    context,
    organizationId,
    organizationSettingsPermission(context),
  );
  if (agent) return agent;
  if (deps.settings.productAccessMode === "managed") {
    return await requireManagedHuman(context, deps);
  }
  if (deps.settings.productAccessMode === "local") {
    const { subjectId } = await requireCanonicalLocalAccountAdministrator(
      context,
      deps,
      organizationId,
    );
    return { subjectId };
  }
  throw new HTTPException(401, {
    message: "organization administrator session required",
  });
}

/** A member of the organization, a key for it, or an agent with the person's account:read. */
async function requireOrganizationReader(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<{ subjectId: string }> {
  const agent = agentActingAsPerson(context, organizationId, "account:read");
  if (agent) return agent;
  const access = await requireAccessContext(context, deps);
  if (!access.accountGrants.some((grant) => grant.accountId === organizationId)) {
    throw new HTTPException(404, { message: "organization not found" });
  }
  return { subjectId: access.subjectId };
}

/**
 * Who is making an EU-only request: an API key whenever an Authorization
 * header is present (personal keys included, which act as their owner),
 * otherwise an agent acting as a person, otherwise a person in the app in a
 * browser.
 */
function inferenceResidencyActorKind(context: Context): InferenceResidencyActorKind {
  if (context.req.header("authorization") !== undefined) return "api_key";
  if (isAgentActingAsPerson(context)) return "agent";
  return "browser_person";
}

/**
 * Whether this request could turn EU-only off: it is on, this is a person in
 * a browser with Opengeni sign-in, and they are an active owner or admin.
 * GET and PATCH both answer with this. The database checks again on change.
 */
async function canTurnInferenceResidencyOff(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  subjectId: string,
  euOnly: boolean,
): Promise<boolean> {
  if (
    !euOnly ||
    deps.settings.productAccessMode !== "managed" ||
    inferenceResidencyActorKind(context) !== "browser_person" ||
    !subjectId.startsWith("user:")
  ) {
    return false;
  }
  const memberships = await listSelfOrganizationMemberships(deps.db, subjectId);
  return memberships.some(
    (membership) =>
      membership.organizationId === organizationId &&
      membership.status === "active" &&
      (membership.role === "owner" || membership.role === "admin"),
  );
}

/**
 * Who may change EU-only. Only Opengeni sign-in (managed access) has people
 * in browsers who can turn it off, so in local and configured modes it can't
 * be changed at all: turning it on there could never be undone. Turning it on
 * takes the privacy-settings administrators (an owner or admin in a browser,
 * an agent with their account:admin, or an administering organization key);
 * turning it off takes an owner or admin in a browser, never an agent or key.
 */
async function requireInferenceResidencyChanger(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  euOnly: boolean,
): Promise<{ subjectId: string; kind: InferenceResidencyActorKind }> {
  if (deps.settings.productAccessMode !== "managed") {
    throw new HTTPException(409, {
      message: "EU-only can only be changed when people sign in to Opengeni.",
    });
  }
  const kind = inferenceResidencyActorKind(context);
  if (kind === "browser_person") requireSameOriginBrowserMutation(context, deps);
  if (euOnly) {
    const { subjectId } = await requirePrivateSessionAdministrator(context, deps, organizationId);
    return { subjectId, kind };
  }
  if (kind !== "browser_person") {
    throw new HTTPException(403, {
      message: "Only an owner or admin can turn EU-only off, in the app in a browser.",
    });
  }
  const { session, subjectId } = await requireManagedHuman(context, deps);
  // A sign-in from the last five minutes, as for changing sign-in methods: an
  // agent driving the person's already signed-in browser has to sign in again.
  const authSessionId = session.session?.id;
  if (
    typeof authSessionId !== "string" ||
    !(await hasRecentManagedSignIn(deps, { authSessionId, authUserId: session.user.id }))
  ) {
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: "Sign in again to turn EU-only off.",
      details: { code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" },
      retryable: false,
    });
  }
  return { subjectId, kind };
}

const INFERENCE_RESIDENCY_REFUSAL_STATUS = {
  forbidden: 403,
  version_conflict: 409,
  operation_reused: 409,
  invalid: 422,
  unavailable: 503,
} as const;

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = parseRequestBody(schema, await context.req.json().catch(() => null), {
    status: 422,
    message: "invalid organization membership request",
  });
  return parsed;
}

function parseId(schema: z.ZodString, value: string, label: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(422, { message: `invalid ${label}` });
  return parsed.data;
}

function rethrowMembershipError(error: unknown, resourceLimitMessage?: string): never {
  const sqlState = nestedPostgresSqlState(error);
  if (sqlState === "P0S01") {
    throw new ApiHttpError(402, {
      code: "seat_limit_reached",
      message: "Organization seat limit reached. Upgrade your plan to add people.",
      retryable: false,
      outcomeUnknown: false,
      details: { action: { type: "upgrade", href: "/billing" } },
    });
  }
  if (sqlState === "54000" && resourceLimitMessage) {
    throw new HTTPException(409, {
      message: resourceLimitMessage,
    });
  }
  const status = organizationMembershipHttpStatus(sqlState);
  if (status !== null) {
    throw new HTTPException(status, {
      message:
        status === 403
          ? "organization administration is not authorized"
          : status === 404
            ? "organization resource not found"
            : status === 409
              ? "organization membership state changed; refresh and retry"
              : "invalid organization membership operation",
    });
  }
  throw error;
}

export function registerOrganizationMembershipRoutes(app: Hono, deps: ApiRouteDeps): void {
  // POST carries an opaque identity reference; this lookup never provisions.
  app.post("/v1/organizations/:organizationId/external-identities/lookup", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    return context.json(
      await lookupExternalIdentityForRequest(
        context,
        deps,
        organizationId,
        await context.req.json().catch(() => null),
      ),
    );
  });
  app.patch("/v1/organizations/:organizationId/external-members/:membershipId", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const membershipId = parseId(MembershipId, context.req.param("membershipId"), "membership id");
    try {
      return context.json(
        await updateExternalIdentityMembershipForRequest(
          context,
          deps,
          organizationId,
          membershipId,
          await context.req.json().catch(() => null),
        ),
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      rethrowMembershipError(error);
    }
  });
  app.post("/v1/organizations", async (context) => {
    const { session, subjectId } = await requireManagedHuman(context, deps);
    const payload = await parseBody(context, CreateOrganizationRequest);
    try {
      return context.json(
        CreateOrganizationResponse.parse(
          await createManagedOrganization(deps.db, {
            subjectId,
            subjectLabel: accountContactEmail(session.user.email) || session.user.name,
            ...payload,
            trialCreditModelIds: signupCreditModelIds(deps.settings),
            trialCreditsEnabled:
              deps.settings.productAccessMode === "managed" &&
              deps.settings.verifiedSignupTrialCreditsEnabled,
          }),
        ),
        201,
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.post("/v1/organizations/additional", async (context) => {
    const { session, subjectId } = await requireManagedHuman(context, deps);
    const payload = await parseBody(context, CreateAdditionalOrganizationRequest);
    try {
      return context.json(
        CreateAdditionalOrganizationResponse.parse(
          await createAdditionalManagedOrganization(deps.db, {
            subjectId,
            subjectLabel: accountContactEmail(session.user.email) || session.user.name,
            ...payload,
          }),
        ),
        201,
      );
    } catch (error) {
      rethrowMembershipError(error, "additional organization limit reached");
    }
  });

  app.get("/v1/organization-memberships", async (context) => {
    const { session } = await requireManagedHuman(context, deps);
    try {
      const result = await ensureManagedAccessForUserWithOrganizationMemberships(deps.db, {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
        provisionFallbackOrganization: false,
      });
      return context.json(
        ListManagedOrganizationMembershipsResponse.parse({
          // Each organization says whether its people keep a Personal
          // workspace to see and work in, so the app can hide it when off.
          memberships: await Promise.all(
            result.organizationMemberships.map(async (membership) => ({
              ...membership,
              personalWorkspacesEnabled: (
                await getOrganizationPrivacyPreferences(deps.db, membership.organizationId)
              ).personalWorkspacesEnabled,
            })),
          ),
        }),
      );
    } catch (error) {
      // Not dead after 0348: a terminal-only membership is now a bounded EMPTY
      // projection rather than a 42501, but the verified-email binder still
      // raises 42501 when the session claims `emailVerified` and the durable
      // `auth_users` row disagrees (an email change clears it), so this stays
      // the correct deny for a stale-verification session.
      if (nestedPostgresSqlState(error) === "42501") {
        throw new HTTPException(403, {
          message: "organization membership is not active",
        });
      }
      rethrowMembershipError(error);
    }
  });

  app.get("/v1/organization-invitations", async (context) => {
    const { session, subjectId } = await requireManagedHuman(context, deps);
    const query = parseRequestQuery(ListOrganizationInvitationsPageQuery, context.req.query(), {
      status: 422,
      message: "invalid organization invitation page",
    });
    try {
      if (session.user.emailVerified) {
        await bindPendingOrganizationInvitationsForVerifiedEmail(deps.db, {
          subjectId,
          email: session.user.email,
        });
      }
      return context.json(
        ListOrganizationInvitationsPageResponse.parse(
          await listSelfOrganizationInvitations(deps.db, {
            subjectId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: query.limit,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.get("/v1/organizations/:organizationId/overview", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    try {
      return context.json(
        OrganizationAdministrationOverview.parse(
          await getOrganizationAdministrationOverview(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    const payload = await parseBody(context, UpdateOrganizationNameRequest);
    try {
      return context.json(
        OrganizationSummary.parse(
          await updateOrganizationName(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            ...payload,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId/workspaces/:workspaceId", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
    const payload = await parseBody(context, UpdateOrganizationWorkspaceRequest);
    try {
      return context.json(
        OrganizationWorkspaceAccess.parse(
          await updateOrganizationWorkspace(deps.db, {
            organizationId,
            workspaceId,
            actorSubjectId: subjectId,
            name: payload.name.trim(),
            expectedUpdatedAt: payload.expectedUpdatedAt,
            operationId: payload.operationId,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.post("/v1/organizations/:organizationId/workspaces", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    const payload = await parseBody(context, CreateOrganizationWorkspaceRequest);
    try {
      return context.json(
        OrganizationWorkspaceAccess.parse(
          await createOrganizationWorkspace(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            name: payload.name.trim(),
            operationId: payload.operationId,
          }),
        ),
        201,
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.delete("/v1/organizations/:organizationId/workspaces/:workspaceId", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    if (context.req.header("authorization")) {
      // An integrating backend deletes the organization workspaces it
      // provisions (tenant offboarding, test cleanup) with its organization
      // key. This is exactly the authority `DELETE /v1/workspaces/:id` already
      // grants that key - an organization workspace (never a Personal one) in
      // the key's own organization, with `workspace:admin` - under the same
      // quiescence rules. It confers no organization-administrator identity.
      const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
      await requireOrganizationKeyWorkspaceDeletion(context, deps, organizationId, workspaceId);
      await deleteWorkspaceForRequest(deps, { accountId: organizationId, workspaceId });
      return context.body(null, 204);
    }
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
    await deleteWorkspaceForRequest(deps, {
      accountId: organizationId,
      workspaceId,
      organizationAdministratorSubjectId: subjectId,
    });
    return context.body(null, 204);
  });

  app.patch(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/settings",
    async (context) => {
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
      const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
      const payload = await parseBody(context, UpdateWorkspaceSettingsRequest);
      try {
        return context.json(
          Workspace.parse(
            await updateOrganizationSharedWorkspaceSettings(deps.db, {
              organizationId,
              workspaceId,
              actorSubjectId: subjectId,
              patch: payload,
            }),
          ),
        );
      } catch (error) {
        rethrowMembershipError(error);
      }
    },
  );

  app.put(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/members/:membershipId",
    async (context) => {
      const { subjectId } = await requireOrganizationPerson(context, deps, "members:manage");
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
      const membershipId = parseId(
        MembershipId,
        context.req.param("membershipId"),
        "membership id",
      );
      const payload = await parseBody(context, PutOrganizationWorkspaceMemberRequest);
      try {
        return context.json(
          OrganizationWorkspaceAccessMember.parse(
            await putOrganizationWorkspaceMember(deps.db, {
              organizationId,
              workspaceId,
              actorSubjectId: subjectId,
              targetOrganizationMembershipId: membershipId,
              access: payload,
            }),
          ),
        );
      } catch (error) {
        rethrowMembershipError(error);
      }
    },
  );

  // Organization service key: replace an existing external member's
  // permissions in one shared workspace (keyed, idempotent, non-destructive).
  app.patch(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/external-members/:membershipId",
    async (context) =>
      context.json(
        await updateExternalWorkspaceMemberForRequest(
          context,
          deps,
          parseId(OrganizationId, context.req.param("organizationId"), "organization id"),
          parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id"),
          parseId(MembershipId, context.req.param("membershipId"), "membership id"),
          await readRequestJson(context),
        ),
      ),
  );

  app.post(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/members/:membershipId/revoke",
    async (context) => {
      const input: unknown = await context.req.json().catch(() => null);
      if (input && typeof input === "object" && "cancelGrantOperationId" in input) {
        return context.json(
          await cancelExternalWorkspaceMemberGrantForRequest(
            context,
            deps,
            parseId(OrganizationId, context.req.param("organizationId"), "organization id"),
            parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id"),
            parseId(MembershipId, context.req.param("membershipId"), "membership id"),
            input,
          ),
        );
      }
      const { subjectId } = await requireOrganizationPerson(context, deps, "members:manage");
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
      const membershipId = parseId(
        MembershipId,
        context.req.param("membershipId"),
        "membership id",
      );
      const payload = await parseBody(context, RevokeOrganizationWorkspaceMemberRequest);
      try {
        return context.json(
          RevokeOrganizationWorkspaceMemberResponse.parse(
            await revokeOrganizationWorkspaceMember(deps.db, {
              organizationId,
              workspaceId,
              actorSubjectId: subjectId,
              targetOrganizationMembershipId: membershipId,
              expectedUpdatedAt: payload.expectedUpdatedAt,
              operationId: payload.operationId,
            }),
          ),
        );
      } catch (error) {
        rethrowMembershipError(error);
      }
    },
  );

  app.get("/v1/organizations/:organizationId/private-session-settings", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requirePrivateSessionAdministrator(context, deps, organizationId);
    try {
      const value = await getOrganizationPrivateSessionSettings(deps.db, {
        organizationId,
        actorSubjectId: subjectId,
      });
      // A deployment that turns Only me off makes it unavailable everywhere.
      return context.json(
        OrganizationPrivateSessionSettings.parse({
          ...value,
          available: value.available && privacyDeploymentLimits(deps.settings).onlyMeAllowed,
        }),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId/private-session-settings", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requirePrivateSessionAdministrator(context, deps, organizationId);
    const payload = await parseBody(context, UpdateOrganizationPrivateSessionSettingsRequest);
    if (payload.enabled && !privacyDeploymentLimits(deps.settings).onlyMeAllowed) {
      throw new HTTPException(409, { message: "Only me is turned off for this app." });
    }
    try {
      return context.json(
        OrganizationPrivateSessionSettings.parse(
          await updateOrganizationPrivateSessionSettings(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            ...payload,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  // The organization's privacy choices: the default audience for new chats and
  // schedules, and whether admins see that other people's Only me schedules
  // exist. `limits` reports what this deployment fixes.
  app.get("/v1/organizations/:organizationId/privacy-settings", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requirePrivateSessionAdministrator(context, deps, organizationId);
    try {
      // The same owner/admin check the private session settings read makes.
      await getOrganizationPrivateSessionSettings(deps.db, {
        organizationId,
        actorSubjectId: subjectId,
      });
      return context.json(
        OrganizationPrivacySettings.parse(
          await getOrganizationPrivacySettings(deps, organizationId),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId/privacy-settings", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requirePrivateSessionAdministrator(context, deps, organizationId);
    const request = await parseBody(context, UpdateOrganizationPrivacySettingsRequest);
    try {
      return context.json(
        OrganizationPrivacySettings.parse(
          await updateOrganizationPrivacySettings(deps, {
            organizationId,
            actorSubjectId: subjectId,
            request,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof OrganizationPrivacyLockedError) {
        throw new HTTPException(409, { message: error.message });
      }
      rethrowMembershipError(error);
    }
  });

  // EU-only inference. Any member can read it, since it decides which models
  // and features they can use. See requireInferenceResidencyChanger for who
  // can change it.
  app.get("/v1/organizations/:organizationId/inference-residency", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationReader(context, deps, organizationId);
    const state = await getOrganizationInferenceResidency(deps.db, organizationId);
    return context.json(
      OrganizationInferenceResidency.parse({
        ...state,
        canTurnOff: await canTurnInferenceResidencyOff(
          context,
          deps,
          organizationId,
          subjectId,
          state.euOnly,
        ),
      }),
    );
  });

  app.patch("/v1/organizations/:organizationId/inference-residency", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const request = await parseBody(context, UpdateOrganizationInferenceResidencyRequest);
    const actor = await requireInferenceResidencyChanger(
      context,
      deps,
      organizationId,
      request.euOnly,
    );
    let state: Awaited<ReturnType<typeof updateOrganizationInferenceResidency>>;
    try {
      state = await updateOrganizationInferenceResidency(deps.db, {
        organizationId,
        actorSubjectId: actor.subjectId,
        actorKind: actor.kind,
        euOnly: request.euOnly,
        expectedVersion: request.expectedVersion,
        operationId: request.operationId,
      });
    } catch (error) {
      if (error instanceof InferenceResidencyChangeRefusedError) {
        throw new HTTPException(INFERENCE_RESIDENCY_REFUSAL_STATUS[error.reason], {
          message: error.message,
        });
      }
      rethrowMembershipError(error);
    }
    return context.json(
      OrganizationInferenceResidency.parse({
        ...state,
        canTurnOff: await canTurnInferenceResidencyOff(
          context,
          deps,
          organizationId,
          actor.subjectId,
          state.euOnly,
        ),
      }),
    );
  });

  app.post("/v1/organizations/:organizationId/invitations", async (context) => {
    const { subjectId } = await requireOrganizationPerson(context, deps, "members:manage");
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const payload = await parseBody(context, CreateOrganizationInvitationRequest);
    // `.invalid` addresses (RFC 2606) reach no one, and one is the stored
    // placeholder of an account without an email address.
    if (payload.email.trim().toLowerCase().endsWith(".invalid")) {
      throw new HTTPException(422, { message: "That email address can't receive invitations" });
    }
    // Bearer construction configuration must fail before the invitation
    // commits. Provider outcomes are journaled durably after this boundary.
    try {
      assertOrganizationUserSetupDeliveryConfigured(deps.settings, deps.managedEmailTransport);
    } catch {
      throw new HTTPException(503, {
        message: "invited-user account setup delivery is not configured on this deployment",
      });
    }
    try {
      const invitation = OrganizationInvitation.parse(
        await createOrganizationInvitation(deps.db, {
          organizationId,
          actorSubjectId: subjectId,
          operationId: payload.operationId,
          targetSubjectId: null,
          targetEmail: payload.email.trim().toLowerCase(),
          ...(payload.name === undefined ? {} : { targetName: payload.name }),
          initialWorkspaceIds: payload.initialWorkspaceIds,
          role: payload.role,
          expiresAt: payload.expiresAt,
        }),
      );
      await deliverOrganizationUserSetup(deps, {
        organizationId,
        actorSubjectId: subjectId,
        invitationId: invitation.id,
        invitationOperationId: payload.operationId,
        operationId: payload.operationId,
      });
      return context.json(
        OrganizationInvitation.parse(
          await getOrganizationInvitationForAdministration(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            invitationId: invitation.id,
          }),
        ),
        201,
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      rethrowMembershipError(error);
    }
  });

  app.get("/v1/organizations/:organizationId/invitations", async (context) => {
    const { subjectId } = await requireOrganizationPerson(context, deps, "account:read");
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const query = parseRequestQuery(ListOrganizationInvitationsPageQuery, context.req.query(), {
      status: 422,
      message: "invalid organization invitation page",
    });
    try {
      return context.json(
        ListOrganizationInvitationsPageResponse.parse(
          await listOrganizationInvitations(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: query.limit,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.post(
    "/v1/organizations/:organizationId/invitations/:invitationId/delivery/retry",
    async (context) => {
      const { subjectId } = await requireOrganizationPerson(context, deps, "members:manage");
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const invitationId = parseId(
        InvitationId,
        context.req.param("invitationId"),
        "invitation id",
      );
      const payload = await parseBody(context, RetryOrganizationUserSetupDeliveryRequest);
      try {
        assertOrganizationUserSetupDeliveryConfigured(deps.settings, deps.managedEmailTransport);
      } catch {
        throw new HTTPException(503, {
          message: "invited-user account setup delivery is not configured on this deployment",
        });
      }
      try {
        return context.json(
          OrganizationUserSetupDelivery.parse(
            await deliverOrganizationUserSetup(deps, {
              organizationId,
              actorSubjectId: subjectId,
              invitationId,
              operationId: payload.operationId,
            }),
          ),
        );
      } catch (error) {
        rethrowMembershipError(error);
      }
    },
  );

  app.post("/v1/organization-invitations/:invitationId/accept", async (context) => {
    const { session, subjectId } = await requireManagedHuman(context, deps);
    const invitationId = parseId(InvitationId, context.req.param("invitationId"), "invitation id");
    const payload = await parseBody(context, AcceptOrganizationInvitationRequest);
    try {
      if (session.user.emailVerified) {
        await bindPendingOrganizationInvitationsForVerifiedEmail(deps.db, {
          subjectId,
          email: session.user.email,
        });
      }
      const invitation = await getSelfOrganizationInvitation(deps.db, {
        subjectId,
        invitationId,
      });
      const result = await acceptOrganizationInvitation(deps.db, {
        organizationId: invitation.organizationId,
        actorSubjectId: subjectId,
        operationId: payload.operationId,
        invitationId,
        expectedRevision: payload.expectedRevision,
      });
      return context.json({
        invitation: OrganizationInvitation.parse(result.invitation),
        membership: OrganizationMember.parse(result.membership),
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      rethrowMembershipError(error);
    }
  });

  app.post(
    "/v1/organizations/:organizationId/invitations/:invitationId/revoke",
    async (context) => {
      const { subjectId } = await requireOrganizationPerson(context, deps, "members:manage");
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const invitationId = parseId(
        InvitationId,
        context.req.param("invitationId"),
        "invitation id",
      );
      const payload = await parseBody(context, RevokeOrganizationInvitationRequest);
      try {
        return context.json(
          OrganizationInvitation.parse(
            await revokeOrganizationInvitation(deps.db, {
              organizationId,
              actorSubjectId: subjectId,
              operationId: payload.operationId,
              invitationId,
              expectedRevision: payload.expectedRevision,
            }),
          ),
        );
      } catch (error) {
        rethrowMembershipError(error);
      }
    },
  );

  app.get("/v1/organizations/:organizationId/members", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    try {
      return context.json(
        ListOrganizationAdministrationMembersResponse.parse({
          members: await listOrganizationAdministrationMembers(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
          }),
        }),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId/members/:membershipId", async (context) => {
    const { subjectId } = await requireOrganizationPerson(context, deps, "members:manage");
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const membershipId = parseId(MembershipId, context.req.param("membershipId"), "membership id");
    const payload = await parseBody(context, UpdateOrganizationMemberRequest);
    try {
      return context.json(
        OrganizationMember.parse(
          await updateOrganizationMember(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            operationId: payload.operationId,
            membershipId,
            transition: payload,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.get("/v1/organizations/:organizationId/retention-policy", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    try {
      return context.json(
        OrganizationRetentionPolicy.parse(
          await getOrganizationRetentionPolicy(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId/retention-policy", async (context) => {
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const { subjectId } = await requireOrganizationAdministrator(context, deps, organizationId);
    const payload = await parseBody(context, UpdateOrganizationRetentionPolicyRequest);
    try {
      return context.json(
        OrganizationRetentionPolicy.parse(
          await updateOrganizationRetentionPolicy(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            operationId: payload.operationId,
            mode: payload.mode,
            retentionDays: payload.retentionDays,
            expectedVersion: payload.expectedVersion,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });
}

async function deliverOrganizationUserSetup(
  deps: ApiRouteDeps,
  input: {
    organizationId: string;
    actorSubjectId: string;
    invitationId: string;
    invitationOperationId?: string;
    operationId: string;
  },
) {
  const claim = await claimOrganizationUserSetupDelivery(deps.db, input);
  if (!claim.claimed) return claim.delivery;
  const prepared = await resolveOrganizationUserSetupDeliveryEmail(deps.settings, {
    invitationId: claim.invitationId,
    deliveryId: claim.delivery.id,
    senderEmail: deps.managedEmailTransport.sender,
    recipientEmail: claim.recipientEmail,
    recipientName: claim.recipientName,
    organizationName: claim.organizationName,
    organizationRole: claim.organizationRole,
    sharedWorkspaceAccess: claim.sharedWorkspaceAccess,
    providerIdempotencyScope: deps.managedEmailTransport.idempotency.scope,
    frozenTransport: claim.setupTokenTransport,
    frozenPayloadDigest: claim.payloadDigest,
  });
  await prepareOrganizationUserSetupDelivery(deps.db, {
    organizationId: input.organizationId,
    actorSubjectId: input.actorSubjectId,
    deliveryId: claim.delivery.id,
    attemptId: claim.attemptId,
    claimHolderId: claim.claimHolderId,
    tokenDigest: prepared.tokenDigest,
    payloadDigest: prepared.payloadDigest,
    setupTokenTransport: prepared.transport,
    providerIdempotencyScope: deps.managedEmailTransport.idempotency.scope,
    providerIdempotencyRetentionSeconds: deps.managedEmailTransport.idempotency.retentionSeconds,
  });
  let outcome:
    | { status: "sent"; providerMessageId: string | null }
    | { status: "failed" | "outcome_unknown"; errorClass: string };
  try {
    outcome = await deps.managedEmailTransport.send({
      kind: "organization_user_setup",
      ...prepared.message,
      idempotencyKey: claim.providerKey,
    });
  } catch {
    outcome = { status: "outcome_unknown", errorClass: "transport_threw" };
  }
  return await settleOrganizationUserSetupDelivery(deps.db, {
    organizationId: input.organizationId,
    actorSubjectId: input.actorSubjectId,
    deliveryId: claim.delivery.id,
    attemptId: claim.attemptId,
    claimHolderId: claim.claimHolderId,
    outcome: outcome.status,
    ...(outcome.status === "sent"
      ? { providerMessageId: outcome.providerMessageId }
      : { errorClass: outcome.errorClass }),
  });
}

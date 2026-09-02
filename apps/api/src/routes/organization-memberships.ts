import {
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
  OrganizationInvitation,
  OrganizationUserSetupDelivery,
  OrganizationMember,
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
  UpdateOrganizationMemberRequest,
  UpdateOrganizationNameRequest,
  UpdateOrganizationPrivateSessionSettingsRequest,
  UpdateOrganizationRetentionPolicyRequest,
  UpdateOrganizationWorkspaceRequest,
  UpdateWorkspaceSettingsRequest,
  Workspace,
} from "@opengeni/contracts";
import {
  getManagedSession,
  organizationMembershipHttpStatus,
  requireCanonicalLocalAccountAdministrator,
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
  getOrganizationInvitationForAdministration,
  getOrganizationPrivateSessionSettings,
  getSelfOrganizationInvitation,
  getOrganizationRetentionPolicy,
  listOrganizationAdministrationMembers,
  listOrganizationInvitations,
  listSelfOrganizationInvitations,
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

import {
  assertOrganizationUserSetupDeliveryConfigured,
  deriveOrganizationUserSetupToken,
  organizationUserSetupPayloadDigest,
  renderOrganizationUserSetupEmail,
} from "../auth/organization-user-setup";

const OrganizationId = z.string().uuid();
const WorkspaceId = z.string().uuid();
const MembershipId = z.string().uuid();
const InvitationId = z.string().uuid();

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

async function requireOrganizationAdministrator(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<{ subjectId: string }> {
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

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: "invalid organization membership request",
    });
  }
  return parsed.data;
}

function parseId(schema: z.ZodString, value: string, label: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(422, { message: `invalid ${label}` });
  return parsed.data;
}

function rethrowMembershipError(error: unknown): never {
  const status = organizationMembershipHttpStatus(nestedPostgresSqlState(error));
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
  app.post("/v1/organizations", async (context) => {
    const { session, subjectId } = await requireManagedHuman(context, deps);
    const payload = await parseBody(context, CreateOrganizationRequest);
    try {
      return context.json(
        CreateOrganizationResponse.parse(
          await createManagedOrganization(deps.db, {
            subjectId,
            subjectLabel: session.user.email || session.user.name,
            ...payload,
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
            subjectLabel: session.user.email || session.user.name,
            ...payload,
          }),
        ),
        201,
      );
    } catch (error) {
      rethrowMembershipError(error);
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
          memberships: result.organizationMemberships,
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
    const query = ListOrganizationInvitationsPageQuery.safeParse(context.req.query());
    if (!query.success) {
      throw new HTTPException(422, {
        message: "invalid organization invitation page",
      });
    }
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
            ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
            limit: query.data.limit,
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
      const { subjectId } = await requireManagedHuman(context, deps);
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

  app.post(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/members/:membershipId/revoke",
    async (context) => {
      const { subjectId } = await requireManagedHuman(context, deps);
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    try {
      return context.json(
        OrganizationPrivateSessionSettings.parse(
          await getOrganizationPrivateSessionSettings(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch("/v1/organizations/:organizationId/private-session-settings", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const payload = await parseBody(context, UpdateOrganizationPrivateSessionSettingsRequest);
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
      if (nestedPostgresSqlState(error) === "55000") {
        throw new HTTPException(409, {
          message: "private-session readiness is not activated for this organization",
        });
      }
      rethrowMembershipError(error);
    }
  });

  app.post("/v1/organizations/:organizationId/invitations", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const payload = await parseBody(context, CreateOrganizationInvitationRequest);
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const query = ListOrganizationInvitationsPageQuery.safeParse(context.req.query());
    if (!query.success) {
      throw new HTTPException(422, {
        message: "invalid organization invitation page",
      });
    }
    try {
      return context.json(
        ListOrganizationInvitationsPageResponse.parse(
          await listOrganizationInvitations(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
            limit: query.data.limit,
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
      const { subjectId } = await requireManagedHuman(context, deps);
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
      const { subjectId } = await requireManagedHuman(context, deps);
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
    const { subjectId } = await requireManagedHuman(context, deps);
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
  const setup = await deriveOrganizationUserSetupToken(deps.settings, {
    invitationId: claim.invitationId,
    deliveryId: claim.delivery.id,
  });
  const message = renderOrganizationUserSetupEmail({
    senderEmail: deps.managedEmailTransport.sender,
    recipientEmail: claim.recipientEmail,
    recipientName: claim.recipientName,
    organizationName: claim.organizationName,
    organizationRole: claim.organizationRole,
    sharedWorkspaceAccess: claim.sharedWorkspaceAccess,
    setupUrl: setup.url,
  });
  await prepareOrganizationUserSetupDelivery(deps.db, {
    organizationId: input.organizationId,
    actorSubjectId: input.actorSubjectId,
    deliveryId: claim.delivery.id,
    attemptId: claim.attemptId,
    claimHolderId: claim.claimHolderId,
    tokenDigest: setup.digest,
    payloadDigest: await organizationUserSetupPayloadDigest({
      ...message,
      providerIdempotencyScope: deps.managedEmailTransport.idempotency.scope,
    }),
    providerIdempotencyScope: deps.managedEmailTransport.idempotency.scope,
    providerIdempotencyRetentionSeconds: deps.managedEmailTransport.idempotency.retentionSeconds,
  });
  let outcome:
    | { status: "sent"; providerMessageId: string | null }
    | { status: "failed" | "outcome_unknown"; errorClass: string };
  try {
    outcome = await deps.managedEmailTransport.send({
      kind: "organization_user_setup",
      ...message,
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

import {
  AddOrganizationWorkspaceMemberRequest,
  AcceptOrganizationInvitationRequest,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  CreateOrganizationWorkspaceRequest,
  CreateOrganizationInvitationRequest,
  ListManagedOrganizationMembershipsResponse,
  ListOrganizationInvitationsPageQuery,
  ListOrganizationInvitationsPageResponse,
  ListOrganizationMembersResponse,
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationPrivateSessionSettings,
  OrganizationRetentionPolicy,
  OrganizationSummary,
  Permission,
  RevokeOrganizationInvitationRequest,
  UpdateOrganizationMemberRequest,
  UpdateOrganizationNameRequest,
  UpdateOrganizationPrivateSessionSettingsRequest,
  UpdateOrganizationRetentionPolicyRequest,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceRequest,
  UpdateWorkspaceSettingsRequest,
  Workspace,
  WorkspaceMember,
} from "@opengeni/contracts";
import {
  getManagedSession,
  organizationMembershipHttpStatus,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  bindPendingOrganizationInvitationsForVerifiedEmail,
  createManagedOrganization,
  createOrganizationSharedWorkspace,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getManagedUserProfilesByIds,
  ensureOrganizationUserSetupIntent,
  getOrganizationAdministrationOverview,
  getOrganizationPrivateSessionSettings,
  getSelfOrganizationInvitation,
  getOrganizationRetentionPolicy,
  listOrganizationMembers,
  listOrganizationInvitations,
  listSelfOrganizationInvitations,
  nestedPostgresSqlState,
  revokeOrganizationInvitation,
  removeWorkspaceMember,
  updateOrganizationSharedWorkspace,
  updateOrganizationSharedWorkspaceSettings,
  updateOrganizationMember,
  updateOrganizationName,
  updateOrganizationPrivateSessionSettings,
  updateOrganizationRetentionPolicy,
  upsertOrganizationSharedWorkspaceMember,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { sendManagedAuthEmail } from "../auth/managed-auth";
import {
  assertOrganizationUserSetupDeliveryConfigured,
  deriveOrganizationUserSetupToken,
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
  });
  if (!session?.user) {
    throw new HTTPException(401, { message: "managed human session required" });
  }
  return { session, subjectId: `user:${session.user.id}` };
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

function parseWorkspacePermissions(permissions: string[]) {
  const parsed = z.array(Permission).max(128).safeParse(permissions);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "invalid workspace permissions" });
  }
  return parsed.data;
}

function normalizeAgentInstructions(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() || null;
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
    const payload = await parseBody(context, UpdateWorkspaceRequest);
    try {
      return context.json(
        Workspace.parse(
          await updateOrganizationSharedWorkspace(deps.db, {
            organizationId,
            workspaceId,
            actorSubjectId: subjectId,
            ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
            ...(payload.slug !== undefined ? { slug: payload.slug?.trim() || null } : {}),
            ...(payload.agentInstructions !== undefined
              ? {
                  agentInstructions: normalizeAgentInstructions(payload.agentInstructions),
                }
              : {}),
          }),
        ),
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.post("/v1/organizations/:organizationId/workspaces", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const payload = await parseBody(context, CreateOrganizationWorkspaceRequest);
    try {
      return context.json(
        Workspace.parse(
          await createOrganizationSharedWorkspace(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            name: payload.name.trim(),
            ...(payload.slug !== undefined ? { slug: payload.slug?.trim() || null } : {}),
            ...(payload.agentInstructions !== undefined
              ? { agentInstructions: normalizeAgentInstructions(payload.agentInstructions) }
              : {}),
            operationId: payload.operationId,
          }),
        ),
        201,
      );
    } catch (error) {
      rethrowMembershipError(error);
    }
  });

  app.patch(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/settings",
    async (context) => {
      const { subjectId } = await requireManagedHuman(context, deps);
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
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

  app.post("/v1/organizations/:organizationId/workspaces/:workspaceId/members", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
    const payload = await parseBody(context, AddOrganizationWorkspaceMemberRequest);
    try {
      const members = await listOrganizationMembers(deps.db, {
        organizationId,
        actorSubjectId: subjectId,
      });
      const target = members.find(
        (member) => member.id === payload.organizationMembershipId && member.status === "active",
      );
      if (!target) {
        throw new HTTPException(404, {
          message: "active organization member not found",
        });
      }
      const [profile] = await getManagedUserProfilesByIds(deps.db, [
        target.subjectId.slice("user:".length),
      ]);
      return context.json(
        WorkspaceMember.parse(
          await upsertOrganizationSharedWorkspaceMember(deps.db, {
            organizationId,
            workspaceId,
            actorSubjectId: subjectId,
            targetOrganizationMembershipId: target.id,
            subjectLabel: profile?.email ?? profile?.name ?? null,
            role: payload.role ?? "member",
            permissions: parseWorkspacePermissions(payload.permissions),
            requireExisting: false,
          }),
        ),
        201,
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      rethrowMembershipError(error);
    }
  });

  app.patch(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/members/:subjectId",
    async (context) => {
      const { subjectId: actorSubjectId } = await requireManagedHuman(context, deps);
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
      const targetSubjectId = decodeURIComponent(context.req.param("subjectId"));
      const payload = await parseBody(context, UpdateWorkspaceMemberRequest);
      try {
        const members = await listOrganizationMembers(deps.db, {
          organizationId,
          actorSubjectId,
        });
        const target = members.find(
          (member) => member.subjectId === targetSubjectId && member.status === "active",
        );
        if (!target) {
          throw new HTTPException(404, {
            message: "active organization member not found",
          });
        }
        const [profile] = await getManagedUserProfilesByIds(deps.db, [
          target.subjectId.slice("user:".length),
        ]);
        return context.json(
          WorkspaceMember.parse(
            await upsertOrganizationSharedWorkspaceMember(deps.db, {
              organizationId,
              workspaceId,
              actorSubjectId,
              targetOrganizationMembershipId: target.id,
              subjectLabel: profile?.email ?? profile?.name ?? null,
              ...(payload.role === undefined ? {} : { role: payload.role }),
              permissions: payload.permissions,
              requireExisting: true,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        rethrowMembershipError(error);
      }
    },
  );

  app.delete(
    "/v1/organizations/:organizationId/workspaces/:workspaceId/members/:subjectId",
    async (context) => {
      const { subjectId: actorSubjectId } = await requireManagedHuman(context, deps);
      const organizationId = parseId(
        OrganizationId,
        context.req.param("organizationId"),
        "organization id",
      );
      const workspaceId = parseId(WorkspaceId, context.req.param("workspaceId"), "workspace id");
      const targetSubjectId = decodeURIComponent(context.req.param("subjectId"));
      try {
        await removeWorkspaceMember(deps.db, {
          accountId: organizationId,
          workspaceId,
          actorSubjectId,
          targetSubjectId,
          requireOrganizationSharedWorkspaceAdministration: true,
        });
        return context.body(null, 204);
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
    // Fail before the invitation commits, never after: a 500 raised once the
    // row exists is an outcome-unknown state for the administrator.
    try {
      assertOrganizationUserSetupDeliveryConfigured(deps.settings);
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
      const setup = await deriveOrganizationUserSetupToken(deps.settings, {
        invitationId: invitation.id,
        operationId: payload.operationId,
      });
      await ensureOrganizationUserSetupIntent(deps.db, {
        organizationId,
        actorSubjectId: subjectId,
        invitationId: invitation.id,
        tokenDigest: setup.digest,
        expiresAt: invitation.expiresAt,
      });
      await sendManagedAuthEmail(deps.settings, {
        to: invitation.targetEmail,
        subject: "Join your OpenGeni organization",
        text: `You have been invited to an OpenGeni organization. If you need a new account, set it up here: ${setup.url}\n\nIf you already have an account, sign in at ${deps.settings.publicBaseUrl ?? "OpenGeni"} and accept the invitation.`,
        html: `<p>You have been invited to an OpenGeni organization.</p><p><a href="${escapeHtml(setup.url)}">Set up your account</a></p><p>If you already have an account, sign in to OpenGeni and accept the invitation.</p>`,
        idempotencyKey: `opengeni-organization-setup-${payload.operationId}`,
      });
      return context.json(invitation, 201);
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    try {
      const members = await listOrganizationMembers(deps.db, {
        organizationId,
        actorSubjectId: subjectId,
      });
      const profiles = await getManagedUserProfilesByIds(
        deps.db,
        members.flatMap((member) =>
          member.subjectId.startsWith("user:") ? [member.subjectId.slice("user:".length)] : [],
        ),
      );
      const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
      return context.json(
        ListOrganizationMembersResponse.parse({
          members: members.map((member) => {
            const profile = profileById.get(member.subjectId.slice("user:".length));
            return {
              ...member,
              name: profile?.name?.trim() || null,
              email: profile?.email ?? null,
            };
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
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
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

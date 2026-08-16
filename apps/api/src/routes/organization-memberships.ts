import {
  AcceptOrganizationInvitationRequest,
  CreateOrganizationInvitationRequest,
  ListManagedOrganizationMembershipsResponse,
  ListOrganizationInvitationsPageQuery,
  ListOrganizationInvitationsPageResponse,
  ListOrganizationMembersResponse,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRetentionPolicy,
  RevokeOrganizationInvitationRequest,
  UpdateOrganizationMemberRequest,
  UpdateOrganizationRetentionPolicyRequest,
} from "@opengeni/contracts";
import {
  getManagedSession,
  organizationMembershipHttpStatus,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getManagedUserByEmail,
  getSelfOrganizationInvitation,
  getOrganizationRetentionPolicy,
  listOrganizationMembers,
  listOrganizationInvitations,
  listSelfOrganizationInvitations,
  nestedPostgresSqlState,
  revokeOrganizationInvitation,
  updateOrganizationMember,
  updateOrganizationRetentionPolicy,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const OrganizationId = z.string().uuid();
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
            ? "organization membership resource not found"
            : status === 409
              ? "organization membership state changed; refresh and retry"
              : "invalid organization membership operation",
    });
  }
  throw error;
}

export function registerOrganizationMembershipRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/organization-memberships", async (context) => {
    const { session } = await requireManagedHuman(context, deps);
    try {
      const result = await ensureManagedAccessForUserWithOrganizationMemberships(deps.db, {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
      });
      return context.json(
        ListManagedOrganizationMembershipsResponse.parse({
          memberships: result.organizationMemberships,
        }),
      );
    } catch (error) {
      if (nestedPostgresSqlState(error) === "42501") {
        throw new HTTPException(403, {
          message: "organization membership is not active",
        });
      }
      rethrowMembershipError(error);
    }
  });

  app.get("/v1/organization-invitations", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const query = ListOrganizationInvitationsPageQuery.safeParse(context.req.query());
    if (!query.success) {
      throw new HTTPException(422, {
        message: "invalid organization invitation page",
      });
    }
    try {
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

  app.post("/v1/organizations/:organizationId/invitations", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const organizationId = parseId(
      OrganizationId,
      context.req.param("organizationId"),
      "organization id",
    );
    const payload = await parseBody(context, CreateOrganizationInvitationRequest);
    try {
      // Authenticate organization administration before resolving a platform
      // email address, so this endpoint cannot become a registered-user oracle.
      await listOrganizationInvitations(deps.db, {
        organizationId,
        actorSubjectId: subjectId,
        limit: 1,
      });
      const targetUserId = await getManagedUserByEmail(deps.db, payload.email);
      if (!targetUserId) {
        throw new HTTPException(404, {
          message: "invitations currently require an existing registered user",
        });
      }
      return context.json(
        OrganizationInvitation.parse(
          await createOrganizationInvitation(deps.db, {
            organizationId,
            actorSubjectId: subjectId,
            operationId: payload.operationId,
            targetSubjectId: `user:${targetUserId}`,
            targetEmail: payload.email.trim().toLowerCase(),
            role: payload.role,
            expiresAt: payload.expiresAt,
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

  app.post("/v1/organization-invitations/:invitationId/accept", async (context) => {
    const { subjectId } = await requireManagedHuman(context, deps);
    const invitationId = parseId(InvitationId, context.req.param("invitationId"), "invitation id");
    const payload = await parseBody(context, AcceptOrganizationInvitationRequest);
    try {
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
      return context.json(
        ListOrganizationMembersResponse.parse({
          members: await listOrganizationMembers(deps.db, {
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

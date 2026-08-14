import { ListManagedOrganizationMembershipsResponse } from "@opengeni/contracts";
import { getManagedSession, type ApiRouteDeps } from "@opengeni/core";
import {
  ensureManagedAccessForUserWithOrganizationMemberships,
  nestedPostgresSqlState,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerOrganizationMembershipRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/organization-memberships", async (context) => {
    if (
      deps.settings.productAccessMode !== "managed" ||
      !deps.managedAuth ||
      !context.req.header("cookie") ||
      context.req.header("authorization")
    ) {
      throw new HTTPException(401, {
        message: "managed human session required",
      });
    }

    const session = await getManagedSession(context, deps.managedAuth, {
      db: deps.db,
    });
    if (!session?.user) {
      throw new HTTPException(401, {
        message: "managed human session required",
      });
    }

    let result;
    try {
      result = await ensureManagedAccessForUserWithOrganizationMemberships(deps.db, {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
      });
    } catch (error) {
      if (nestedPostgresSqlState(error) === "42501") {
        throw new HTTPException(403, {
          message: "organization membership is not active",
        });
      }
      throw error;
    }
    return context.json(
      ListManagedOrganizationMembershipsResponse.parse({
        memberships: result.organizationMemberships,
      }),
    );
  });
}

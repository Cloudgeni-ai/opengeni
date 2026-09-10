import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  CreateHostMcpBindingRequest,
  IssueHostMcpDelegationRequest,
} from "@opengeni/contracts/host-mcp-bindings";
import {
  createHostMcpBinding,
  getHostMcpBinding,
  revokeHostMcpBinding,
  issueHostMcpDelegation,
  getHostMcpDelegation,
  revokeHostMcpDelegation,
  HostMcpDelegationAuthorityError,
  HostMcpBindingConflictError,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import {
  requireAccessGrantAuthorization,
  prepareHostMcpOwnerAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";

/** Registration is not an execution grant. The durable runtime must separately
 * validate the exact binding generation and accepted execution context. */
export function registerHostMcpBindingRoutes(app: Hono, deps: ApiRouteDeps): void {
  for (const entity of ["bindings", "delegations"] as const) {
    app.on(
      ["GET", "POST"],
      [
        `/v1/workspaces/:workspaceId/host-mcp-${entity}`,
        `/v1/workspaces/:workspaceId/host-mcp-${entity}/:bindingId`,
        `/v1/workspaces/:workspaceId/host-mcp-${entity}/:bindingId/revoke`,
      ],
      async (c) => {
        const workspaceId = c.req.param("workspaceId")!;
        const bindingId = c.req.param("bindingId");
        const method = c.req.method;
        const revoke = c.req.path.endsWith("/revoke");
        if (
          !(
            (method === "POST" && !bindingId) ||
            (method === "GET" && bindingId && !revoke) ||
            (method === "POST" && bindingId && revoke)
          )
        )
          throw new HTTPException(404, { message: "not found" });
        const permission = method === "GET" ? "connections:read" : "connections:write";
        const authorization = await requireAccessGrantAuthorization(
          c,
          deps,
          workspaceId,
          permission,
        );
        const authorizeCommit = prepareHostMcpOwnerAuthorization(
          authorization,
          workspaceId,
          permission,
        );
        if (bindingId) z.string().uuid().parse(bindingId);
        const createInput =
          method === "POST" && !bindingId
            ? (entity === "bindings"
                ? CreateHostMcpBindingRequest
                : IssueHostMcpDelegationRequest
              ).parse(await c.req.json())
            : null;
        const revokeInput = revoke
          ? z
              .object({ expectedGeneration: z.number().int().positive().safe() })
              .strict()
              .parse(await c.req.json())
          : null;
        const owner = {
          accountId: authorization.grant.accountId,
          workspaceId,
          subjectId: authorization.grant.subjectId,
        };
        try {
          const result = await withWorkspaceSubjectRls(
            deps.db,
            workspaceId,
            owner.subjectId,
            async (tx) => {
              const effectiveOwner = await authorizeCommit(tx);
              if (createInput)
                return entity === "bindings"
                  ? createHostMcpBinding(tx, effectiveOwner, createInput)
                  : issueHostMcpDelegation(tx, effectiveOwner, createInput);
              const existing = await (
                entity === "bindings" ? getHostMcpBinding : getHostMcpDelegation
              )(tx, effectiveOwner, bindingId!);
              if (!existing)
                throw new HTTPException(404, {
                  message:
                    entity === "bindings" ? "Host binding not found" : "Host delegation not found",
                });
              return revokeInput
                ? (entity === "bindings" ? revokeHostMcpBinding : revokeHostMcpDelegation)(
                    tx,
                    effectiveOwner,
                    bindingId!,
                    revokeInput.expectedGeneration,
                  )
                : existing;
            },
          );
          return c.json(result, createInput ? 201 : 200);
        } catch (error) {
          if (error instanceof HostMcpDelegationAuthorityError)
            throw new HTTPException(403, { message: "Host delegation authority unavailable" });
          if (error instanceof HostMcpBindingConflictError)
            throw new HTTPException(409, {
              message: "Host binding changed; reload before retrying",
            });
          throw error;
        }
      },
    );
  }
}

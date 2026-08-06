import {
  ApproveOrganizationRecoveryRequest,
  CreateOrganizationRecoveryOperationRequest,
  LockOrganizationGovernanceRequest,
  OrganizationGovernance,
  OrganizationRecoveryCommandRequest,
  OrganizationRecoveryOperation,
  SetOrganizationRecoveryPolicyRequest,
} from "@opengeni/contracts";
import {
  approveOrganizationRecoveryForRequest,
  acceptOrganizationRecoveryCustodianForRequest,
  beginOrganizationRecovery,
  cancelOrganizationRecoveryForRequest,
  enrollOrganizationRecoveryPolicy,
  finalizeOrganizationRecoveryForRequest,
  lockOrganizationForRecovery,
  readOrganizationGovernance,
  requireAccessContext,
  requireOrganizationGovernanceAdmin,
  requireOrganizationGovernanceAdminOrLockedReplay,
  requireOrganizationRecoveryCustodianOrReplay,
  revokeOrganizationRecoveryForRequest,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerOrganizationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/accounts/:accountId/governance", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = c.req.param("accountId");
    return c.json(
      OrganizationGovernance.parse(await readOrganizationGovernance(deps, context, accountId)),
    );
  });

  app.put("/v1/accounts/:accountId/governance/recovery-policy", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = c.req.param("accountId");
    await requireOrganizationGovernanceAdmin(deps, context, accountId);
    const request = SetOrganizationRecoveryPolicyRequest.parse(await c.req.json());
    return c.json(
      OrganizationGovernance.parse(
        await enrollOrganizationRecoveryPolicy(deps, context, accountId, request),
      ),
    );
  });

  // Exactly one body-minimal enrollment operation. The direct managed session
  // evidence is request-local and the database resolves it to the canonical
  // Better Auth user inside the same transaction; no caller-supplied identity
  // or session id is accepted in the body.
  app.post("/v1/accounts/:accountId/governance/recovery-policy/self-accept", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = c.req.param("accountId");
    requireSecureRecoveryTransport(c.req.url, deps);
    return c.json(
      OrganizationGovernance.parse(
        await acceptOrganizationRecoveryCustodianForRequest(deps, context, accountId),
      ),
    );
  });

  app.post("/v1/accounts/:accountId/governance/lock", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = c.req.param("accountId");
    await requireOrganizationGovernanceAdminOrLockedReplay(deps, context, accountId);
    const request = LockOrganizationGovernanceRequest.parse(await c.req.json());
    return c.json(
      OrganizationGovernance.parse(
        await lockOrganizationForRecovery(deps, context, accountId, request),
      ),
    );
  });

  app.post("/v1/accounts/:accountId/recovery-operations", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = c.req.param("accountId");
    await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
    const request = CreateOrganizationRecoveryOperationRequest.parse(await c.req.json());
    return c.json(
      OrganizationRecoveryOperation.parse(
        await beginOrganizationRecovery(deps, context, accountId, request),
      ),
      201,
    );
  });

  app.post("/v1/accounts/:accountId/recovery-operations/:operationId/approvals", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = c.req.param("accountId");
    // Authenticate and authorize before the sensitive body is read.
    await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
    requireSecureRecoveryTransport(c.req.url, deps);
    const request = ApproveOrganizationRecoveryRequest.parse(await c.req.json());
    return c.json(
      OrganizationRecoveryOperation.parse(
        await approveOrganizationRecoveryForRequest(
          deps,
          context,
          accountId,
          c.req.param("operationId"),
          request,
        ),
      ),
    );
  });

  app.post(
    "/v1/accounts/:accountId/recovery-operations/:operationId/approval/revoke",
    async (c) => {
      const context = await requireAccessContext(c, deps);
      const accountId = c.req.param("accountId");
      await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
      const request = OrganizationRecoveryCommandRequest.parse(await c.req.json());
      return c.json(
        OrganizationRecoveryOperation.parse(
          await revokeOrganizationRecoveryForRequest(
            deps,
            context,
            accountId,
            c.req.param("operationId"),
            request,
          ),
        ),
      );
    },
  );

  for (const action of ["cancel", "finalize"] as const) {
    app.post(`/v1/accounts/:accountId/recovery-operations/:operationId/${action}`, async (c) => {
      const context = await requireAccessContext(c, deps);
      const accountId = c.req.param("accountId");
      await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
      const request = OrganizationRecoveryCommandRequest.parse(await c.req.json());
      const operation =
        action === "cancel"
          ? await cancelOrganizationRecoveryForRequest(
              deps,
              context,
              accountId,
              c.req.param("operationId"),
              request,
            )
          : await finalizeOrganizationRecoveryForRequest(
              deps,
              context,
              accountId,
              c.req.param("operationId"),
              request,
            );
      return c.json(OrganizationRecoveryOperation.parse(operation));
    });
  }
}

export function requireSecureRecoveryTransport(requestUrl: string, deps: ApiRouteDeps): void {
  if (deps.settings.environment === "local" || deps.settings.environment === "test") return;
  // The request URL is authoritative for direct TLS. When TLS terminates at a
  // deployment edge, trust only the operator-owned canonical URL rather than
  // a caller-controlled forwarding header.
  if (
    new URL(requestUrl).protocol === "https:" ||
    (deps.settings.publicBaseUrl && new URL(deps.settings.publicBaseUrl).protocol === "https:")
  ) {
    return;
  }
  throw new HTTPException(400, { message: "organization recovery evidence requires HTTPS" });
}

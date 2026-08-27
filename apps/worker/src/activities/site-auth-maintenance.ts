import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  SITE_AUTH_MAINTENANCE_CONNECTION_CONTEXT_KEY,
  SITE_AUTH_MAINTENANCE_OPERATION_CONTEXT_KEY,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import {
  assertWorkspaceModelPolicyAllows,
  canonicalConfiguredModel,
  createAndStartSessionWithOutcome,
  recordWorkspaceUsage,
  resolveCatalogSettings,
} from "@opengeni/core";
import {
  claimSiteAuthMaintenance,
  confirmSiteAuthMaintenanceSessionInTransaction,
  deferSiteAuthMaintenance,
  type SiteAuthMaintenanceClaim,
} from "@opengeni/db";
import { agentRunAdmissionDenial } from "./agent-run-admission";
import type { ControlActivityServices } from "./types";

export const SITE_AUTH_MAINTENANCE_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
export const SITE_AUTH_MAINTENANCE_BATCH_SIZE = 16;

const MAINTENANCE_TOOLS = [
  "interaction_discover",
  "browser_open",
  "browser_tabs",
  "browser_observe",
  "browser_act",
  "browser_debug",
  "browser_auth",
  "interaction_request_human",
  "browser_identity",
  "browser_lifecycle",
] as const satisfies readonly FirstPartyMcpToolName[];

export type MaintainSiteAuthConnectionsResult = {
  claimed: number;
  started: number;
  deferred: number;
};

export type SiteAuthMaintenanceOptions = {
  claimTimeoutMs?: number;
  batchSize?: number;
  claim?: typeof claimSiteAuthMaintenance;
  confirm?: typeof confirmSiteAuthMaintenanceSessionInTransaction;
  defer?: typeof deferSiteAuthMaintenance;
  createSession?: typeof createAndStartSessionWithOutcome;
  admit?: typeof agentRunAdmissionDenial;
  recordUsage?: typeof recordWorkspaceUsage;
  assertModelPolicy?: typeof assertWorkspaceModelPolicyAllows;
};

/** Dispatch bounded, auditable agent sessions for due authentication checks.
 * A hidden claim id/session id pair makes every crash point replayable. */
export function createSiteAuthMaintenanceActivities(
  services: () => Promise<ControlActivityServices>,
  options: SiteAuthMaintenanceOptions = {},
) {
  const claimTimeoutMs = options.claimTimeoutMs ?? SITE_AUTH_MAINTENANCE_CLAIM_TIMEOUT_MS;
  const batchSize = options.batchSize ?? SITE_AUTH_MAINTENANCE_BATCH_SIZE;
  const claim = options.claim ?? claimSiteAuthMaintenance;
  const confirm = options.confirm ?? confirmSiteAuthMaintenanceSessionInTransaction;
  const defer = options.defer ?? deferSiteAuthMaintenance;
  const createSession = options.createSession ?? createAndStartSessionWithOutcome;
  const admit = options.admit ?? agentRunAdmissionDenial;
  const recordUsage = options.recordUsage ?? recordWorkspaceUsage;
  const assertModelPolicy = options.assertModelPolicy ?? assertWorkspaceModelPolicyAllows;

  async function maintainSiteAuthConnections(): Promise<MaintainSiteAuthConnectionsResult> {
    const service = await services();
    const claims = await claim(service.db, { claimTimeoutMs, limit: batchSize });
    const result: MaintainSiteAuthConnectionsResult = {
      claimed: claims.length,
      started: 0,
      deferred: 0,
    };
    for (const maintenance of claims) {
      try {
        await dispatchMaintenanceSession(service, maintenance, {
          confirm,
          createSession,
          admit,
          recordUsage,
          assertModelPolicy,
        });
        result.started += 1;
      } catch (error) {
        const released = await defer(service.db, {
          accountId: maintenance.accountId,
          workspaceId: maintenance.workspaceId,
          siteAuthConnectionId: maintenance.siteAuthConnectionId,
          operationId: maintenance.operationId,
          sessionId: maintenance.sessionId,
          retryAt: maintenanceRetryAt(maintenance),
        }).catch(() => false);
        if (released) result.deferred += 1;
        service.observability.warn("site auth maintenance dispatch deferred", {
          workspaceId: maintenance.workspaceId,
          siteAuthConnectionId: maintenance.siteAuthConnectionId,
          action: maintenance.action,
          errorCategory: maintenanceErrorCategory(error),
          claimReleased: released,
        });
      }
    }
    if (result.claimed > 0) {
      service.observability.info("site auth maintenance swept", result);
    }
    return result;
  }

  return { maintainSiteAuthConnections };
}

async function dispatchMaintenanceSession(
  service: ControlActivityServices,
  maintenance: SiteAuthMaintenanceClaim,
  dependencies: {
    confirm: typeof confirmSiteAuthMaintenanceSessionInTransaction;
    createSession: typeof createAndStartSessionWithOutcome;
    admit: typeof agentRunAdmissionDenial;
    recordUsage: typeof recordWorkspaceUsage;
    assertModelPolicy: typeof assertWorkspaceModelPolicyAllows;
  },
): Promise<void> {
  const catalogSettings = (await resolveCatalogSettings(service.db, service.settings)).settings;
  const catalogService = { ...service, settings: catalogSettings };
  const model = canonicalConfiguredModel(catalogSettings, catalogSettings.openaiModel);
  if (!model) throw new Error("site auth maintenance has no configured model");
  await dependencies.assertModelPolicy(service.db, catalogSettings, maintenance.workspaceId, model);
  const denial = await dependencies.admit(catalogService, {
    accountId: maintenance.accountId,
    workspaceId: maintenance.workspaceId,
    model,
    requestedAgentRuns: 1,
  });
  if (denial) throw new Error(`site auth maintenance admission denied: ${denial}`);
  const reasoningEffort = catalogSettings.openaiReasoningEffort;
  const turnExecutionPolicy = resolveTurnExecutionPolicyV1(catalogSettings, {
    modelId: model,
    requestedModelId: null,
    modelSource: "deployment",
    reasoningEffort,
    reasoningSource: "deployment",
    latencyMode: "standard",
    latencyModeSource: "deployment",
  });
  const created = await dependencies.createSession({
    requestedSessionId: maintenance.sessionId,
    db: service.db,
    bus: service.bus,
    workflowClient: {
      wakeSessionWorkflow: async (input) => {
        await service.wakeSessionWorkflow?.(input);
      },
    },
    beforeCreateCommit: async (tx, sessionId) => {
      const confirmed = await dependencies.confirm(tx, {
        accountId: maintenance.accountId,
        workspaceId: maintenance.workspaceId,
        siteAuthConnectionId: maintenance.siteAuthConnectionId,
        operationId: maintenance.operationId,
        sessionId,
      });
      if (!confirmed) throw new Error("site auth maintenance claim changed before session start");
    },
    accountId: maintenance.accountId,
    workspaceId: maintenance.workspaceId,
    initialMessage: maintenancePrompt(maintenance),
    resources: [],
    tools: [{ kind: "mcp", id: "opengeni" }],
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    model,
    reasoningEffort,
    turnExecutionPolicy,
    sandboxBackend: catalogSettings.sandboxBackend,
    metadata: {
      role: "site_auth_maintenance",
      [SITE_AUTH_MAINTENANCE_CONNECTION_CONTEXT_KEY]: maintenance.siteAuthConnectionId,
      [SITE_AUTH_MAINTENANCE_OPERATION_CONTEXT_KEY]: maintenance.operationId,
    },
    createdBy: {
      kind: "service",
      subjectId: "site-auth-maintenance",
      label: "OpenGeni authentication maintenance",
    },
    createdByContext: {
      [SITE_AUTH_MAINTENANCE_CONNECTION_CONTEXT_KEY]: maintenance.siteAuthConnectionId,
      [SITE_AUTH_MAINTENANCE_OPERATION_CONTEXT_KEY]: maintenance.operationId,
    },
    instructions:
      "Complete only the exact browser-auth maintenance run in the initial request. Use the canonical browser/auth tools, preserve their causal fences, expose no secrets, never publish a BrowserIdentity revision, and do not perform unrelated work.",
    policyRole: "site_auth_maintenance",
    firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    firstPartyMcpTools: [...MAINTENANCE_TOOLS],
    createIdempotencyKey: `site-auth-maintenance:${maintenance.operationId}`,
    subjectId: "site-auth-maintenance",
  });
  try {
    await dependencies.recordUsage(
      { db: service.db, settings: catalogSettings },
      {
        accountId: maintenance.accountId,
        workspaceId: maintenance.workspaceId,
        subjectId: "site-auth-maintenance",
        eventType: "agent_run.created",
        quantity: 1,
        unit: "run",
        sourceResourceType: "site_auth_connection",
        sourceResourceId: maintenance.siteAuthConnectionId,
        sessionId: created.session.id,
        initiator: created.session.createdBy,
        initiatorContext: created.session.createdByContext,
        origin: "system",
        idempotencyKey: `agent_run.created:site-auth-maintenance:${maintenance.operationId}`,
      },
    );
  } catch (error) {
    service.observability.warn("site auth maintenance usage recording failed", {
      workspaceId: maintenance.workspaceId,
      siteAuthConnectionId: maintenance.siteAuthConnectionId,
      errorCategory: maintenanceErrorCategory(error),
    });
  }
}

function maintenancePrompt(maintenance: SiteAuthMaintenanceClaim): string {
  const action = maintenance.action === "repair" ? "repair authentication" : "check authentication";
  return [
    `Perform one scheduled SiteAuthConnection maintenance run: ${action}.`,
    `Connection id: ${maintenance.siteAuthConnectionId}`,
    `Connection: ${maintenance.name} (${maintenance.accountLabel})`,
    `Purpose: ${maintenance.action}`,
    maintenance.loginUrl ? `Login URL: ${maintenance.loginUrl}` : null,
    maintenance.verificationUrlPrefixes.length > 0
      ? `Verification URL prefixes: ${maintenance.verificationUrlPrefixes.join(", ")}`
      : "No dedicated verification URL is configured; use the connection's allowed origins.",
    maintenance.preferredIdentityId
      ? `Preferred BrowserIdentity: ${maintenance.preferredIdentityId}`
      : "No preferred BrowserIdentity is configured.",
    maintenance.preferredPlacement
      ? `Preferred placement: ${JSON.stringify(maintenance.preferredPlacement)}`
      : "Use the normal managed-browser placement.",
    maintenance.preferredNetworkRouteId
      ? `Preferred NetworkRoute: ${maintenance.preferredNetworkRouteId}`
      : "No preferred NetworkRoute is configured.",
    "First call browser_auth get_connection and ensure this exact maintenance action is still active. Open a new browser (do not reuse an unrelated session) with the preferred identity, placement, and network route. Observe the current page, start one AuthRun with the exact purpose above, and settle it as verified, failed, cancelled, or a durable human intervention. For an external_provider authority use advance_external. If authentication is already valid, verify it without logging in again. If a health check finds invalid authentication, report it failed; automatic repair, when enabled, is a separate maintenance run. Never save/publish browser state in this run.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function maintenanceRetryAt(maintenance: SiteAuthMaintenanceClaim): Date {
  const retrySeconds = Math.min(maintenance.healthPolicy.intervalSeconds ?? 300, 15 * 60);
  return new Date(Date.now() + retrySeconds * 1_000);
}

function maintenanceErrorCategory(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.length <= 100 ? name : "unknown";
}

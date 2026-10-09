// Codex routes for organizations whose Codex cutover row exists (M3 PR 2b).
//
// `codexRouteDisposition` is read first by every Codex route. Without a
// cutover row the legacy handler runs unchanged. A disabled row answers a
// typed 503 and reads no legacy Codex table. An enabled row runs the
// handlers below: the same paths, verbs, request fields and response shapes,
// projected from the shared subscription core (SUB-COMPAT-02). Operations the
// core does not serve yet answer a typed 409 instead of touching legacy state.
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod/v4";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { ApiHttpError } from "../http/api-error";
import {
  clearSubscriptionCoreCodexApps,
  deliverSubscriptionCoreCodexWake,
  designateSubscriptionCoreCodexApps,
  fetchSubscriptionCoreCodexUsage,
  getSubscriptionCoreCodexAppsSettings,
  getSubscriptionCoreCodexWorkspaceProjection,
  getSubscriptionCoreOrganizationCodexProjection,
  readCodexCutoverDisposition,
  renameSubscriptionCoreCodexConnection,
  resolveSubscriptionCoreCodexConnectionId,
  setSubscriptionCoreCodexAllocator,
  setSubscriptionCoreCodexExtraCredits,
  setSubscriptionCoreCodexPrimary,
  setSubscriptionCoreCodexRotation,
  setSubscriptionCoreWorkspaceCodexSource,
  SubscriptionCoreCodexSourceRefusedError,
} from "@opengeni/db";
import type { CodexFetch, CodexUsagePayload } from "@opengeni/codex";
import {
  codexAccountJson,
  codexModelsForPicker,
  codexUsageJson,
  codexWorkerReadiness,
  managedHumanOrAgent,
  requireCodexAppsHuman,
} from "./codex";

export const SUBSCRIPTION_CORE_CUTOVER_DISABLED = "subscription_core_cutover_disabled";
export const SUBSCRIPTION_CORE_ROUTE_UNSUPPORTED = "subscription_core_route_unsupported";

/** The public error envelope with the core reason in `details.reason`. */
function typedHttpError(status: 409 | 503, reason: string, message: string): ApiHttpError {
  return new ApiHttpError(status, {
    code: status === 503 ? "upstream_unavailable" : "conflict",
    message,
    retryable: status === 503,
    outcomeUnknown: false,
    details: { reason },
  });
}

/**
 * `legacy` without a Codex cutover row, `core` with an enabled one. A
 * disabled row is maintenance: fail closed, never fall back to legacy state.
 */
export async function codexRouteDisposition(
  deps: ApiRouteDeps,
  accountId: string,
): Promise<"legacy" | "core"> {
  const disposition = await readCodexCutoverDisposition(deps.db, accountId);
  if (disposition === "maintenance") {
    throw typedHttpError(
      503,
      SUBSCRIPTION_CORE_CUTOVER_DISABLED,
      "Codex subscriptions are paused for maintenance in this organization",
    );
  }
  return disposition;
}

/** An operation the shared core does not serve yet (listed as a PR 3 leftover). */
export function coreCodexRouteUnsupported(): never {
  throw typedHttpError(
    409,
    SUBSCRIPTION_CORE_ROUTE_UNSUPPORTED,
    "This Codex operation is not available yet for this organization",
  );
}

function projection(deps: ApiRouteDeps, accountId: string, workspaceId: string) {
  return getSubscriptionCoreCodexWorkspaceProjection(deps.db, { accountId, workspaceId });
}

export async function coreCodexSource(
  c: Context,
  deps: ApiRouteDeps,
  accountId: string,
  workspaceId: string,
) {
  return c.json((await projection(deps, accountId, workspaceId)).source);
}

export async function coreCodexSetSource(
  c: Context,
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    mode: "automatic" | "workspace" | "organization" | "disabled";
  },
) {
  let result: Awaited<ReturnType<typeof setSubscriptionCoreWorkspaceCodexSource>>;
  try {
    result = await setSubscriptionCoreWorkspaceCodexSource(deps.db, input);
  } catch (error) {
    if (error instanceof SubscriptionCoreCodexSourceRefusedError) {
      throw new HTTPException(error.message.includes("personal workspaces") ? 409 : 403, {
        message: error.message,
      });
    }
    throw error;
  }
  await deliverSubscriptionCoreCodexWake(deps.db, result.wake);
  return c.json(result.source);
}

/**
 * Readiness is computed from the core pool; there is no live provider model
 * probe (that needs a connection-level credential read, which is PR 2c's usage
 * seam), so `valid` reports whether a serviceable account exists and `models`
 * is the configured Codex catalog.
 */
export async function coreCodexStatus(
  c: Context,
  deps: ApiRouteDeps,
  accountId: string,
  workspaceId: string,
  catalogSettings: Parameters<typeof codexModelsForPicker>[0],
) {
  const { accounts, rotation, source } = await projection(deps, accountId, workspaceId);
  const active = accounts.find((account) => account.id === rotation.activeCredentialId) ?? null;
  const readiness = codexWorkerReadiness({
    effectiveSource: source.effectiveSource,
    rotationEnabled: rotation.rotationEnabled,
    activeCredentialId: rotation.activeCredentialId,
    accounts,
    now: new Date(),
  });
  const connected = accounts.some((account) => account.status === "active");
  return c.json({
    connected,
    plan: active?.planType ?? null,
    valid: readiness.poolReady,
    activeAccountValid: active?.status === "active",
    poolReady: readiness.poolReady,
    workerRoutable: readiness.workerRoutable,
    expiresAt: active?.expiresAt ?? null,
    lastError: active?.lastError ?? null,
    models: connected ? codexModelsForPicker(catalogSettings) : [],
    activeAccount: active
      ? {
          id: active.id,
          label: active.label ?? active.accountEmail ?? active.planType ?? active.chatgptAccountId,
          chatgptAccountId: active.chatgptAccountId,
        }
      : null,
    accountCount: accounts.length,
    source,
  });
}

export async function coreCodexAccounts(
  c: Context,
  deps: ApiRouteDeps,
  grant: Awaited<ReturnType<typeof requireAccessGrant>>,
  workspaceId: string,
) {
  const [{ accounts, rotation, source }, apps, human] = await Promise.all([
    projection(deps, grant.accountId, workspaceId),
    getSubscriptionCoreCodexAppsSettings(deps.db, { accountId: grant.accountId, workspaceId }),
    managedHumanOrAgent(c, deps),
  ]);
  const humanSubjectId = human?.subjectId === grant.subjectId ? human.subjectId : null;
  const canManageApps =
    deps.settings.codexConnectedAppsEnabled &&
    humanSubjectId !== null &&
    hasPermission(grant.permissions, "connections:write");
  return c.json({
    accounts: accounts.map((account) => ({
      ...codexAccountJson(account, {
        appsCredentialId: apps.credentialId,
        canManageApps,
        humanSubjectId,
      }),
      // Core designation authority is administrator/delegated manager in any
      // source mode (design 6.3), enforced by the database; this is the hint.
      canEnableApps: apps.credentialId === null && canManageApps && account.status === "active",
    })),
    activeAccountId: rotation.activeCredentialId,
    source,
    apps: {
      available: deps.settings.codexConnectedAppsEnabled,
      credentialId: apps.credentialId,
      version: apps.version,
      designatedAt: apps.designatedAt,
      canDisable: canManageApps && apps.credentialId !== null,
    },
    settings: {
      rotationEnabled: rotation.rotationEnabled,
      rotationStrategy: "sharded",
      activeCredentialId: rotation.activeCredentialId,
    },
  });
}

type AppsHuman = Awaited<ReturnType<typeof requireCodexAppsHuman>>;

export async function coreCodexDesignateApps(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  { human, accountId }: AppsHuman,
) {
  if (!deps.settings.codexConnectedAppsEnabled) {
    throw new HTTPException(409, { message: "Codex Apps is disabled for this deployment" });
  }
  const parsed = z
    .object({ accountId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(400, { message: "accountId and expectedVersion are required" });
  }
  const result = await designateSubscriptionCoreCodexApps(deps.db, {
    accountId,
    workspaceId,
    connectionId: parsed.data.accountId,
    subjectId: human.subjectId,
    expectedVersion: parsed.data.expectedVersion,
  });
  if (result.kind === "not_found") {
    throw new HTTPException(404, { message: "codex account not found" });
  }
  if (result.kind === "forbidden") {
    throw new HTTPException(403, {
      message:
        "only an organization administrator or the account's managing workspace administrator may designate it",
    });
  }
  if (result.kind === "unavailable") {
    throw new HTTPException(409, { message: "codex account requires relogin" });
  }
  const response = {
    credentialId: result.credentialId,
    version: result.version,
    designatedAt: result.designatedAt,
    changed: result.kind === "updated",
  };
  return result.kind === "updated" ? c.json(response) : c.json(response, 409);
}

export async function coreCodexClearApps(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  { human, accountId }: AppsHuman,
) {
  const parsed = z
    .object({ expectedVersion: z.number().int().nonnegative() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(400, { message: "expectedVersion is required" });
  }
  const result = await clearSubscriptionCoreCodexApps(deps.db, {
    accountId,
    workspaceId,
    subjectId: human.subjectId,
    expectedVersion: parsed.data.expectedVersion,
  });
  if (result.kind === "forbidden") {
    throw new HTTPException(403, {
      message:
        "only an organization administrator or the account's managing workspace administrator may clear it",
    });
  }
  const response = {
    credentialId: result.credentialId,
    version: result.version,
    designatedAt: result.designatedAt,
    changed: result.kind === "updated",
  };
  return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
}

type Admin = { accountId: string; workspaceId: string | null; subjectId: string };

export async function coreCodexActivate(
  c: Context,
  deps: ApiRouteDeps,
  admin: Admin,
  connectionId: string,
) {
  const result = await setSubscriptionCoreCodexPrimary(deps.db, { ...admin, connectionId });
  if (!result.activated) throw new HTTPException(404, { message: "codex account not found" });
  await deliverSubscriptionCoreCodexWake(deps.db, result.wake);
  return c.json({ activated: true, accountId: connectionId });
}

export async function coreCodexSetRotation(
  c: Context,
  deps: ApiRouteDeps,
  admin: Admin,
  rotationEnabled: boolean,
) {
  const result = await setSubscriptionCoreCodexRotation(deps.db, { ...admin, rotationEnabled });
  if (!result.rotation) {
    throw new HTTPException(404, {
      message: admin.workspaceId ? "codex rotation settings not found" : "Codex settings not found",
    });
  }
  await deliverSubscriptionCoreCodexWake(deps.db, result.wake);
  return c.json({
    rotationEnabled: result.rotation.rotationEnabled,
    rotationStrategy: "sharded",
    activeCredentialId: result.rotation.activeCredentialId,
  });
}

export async function coreCodexRename(
  c: Context,
  deps: ApiRouteDeps,
  admin: Admin,
  connectionId: string,
  label: string | null,
) {
  const renamed = await renameSubscriptionCoreCodexConnection(deps.db, {
    ...admin,
    connectionId,
    label,
  });
  if (!renamed) throw new HTTPException(404, { message: "codex account not found" });
  const accounts = admin.workspaceId
    ? (await projection(deps, admin.accountId, admin.workspaceId)).accounts
    : (
        await getSubscriptionCoreOrganizationCodexProjection(deps.db, {
          organizationId: admin.accountId,
          subjectId: admin.subjectId,
        })
      ).accounts;
  const row = accounts.find((account) => account.id === renamed);
  if (!row) throw new HTTPException(404, { message: "codex account not found" });
  return c.json(codexAccountJson(row));
}

export async function coreCodexAllocator(
  c: Context,
  deps: ApiRouteDeps,
  admin: Admin,
  connectionId: string,
  body: { enabled: boolean; expectedVersion: number },
) {
  const mutation = await setSubscriptionCoreCodexAllocator(deps.db, {
    ...admin,
    connectionId,
    ...body,
  });
  const result = mutation.result;
  if (result.kind === "not_found") {
    throw new HTTPException(404, { message: "codex account not found" });
  }
  await deliverSubscriptionCoreCodexWake(deps.db, mutation.wake);
  const response = {
    allocatorEnabled: result.allocatorEnabled,
    allocatorVersion: result.allocatorVersion,
    allocatorUpdatedAt: result.allocatorUpdatedAt,
    changed: result.kind === "updated",
  };
  return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
}

export async function coreCodexExtraCredits(
  c: Context,
  deps: ApiRouteDeps,
  admin: Admin,
  connectionId: string,
  body: { enabled: boolean; expectedVersion: number },
) {
  const mutation = await setSubscriptionCoreCodexExtraCredits(deps.db, {
    ...admin,
    connectionId,
    ...body,
  });
  const result = mutation.result;
  if (result.kind === "not_found") {
    throw new HTTPException(404, { message: "codex account not found" });
  }
  await deliverSubscriptionCoreCodexWake(deps.db, mutation.wake);
  const response = {
    extraCreditsEnabled: result.extraCreditsEnabled,
    extraCreditsVersion: result.extraCreditsVersion,
    extraCreditsUpdatedAt: result.extraCreditsUpdatedAt,
    changed: result.kind === "updated",
  };
  return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
}

export async function coreOrganizationCodexAccounts(
  c: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  subjectId: string,
) {
  const { accounts, rotation } = await getSubscriptionCoreOrganizationCodexProjection(deps.db, {
    organizationId,
    subjectId,
  });
  return c.json({
    accounts: accounts.map((account) => codexAccountJson(account)),
    activeAccountId: rotation.activeCredentialId,
    settings: {
      rotationEnabled: rotation.rotationEnabled,
      rotationStrategy: "sharded",
      activeCredentialId: rotation.activeCredentialId,
    },
  });
}

type Grant = Awaited<ReturnType<typeof requireAccessGrant>>;

/** One connection's live usage through the core seam; wakes waiters on recovery. */
async function liveCoreCodexUsage(
  deps: ApiRouteDeps,
  grant: Grant,
  workspaceId: string,
  connectionId: string,
): Promise<CodexUsagePayload> {
  const { usage, recovered } = await fetchSubscriptionCoreCodexUsage(
    deps.db,
    deps.settings,
    { kind: "workspace", accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
    connectionId,
    (deps.codexFetch ?? fetch) as CodexFetch,
  );
  if (recovered) {
    // The quota observation already committed; a failed wake hint must never
    // turn the read into an error (every core waiter has its own recheck).
    await deliverSubscriptionCoreCodexWake(deps.db, {
      accountId: grant.accountId,
      reason: "usage_recovered",
    }).catch(() => undefined);
  }
  return usage;
}

/**
 * Live usage on the core (EP-N21): the workspace's effective primary
 * connection (the legacy active account), or one connection of the
 * workspace's pool by id or legacy alias. The 404 copy matches legacy.
 */
export async function coreCodexUsage(
  c: Context,
  deps: ApiRouteDeps,
  grant: Grant,
  workspaceId: string,
  requestedId: string | null,
) {
  const { accounts, rotation } = await projection(deps, grant.accountId, workspaceId);
  let connectionId: string | null;
  if (requestedId === null) {
    connectionId = rotation.activeCredentialId;
    if (!connectionId || !accounts.some((account) => account.id === connectionId)) {
      throw new HTTPException(404, { message: "codex subscription is not connected" });
    }
  } else {
    connectionId = z.uuid().safeParse(requestedId).success
      ? await resolveSubscriptionCoreCodexConnectionId(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          connectionId: requestedId,
        })
      : null;
    if (!connectionId || !accounts.some((account) => account.id === connectionId)) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
  }
  return c.json(codexUsageJson(await liveCoreCodexUsage(deps, grant, workspaceId, connectionId)));
}

/** Batched live refresh over the workspace's core pool, four provider calls at a time. */
export async function coreCodexUsageRefresh(
  c: Context,
  deps: ApiRouteDeps,
  grant: Grant,
  workspaceId: string,
) {
  const { accounts } = await projection(deps, grant.accountId, workspaceId);
  const usage: Record<string, ReturnType<typeof codexUsageJson>> = {};
  const queue = [...accounts];
  const worker = async (): Promise<void> => {
    for (;;) {
      const account = queue.shift();
      if (!account) return;
      const settled = await Promise.allSettled([
        liveCoreCodexUsage(deps, grant, workspaceId, account.id),
      ]);
      const result = settled[0];
      usage[account.id] =
        result.status === "fulfilled"
          ? codexUsageJson(result.value)
          : codexUsageJson({
              status: "error",
              planType: null,
              fiveHour: null,
              weekly: null,
              limitReached: false,
              fetchedAt: new Date().toISOString(),
              rateLimitResetCredits: null,
            });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, accounts.length)) }, () => worker()),
  );
  return c.json({ usage });
}

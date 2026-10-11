import {
  ModelAccountSettingsOverview,
  OrganizationModelAccountSettings,
  UpdateOrganizationModelAccountSettingsRequest,
  UpdateWorkspaceModelAccountSettingsRequest,
  WorkspaceModelAccountSettings,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  deliverSubscriptionCoreCodexWake,
  readOrganizationSubscriptionSettings,
  readSubscriptionSettingsOverview,
  readWorkspaceSubscriptionSettings,
  SubscriptionSettingsBusyError,
  SubscriptionSettingsForbiddenError,
  SubscriptionSettingsInvalidError,
  SubscriptionSettingsLockedError,
  subscriptionSettingLockRefusal,
  SubscriptionSettingsPersonalWorkspaceError,
  SubscriptionSettingsVersionConflictError,
  updateOrganizationSubscriptionSettings,
  updateWorkspaceSubscriptionSettings,
  type SubscriptionSettingsWake,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ApiHttpError } from "../http/api-error";
import { requireOrganizationCodexHuman, requireSameOriginBrowserMutation } from "./codex";

const Uuid = z.string().uuid();

function parseId(value: string | undefined, what: "organization" | "workspace"): string {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: `${what} not found` });
  return parsed.data;
}

/**
 * 409 `setting_locked` for any write the organization's settings lock refused:
 * these routes and every older route whose write meets the 0716 guard (for
 * example a Codex rotation, primary or source change). Mapped centrally in
 * the app error handler.
 */
export function subscriptionSettingsLockedHttpError(error: unknown): ApiHttpError | null {
  const settings =
    error instanceof SubscriptionSettingsLockedError
      ? [...error.settings]
      : subscriptionSettingLockRefusal(error);
  if (settings === null) return null;
  return new ApiHttpError(409, {
    code: "conflict",
    message: "the organization locked this setting",
    retryable: false,
    outcomeUnknown: false,
    details: { reason: "setting_locked", settings },
  });
}

/** Typed refusals to HTTP: 403, 409 (locked, Personal workspace, version), 422 or 503 (busy). */
function refused(error: unknown): never {
  if (error instanceof SubscriptionSettingsForbiddenError) {
    throw new HTTPException(403, { message: error.message });
  }
  const locked = subscriptionSettingsLockedHttpError(error);
  if (locked) throw locked;
  if (error instanceof SubscriptionSettingsPersonalWorkspaceError) {
    throw new ApiHttpError(409, {
      code: "conflict",
      message: error.message,
      retryable: false,
      outcomeUnknown: false,
      details: { reason: "personal_workspace" },
    });
  }
  if (error instanceof SubscriptionSettingsVersionConflictError) {
    throw new ApiHttpError(409, {
      code: "conflict",
      message: error.message,
      retryable: false,
      outcomeUnknown: false,
      details: { reason: "version_conflict", currentVersion: error.currentVersion },
    });
  }
  if (error instanceof SubscriptionSettingsInvalidError) {
    throw new HTTPException(422, { message: error.message });
  }
  if (error instanceof SubscriptionSettingsBusyError) {
    // A lock change kept yielding to workspace writes; nothing was written.
    throw new ApiHttpError(503, {
      code: "upstream_unavailable",
      message: error.message,
      retryable: true,
      outcomeUnknown: false,
      details: { reason: "settings_busy" },
    });
  }
  throw error;
}

async function wake(deps: ApiRouteDeps, value: SubscriptionSettingsWake | null): Promise<void> {
  // Capacity waiters recheck on their own bounded timer; a lost wake only delays.
  await deliverSubscriptionCoreCodexWake(deps.db, value).catch(() => undefined);
}

async function jsonBody(c: Context): Promise<unknown> {
  return await c.req.json().catch(() => null);
}

/**
 * Model-account settings (SUB-SET-01..05). Organization owners and admins
 * read and change the organization's values and locks and read the overview
 * of every shared workspace. Workspace members read their workspace's
 * effective values; its administrators (and organization administrators)
 * override what the organization has not locked. The database enforces
 * every refusal; these routes only translate it.
 */
export function registerModelAccountSettingsRoutes(app: Hono, deps: ApiRouteDeps): void {
  const organizationPath = "/v1/organizations/:organizationId/model-account-settings";

  app.get(organizationPath, async (c) => {
    c.header("cache-control", "private, no-store");
    const organizationId = parseId(c.req.param("organizationId"), "organization");
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    try {
      return c.json(
        OrganizationModelAccountSettings.parse(
          await readOrganizationSubscriptionSettings(deps.db, {
            organizationId,
            actorSubjectId: human.subjectId,
          }),
        ),
      );
    } catch (error) {
      refused(error);
    }
  });

  app.patch(organizationPath, async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const organizationId = parseId(c.req.param("organizationId"), "organization");
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const parsed = UpdateOrganizationModelAccountSettingsRequest.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(422, { message: "invalid model account settings" });
    }
    const { expectedVersion, ...patch } = parsed.data;
    try {
      const result = await updateOrganizationSubscriptionSettings(deps.db, {
        organizationId,
        actorSubjectId: human.subjectId,
        patch,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      await wake(deps, result.wake);
      return c.json(OrganizationModelAccountSettings.parse(result.settings));
    } catch (error) {
      refused(error);
    }
  });

  app.get(`${organizationPath}/overview`, async (c) => {
    c.header("cache-control", "private, no-store");
    const organizationId = parseId(c.req.param("organizationId"), "organization");
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const after = c.req.query("after");
    if (after !== undefined && !Uuid.safeParse(after).success) {
      throw new HTTPException(422, { message: "invalid cursor" });
    }
    const limitText = c.req.query("limit");
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new HTTPException(422, { message: "limit must be between 1 and 500" });
    }
    try {
      return c.json(
        ModelAccountSettingsOverview.parse(
          await readSubscriptionSettingsOverview(deps.db, {
            organizationId,
            actorSubjectId: human.subjectId,
            after: after ?? null,
            ...(limit === undefined ? {} : { limit }),
          }),
        ),
      );
    } catch (error) {
      refused(error);
    }
  });

  const workspacePath = "/v1/workspaces/:workspaceId/model-account-settings";

  app.get(workspacePath, async (c) => {
    c.header("cache-control", "private, no-store");
    const workspaceId = parseId(c.req.param("workspaceId"), "workspace");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    try {
      return c.json(
        WorkspaceModelAccountSettings.parse(
          await readWorkspaceSubscriptionSettings(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
          }),
        ),
      );
    } catch (error) {
      refused(error);
    }
  });

  app.patch(workspacePath, async (c) => {
    const workspaceId = parseId(c.req.param("workspaceId"), "workspace");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const parsed = UpdateWorkspaceModelAccountSettingsRequest.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(422, { message: "invalid model account settings" });
    }
    const { expectedVersion, ...patch } = parsed.data;
    try {
      const result = await updateWorkspaceSubscriptionSettings(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        patch,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      await wake(deps, result.wake);
      return c.json(WorkspaceModelAccountSettings.parse(result.settings));
    } catch (error) {
      refused(error);
    }
  });
}

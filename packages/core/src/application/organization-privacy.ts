import type { Settings } from "@opengeni/config";
import type {
  OrganizationPrivacySettings,
  UpdateOrganizationPrivacySettingsRequest,
} from "@opengeni/contracts";
import {
  getOrganizationPrivacyPreferences,
  getPrivateSessionCreatePolicy,
  SessionTenancyNotActivatedError,
  updateOrganizationPrivacyPreferences,
  type Database,
  type OrganizationPrivacyPreferences,
} from "@opengeni/db";

/**
 * Privacy: who can see chats, schedules and their runs. An organization's
 * owners and admins choose whether Only me is allowed (the private session
 * setting), the default audience for new chats and schedules, and whether
 * admins see that other people's Only me schedules exist. A deployment, such
 * as a product that embeds Opengeni, can only narrow those choices. See
 * docs/design/privacy-audiences-2026-10-11.md.
 */

export type PrivacySettings = Pick<
  Settings,
  | "privacyOnlyMeAllowed"
  | "privacyWorkspaceDefaultRequired"
  | "privacyAdminScheduleSummariesRequired"
>;

export type PrivacyDeploymentLimits = OrganizationPrivacySettings["limits"];

export function privacyDeploymentLimits(settings: PrivacySettings): PrivacyDeploymentLimits {
  const onlyMeAllowed = settings.privacyOnlyMeAllowed !== false;
  return {
    onlyMeAllowed,
    // Without Only me, Workspace is the only possible default.
    defaultVisibilityLocked: !onlyMeAllowed || settings.privacyWorkspaceDefaultRequired === true,
    adminsSeePrivateSchedulesLocked: settings.privacyAdminScheduleSummariesRequired === true,
  };
}

export type EffectiveOrganizationPrivacy = {
  defaultVisibility: "private" | "workspace";
  adminsSeePrivateSchedules: boolean;
};

/** The organization's choices with the deployment's limits applied. */
export function effectiveOrganizationPrivacy(
  preferences: Pick<
    OrganizationPrivacyPreferences,
    "defaultVisibility" | "adminsSeePrivateSchedules"
  >,
  limits: PrivacyDeploymentLimits,
): EffectiveOrganizationPrivacy {
  return {
    defaultVisibility:
      !limits.defaultVisibilityLocked && preferences.defaultVisibility === "user_private"
        ? "private"
        : "workspace",
    adminsSeePrivateSchedules:
      limits.adminsSeePrivateSchedulesLocked || preferences.adminsSeePrivateSchedules,
  };
}

export async function resolveOrganizationPrivacy(
  deps: { db: Database; settings: PrivacySettings },
  accountId: string,
): Promise<EffectiveOrganizationPrivacy> {
  return effectiveOrganizationPrivacy(
    await getOrganizationPrivacyPreferences(deps.db, accountId),
    privacyDeploymentLimits(deps.settings),
  );
}

/**
 * Refuse a new Only me chat or schedule in a shared workspace when this
 * deployment turns Only me off. A Personal workspace is only ever its owner's,
 * so it is unaffected. Existing Only me items keep their audience: narrowing
 * is always allowed, widening never happens silently.
 */
export async function requireDeploymentAllowsOnlyMe(
  deps: { db: Database; settings: PrivacySettings },
  input: { workspaceId: string; actorSubjectId: string },
): Promise<void> {
  if (privacyDeploymentLimits(deps.settings).onlyMeAllowed) return;
  const policy = await getPrivateSessionCreatePolicy(deps.db, input).catch(() => null);
  if (!policy?.personalWorkspace) throw new SessionTenancyNotActivatedError();
}

/** Raised when a change would go past what this deployment allows. */
export class OrganizationPrivacyLockedError extends Error {
  readonly name = "OrganizationPrivacyLockedError";
}

function settingsResponse(
  organizationId: string,
  preferences: OrganizationPrivacyPreferences,
  limits: PrivacyDeploymentLimits,
): OrganizationPrivacySettings {
  return {
    organizationId,
    ...effectiveOrganizationPrivacy(preferences, limits),
    limits,
    updatedAt: preferences.updatedAt,
  };
}

export async function getOrganizationPrivacySettings(
  deps: { db: Database; settings: PrivacySettings },
  organizationId: string,
): Promise<OrganizationPrivacySettings> {
  return settingsResponse(
    organizationId,
    await getOrganizationPrivacyPreferences(deps.db, organizationId),
    privacyDeploymentLimits(deps.settings),
  );
}

/**
 * Change the organization's privacy choices. Only an owner or admin may, and
 * never past the deployment's limits.
 */
export async function updateOrganizationPrivacySettings(
  deps: { db: Database; settings: PrivacySettings },
  input: {
    organizationId: string;
    actorSubjectId: string;
    request: UpdateOrganizationPrivacySettingsRequest;
  },
): Promise<OrganizationPrivacySettings> {
  const limits = privacyDeploymentLimits(deps.settings);
  if (input.request.defaultVisibility === "private" && limits.defaultVisibilityLocked) {
    throw new OrganizationPrivacyLockedError(
      limits.onlyMeAllowed
        ? "New chats and schedules always start as Workspace here."
        : "Only me is turned off here.",
    );
  }
  if (input.request.adminsSeePrivateSchedules === false && limits.adminsSeePrivateSchedulesLocked) {
    throw new OrganizationPrivacyLockedError(
      "Admins always see that Only me schedules exist here.",
    );
  }
  const preferences = await updateOrganizationPrivacyPreferences(deps.db, {
    organizationId: input.organizationId,
    actorSubjectId: input.actorSubjectId,
    ...(input.request.defaultVisibility
      ? {
          defaultVisibility:
            input.request.defaultVisibility === "private"
              ? ("user_private" as const)
              : ("workspace_shared" as const),
        }
      : {}),
    ...(input.request.adminsSeePrivateSchedules !== undefined
      ? { adminsSeePrivateSchedules: input.request.adminsSeePrivateSchedules }
      : {}),
  });
  return settingsResponse(input.organizationId, preferences, limits);
}

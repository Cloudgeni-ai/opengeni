// A catalog connect names the capability it is for (OAuthStartRequest
// .capabilityId). When the provider sign-in finishes, the callback turns that
// capability on with the new account, as the person who started it and with
// the same checks as the enable route. Setup is then done even if no page
// loads afterwards: a closed browser tab, a desktop hand-back the browser
// blocked, or an app that was quit. The page that loads later only shows the
// result. Anything that stops it here (no permission, an admin turned the
// integration off, a catalog change) leaves the connection saved and the page
// finishes as before.
import { EnableCapabilityRequest, type ConnectionOwnership } from "@opengeni/contracts";
import { PERSONAL_INTEGRATION_SETUP_PERMISSION } from "@opengeni/contracts/personal-integration-setup";
import {
  currentConnectOwnerGrant,
  enableCapability,
  hasIntegrationAdminPermission,
  hasIntegrationSetupPermission,
  hasPermission,
  type ConnectOwner,
} from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import { getCapabilityInstallation, type Database } from "@opengeni/db";

/**
 * What the callback did with the capability, carried back to the page as
 * `capability=<value>`:
 * - `enabled`: it turned the capability on, or pointed it at the new account;
 * - `on`: it was already on in a way that includes the new account;
 * - absent: it did not finish it, so the page enables it as before.
 */
export type ConnectCapabilityFinish = "enabled" | "on";

type InstalledRef = {
  connectionId?: unknown;
  subjectScope?: unknown;
  accountSelection?: unknown;
};

/**
 * What the page would do for this capability and account, decided from the
 * installation as it is now. Mirrors the web app's `oauthResumeAction`,
 * `catalogConnectionAccountSelection` and `oauthConnectionRef`.
 */
export function connectCapabilityPlan(
  installation: { status: string; config: Record<string, unknown> } | null,
  connection: { id: string; providerDomain: string },
  ownership: ConnectionOwnership,
): { kind: "on" } | { kind: "enable"; payload: EnableCapabilityRequest } {
  const enabled = installation?.status === "active";
  const raw = installation?.config.connectionRef;
  const ref: InstalledRef | null = raw && typeof raw === "object" ? (raw as InstalledRef) : null;
  if (enabled && ref) {
    // A per-person binding finds each person's own account by itself.
    if (ref.subjectScope === "subject") return { kind: "on" };
    if (ref.connectionId === connection.id) return { kind: "on" };
    // Every eligible account is already included, the new one too.
    if (!ref.connectionId && ref.accountSelection === "all_eligible") return { kind: "on" };
  }
  const accountSelection =
    ref?.connectionId || (enabled && ref?.accountSelection !== "all_eligible")
      ? undefined
      : ("all_eligible" as const);
  const connectionRef = accountSelection
    ? {
        providerDomain: connection.providerDomain,
        kind: "oauth2" as const,
        subjectScope: ownership === "personal" ? ("subject" as const) : ("workspace" as const),
        accountSelection,
      }
    : ownership === "personal"
      ? {
          providerDomain: connection.providerDomain,
          kind: "oauth2" as const,
          subjectScope: "subject" as const,
        }
      : {
          connectionId: connection.id,
          providerDomain: connection.providerDomain,
          kind: "oauth2" as const,
          subjectScope: "workspace" as const,
        };
  return { kind: "enable", payload: EnableCapabilityRequest.parse({ connectionRef }) };
}

export async function finishCapabilityAfterConnect(
  deps: { db: Database; settings: Settings },
  input: {
    owner: ConnectOwner;
    capabilityId: string;
    ownership: ConnectionOwnership;
    connection: { id: string; providerDomain: string };
  },
): Promise<ConnectCapabilityFinish | null> {
  const { db, settings } = deps;
  const { owner, capabilityId } = input;
  try {
    const grant = await currentConnectOwnerGrant(db, owner);
    if (!grant) return null;
    const installation = await getCapabilityInstallation(db, owner.workspaceId, capabilityId);
    const plan = connectCapabilityPlan(installation, input.connection, input.ownership);
    if (plan.kind === "on") return "on";
    // The enable route's own rules: integration admins change anything,
    // members turn on what is not on yet, and the personal setup permission
    // turns a reviewed OAuth integration on for personal accounts.
    const memberSetup =
      !hasIntegrationAdminPermission(grant) && hasIntegrationSetupPermission(grant);
    const personalSetup = !hasIntegrationSetupPermission(grant);
    if (
      personalSetup &&
      !hasPermission(grant.permissions, PERSONAL_INTEGRATION_SETUP_PERMISSION, grant.permissionMode)
    )
      return null;
    await enableCapability({
      db,
      grant,
      ...(personalSetup ? { personalSetup: true } : {}),
      ...(memberSetup ? { memberSetup: true } : {}),
      accountId: grant.accountId,
      workspaceId: owner.workspaceId,
      settings,
      capabilityId,
      payload: plan.payload,
    });
    return "enabled";
  } catch (error) {
    console.warn("[api] a finished sign-in could not turn on its capability", {
      workspaceId: owner.workspaceId,
      capabilityId,
      connectionId: input.connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

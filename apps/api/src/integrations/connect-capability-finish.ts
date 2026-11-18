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
  buildCapabilityCatalog,
  currentConnectOwnerGrant,
  enableCapability,
  hasIntegrationAdminPermission,
  hasIntegrationSetupPermission,
  hasPermission,
  type ConnectOwner,
} from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";

/**
 * What the callback did with the capability, carried back to the page as
 * `capability=<value>`:
 * - `enabled`: it turned the capability on, or pointed it at the new account;
 * - `on`: it was already on in a way that includes the new account;
 * - absent: it did not finish it, so the page decides as before.
 */
export type ConnectCapabilityFinish = "enabled" | "on";

type CatalogState = {
  enabled: boolean;
  /** Set up by the organization (`metadata.organizationConnector`); never rewritten here. */
  organizationManaged?: boolean;
  connectionRef?: {
    connectionId?: string | undefined;
    accountSelection?: "all_eligible" | undefined;
    authoritySource?: "host" | undefined;
    subjectScope?: "workspace" | "subject" | undefined;
  } | null;
};

/**
 * What the page would do for this capability and account, decided from the
 * same catalog item the console reads (so an organization connector that
 * already reaches the workspace counts as on). Mirrors the web app's
 * `oauthResumeAction`, `catalogConnectionAccountSelection` and
 * `oauthConnectionRef`. `leave` means it is on in a way the callback should
 * not change (an organization or host setup), so the page decides as before.
 */
export function connectCapabilityPlan(
  item: CatalogState,
  connection: { id: string; providerDomain: string },
  ownership: ConnectionOwnership,
): { kind: "on" } | { kind: "leave" } | { kind: "enable"; payload: EnableCapabilityRequest } {
  const ref = item.connectionRef ?? null;
  if (item.enabled) {
    // A per-person binding finds each person's own account by itself.
    if (ref?.subjectScope === "subject") return { kind: "on" };
    if (ref?.connectionId === connection.id) return { kind: "on" };
    // Every eligible account is already included, the new one too.
    if (ref && !ref.connectionId && ref.accountSelection === "all_eligible") return { kind: "on" };
    if (!ref || ref.authoritySource === "host") return { kind: "leave" };
  }
  if (item.organizationManaged) return { kind: "leave" };
  const accountSelection =
    ref?.connectionId || (item.enabled && ref?.accountSelection !== "all_eligible")
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
  deps: {
    db: Database;
    settings: Settings;
    mcpServerLogoStorage?: Parameters<typeof enableCapability>[0]["mcpServerLogoStorage"];
  },
  input: {
    owner: ConnectOwner;
    capabilityId: string;
    ownership: ConnectionOwnership;
    connection: { id: string; providerDomain: string };
  },
): Promise<ConnectCapabilityFinish | null> {
  const { db, settings } = deps;
  const { owner, capabilityId } = input;
  const catalogItem = async (subjectId: string, accountId: string) => {
    const item =
      (
        await buildCapabilityCatalog({
          db,
          workspaceId: owner.workspaceId,
          settings,
          subjectId,
          accountId,
        })
      ).items.find((candidate) => candidate.id === capabilityId) ?? null;
    return item ? { ...item, organizationManaged: !!item.metadata.organizationConnector } : null;
  };
  try {
    const grant = await currentConnectOwnerGrant(db, owner);
    if (!grant) return null;
    const item = await catalogItem(grant.subjectId, grant.accountId);
    if (!item || item.kind !== "mcp") return null;
    const plan = connectCapabilityPlan(item, input.connection, input.ownership);
    if (plan.kind === "on") return "on";
    if (plan.kind === "leave") return null;
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
      mcpServerLogoStorage: deps.mcpServerLogoStorage ?? null,
    });
    // Report it done only when it now includes this account (a create-only
    // enable can leave an existing setup unchanged).
    const after = await catalogItem(grant.subjectId, grant.accountId);
    return after && connectCapabilityPlan(after, input.connection, input.ownership).kind === "on"
      ? "enabled"
      : null;
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

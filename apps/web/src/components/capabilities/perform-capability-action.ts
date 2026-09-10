import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, ConnectionMetadata, SkillUninstallPreview } from "@/types";
import type { ConnectAction } from "./capability-detail-sheet";
import {
  apiKeyConnectionRef,
  capabilityConnectPlan,
  connectionToReuseForApiKey,
  createInputFromCatalogItem,
} from "@/lib/capabilities";
import { startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";
import { toast } from "sonner";

/** One connection lifecycle for catalog sheets and conversation cards. The caller
 * resolves the live item and owns busy/error state; credentials never enter chat. */
export async function performCapabilityAction(
  {
    client,
    workspaceId,
    item,
    registry = false,
    connections,
    canManageSkills,
    refresh,
    onRuntimeChanged,
    onComplete,
    onSkillRemoval,
    returnPathFor,
    redirect,
  }: {
    client: OpenGeniBrowserClient;
    workspaceId: string;
    item: CapabilityCatalogItem;
    registry?: boolean;
    connections: ConnectionMetadata[] | null;
    canManageSkills: boolean;
    refresh: () => Promise<unknown>;
    onRuntimeChanged: () => void;
    onComplete: () => void | Promise<void>;
    onSkillRemoval: (value: {
      item: CapabilityCatalogItem;
      preview: SkillUninstallPreview;
    }) => void;
    returnPathFor: (id: string) => string;
    redirect: (url: string) => void;
  },
  action: ConnectAction,
): Promise<void> {
  if (action.item !== item) throw new Error("The selected capability changed. Review it again.");
  async function persistIfRegistry(candidate: CapabilityCatalogItem, fromRegistry: boolean) {
    return fromRegistry
      ? client.createCapability(workspaceId, createInputFromCatalogItem(candidate))
      : candidate;
  }
  // The plan is derived from the current catalog/registry item (it carries
  // authKind/mcpUrl/providerDomain); connect calls use the persisted id.
  const plan = capabilityConnectPlan(item);
  if ((action.type === "api_key" || action.type === "reconnect_api_key") && connections === null) {
    throw new Error(
      "Existing connections could not be checked. Refresh and retry before saving credentials.",
    );
  }

  if (action.type === "install_skill") {
    if (!canManageSkills) {
      throw new Error("Workspace administrator permission is required to install Skills.");
    }
    const libraryId = metadataString(item.metadata.libraryId);
    const expectedVersion = metadataString(item.metadata.version);
    const expectedContentSha256 = metadataString(item.metadata.contentSha256);
    if (!libraryId || !expectedVersion || !expectedContentSha256) {
      throw new Error(
        "This Skill is missing its reviewed library identity. Refresh and try again.",
      );
    }
    const installationVersion = installedSkillVersion(item);
    const installed = await client.installLibrarySkill(workspaceId, libraryId, {
      expectedVersion,
      expectedContentSha256,
      ...(installationVersion !== null ? { expectedInstallationVersion: installationVersion } : {}),
    });
    await refresh();
    onRuntimeChanged();
    if (installed.skillReceipt?.outcome === "pending") {
      throw new Error("This Skill is awaiting review and has not been activated.");
    }
    await onComplete();
    toast.success(item.enabled ? `Updated ${item.name}` : `Installed ${item.name}`, {
      description:
        installed.skillReceipt?.outcome === "preserved"
          ? "Your customized Skill was preserved."
          : `Pinned to reviewed Skill version ${expectedVersion}.`,
    });
    return;
  }

  if (action.type === "remove_skill") {
    if (!canManageSkills) {
      throw new Error("Workspace administrator permission is required to remove Skills.");
    }
    const preview = await client.previewSkillUninstall(workspaceId, item.id);
    if (!preview.installed || preview.installationVersion === null || !preview.directOwner) {
      throw new Error("This Skill is no longer directly installed. Refresh and try again.");
    }
    onSkillRemoval({ item, preview });
    return;
  }

  if (action.type === "disconnect") {
    if (item.kind !== "mcp" || !item.actions.includes("disconnect")) {
      throw new Error(`${item.name} must be managed through its dedicated controls.`);
    }
    await client.disableCapability(workspaceId, item.id);
    await refresh();
    onRuntimeChanged();
    await onComplete();
    toast.success(`Disabled ${item.name}`);
    return;
  }

  if (action.type === "social_oauth" && plan.mode === "social_oauth") {
    const returnPath = returnPathFor(item.id);
    const response = await client.startSocialOAuth(workspaceId, {
      provider: action.provider,
      ownership: action.ownership,
      returnPath,
    });
    if (!response.authorizationUrl) {
      throw new Error("The provider did not return an authorization link.");
    }
    redirect(response.authorizationUrl);
    return;
  }

  if (action.type === "disconnect_social") {
    await client.disconnectSocialConnection(workspaceId, action.connectionId);
    await refresh();
    await onComplete();
    toast.success(`Disconnected ${item.name}`);
    return;
  }

  // First-party Fiken connect / token replacement. The install route
  // verifies the token against Fiken before storing it, so a bad paste
  // fails here with a specific message instead of at first tool use.
  if (action.type === "fiken_api_token") {
    await client.installFikenConnection(workspaceId, {
      apiToken: action.apiToken,
      ...(action.connectionId ? { connectionId: action.connectionId } : {}),
    });
    await refresh();
    onRuntimeChanged();
    await onComplete();
    toast.success(`Connected ${item.name}`);
    return;
  }

  // Full-page redirect into Fiken's consent screen; the API callback
  // stores the workspace connection and returns to this page with a
  // `fiken` query param handled by the return effect below.
  if (action.type === "fiken_oauth") {
    const response = await client.startFikenOAuth(workspaceId, {
      returnPath: returnPathFor(item.id),
      ...(action.connectionId ? { connectionId: action.connectionId } : {}),
    });
    if (!response.authorizationUrl) {
      throw new Error("Fiken did not return an authorization link.");
    }
    redirect(response.authorizationUrl);
    return;
  }

  if (action.type === "fiken_disconnect") {
    await client.deleteConnection(workspaceId, action.connectionId);
    await refresh();
    onRuntimeChanged();
    await onComplete();
    toast.success(`Disconnected ${item.name}`);
    return;
  }

  // Reconnect an already-enabled item whose credential lapsed. When the
  // connection row survives, OAuth reuses it (pass connectionId) and the
  // return handler just refreshes; when it was deleted (null id), OAuth
  // mints a fresh row and the return handler re-enables against it. API-key
  // reactivates the surviving row in place, or mints + re-enables if gone.
  if (action.type === "reconnect_oauth") {
    // Trust the installation's connectionRef.kind (the sheet already chose this
    // branch from it), not the catalog plan - on drift plan.mode can read
    // "enable", so fall back to the ref's domain and the item's own MCP URL.
    const providerDomain =
      plan.mode === "oauth" ? plan.providerDomain : (item.connectionRef?.providerDomain ?? null);
    const mcpUrl = plan.mode === "oauth" ? plan.mcpUrl : (item.mcpUrl ?? item.endpointUrl ?? null);
    const returnPath = returnPathFor(item.id);
    const response = await startMcpOAuthWithTimeout(client, workspaceId, {
      ...(mcpUrl ? { mcpUrl } : {}),
      ...(providerDomain ? { providerDomain } : {}),
      // Reuse the existing row when it survives; a null id means the row was
      // deleted, so OAuth mints a fresh connection and the return handler
      // re-enables against it.
      ...(action.connectionId ? { connectionId: action.connectionId } : {}),
      ownership: action.ownership,
      returnPath,
    });
    if (!response.authorizationUrl) {
      throw new Error("The provider did not return an authorization link.");
    }
    redirect(response.authorizationUrl);
    return;
  }

  if (action.type === "reconnect_api_key") {
    if (action.connectionId) {
      // The existing row went inactive - rewrite its credential and
      // reactivate it in place; the installation ref already points at it.
      await client.updateConnection(workspaceId, action.connectionId, {
        credential: { headers: action.headers },
        status: "active",
      });
    } else {
      // The row was deleted - mint a fresh connection and re-enable the
      // installation against it (enable upserts the installation config). Domain
      // comes from the plan, or the installation's ref when the catalog drifted.
      const providerDomain =
        plan.mode === "api_key" ? plan.providerDomain : (item.connectionRef?.providerDomain ?? "");
      const connection = await client.createConnection(workspaceId, {
        providerDomain,
        kind: "api_key",
        ownership: action.ownership,
        credential: { headers: action.headers },
      });
      await client.enableCapability(workspaceId, item.id, {
        connectionRef: apiKeyConnectionRef(
          action.ownership,
          connection.id,
          connection.providerDomain,
        ),
      });
    }
    await refresh();
    onRuntimeChanged();
    await onComplete();
    toast.success(`Reconnected ${item.name}`);
    return;
  }

  if (item.kind !== "mcp") {
    throw new Error(`${item.name} must be installed through its dedicated controls.`);
  }
  const persisted = await persistIfRegistry(item, registry);

  if (action.type === "oauth" && plan.mode === "oauth") {
    const returnPath = returnPathFor(persisted.id);
    const response = await startMcpOAuthWithTimeout(client, workspaceId, {
      ...(plan.mcpUrl ? { mcpUrl: plan.mcpUrl } : {}),
      ...(plan.providerDomain ? { providerDomain: plan.providerDomain } : {}),
      ownership: action.ownership,
      returnPath,
    });
    if (!response.authorizationUrl) {
      throw new Error("The provider did not return an authorization link.");
    }
    // Full-page redirect into the provider's consent screen; we return to
    // returnPath and resume in the OAuth-return effect below.
    redirect(response.authorizationUrl);
    return;
  }

  if (action.type === "api_key" && plan.mode === "api_key") {
    // Reuse only a connection with the selected ownership rather than creating
    // a duplicate on retry; workspace and personal rows never cross-reuse.
    const reuseId = connectionToReuseForApiKey(
      item,
      connections ?? [],
      plan.providerDomain,
      action.ownership,
    );
    const connection = reuseId
      ? await client.updateConnection(workspaceId, reuseId, {
          credential: { headers: action.headers },
          status: "active",
        })
      : await client.createConnection(workspaceId, {
          providerDomain: plan.providerDomain,
          kind: "api_key",
          ownership: action.ownership,
          credential: { headers: action.headers },
        });
    // Build the enable ref from the connection row the API returns, never the
    // catalog domain - the API may canonicalize providerDomain, and the row
    // is the authoritative match the enable path validates against.
    await client.enableCapability(workspaceId, persisted.id, {
      connectionRef: apiKeyConnectionRef(
        action.ownership,
        connection.id,
        connection.providerDomain,
      ),
    });
    await refresh();
    onRuntimeChanged();
    await onComplete();
    toast.success(`Connected and enabled ${persisted.name}`);
    return;
  }

  // A stale form must not fall through from a credentialed action to enable.
  if (action.type !== "enable" || plan.mode !== "enable") {
    throw new Error(
      "The connection requirements changed. Close this form and review the current setup.",
    );
  }
  // Plain enable (no credentials).
  await client.enableCapability(workspaceId, persisted.id);
  await refresh();
  if (persisted.kind === "mcp") onRuntimeChanged();
  await onComplete();
  toast.success(`Enabled ${persisted.name}`);
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function installedSkillVersion(item: CapabilityCatalogItem): number | null {
  const installedSkill = item.metadata.installedSkill;
  if (!installedSkill || typeof installedSkill !== "object" || Array.isArray(installedSkill)) {
    return null;
  }
  const value = (installedSkill as Record<string, unknown>).installationVersion;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

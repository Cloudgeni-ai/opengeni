/**
 * Personal integration setup: a person connecting their own account to an
 * integration and using it in their own chats, without administering the
 * workspace. One shared definition for the API, the SDK and every client.
 */
import { integrationDefinitionIdFromCapabilityId } from "./integration-capability-id";

/** The narrow permission. `connections:write` includes it. */
export const PERSONAL_INTEGRATION_SETUP_PERMISSION = "connections:personal" as const;

/**
 * Literal permission-set coverage for ceilings (organization key policies,
 * delegation limits): the exact permission, or the personal setup permission
 * through `connections:write`. Grants and policies saved before the narrow
 * permission existed keep their meaning.
 */
export function permissionSetCovers(permissions: readonly string[], permission: string): boolean {
  return (
    permissions.includes(permission) ||
    (permission === PERSONAL_INTEGRATION_SETUP_PERMISSION &&
      permissions.includes("connections:write"))
  );
}

/** Catalog sources reviewed by Opengeni or the deployment operator, never a workspace's own entries. */
const REVIEWED_SOURCES = new Set(["built_in", "configured", "registry"]);

/**
 * Whether a catalog integration may be turned on for personal accounts by
 * someone holding only the personal setup permission: a reviewed catalog MCP
 * integration that signs each person in with OAuth. Custom MCP servers,
 * API-key integrations and unreviewed registry entries never qualify.
 */
export function isPersonalIntegrationSetupCandidate(item: {
  kind: string;
  source: string;
  authKind?: string | null | undefined;
  stale?: boolean | undefined;
  workspaceId?: string | null | undefined;
  runtime?:
    | { available?: boolean | undefined; catalogTrust?: { state: string } | undefined }
    | undefined;
}): boolean {
  return (
    item.kind === "mcp" &&
    item.authKind === "oauth2" &&
    REVIEWED_SOURCES.has(item.source) &&
    !item.stale &&
    !item.workspaceId &&
    item.runtime?.available === true &&
    (item.source !== "registry" || item.runtime.catalogTrust?.state === "trusted")
  );
}

/**
 * How this person may set up an integration from a card in their chat, read
 * from their workspace grant and the integration's catalog entry:
 *
 * - `"any"`: they may connect a shared or a personal account (and enable it).
 * - `"personal"`: only their own account; the card offers no ownership choice
 *   and enables the integration for personal accounts if it is not on yet.
 * - `null`: they cannot finish setup here.
 *
 * The API enforces the same rules at call time (and an organization can
 * reserve turning integrations on for admins), so this only decides what to
 * offer. Clients, embeds and integration cards should all use this one rule.
 */
export function personalIntegrationSetupAccess(
  grant: { permissions: readonly string[]; permissionMode?: "legacy" | "explicit" | undefined },
  item: Parameters<typeof isPersonalIntegrationSetupCandidate>[0] & {
    enabled?: boolean | undefined;
    connectionRef?: { subjectScope?: string | undefined } | null | undefined;
  },
): "any" | "personal" | null {
  const can = (permission: string) =>
    permissionSetCovers(grant.permissions, permission) ||
    (grant.permissionMode !== "explicit" &&
      permission !== "secrets:read" &&
      grant.permissions.includes("workspace:admin"));
  if (!can(PERSONAL_INTEGRATION_SETUP_PERMISSION)) return null;
  if (
    can("connections:write") &&
    can("connections:read") &&
    (item.enabled || can("capabilities:manage"))
  )
    return "any";
  // Already on: connecting one's own account changes no installation, but
  // only an installation that signs each person in can take it.
  if (item.enabled) return item.connectionRef?.subjectScope === "subject" ? "personal" : null;
  return can("capabilities:manage") || isPersonalIntegrationSetupCandidate(item)
    ? "personal"
    : null;
}

/**
 * What an agent's setup card for one capability can offer this person in
 * their chat, read from their workspace grant and the capability's catalog
 * entry (`undefined` when the catalog has none):
 *
 * - `"card"`: an OAuth MCP integration they can connect from the card;
 *   `personalOnly` when only their own account is allowed.
 * - `"integration"`: a deployment's reviewed integration definition they
 *   connect with their own account.
 * - `"unavailable"`: they cannot finish this setup from the chat.
 * - `"default"`: not decided here (other kinds of setup keep their own row).
 *
 * The chat card and the agent's setup tool both use this rule, so what the
 * agent says matches what the card offers.
 */
export type InChatCapabilitySetup =
  | { kind: "card"; personalOnly: boolean }
  | { kind: "integration" }
  | { kind: "unavailable" }
  | { kind: "default" };

export function inChatCapabilitySetup(
  grant: { permissions: readonly string[]; permissionMode?: "legacy" | "explicit" | undefined },
  capabilityId: string,
  item:
    | (Parameters<typeof personalIntegrationSetupAccess>[1] & {
        authKind?: string | null | undefined;
      })
    | undefined,
): InChatCapabilitySetup {
  const can = (permission: string) =>
    grant.permissions.includes(permission) ||
    (grant.permissionMode !== "explicit" && grant.permissions.includes("workspace:admin"));
  if (integrationDefinitionIdFromCapabilityId(capabilityId)) {
    // Connecting your own account is the whole step: the integration's tools
    // are installed for that account only, never for the workspace, so the
    // personal setup permission (included in connections:write) is enough.
    return can("sessions:control") &&
      (can(PERSONAL_INTEGRATION_SETUP_PERMISSION) || can("connections:write"))
      ? { kind: "integration" }
      : { kind: "unavailable" };
  }
  if (!item || item.kind !== "mcp" || item.authKind !== "oauth2") return { kind: "default" };
  if (!can("sessions:control")) return { kind: "unavailable" };
  const usesSharedAccount =
    item.enabled === true &&
    item.connectionRef !== null &&
    item.connectionRef !== undefined &&
    item.connectionRef.subjectScope !== "subject";
  if (usesSharedAccount)
    return can("connections:read")
      ? { kind: "card", personalOnly: false }
      : { kind: "unavailable" };
  const access = personalIntegrationSetupAccess(grant, item);
  return access ? { kind: "card", personalOnly: access === "personal" } : { kind: "unavailable" };
}

import { registrableHostDomain } from "@opengeni/capabilities";
import type { CapabilityCatalogItem, OrganizationIntegrationPolicy } from "@opengeni/contracts";
import { deploymentCannotConnect } from "@opengeni/contracts/personal-integration-setup";
import {
  dedicatedMcpIntegrationKey,
  organizationIntegrationCatalog,
} from "./organization-integration-catalog";

/**
 * Built-in integrations and the public-registry entries that duplicate them.
 *
 * A built-in integration is one the deployment serves with its own reviewed
 * connector and organization policy key: a reviewed MCP endpoint with a
 * dedicated Connect adapter (Gmail, Google Calendar, Google Drive, Slack;
 * whichever backend, native or Nango, signs it in), a social provider adapter
 * (X, Reddit) or a config-only Nango integration (LinkedIn, X). A registry
 * entry duplicates one when the deployment also lists that integration as its
 * own (a deployment-configured Gmail server beside the registry's Gmail row),
 * or when it reaches the same service by another endpoint (X's own MCP server
 * beside the X connector). One service is offered once: the built-in when the
 * deployment can connect it, else the registry entry.
 */

const REGISTRY_SOURCES = new Set(["registry", "public_registry"]);

function endpointOf(item: CapabilityCatalogItem): string | null {
  return item.mcpUrl ?? item.endpointUrl ?? null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function registrableDomainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value;
  try {
    host = new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
  return registrableHostDomain(host);
}

/**
 * The organization policy key of the built-in integration this catalog item
 * is, or null when it is not a built-in integration. This is the key its
 * Connect adapter checks, so a policy that leaves it out refuses the
 * connection whichever card starts it.
 */
export function builtInIntegrationKey(item: CapabilityCatalogItem): string | null {
  const nango = text(item.metadata.nangoIntegrationKey);
  if (item.metadata.integrationBackend === "nango" && nango) return nango;
  if (item.metadata.providerAdapter === "social") return text(item.metadata.provider);
  if (item.kind !== "mcp") return null;
  return dedicatedMcpIntegrationKey(endpointOf(item));
}

/** The provider domains of the service a built-in integration item connects. */
function builtInServiceDomains(item: CapabilityCatalogItem): string[] {
  return [
    item.metadata.providerAdapter === "social" ? item.providerDomain : null,
    text(item.metadata.serviceDomain),
  ].flatMap((domain) => {
    const registrable = registrableDomainOf(domain);
    return registrable ? [registrable] : [];
  });
}

/** A built-in this deployment can connect, or one already connected here. */
function builtInOffered(item: CapabilityCatalogItem): boolean {
  return item.enabled || (item.runtime.available && !deploymentCannotConnect(item));
}

/**
 * The built-in integration a public-registry entry duplicates, when the
 * deployment offers that built-in among `items`; null otherwise. A registry
 * entry for a reviewed endpoint is the built-in itself unless the deployment
 * lists its own entry for it, and an entry whose service has no built-in here
 * duplicates nothing.
 */
export function builtInIntegrationDuplicated(
  item: CapabilityCatalogItem,
  items: readonly CapabilityCatalogItem[],
): CapabilityCatalogItem | null {
  // An entry turned on here is this workspace's working setup; it stays.
  if (!REGISTRY_SOURCES.has(item.source) || item.enabled) return null;
  const offered = items.filter(
    (candidate) =>
      candidate.id !== item.id &&
      !REGISTRY_SOURCES.has(candidate.source) &&
      builtInIntegrationKey(candidate) !== null &&
      builtInOffered(candidate),
  );
  const key = builtInIntegrationKey(item);
  if (key !== null)
    return offered.find((candidate) => builtInIntegrationKey(candidate) === key) ?? null;
  const domain = registrableDomainOf(item.providerDomain) ?? registrableDomainOf(endpointOf(item));
  if (!domain) return null;
  return offered.find((candidate) => builtInServiceDomains(candidate).includes(domain)) ?? null;
}

/** The catalog with every registry entry that duplicates an offered built-in left out. */
export function withoutBuiltInIntegrationDuplicates<T extends CapabilityCatalogItem>(
  items: readonly T[],
): T[] {
  return items.filter((item) => builtInIntegrationDuplicated(item, items) === null);
}

/**
 * Why the organization's integration policy refuses this built-in
 * integration, for the agent to tell the person; null when it is allowed or
 * is not a built-in integration. A plugin that adds nothing but built-in
 * integrations' reviewed MCP endpoints is those integrations by another
 * route: refused when the policy leaves all of them out.
 */
export function builtInIntegrationTurnedOffDetail(
  item: CapabilityCatalogItem,
  policy: Pick<OrganizationIntegrationPolicy, "mode" | "allowedIntegrationKeys">,
): string | null {
  if (policy.mode === "unrestricted") return null;
  const pluginKeys = pluginBuiltInIntegrationKeys(item);
  if (pluginKeys)
    return pluginKeys.every((key) => !policy.allowedIntegrationKeys.includes(key))
      ? builtInIntegrationTurnedOffMessage(item.name)
      : null;
  const key = builtInIntegrationKey(item);
  if (!key || policy.allowedIntegrationKeys.includes(key)) return null;
  return builtInIntegrationTurnedOffMessage(item.name);
}

/**
 * The built-in integration keys of a not-installed plugin whose only parts
 * are MCP servers at built-in integrations' reviewed endpoints (the Gmail
 * plugin is Gmail's endpoint). Null for any other item, including plugins
 * with Skills or another server, which add something of their own.
 */
export function pluginBuiltInIntegrationKeys(item: CapabilityCatalogItem): string[] | null {
  if (item.kind !== "plugin" || item.enabled) return null;
  const skills = item.metadata.skills;
  if (Array.isArray(skills) && skills.length > 0) return null;
  const endpoints = Array.isArray(item.metadata.mcpEndpoints) ? item.metadata.mcpEndpoints : [];
  if (!endpoints.length) return null;
  const keys = endpoints.map((endpoint) =>
    typeof endpoint === "string" ? dedicatedMcpIntegrationKey(endpoint) : null,
  );
  return keys.every((key): key is string => key !== null) ? [...new Set(keys)] : null;
}

/** Whether the organization's integration policy decides this item's setup. */
export function builtInIntegrationPolicyApplies(item: CapabilityCatalogItem): boolean {
  return builtInIntegrationKey(item) !== null || pluginBuiltInIntegrationKeys(item) !== null;
}

/** What the person is told when their organization turned a built-in integration off. */
export function builtInIntegrationTurnedOffMessage(name: string): string {
  return `${name} is turned off for this organization, so it can't be connected here. An organization admin can turn it on in the organization's integration settings.`;
}

/**
 * The built-in integration a sign-in to this MCP endpoint duplicates, when it
 * is not the integration being connected: a custom connection to Gmail's,
 * Google Calendar's, Google Drive's or Slack's reviewed endpoint is that
 * built-in by another route, so the organization's choice for the built-in
 * applies to it too. Null for every other endpoint.
 */
export function builtInIntegrationDuplicatedByEndpoint(
  mcpUrl: string | null | undefined,
  integrationKey: string | null | undefined,
): { key: string; label: string } | null {
  const key = dedicatedMcpIntegrationKey(mcpUrl);
  if (!key || key === integrationKey) return null;
  const label =
    organizationIntegrationCatalog().integrations.find((integration) => integration.key === key)
      ?.label ?? key;
  return { key, label };
}

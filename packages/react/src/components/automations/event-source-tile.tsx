import { WebhookIcon, WorkflowIcon } from "lucide-react";

import type { CapabilityCatalogItem, EventSource } from "@opengeni/sdk";

import { connectorLogo, connectorLogoIndex } from "../../timeline/connector-logo-index";
import { useOpenGeniText } from "../../messages/runtime";
import { LogoTile, type LogoTileSize } from "../../ui/logo-tile";
import {
  eventSourceChoiceOf,
  eventSourceChoiceName,
  eventSourceProviderDomain,
  type EventSourceChoice,
} from "./event-source-model";

/** Resolves the brand logo for a source (a provider domain), when the host has one. */
export type EventSourceLogoResolver = (source: EventSourceLogoSubject) => string | null | undefined;

export type EventSourceLogoSubject = Pick<EventSource, "kind" | "adapter" | "name" | "mcp">;

/**
 * Logos from a capability catalog: the app's own logo for GitHub, Slack,
 * Gmail, Linear and Sentry, and the MCP server's logo for an MCP source.
 * Build it once per catalog.
 */
export function eventSourceLogoResolver(
  catalog: readonly Pick<
    CapabilityCatalogItem,
    "id" | "runtime" | "providerDomain" | "mcpUrl" | "connectionRef" | "logoAssetPath"
  >[],
  assetUrl: (logoAssetPath: string) => string | null | undefined,
): EventSourceLogoResolver {
  const index = connectorLogoIndex(catalog, (path) => (path ? assetUrl(path) : null));
  return (source) => {
    if (source.kind === "mcp" && source.mcp) {
      const serverId = source.mcp.serverId;
      const item = catalog.find(
        (entry) => entry.runtime.mcpServerId === serverId || entry.id === serverId,
      );
      if (!item) return null;
      return item.logoAssetPath
        ? (assetUrl(item.logoAssetPath) ?? null)
        : connectorLogo(index, item.providerDomain);
    }
    return connectorLogo(index, eventSourceProviderDomain(source));
  };
}

const GLYPH: Partial<Record<EventSourceChoice, typeof WebhookIcon>> = {
  webhook: WebhookIcon,
  mcp: WorkflowIcon,
};

/**
 * The tile for a source: its app's logo when the host resolves one, a webhook
 * or MCP glyph for those kinds, otherwise the app's monogram ("G" for a
 * GitHub source, whatever the source is named).
 */
export function EventSourceTile({
  source,
  logo,
  size,
  className,
}: {
  source: EventSourceLogoSubject;
  logo?: EventSourceLogoResolver | undefined;
  size?: LogoTileSize | undefined;
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const src = logo?.(source) ?? null;
  const choice = eventSourceChoiceOf(source);
  const Glyph = GLYPH[choice];
  return (
    <LogoTile
      size={size}
      src={src}
      fit="contain"
      name={Glyph ? source.name : eventSourceChoiceName(t, choice)}
      icon={Glyph ? <Glyph /> : undefined}
      className={className}
    />
  );
}

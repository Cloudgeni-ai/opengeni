import { Building2Icon, WebhookIcon, WorkflowIcon } from "lucide-react";

import type { CapabilityCatalogItem, EventSource } from "@opengeni/sdk";

import gmailLogo from "../../assets/gmail.ico";
import { connectorLogo, connectorLogoIndex } from "../../timeline/connector-logo-index";
import { useOpenGeniText } from "../../messages/runtime";
import { LogoTile, logoTileHue, type LogoTileSize } from "../../ui/logo-tile";
import {
  eventSourceChoiceOf,
  eventSourceChoiceName,
  eventSourceProviderDomain,
  type EventSourceChoice,
  type EventSourceChoiceSubject,
} from "./event-source-model";

/** Resolves the brand logo for a source (a provider domain), when the host has one. */
export type EventSourceLogoResolver = (source: EventSourceLogoSubject) => string | null | undefined;

export type EventSourceLogoSubject = Pick<EventSource, "kind" | "adapter" | "name" | "mcp"> &
  Pick<EventSourceChoiceSubject, "format">;

/**
 * Logos from a capability catalog: the app's own logo for GitHub, Slack,
 * Gmail, Linear, Sentry and apps with a webhook preset such as Tailscale, and
 * the MCP server's logo for an MCP source.
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
  workspace: Building2Icon,
};

// GitHub's vendor mark, inlined so it needs no asset and follows the theme.
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Bundled marks for sources whose app the host's catalog may not carry a logo for. */
const BUNDLED_LOGO: Partial<Record<EventSourceChoice, string>> = { gmail: gmailLogo };

/**
 * The tile for a source: its app's logo when the host resolves one, else a
 * bundled mark (GitHub, Gmail), a webhook, MCP or workspace glyph for those
 * kinds, otherwise the app's monogram on a hued tile ("L" for a Linear
 * source, whatever the source is named).
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
  const choice = eventSourceChoiceOf(source);
  const src = logo?.(source) ?? BUNDLED_LOGO[choice] ?? null;
  const Glyph = GLYPH[choice];
  const github = choice === "github" || choice === "github_personal";
  return (
    <LogoTile
      size={size}
      src={src}
      name={Glyph ? source.name : eventSourceChoiceName(t, choice)}
      icon={Glyph ? <Glyph /> : github ? <GitHubMark /> : undefined}
      tone={github ? "brand" : undefined}
      hue={Glyph || github ? undefined : logoTileHue(choice)}
      className={className}
    />
  );
}

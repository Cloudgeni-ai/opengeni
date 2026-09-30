import { ArrowUpRightIcon, BoxesIcon, Loader2Icon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import {
  pluginMcpUnavailableReason,
  type PluginDiscoveryItem,
  type PluginInstallationSummary,
} from "@opengeni/contracts";
import { Markdown } from "@opengeni/react";

import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import { humanizeName } from "@/components/capabilities/skill-copy";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";

/* ----------------------------------------------------------------------------
   A plugin's page: a bundle of skills and the connections they need. What it
   adds leads, then the connections to set up separately; the registry, the
   repository and digests sit in Technical details.
   -------------------------------------------------------------------------- */

const buttonClass = "rounded-[10px] pointer-coarse:h-11";

const OTHER_COMPONENTS: Record<string, string> = {
  apps: "hosted apps",
  hooks: "hooks",
  agents: "agents",
  commands: "commands",
  lsp: "language servers",
};

function registryLabel(provider: string): string {
  return provider === "openai"
    ? "OpenAI plugin registry"
    : provider === "anthropic"
      ? "Anthropic plugin registry"
      : "Custom source";
}

function categoryLabel(category: string | null | undefined): string | null {
  if (!category) return null;
  const words = category.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : null;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export type PluginManageActions = {
  onUpdate: () => void;
  onRemove: () => void;
  busy: boolean;
  /** Why an update can't be reviewed (no retained source URL). */
  updateUnavailableReason?: string;
};

export function PluginPage({
  item,
  installation,
  installed,
  busy,
  error,
  canManage,
  connections,
  onInstall,
  onConnect,
  manage,
  onBack,
  backLabel,
}: {
  item: PluginDiscoveryItem;
  installation: PluginInstallationSummary | null;
  installed: boolean;
  busy: boolean;
  error: string | null;
  canManage: boolean;
  /** Connected state by MCP endpoint. */
  connections: Record<string, boolean>;
  onInstall?: (() => void) | undefined;
  onConnect?: ((server: { name: string; endpoint: string | null }) => void) | undefined;
  manage?: PluginManageActions | undefined;
  onBack: () => void;
  backLabel?: string;
}) {
  const title = humanizeName(item.displayName);
  const skills = item.skills ?? null;
  const servers = item.mcpServers ?? null;
  const supported = (server: NonNullable<PluginDiscoveryItem["mcpServers"]>[number]) =>
    pluginMcpUnavailableReason(server) === null;
  const contentsUnknown = skills === null || servers === null;
  const installableCount = (skills?.length ?? 0) + (servers?.filter(supported).length ?? 0);
  const exceedsLimit = installableCount > 64;
  const installable = !contentsUnknown && installableCount > 0 && !exceedsLimit;
  const others = (item.components ?? [])
    .filter((component) => !["skills", "mcp"].includes(component))
    .map((component) => OTHER_COMPONENTS[component] ?? component);
  const needsAttention = installation?.status === "needs_attention";
  const skillCount = skills?.length ?? 0;
  const whatItAdds = exceedsLimit
    ? "This plugin has more than 64 parts, more than Opengeni can install at once."
    : contentsUnknown
      ? "We couldn't read what this plugin contains, so it can't be installed yet."
      : !installableCount
        ? "Nothing in this plugin can run in Opengeni yet."
        : skillCount
          ? `Adds ${skillCount} ${skillCount === 1 ? "skill" : "skills"}.${servers?.length ? " You'll connect any apps it needs separately." : ""}`
          : "You'll connect the apps it needs separately.";
  const description = item.longDescription || item.description;
  const [expanded, setExpanded] = useState(false);
  const lengthy = description.length > 700;
  const version = installation?.version ?? item.version;

  const primary =
    !installed && onInstall ? (
      <Button
        type="button"
        size="sm"
        className={buttonClass}
        disabled={!installable || busy}
        title={!installable ? whatItAdds : undefined}
        onClick={onInstall}
      >
        {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
        {busy ? "Installing…" : "Install plugin"}
      </Button>
    ) : null;
  const managed = installed && installation && manage && canManage;

  return (
    <CapabilityPage
      onBack={onBack}
      backLabel={backLabel}
      mark={<CapabilityMark name={title} src={item.logoUrl} icon={<BoxesIcon />} />}
      title={title}
      status={installed ? (needsAttention ? "Needs attention" : "Installed") : undefined}
      meta={[
        item.author?.name ? `By ${item.author.name}` : null,
        categoryLabel(item.category ?? installation?.category),
        version ? `v${version}` : null,
      ]}
      actions={
        primary || managed ? (
          <>
            {primary}
            {managed ? (
              <>
                <RowButton
                  disabled={manage.busy || Boolean(manage.updateUnavailableReason)}
                  title={manage.updateUnavailableReason}
                  onClick={manage.onUpdate}
                >
                  {manage.busy ? (
                    <Loader2Icon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCwIcon aria-hidden="true" />
                  )}
                  Check for update
                </RowButton>
                <MoreMenu label={`More actions for ${title}`}>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={manage.busy}
                    onSelect={manage.onRemove}
                  >
                    <TrashIcon />
                    Remove plugin
                  </DropdownMenuItem>
                </MoreMenu>
              </>
            ) : null}
          </>
        ) : undefined
      }
      aside={
        <CapabilityAside
          name={title}
          items={[
            item.author?.name ? { label: "Made by", value: item.author.name } : null,
            categoryLabel(item.category)
              ? { label: "Category", value: categoryLabel(item.category) }
              : null,
            version ? { label: "Version", value: `v${version}` } : null,
            {
              label: "In this workspace",
              value: installed ? "Installed" : "Not installed",
            },
          ]}
        />
      }
    >
      {error ? (
        <DetailSection>
          <Notice tone="failed" title="That didn't work">
            <span role="alert">{error}</span>
          </Notice>
        </DetailSection>
      ) : null}
      {needsAttention ? (
        <DetailSection>
          <Notice tone="waiting" title="This plugin needs attention">
            Check for an update to repair it, or remove it if you no longer need it.
          </Notice>
        </DetailSection>
      ) : null}

      <DetailSection title="About">
        <div
          className={
            lengthy && !expanded
              ? "max-h-48 overflow-hidden text-sm leading-6 text-fg [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
              : "text-sm leading-6 text-fg"
          }
        >
          <Markdown streaming={false}>{description}</Markdown>
        </div>
        {lengthy ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="mt-2 rounded-sm text-xs font-medium text-brand hover:underline"
          >
            {expanded ? "Show less" : "Read more"}
          </button>
        ) : null}
        <p className="mt-4 mb-0 text-xs leading-4.5 text-fg-muted">{whatItAdds}</p>
        {others.length ? (
          <p className="mt-2 mb-0 text-xs leading-4.5 text-fg-muted">
            {`Includes ${joinList(others)}, which Opengeni doesn't run yet.`}
          </p>
        ) : null}
        {!canManage ? (
          <p className="mt-2 mb-0 text-xs leading-4.5 text-fg-muted">
            Only workspace admins can install, update and remove plugins.
          </p>
        ) : null}
      </DetailSection>

      {skillCount > 0 ? (
        <DetailSection
          title={`Adds ${skillCount} ${skillCount === 1 ? "skill" : "skills"}`}
          description="Instructions agents load when they need them."
        >
          <ul className="m-0 grid list-none gap-x-6 gap-y-2 p-0 @[560px]/detail:grid-cols-2">
            {skills!.map((skill) => (
              <li key={skill.sourceUrl} className="min-w-0">
                <a
                  href={skill.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm leading-5 text-fg hover:text-brand"
                >
                  <span className="truncate">{humanizeName(skill.name)}</span>
                  <ArrowUpRightIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-fg-subtle group-hover:text-brand"
                  />
                </a>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {servers && servers.length > 0 ? (
        <DetailSection
          title="Connections it needs"
          description="Each one is connected separately, from its own page."
        >
          <ul className="m-0 list-none divide-y divide-border p-0">
            {servers.map((server) => {
              const connected = Boolean(server.endpoint && connections[server.endpoint]);
              const unavailable = connected ? null : pluginMcpUnavailableReason(server);
              return (
                <li
                  key={server.name}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="m-0 truncate text-sm leading-5 font-medium text-fg">
                      {humanizeName(server.name)}
                    </p>
                    <p className="m-0 text-xs leading-4.5 text-fg-muted">
                      {unavailable
                        ? `Can't connect here: ${unavailable.toLowerCase()}`
                        : connected
                          ? "Connected"
                          : "Not connected"}
                    </p>
                  </div>
                  {connected ? <StatusBadge status="connected" variant="dot" /> : null}
                  {!unavailable && onConnect ? (
                    <RowButton disabled={busy} onClick={() => onConnect(server)}>
                      {connected ? "Manage" : "Connect"}
                    </RowButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </DetailSection>
      ) : null}

      <TechnicalDetails
        facts={[
          { label: "Registry", value: registryLabel(item.provider) },
          {
            label: "Repository",
            value: item.sourceUrl ? (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand hover:underline"
              >
                {item.sourceUrl.replace(/^https?:\/\//, "")}
              </a>
            ) : null,
          },
          { label: "Plugin ID", value: item.id, mono: true },
          { label: "Installed as", value: installation?.pluginKey ?? null, mono: true },
          {
            label: "Parts",
            value: installation ? String(installation.componentCount) : null,
          },
          { label: "Manifest digest", value: installation?.manifestDigest ?? null, mono: true },
          {
            label: "Installation version",
            value: installation ? String(installation.installationVersion) : null,
          },
        ]}
      />
    </CapabilityPage>
  );
}

import { useState } from "react";
import { pluginMcpUnavailableReason, type PluginDiscoveryItem } from "@opengeni/sdk";
import { BoxesIcon } from "lucide-react";
import { Markdown } from "./components/markdown";
import { ConnectionLogo } from "./connection-logo";
import { useOpenGeniText, type OpenGeniText } from "./messages/runtime";

const componentLabels = (t: OpenGeniText): Record<string, string> => ({
  skills: t("pluginDetails.skills"),
  mcp: t("pluginDetails.mcpConnections"),
  apps: t("pluginDetails.hostedApps"),
  hooks: t("pluginDetails.hooks"),
  agents: t("pluginDetails.agents"),
  commands: t("pluginDetails.commands"),
  lsp: t("pluginDetails.languageServers"),
});

const EMPTY_CONNECTIONS: Record<string, boolean> = {};

/** Embeddable plugin overview. Hosts own the dialog and installation actions. */
export function PluginDetails({
  item,
  onInstall,
  busy = false,
  installed = false,
  error,
  connections = EMPTY_CONNECTIONS,
  onConnect,
}: {
  item: PluginDiscoveryItem;
  onInstall?: () => void;
  busy?: boolean;
  installed?: boolean;
  error?: string | null;
  connections?: Record<string, boolean>;
  onConnect?: (server: { name: string; endpoint: string | null }) => void;
}) {
  const t = useOpenGeniText();
  const supported = (server: NonNullable<PluginDiscoveryItem["mcpServers"]>[number]) =>
    pluginMcpUnavailableReason(server) === null;
  const contentsUnknown = item.skills == null || item.mcpServers == null;
  const installableCount =
    (item.skills?.length ?? 0) + (item.mcpServers?.filter(supported).length ?? 0);
  const exceedsInstallLimit = installableCount > 64;
  const installable = !contentsUnknown && installableCount > 0 && !exceedsInstallLimit;
  const [expanded, setExpanded] = useState(false);
  const description = item.longDescription || item.description;
  const lengthy = description.length > 700;
  const registryLabel =
    item.provider === "openai"
      ? t("pluginDetails.openaiPluginRegistry")
      : item.provider === "anthropic"
        ? t("pluginDetails.anthropicPluginRegistry")
        : t("pluginDetails.customSource");
  return (
    <article className="og-plugin-details">
      <header className="og-plugin-details-header">
        <ConnectionLogo
          src={item.logoUrl}
          name={item.displayName}
          fallback={<BoxesIcon aria-hidden="true" />}
        />
        <div>
          <h2>{item.displayName.replace(/-/g, " ")}</h2>
          {item.author?.name ? (
            <p>{t("pluginDetails.byName", { name: item.author.name })}</p>
          ) : null}
        </div>
      </header>
      <div className="og-plugin-details-meta">
        <span>{registryLabel}</span>
        {item.category ? <span>{item.category}</span> : null}
        {item.version ? <span>v{item.version}</span> : null}
      </div>
      <section className="og-plugin-details-members">
        <h3>
          {t("pluginDetails.skills")} <span>{item.skills?.length ?? "—"}</span>
        </h3>
        {item.skills?.length ? (
          <ul>
            {item.skills.map((skill) => (
              <li key={skill.sourceUrl}>
                <a href={skill.sourceUrl} target="_blank" rel="noopener noreferrer">
                  <strong>{skill.name}</strong>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            {item.skills
              ? t("pluginDetails.noBundledSkills")
              : t("pluginDetails.contentsHavenTBeenIndexed")}
          </p>
        )}
        <h3>
          {t("pluginDetails.mcpServers")} <span>{item.mcpServers?.length ?? "—"}</span>
        </h3>
        {item.mcpServers?.length ? (
          <ul>
            {item.mcpServers.map((server) => {
              const connected = Boolean(server.endpoint && connections[server.endpoint]);
              // Existing connections remain manageable regardless of the source manifest's setup requirements.
              const unavailableReason = connected ? null : pluginMcpUnavailableReason(server);
              return (
                <li
                  key={server.name}
                  className={unavailableReason ? "og-plugin-member-disabled" : undefined}
                >
                  <div className="og-plugin-server-heading">
                    <strong>{server.name}</strong>
                    {!unavailableReason && onConnect ? (
                      <button type="button" disabled={busy} onClick={() => onConnect(server)}>
                        {connected ? t("pluginDetails.manage") : t("pluginDetails.connect")}
                      </button>
                    ) : null}
                  </div>
                  <small>
                    {connected ? `${t("pluginDetails.connectedPrefix")} ` : ""}
                    {unavailableReason ?? server.endpoint}
                  </small>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            {item.mcpServers
              ? t("pluginDetails.noBundledMcpServers")
              : t("pluginDetails.serverDetailsHavenTBeen")}
          </p>
        )}
        {item.components?.some((component) => !["skills", "mcp"].includes(component)) ? (
          <div className="og-plugin-details-other">
            {t("pluginDetails.notInstalledHere")}{" "}
            {item.components
              .filter((component) => !["skills", "mcp"].includes(component))
              .map((component) => componentLabels(t)[component] ?? component)
              .join(", ")}
          </div>
        ) : null}
      </section>
      <section className="og-plugin-details-overview" aria-label={t("pluginDetails.overview")}>
        <div className={lengthy && !expanded ? "og-plugin-details-excerpt" : undefined}>
          <Markdown>{description}</Markdown>
        </div>
        {lengthy ? (
          <button
            type="button"
            className="og-plugin-details-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t("pluginDetails.showLess") : t("pluginDetails.readMore")}
          </button>
        ) : null}
      </section>
      <footer>
        {item.sourceUrl ? (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
            {t("pluginDetails.viewRepository")} <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        {onInstall ? (
          <button
            className="og-plugin-install"
            type="button"
            disabled={!installable || busy || installed}
            onClick={onInstall}
          >
            {installed
              ? t("pluginDetails.installed")
              : busy
                ? t("pluginDetails.installing")
                : t("pluginDetails.installPlugin")}
          </button>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {exceedsInstallLimit ? (
          <p>{t("pluginDetails.thisPluginExceedsTheCurrent")}</p>
        ) : contentsUnknown ? (
          <p>{t("pluginDetails.pluginContentsAreUnavailableInstallation")}</p>
        ) : !installable ? (
          <p>{t("pluginDetails.noInstallableSkillsOrRemote")}</p>
        ) : (
          <p>{t("pluginDetails.installsSkillsAndAddsConnection")}</p>
        )}
      </footer>
    </article>
  );
}

const EMPTY_CONNECTIONS: Record<string, boolean> = {};
import { useState } from "react";
import { pluginMcpUnavailableReason, type PluginDiscoveryItem } from "@opengeni/sdk";
import { Markdown } from "./components/markdown";

const componentLabels: Record<string, string> = {
  skills: "Skills",
  mcp: "MCP connections",
  apps: "Hosted apps",
  hooks: "Hooks",
  agents: "Agents",
  commands: "Commands",
  lsp: "Language servers",
};

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
  const supported = (server: NonNullable<PluginDiscoveryItem["mcpServers"]>[number]) =>
    pluginMcpUnavailableReason(server) === null;
  const contentsUnknown = item.skills == null || item.mcpServers == null;
  const installableCount =
    (item.skills?.length ?? 0) + (item.mcpServers?.filter(supported).length ?? 0);
  const exceedsInstallLimit = installableCount > 64;
  const installable = installableCount > 0 && !exceedsInstallLimit;
  const [expanded, setExpanded] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const description = item.longDescription || item.description;
  const lengthy = description.length > 700;
  const registryLabel =
    item.provider === "openai"
      ? "OpenAI plugin registry"
      : item.provider === "anthropic"
        ? "Anthropic plugin registry"
        : "Custom source";
  return (
    <article className="og-plugin-details">
      <header className="og-plugin-details-header">
        {item.logoUrl && !logoFailed ? (
          <img src={item.logoUrl} alt="" onError={() => setLogoFailed(true)} />
        ) : null}
        <div>
          <h2>{item.displayName.replace(/-/g, " ")}</h2>
          {item.author?.name ? <p>By {item.author.name}</p> : null}
        </div>
      </header>
      <div className="og-plugin-details-meta">
        <span>{registryLabel}</span>
        {item.category ? <span>{item.category}</span> : null}
        {item.version ? <span>v{item.version}</span> : null}
      </div>
      <section className="og-plugin-details-members">
        <h3>
          Skills <span>{item.skills?.length ?? "—"}</span>
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
              ? "No bundled skills."
              : "Contents haven’t been indexed for this repository."}
          </p>
        )}
        <h3>
          MCP servers <span>{item.mcpServers?.length ?? "—"}</span>
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
                        {connected ? "Manage" : "Connect"}
                      </button>
                    ) : null}
                  </div>
                  <small>
                    {connected ? "Connected · " : ""}
                    {unavailableReason ?? server.endpoint}
                  </small>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            {item.mcpServers ? "No bundled MCP servers." : "Server details haven’t been indexed."}
          </p>
        )}
        {item.components?.some((component) => !["skills", "mcp"].includes(component)) ? (
          <div className="og-plugin-details-other">
            Not installed here:{" "}
            {item.components
              .filter((component) => !["skills", "mcp"].includes(component))
              .map((component) => componentLabels[component] ?? component)
              .join(", ")}
          </div>
        ) : null}
      </section>
      <section className="og-plugin-details-overview" aria-label="Overview">
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
            {expanded ? "Show less" : "Read more"}
          </button>
        ) : null}
      </section>
      <footer>
        {item.sourceUrl ? (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
            View repository <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        {onInstall ? (
          <button
            className="og-plugin-install"
            type="button"
            disabled={!installable || busy || installed}
            onClick={onInstall}
          >
            {installed ? "Installed" : busy ? "Installing…" : "Install plugin"}
          </button>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {exceedsInstallLimit ? (
          <p>This plugin exceeds the current 64-component installation limit.</p>
        ) : contentsUnknown ? (
          <p>
            Plugin contents are unavailable. Installation is disabled until the repository can be
            inspected.
          </p>
        ) : !installable ? (
          <p>No installable skills or remote MCP servers.</p>
        ) : (
          <p>Installs skills and adds connection references. Connect each server separately.</p>
        )}
      </footer>
    </article>
  );
}

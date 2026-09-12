import { repositoryMetadata } from "./plugin-repository-metadata";
/** Sync discovery metadata only. Never execute or install upstream plugin content. */
import { mkdir, rename } from "node:fs/promises";

const sources = [
  {
    id: "openai",
    repository: "openai/plugins",
    index: ".agents/plugins/marketplace.json",
    manifest: ".codex-plugin/plugin.json",
  },
  {
    id: "anthropic",
    repository: "anthropics/claude-plugins-official",
    index: ".claude-plugin/marketplace.json",
    manifest: ".claude-plugin/plugin.json",
  },
];
async function json(url: string, optional = false): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
}
const catalog = [];
for (const source of sources) {
  const commit = await json(`https://api.github.com/repos/${source.repository}/commits/main`);
  const revision = commit.sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Missing upstream revision");
  const raw = `https://raw.githubusercontent.com/${source.repository}/${revision}/`;
  const index = await json(raw + source.index);
  if (!Array.isArray(index.plugins) || !index.plugins.length) throw new Error("Empty plugin index");
  const tree = await json(
    `https://api.github.com/repos/${source.repository}/git/trees/${revision}?recursive=1`,
  );
  if (tree.truncated) throw new Error("Incomplete upstream tree");
  const paths: string[] = tree.tree.map((entry: any) => entry.path);
  const entries = [];
  // Small batches keep refresh traffic bounded; browsing never requests GitHub.
  for (let offset = 0; offset < index.plugins.length; offset += 6) {
    entries.push(
      ...(await Promise.all(
        index.plugins.slice(offset, offset + 6).map(async (entry: any) => {
          const local =
            typeof entry.source === "string"
              ? entry.source
              : entry.source?.source === "local"
                ? entry.source.path
                : null;
          let path = local?.replace(/^\.\//, "");
          let repo = source.repository,
            pin = revision,
            base = raw,
            repoPaths = paths;
          let external: Map<string, string> | null = null;
          let inspectionError: string | null = null;
          if (!local) {
            const location =
              typeof entry.source?.url === "string"
                ? entry.source.url.match(
                    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
                  )
                : null;
            if (location && /^[a-f0-9]{40}$/.test(entry.source?.sha ?? "")) {
              try {
                repo = location[1];
                pin = entry.source.sha;
                external = await repositoryMetadata(repo, pin);
                path = (entry.source.path ?? "").replace(/^\.\//, "").replace(/\/$/, "");
                repoPaths = [...external.keys()];
                base = "https://raw.githubusercontent.com/" + repo + "/" + pin + "/";
              } catch (error) {
                inspectionError =
                  error instanceof Error ? error.message : "Could not inspect repository";
              }
            } else inspectionError = "Source has no supported repository and pinned commit";
          }
          const inspected = path !== undefined;
          const prefix = path ? path + "/" : "";
          const read = async (file: string) =>
            external
              ? external.get(prefix + file)
                ? JSON.parse(external.get(prefix + file)!)
                : null
              : json(base + prefix + file, true);
          const manifest = inspected ? await read(source.manifest) : null;
          const ui = manifest?.interface ?? {};
          const asset = (value: unknown) =>
            typeof value !== "string"
              ? null
              : /^https:\/\//.test(value)
                ? value
                : inspected
                  ? new URL(value, base + prefix).href
                  : null;
          const pluginPaths = inspected
            ? repoPaths
                .filter((value) => value.startsWith(prefix))
                .map((value) => value.slice(prefix.length))
            : [];
          const skills = inspected
            ? pluginPaths
                .filter((value) => /(^|\/)SKILL\.md$/.test(value))
                .map((value) => ({
                  name: value.split("/").at(-2) ?? entry.name,
                  sourceUrl: "https://github.com/" + repo + "/blob/" + pin + "/" + prefix + value,
                }))
            : null;
          let mcpConfig: any =
            manifest?.mcpServers && typeof manifest.mcpServers === "object"
              ? manifest.mcpServers
              : null;
          const mcpFile =
            typeof manifest?.mcpServers === "string"
              ? manifest.mcpServers.replace(/^\.\//, "")
              : ".mcp.json";
          if (inspected && pluginPaths.includes(mcpFile)) mcpConfig = await read(mcpFile);
          const servers = mcpConfig?.mcpServers ?? mcpConfig ?? {};
          const mcpServers = inspected
            ? Object.entries(servers).map(([name, config]: [string, any]) => ({
                requiresConfiguration: Boolean(
                  config.headers && Object.keys(config.headers).length,
                ),
                name,
                transport: config.type ?? (config.url ? "http" : "stdio"),
                endpoint: typeof config.url === "string" ? config.url : null,
              }))
            : null;
          const components = inspected
            ? [
                pluginPaths.some((value) => /(^|\/)SKILL\.md$/.test(value)) && "skills",
                (manifest?.mcpServers || pluginPaths.includes(".mcp.json")) && "mcp",
                (manifest?.apps || pluginPaths.includes(".app.json")) && "apps",
                pluginPaths.some((value) => value.startsWith("hooks/")) && "hooks",
                pluginPaths.some((value) => value.startsWith("agents/")) && "agents",
                pluginPaths.some((value) => value.startsWith("commands/")) && "commands",
                pluginPaths.some((value) => value.endsWith(".lsp.json")) && "lsp",
              ].filter(Boolean)
            : null;
          return {
            id: `${source.id}:${entry.name}`,
            name: entry.name,
            displayName: ui.displayName ?? manifest?.name ?? entry.name,
            description: ui.shortDescription ?? manifest?.description ?? entry.description ?? "",
            longDescription: ui.longDescription ?? manifest?.description ?? entry.description ?? "",
            category: ui.category ?? entry.category ?? null,
            keywords: manifest?.keywords ?? entry.keywords ?? [],
            author: manifest?.author ?? entry.author ?? null,
            version: manifest?.version ?? entry.version ?? null,
            license: manifest?.license ?? entry.license ?? null,
            logoUrl: asset(ui.logo ?? ui.composerIcon),
            darkLogoUrl: asset(ui.logoDark ?? ui.composerIconDark),
            homepage: manifest?.homepage ?? entry.homepage ?? null,
            sourceUrl: inspected
              ? `https://github.com/${repo}/tree/${pin}/${path}`
              : (entry.source?.url ?? entry.homepage ?? null),
            skills,
            mcpServers,
            components,
            componentInspection: inspected ? "repository" : "not_inspected",
            inspectionError,
            installation: "requires_adapter",
            upstream: { source: entry.source, policy: entry.policy ?? null },
          };
        }),
      )),
    );
  }
  catalog.push({
    provider: source.id,
    repository: source.repository,
    revision,
    indexUrl: raw + source.index,
    entries,
  });
  console.log(`${source.id}: ${entries.length} plugins`);
}
const output = new URL("../data/catalog/plugins-snapshot.json", import.meta.url);
await mkdir(new URL(".", output), { recursive: true });
const temporary = new URL(output.href + ".tmp");
await Bun.write(temporary, JSON.stringify({ schemaVersion: 1, sources: catalog }, null, 2) + "\n");
await rename(temporary, output);

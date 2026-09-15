import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { PluginInstallationSummary, PluginUninstallPreview } from "@opengeni/sdk";
import { Toaster } from "sonner";
import { Button } from "../src/components/ui/button";
import { useSourcePackages } from "../src/components/capabilities/use-source-packages";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.has("dark"));
document.documentElement.dataset.ogTheme = params.has("dark") ? "dark" : "light";
const plugin: PluginInstallationSummary = {
  pluginKey: "marketplace/openai/aikido",
  name: "Aikido",
  description: "Security tools for your workspace.",
  version: "1.0.0",
  category: "security",
  tags: [],
  sourceUrl: null,
  manifestDigest: "a".repeat(64),
  installationVersion: 1,
  componentCount: 4,
  status: "active",
  installedAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
};
let installed = true;
let attempts = 0;
const requests: unknown[] = [];
Object.assign(window, { removalRequests: requests });
const refreshGate = new Promise<void>((resolve) => {
  Object.assign(window, { releaseRemovalRefresh: resolve });
});
async function beforeList(kind: "skill" | "plugin") {
  if (installed) return;
  if (params.has("delayed-refresh")) await refreshGate;
  if (params.has(`${kind}-list-error`)) throw new Error(`${kind} list unavailable`);
}
function preview(): PluginUninstallPreview {
  const component = (
    capabilityId: string,
    name: string,
    disposition: "removed" | "retained" | "inactive",
    retentionReasons: PluginUninstallPreview["components"][number]["retentionReasons"] = [],
  ): PluginUninstallPreview["components"][number] => ({
    capabilityId,
    name,
    disposition,
    kind: "skill",
    retentionReasons,
    remainingOwners: [],
    retainedByOtherOwners: false,
  });
  const customized = component("skill:review", "Security review", "retained", ["customized"]);
  customized.skillId = "00000000-0000-4000-8000-000000000003";
  const shared = {
    ...component("skill:triage", "Issue triage", "retained", ["other_owners"]),
    retainedByOtherOwners: true,
    remainingOwners: [{ kind: "plugin" as const, name: "Code review" }],
  };
  const components = params.has("empty")
    ? []
    : params.has("simple")
      ? [
          component("skill:scan", "Scan repository", "removed"),
          { ...component("mcp:aikido", "Aikido tools", "removed"), kind: "mcp" as const },
        ]
      : [
          component(
            "skill:scan",
            "Scan repository",
            attempts && params.has("stale") ? "retained" : "removed",
            attempts && params.has("stale") ? ["customized"] : [],
          ),
          customized,
          shared,
          component("skill:legacy", "Legacy checks", "inactive"),
        ];
  if (params.has("long"))
    components.push(
      ...Array.from({ length: 30 }, (_, index) =>
        component(
          `skill:long-${index}`,
          `Repository security checks ${index + 1} with a long name to verify wrapping on a small screen`,
          "removed",
        ),
      ),
    );
  if (params.has("unavailable"))
    components.push(
      component("skill:unknown", "Restricted skill", "retained", ["registry_unavailable"]),
    );
  return {
    pluginKey: plugin.pluginKey,
    installed,
    version: "1.0.0",
    installationVersion: 1,
    previewToken: (attempts ? "b" : "a").repeat(64),
    components,
  };
}
const client = {
  listInstalledSkills: async () => {
    await beforeList("skill");
    return { skills: [] };
  },
  listInstalledPlugins: async () => {
    await beforeList("plugin");
    return { plugins: installed ? [plugin] : [] };
  },
  previewPluginUninstall: async () => preview(),
  uninstallPlugin: async (_workspaceId: string, _pluginKey: string, request: unknown) => {
    attempts++;
    requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (params.has("error")) throw new Error("Couldn’t remove Aikido. Try again.");
    if (params.has("stale") && attempts === 1)
      throw new OpenGeniApiError(409, "Removal details changed");
    installed = false;
    if (params.has("already-removed-refresh-error"))
      throw new OpenGeniApiError(409, "This plugin was removed elsewhere");
    return {
      pluginKey: plugin.pluginKey,
      status: "uninstalled",
      retainedComponents: params.has("simple") ? [] : ["skill:triage"],
      skillReleases: params.has("simple")
        ? []
        : [
            {
              skillId: "00000000-0000-4000-8000-000000000003",
              revisionId: null,
              disposition: "preserved",
              eventId: null,
              warning: null,
            },
          ],
    };
  },
} as unknown as OpenGeniBrowserClient;

function Fixture() {
  const trigger = useRef<HTMLButtonElement>(null);
  const fallback = useRef<HTMLHeadingElement>(null);
  const [refreshed, setRefreshed] = useState(false);
  const source = useSourcePackages({
    client,
    workspaceId: "workspace",
    connections: [],
    canManage: true,
    restoreFocusRef: trigger,
    restoreFocusFallbackRef: fallback,
    onChanged: () => {
      if (params.has("refresh-error") || params.has("already-removed-refresh-error"))
        throw new Error("Refresh unavailable");
      setRefreshed(true);
    },
  });
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-10">
      <h1 ref={fallback} tabIndex={-1} className="text-xl font-semibold">
        Plugins
      </h1>
      <p className="text-sm text-fg-muted">Skills and tools installed in your workspace.</p>
      {source.plugins.map((item) => (
        <div
          key={item.pluginKey}
          className="flex items-center justify-between gap-4 rounded-lg bg-surface p-4"
        >
          <div>
            <h2 className="font-medium">{item.name}</h2>
            <p className="text-sm text-fg-muted">{item.description}</p>
          </div>
          <Button ref={trigger} variant="outline" onClick={() => source.removePlugin(item)}>
            Remove
          </Button>
        </div>
      ))}
      {!source.loading && !source.plugins.length ? <p>No plugins installed.</p> : null}
      {refreshed ? <p data-refreshed>Skills and tools refreshed.</p> : null}
      {source.dialogs}
      <Toaster />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

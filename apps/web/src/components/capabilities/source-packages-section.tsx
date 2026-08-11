import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { toast } from "sonner";

import {
  initialSourceImportState,
  pluginBindingsRequest,
  sourceImportReducer,
  sourceImportValidationError,
  workspaceImportedSkills,
  type InstalledSourceSkill,
  type SourceImportKind,
} from "@/components/capabilities/source-import-flow";
import type {
  CapabilityCatalogItem,
  CapabilityInstallation,
  ConnectionMetadata,
  PluginInstallationSummary,
  PluginUninstallPreview,
  SkillUninstallPreview,
} from "@/types";

export type SourcePackageFilter = "all" | "skill" | "plugin";

export type SourceRemoveTarget =
  | {
      kind: "skill";
      skill: InstalledSourceSkill;
      preview: SkillUninstallPreview;
    }
  | {
      kind: "plugin";
      plugin: PluginInstallationSummary;
      preview: PluginUninstallPreview;
      operationId: string;
    };

const SourcePackagesSectionView = lazy(async () => {
  const module = await import("@/components/capabilities/integration-control-center-view");
  return { default: module.SourcePackagesSectionView };
});

export function SourcePackagesSection({
  client,
  workspaceId,
  items,
  installations,
  connections,
  canManage,
  filter,
  query,
  onChanged,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  items: CapabilityCatalogItem[];
  installations: CapabilityInstallation[];
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  filter: SourcePackageFilter;
  query: string;
  onChanged: () => void | Promise<void>;
}) {
  const [plugins, setPlugins] = useState<PluginInstallationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SourceRemoveTarget | null>(null);
  const [sourceImport, dispatchSourceImport] = useReducer(
    sourceImportReducer,
    undefined,
    initialSourceImportState,
  );

  const skills = useMemo(
    () => workspaceImportedSkills(items, installations),
    [installations, items],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await client.listInstalledPlugins(workspaceId);
      setPlugins(response.plugins);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => void load(), [load]);

  function openNew(kind: SourceImportKind) {
    const hasDraft = Boolean(
      sourceImport.url.trim() ||
      sourceImport.skillPreview ||
      sourceImport.pluginPreview ||
      sourceImport.error ||
      sourceImport.editingSkill ||
      sourceImport.editingPlugin,
    );
    if (hasDraft && sourceImport.kind === kind) {
      dispatchSourceImport({ type: "open" });
      return;
    }
    dispatchSourceImport({
      type: "new",
      kind,
      operationId: crypto.randomUUID(),
    });
  }

  async function previewSource() {
    if (!sourceImport.url.trim()) return;
    dispatchSourceImport({ type: "phase", phase: "previewing", error: null });
    try {
      if (sourceImport.kind === "skill") {
        const preview = await client.previewSkillImport(workspaceId, {
          url: sourceImport.url.trim(),
        });
        dispatchSourceImport({ type: "skill_preview", preview });
        return;
      }
      const preview = await client.previewPlugin(workspaceId, {
        url: sourceImport.url.trim(),
        bindings: pluginBindingsRequest(sourceImport.pluginBindings),
      });
      dispatchSourceImport({ type: "plugin_preview", preview });
    } catch (error) {
      dispatchSourceImport({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function installSource() {
    const validationError = sourceImportValidationError(sourceImport);
    if (validationError) {
      dispatchSourceImport({
        type: "phase",
        phase: "review",
        error: validationError,
      });
      return;
    }
    dispatchSourceImport({ type: "phase", phase: "installing", error: null });
    try {
      if (sourceImport.kind === "skill") {
        const preview = sourceImport.skillPreview!;
        await client.installSkill(workspaceId, {
          url: sourceImport.url.trim(),
          expectedSourceCommit: preview.sourceCommit,
          expectedContentSha256: preview.contentSha256,
          ...(preview.installed && preview.installationVersion !== null
            ? { expectedInstallationVersion: preview.installationVersion }
            : {}),
        });
        toast.success(preview.installed ? `${preview.name} updated` : `${preview.name} installed`, {
          description: `Pinned to ${preview.sourceCommit.slice(0, 12)} with ${preview.files.length} reviewed files.`,
        });
      } else {
        const preview = sourceImport.pluginPreview!;
        await client.installPlugin(workspaceId, {
          url: sourceImport.url.trim(),
          expectedManifestDigest: preview.manifestDigest,
          expectedComponents: preview.components.map((component) => ({
            key: component.key,
            digest: component.digest,
          })),
          bindings: pluginBindingsRequest(sourceImport.pluginBindings),
          idempotencyKey: sourceImport.operationId,
          ...(preview.installed && preview.installationVersion !== null
            ? { expectedInstallationVersion: preview.installationVersion }
            : {}),
        });
        toast.success(
          preview.installed
            ? `${preview.manifest.name} updated`
            : `${preview.manifest.name} installed`,
          {
            description: `${preview.components.length} immutable components are owned by this Plugin installation.`,
          },
        );
      }
      dispatchSourceImport({ type: "reset" });
      await Promise.all([load(), Promise.resolve(onChanged())]);
    } catch (error) {
      dispatchSourceImport({
        type: "phase",
        phase: "review",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function previewSkillRemoval(skill: InstalledSourceSkill) {
    setBusyKey(`skill:${skill.item.id}`);
    try {
      const preview = await client.previewSkillUninstall(workspaceId, skill.item.id);
      if (!preview.installed || preview.installationVersion === null) {
        throw new Error("This Skill is no longer directly installed. Refresh and try again.");
      }
      setRemoveTarget({ kind: "skill", skill, preview });
    } catch (error) {
      toast.error("Couldn't inspect Skill removal", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function previewPluginRemoval(plugin: PluginInstallationSummary) {
    setBusyKey(`plugin:${plugin.pluginKey}`);
    try {
      const preview = await client.previewPluginUninstall(workspaceId, plugin.pluginKey);
      if (!preview.installed || preview.installationVersion === null) {
        throw new Error("This Plugin is no longer installed. Refresh and try again.");
      }
      setRemoveTarget({
        kind: "plugin",
        plugin,
        preview,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      toast.error("Couldn't inspect Plugin removal", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function removeSource(): Promise<boolean> {
    if (!removeTarget || removeTarget.preview.installationVersion === null) return false;
    const key =
      removeTarget.kind === "skill"
        ? `skill:${removeTarget.skill.item.id}`
        : `plugin:${removeTarget.plugin.pluginKey}`;
    setBusyKey(key);
    try {
      if (removeTarget.kind === "skill") {
        const result = await client.uninstallSkill(workspaceId, removeTarget.skill.item.id, {
          expectedInstallationVersion: removeTarget.preview.installationVersion,
        });
        toast.success(`${removeTarget.skill.item.name} direct installation removed`, {
          description:
            result.status === "retained_by_other_owners"
              ? "The runtime Skill remains available because another Plugin or Pack still owns it."
              : "The reviewed Skill files are no longer active in this workspace.",
        });
      } else {
        const result = await client.uninstallPlugin(workspaceId, removeTarget.plugin.pluginKey, {
          expectedInstallationVersion: removeTarget.preview.installationVersion,
          idempotencyKey: removeTarget.operationId,
        });
        toast.success(`${removeTarget.plugin.name} removed`, {
          description:
            result.retainedComponents.length > 0
              ? `${result.retainedComponents.length} shared components remain because another owner still uses them.`
              : "Its Plugin-owned components were removed; Connections were retained.",
        });
      }
      setRemoveTarget(null);
      await Promise.all([load(), Promise.resolve(onChanged())]);
      return true;
    } catch (error) {
      toast.error(`Couldn't remove this ${removeTarget.kind === "skill" ? "Skill" : "Plugin"}`, {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Suspense
      fallback={
        <div
          className="h-40 rounded-xl border border-border bg-surface"
          aria-label="Loading Skills and Plugins"
          aria-busy="true"
        />
      }
    >
      <SourcePackagesSectionView
        skills={skills}
        plugins={plugins}
        loading={loading}
        loadError={loadError}
        canManage={canManage}
        filter={filter}
        query={query}
        busyKey={busyKey}
        sourceImport={sourceImport}
        connections={connections}
        removeTarget={removeTarget}
        onRetry={() => void load()}
        onImportSkill={() => openNew("skill")}
        onInstallPlugin={() => openNew("plugin")}
        onUpdateSkill={(skill) =>
          dispatchSourceImport({
            type: "edit_skill",
            skill,
            operationId: crypto.randomUUID(),
          })
        }
        onUpdatePlugin={(plugin) =>
          dispatchSourceImport({
            type: "edit_plugin",
            plugin,
            operationId: crypto.randomUUID(),
          })
        }
        onRemoveSkill={(skill) => void previewSkillRemoval(skill)}
        onRemovePlugin={(plugin) => void previewPluginRemoval(plugin)}
        onSourceImportOpenChange={(open) => dispatchSourceImport({ type: open ? "open" : "close" })}
        onKindChange={(kind) => dispatchSourceImport({ type: "kind", kind })}
        onUrlChange={(url) => dispatchSourceImport({ type: "url", url })}
        onPreview={() => void previewSource()}
        onBindingChange={(componentKey, connectionId) =>
          dispatchSourceImport({
            type: "plugin_binding",
            componentKey,
            connectionId,
          })
        }
        onInstall={() => void installSource()}
        onBack={() => dispatchSourceImport({ type: "phase", phase: "source", error: null })}
        onRemoveClose={() => setRemoveTarget(null)}
        onRemoveConfirm={removeSource}
      />
    </Suspense>
  );
}

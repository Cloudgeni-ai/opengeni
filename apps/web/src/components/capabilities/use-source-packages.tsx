/**
 * Skills and Plugins installed from an immutable source (GitHub, skills.sh, or
 * a reviewed Plugin manifest URL).
 *
 * This owns the data and every mutation - preview, install/update, and the
 * version-fenced removal - and hands back plain state plus the dialogs those
 * flows need. The Bundles section renders the rows; nothing about how a row
 * looks lives here.
 */
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";
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
  ConnectionMetadata,
  InstalledSkillSummary,
  PluginInstallationSummary,
  PluginUninstallPreview,
  SkillUninstallPreview,
} from "@/types";

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

export type SourcePackages = {
  skills: InstalledSourceSkill[];
  plugins: PluginInstallationSummary[];
  loading: boolean;
  loadError: Error | null;
  /** `skill:<capabilityId>` or `plugin:<pluginKey>` while that one mutates. */
  busyKey: string | null;
  reload: () => void;
  importSkill: () => void;
  installPlugin: () => void;
  updateSkill: (skill: InstalledSourceSkill) => void;
  updatePlugin: (plugin: PluginInstallationSummary) => void;
  removeSkill: (skill: InstalledSourceSkill) => void;
  removePlugin: (plugin: PluginInstallationSummary) => void;
  /** The import stepper and the removal confirmation, mounted by the caller. */
  dialogs: ReactNode;
};

// The URL-paste -> preview -> review -> install stepper is only needed once an
// admin actually starts an import, so it stays lazy.
const SourcePackageDialogs = lazy(async () => {
  const module = await import("@/components/capabilities/source-package-dialogs");
  return { default: module.SourcePackageDialogs };
});

export function useSourcePackages({
  client,
  workspaceId,
  connections,
  canManage,
  onChanged,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  onChanged: () => void | Promise<void>;
}): SourcePackages {
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillSummary[]>([]);
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

  const skills = useMemo(() => workspaceImportedSkills(installedSkills), [installedSkills]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [skillResponse, pluginResponse] = await Promise.all([
        client.listInstalledSkills(workspaceId),
        client.listInstalledPlugins(workspaceId),
      ]);
      setInstalledSkills(skillResponse.skills);
      setPlugins(pluginResponse.plugins);
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
    setBusyKey(`skill:${skill.capabilityId}`);
    try {
      const preview = await client.previewSkillUninstall(workspaceId, skill.capabilityId);
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
        ? `skill:${removeTarget.skill.capabilityId}`
        : `plugin:${removeTarget.plugin.pluginKey}`;
    setBusyKey(key);
    try {
      if (removeTarget.kind === "skill") {
        const result = await client.uninstallSkill(workspaceId, removeTarget.skill.capabilityId, {
          expectedInstallationVersion: removeTarget.preview.installationVersion,
        });
        toast.success(`${removeTarget.skill.name} direct installation removed`, {
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

  const dialogs = (
    <Suspense fallback={null}>
      <SourcePackageDialogs
        sourceImport={sourceImport}
        connections={connections}
        canManage={canManage}
        removeTarget={removeTarget}
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

  return {
    skills,
    plugins,
    loading,
    loadError,
    busyKey,
    reload: () => void load(),
    importSkill: () => openNew("skill"),
    installPlugin: () => openNew("plugin"),
    updateSkill: (skill) =>
      dispatchSourceImport({
        type: "edit_skill",
        skill,
        operationId: crypto.randomUUID(),
      }),
    updatePlugin: (plugin) =>
      dispatchSourceImport({
        type: "edit_plugin",
        plugin,
        operationId: crypto.randomUUID(),
      }),
    removeSkill: (skill) => void previewSkillRemoval(skill),
    removePlugin: (plugin) => void previewPluginRemoval(plugin),
    dialogs,
  };
}

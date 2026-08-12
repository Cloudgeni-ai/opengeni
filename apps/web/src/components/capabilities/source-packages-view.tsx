import {
  Loader2Icon,
  PackageIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { SourceImportDialog } from "@/components/capabilities/source-import-dialog";
import type {
  InstalledSourceSkill,
  SourceImportState,
} from "@/components/capabilities/source-import-flow";
import type {
  SourcePackageFilter,
  SourceRemoveTarget,
} from "@/components/capabilities/source-packages-section";
import { LoadErrorState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ConnectionMetadata, PluginInstallationSummary } from "@/types";

export function SourcePackagesSectionView({
  skills,
  plugins,
  loading,
  loadError,
  canManage,
  filter,
  query,
  busyKey,
  sourceImport,
  connections,
  removeTarget,
  onRetry,
  onImportSkill,
  onInstallPlugin,
  onUpdateSkill,
  onUpdatePlugin,
  onRemoveSkill,
  onRemovePlugin,
  onSourceImportOpenChange,
  onKindChange,
  onUrlChange,
  onPreview,
  onBindingChange,
  onInstall,
  onBack,
  onRemoveClose,
  onRemoveConfirm,
}: {
  skills: InstalledSourceSkill[];
  plugins: PluginInstallationSummary[];
  loading: boolean;
  loadError: Error | null;
  canManage: boolean;
  filter: SourcePackageFilter;
  query: string;
  busyKey: string | null;
  sourceImport: SourceImportState;
  connections: ConnectionMetadata[] | null;
  removeTarget: SourceRemoveTarget | null;
  onRetry: () => void;
  onImportSkill: () => void;
  onInstallPlugin: () => void;
  onUpdateSkill: (skill: InstalledSourceSkill) => void;
  onUpdatePlugin: (plugin: PluginInstallationSummary) => void;
  onRemoveSkill: (skill: InstalledSourceSkill) => void;
  onRemovePlugin: (plugin: PluginInstallationSummary) => void;
  onSourceImportOpenChange: (open: boolean) => void;
  onKindChange: (kind: SourceImportState["kind"]) => void;
  onUrlChange: (url: string) => void;
  onPreview: () => void;
  onBindingChange: (componentKey: string, connectionId: string) => void;
  onInstall: () => void;
  onBack: () => void;
  onRemoveClose: () => void;
  onRemoveConfirm: () => Promise<boolean>;
}) {
  return (
    <>
      <SourcePackagesView
        skills={skills}
        plugins={plugins}
        loading={loading}
        loadError={loadError}
        canManage={canManage}
        filter={filter}
        query={query}
        busyKey={busyKey}
        onRetry={onRetry}
        onImportSkill={onImportSkill}
        onInstallPlugin={onInstallPlugin}
        onUpdateSkill={onUpdateSkill}
        onUpdatePlugin={onUpdatePlugin}
        onRemoveSkill={onRemoveSkill}
        onRemovePlugin={onRemovePlugin}
      />

      <SourceImportDialog
        state={sourceImport}
        connections={connections}
        canManage={canManage}
        onOpenChange={onSourceImportOpenChange}
        onKindChange={onKindChange}
        onUrlChange={onUrlChange}
        onPreview={onPreview}
        onBindingChange={onBindingChange}
        onInstall={onInstall}
        onBack={onBack}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) onRemoveClose();
        }}
        title={removeDialogTitle(removeTarget)}
        description={removeDialogDescription(removeTarget)}
        confirmLabel={removeTarget?.kind === "skill" ? "Remove direct Skill" : "Remove Plugin"}
        cancelAutoFocus
        onConfirm={onRemoveConfirm}
      >
        <RemoveImpact target={removeTarget} />
      </ConfirmDialog>
    </>
  );
}

export function SourcePackagesView({
  skills,
  plugins,
  loading,
  loadError,
  canManage,
  filter,
  query,
  busyKey,
  onRetry,
  onImportSkill,
  onInstallPlugin,
  onUpdateSkill,
  onUpdatePlugin,
  onRemoveSkill,
  onRemovePlugin,
}: {
  skills: InstalledSourceSkill[];
  plugins: PluginInstallationSummary[];
  loading: boolean;
  loadError: Error | null;
  canManage: boolean;
  filter: SourcePackageFilter;
  query: string;
  busyKey: string | null;
  onRetry: () => void;
  onImportSkill: () => void;
  onInstallPlugin: () => void;
  onUpdateSkill: (skill: InstalledSourceSkill) => void;
  onUpdatePlugin: (plugin: PluginInstallationSummary) => void;
  onRemoveSkill: (skill: InstalledSourceSkill) => void;
  onRemovePlugin: (plugin: PluginInstallationSummary) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSkills =
    filter === "plugin" ? [] : skills.filter((skill) => sourceSkillMatches(skill, normalizedQuery));
  const visiblePlugins =
    filter === "skill"
      ? []
      : plugins.filter((plugin) => sourcePluginMatches(plugin, normalizedQuery));
  const empty = !loading && !loadError && visibleSkills.length + visiblePlugins.length === 0;

  return (
    <section className="space-y-4" aria-labelledby="source-packages-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="source-packages-heading" className="text-sm font-semibold text-fg">
              Skills and Plugins
            </h2>
            <Badge variant="outline" className="text-2xs text-fg-subtle">
              Immutable source
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
            Import a GitHub or skills.sh Skill, or install a reviewed Plugin bill of materials.
            Updates are pinned, diffed, and version-fenced before workspace mutation.
          </p>
          {!canManage ? (
            <p className="mt-1 text-2xs leading-4 text-fg-subtle">
              Workspace administrators can install, update, and remove source packages.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filter !== "plugin" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={onImportSkill}
            >
              <SparklesIcon />
              Import Skill
            </Button>
          ) : null}
          {filter !== "skill" ? (
            <Button type="button" size="sm" disabled={!canManage} onClick={onInstallPlugin}>
              <PlusIcon />
              Install Plugin
            </Button>
          ) : null}
        </div>
      </div>

      {loadError && filter !== "skill" ? (
        <LoadErrorState
          title="Couldn't load installed Plugins"
          error={loadError}
          onRetry={onRetry}
        />
      ) : null}

      {visibleSkills.length > 0 || visiblePlugins.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {visibleSkills.map((skill) => (
            <SkillSourceCard
              key={skill.capabilityId}
              skill={skill}
              canManage={canManage}
              busy={busyKey === `skill:${skill.capabilityId}`}
              onUpdate={() => onUpdateSkill(skill)}
              onRemove={() => onRemoveSkill(skill)}
            />
          ))}
          {visiblePlugins.map((plugin) => (
            <PluginSourceCard
              key={plugin.pluginKey}
              plugin={plugin}
              canManage={canManage}
              busy={busyKey === `plugin:${plugin.pluginKey}`}
              onUpdate={() => onUpdatePlugin(plugin)}
              onRemove={() => onRemovePlugin(plugin)}
            />
          ))}
        </div>
      ) : null}

      {loading && filter !== "skill" ? (
        <div className="grid gap-3 lg:grid-cols-2" aria-label="Loading installed Plugins">
          <SourcePackageSkeleton />
          {visibleSkills.length === 0 ? <SourcePackageSkeleton /> : null}
        </div>
      ) : null}

      {empty ? (
        <EmptyState
          icon={filter === "plugin" ? <PuzzleIcon /> : <SparklesIcon />}
          title={normalizedQuery ? "No source packages match" : "No source packages installed"}
          description={
            normalizedQuery
              ? "Try another search, or import a reviewed Skill or Plugin source."
              : "Pin reusable instructions from GitHub or install a Plugin that owns several capabilities as one unit."
          }
          action={
            canManage ? (
              <div className="flex flex-wrap justify-center gap-2">
                {filter !== "plugin" ? (
                  <Button type="button" variant="outline" size="sm" onClick={onImportSkill}>
                    <SparklesIcon />
                    Import Skill
                  </Button>
                ) : null}
                {filter !== "skill" ? (
                  <Button type="button" size="sm" onClick={onInstallPlugin}>
                    <PlusIcon />
                    Install Plugin
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        />
      ) : null}
    </section>
  );
}

function SkillSourceCard({
  skill,
  canManage,
  busy,
  onUpdate,
  onRemove,
}: {
  skill: InstalledSourceSkill;
  canManage: boolean;
  busy: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  return (
    <article
      className="rounded-xl border border-border bg-surface/50 p-4"
      data-source-package-kind="skill"
      data-source-package-id={skill.capabilityId}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <SparklesIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-fg">{skill.name}</h3>
            <Badge variant="outline" className="text-2xs uppercase text-fg-subtle">
              Skill
            </Badge>
            <SourceStatus state="ready" />
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{skill.description}</p>
          <p className="mt-2 break-all font-mono text-2xs text-fg-subtle">
            {sourceHost(skill.sourceUrl)} · {skill.sourceCommit.slice(0, 12)} ·{" "}
            {skill.contentSha256.slice(0, 12)}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border/70 pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canManage || busy}
          onClick={onUpdate}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          Check for update
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canManage || busy}
          onClick={onRemove}
        >
          <Trash2Icon />
          Remove
        </Button>
      </div>
    </article>
  );
}

function PluginSourceCard({
  plugin,
  canManage,
  busy,
  onUpdate,
  onRemove,
}: {
  plugin: PluginInstallationSummary;
  canManage: boolean;
  busy: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const sourceAvailable = plugin.sourceUrl !== null;
  return (
    <article
      className="rounded-xl border border-border bg-surface/50 p-4"
      data-source-package-kind="plugin"
      data-source-package-id={plugin.pluginKey}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <PuzzleIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-fg">{plugin.name}</h3>
            <Badge variant="outline" className="text-2xs text-fg-subtle">
              v{plugin.version}
            </Badge>
            <SourceStatus state={plugin.status === "active" ? "ready" : "attention"} />
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">
            {plugin.description || "Portable Plugin package"}
          </p>
          <p className="mt-2 break-all font-mono text-2xs text-fg-subtle">
            {plugin.componentCount} components · {plugin.manifestDigest.slice(0, 12)}
            {plugin.sourceUrl ? ` · ${sourceHost(plugin.sourceUrl)}` : " · source unavailable"}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border/70 pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canManage || busy || !sourceAvailable}
          title={sourceAvailable ? undefined : "This installed Plugin did not retain a source URL."}
          onClick={onUpdate}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          Review update
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canManage || busy}
          onClick={onRemove}
        >
          <Trash2Icon />
          Remove
        </Button>
      </div>
    </article>
  );
}

function SourceStatus({ state }: { state: "ready" | "attention" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-2xs font-medium",
        state === "ready" ? "text-success" : "text-warning",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", state === "ready" ? "bg-success" : "bg-warning")}
      />
      {state === "ready" ? "Ready" : "Needs attention"}
    </span>
  );
}

function SourcePackageSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="flex gap-3">
        <Skeleton className="size-10 rounded-xl" />
        <div className="flex-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-3/4" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      </div>
    </div>
  );
}

function RemoveImpact({ target }: { target: SourceRemoveTarget | null }) {
  if (!target) return null;
  if (target.kind === "skill") {
    return (
      <div className="rounded-lg border border-border bg-bg/50 p-3 text-xs leading-5 text-fg-muted">
        <div className="flex items-start gap-2">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-brand" />
          <p>
            {target.preview.removesRuntimeSkill
              ? "The runtime Skill will be removed because no other owner retains it."
              : `${target.preview.remainingOwners.length} other owner${target.preview.remainingOwners.length === 1 ? "" : "s"} will retain the runtime Skill.`}
          </p>
        </div>
      </div>
    );
  }
  const retained = target.preview.components.filter((component) => component.retainedByOtherOwners);
  return (
    <div className="rounded-lg border border-border bg-bg/50 p-3 text-xs leading-5 text-fg-muted">
      <div className="flex items-start gap-2">
        <PackageIcon className="mt-0.5 size-4 shrink-0 text-brand" />
        <p>
          {target.preview.components.length} components are in this Plugin. {retained.length} will
          remain because another Plugin, Pack, or direct installation also owns them. Connections
          are never deleted by Plugin removal.
        </p>
      </div>
    </div>
  );
}

function removeDialogTitle(target: SourceRemoveTarget | null): string {
  if (!target) return "Remove source package?";
  return target.kind === "skill"
    ? `Remove direct Skill “${target.skill.name}”?`
    : `Remove Plugin “${target.plugin.name}”?`;
}

function removeDialogDescription(target: SourceRemoveTarget | null): string {
  if (!target) return "Review the exact ownership impact before removal.";
  return target.kind === "skill"
    ? "This removes only the direct workspace owner. Shared ownership is retained and no Connection is deleted."
    : "This removes the Plugin owner and only components no other owner retains. Existing Connections remain available.";
}

function sourceSkillMatches(skill: InstalledSourceSkill, query: string): boolean {
  if (!query) return true;
  return [skill.name, skill.description, skill.category, ...skill.tags, skill.sourceUrl].some(
    (value) => (value ?? "").toLowerCase().includes(query),
  );
}

function sourcePluginMatches(plugin: PluginInstallationSummary, query: string): boolean {
  if (!query) return true;
  return [
    plugin.name,
    plugin.description,
    plugin.category,
    plugin.pluginKey,
    ...plugin.tags,
    plugin.sourceUrl ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

function sourceHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

import { CatalogHeader } from "./catalog-header";
import { PluginDiscovery } from "./plugin-discovery";
import { SkillDiscovery } from "./skill-discovery";

import { BookOpenIcon, PackagePlusIcon, PlusIcon, PuzzleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  catalogSkillBundleRow,
  filterBundleRows,
  importedSkillBundleRow,
  pluginBundleRow,
  sortBundleRows,
  type BundleRow,
} from "@/components/capabilities/bundles";
import { IntegrationRow } from "@/components/capabilities/integration-row";
import { IntegrationSheet } from "@/components/capabilities/integration-sheet";

import { isWorkspaceImportedSkill } from "@/components/capabilities/source-import-flow";
import { useSourcePackages } from "@/components/capabilities/use-source-packages";
import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";

/** Stable identity for the bundle search result count. */
const BUNDLE_COUNT_ID = "bundles-visible-count";

export function BundlesSection({
  query,
  importSkillRef,
  onSearchSkills,
  onShowCategory,
  overviewSkills,
  discoveryEnabled = true,
  section = "plugins",
  client,
  workspaceId,
  connections,
  canManage,
  items,
  logoUrl,
  busyCatalogId,
  onOpenCatalogItem,

  onChanged,
}: {
  query: string;
  discoveryEnabled?: boolean;
  importSkillRef?: RefObject<(() => void) | null>;
  overviewSkills?: readonly {
    id: string;
    name: string;
    description?: string;
    status?: "added" | "attention" | "unavailable";
    statusLabel?: string;
    onOpen: () => void;
  }[];
  onShowCategory?: (category: "skills" | "plugins") => void;
  onSearchSkills?: (() => void) | undefined;
  section?: "skills" | "plugins" | "all";
  client: OpenGeniBrowserClient;
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  /** Workspace administrator authority: install, update, remove, register. */
  canManage: boolean;

  items: CapabilityCatalogItem[];
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  busyCatalogId: string | null;
  onOpenCatalogItem: (item: CapabilityCatalogItem) => void;

  onChanged: () => void | Promise<void>;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  const removalFallbackRef = useRef<HTMLElement | null>(null);
  const source = useSourcePackages({
    client,
    workspaceId,
    connections,
    canManage,
    onChanged,
    restoreFocusRef: openerRef,
    restoreFocusFallbackRef: removalFallbackRef,
    ...(onShowCategory ? { onManageSkills: () => onShowCategory("skills") } : {}),
  });
  const [openSheetId, setOpenSheetId] = useState<string | null>(null);
  useEffect(() => {
    if (!importSkillRef) return;
    importSkillRef.current = source.importSkill;
    return () => {
      importSkillRef.current = null;
    };
  }, [importSkillRef, source.importSkill]);

  // Captured synchronously when a row opens something, so closing returns focus
  // to that exact row instead of dropping it on the body.

  const catalogSkills = useMemo(
    () =>
      items.filter(
        (item) => item.kind === "skill" && item.enabled && !isWorkspaceImportedSkill(item),
      ),
    [items],
  );

  const rows = useMemo(() => {
    const collected: BundleRow[] = [
      ...source.plugins.map((plugin) =>
        pluginBundleRow(plugin, {
          canManage,
          busy: source.busyKey === `plugin:${plugin.pluginKey}`,
          onUpdate: () => leaveSheet(() => source.updatePlugin(plugin)),
          onRemove: () => leaveSheet(() => source.removePlugin(plugin)),
        }),
      ),
      ...source.skills.map((skill) =>
        importedSkillBundleRow(skill, {
          canManage,
          busy: source.busyKey === `skill:${skill.capabilityId}`,
          onUpdate: () => leaveSheet(() => source.updateSkill(skill)),
          onRemove: () => leaveSheet(() => source.removeSkill(skill)),
        }),
      ),
      ...catalogSkills.map((item) =>
        catalogSkillBundleRow(item, {
          logoSrc: logoUrl(item),
          busy: busyCatalogId === item.id,
          provenance: item.source === "library" ? "built_in" : "installed_from_source",
        }),
      ),
    ];
    return sortBundleRows(collected);
    // `source` is a fresh object each render; its individual fields are the
    // real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,

    source.plugins,
    source.skills,
    source.busyKey,
    catalogSkills,
    logoUrl,
    busyCatalogId,
    canManage,
  ]);

  const visible = useMemo(
    () =>
      filterBundleRows(
        rows.filter((row) =>
          section === "all"
            ? row.kind !== "plugin"
            : section === "skills"
              ? row.kind === "skill"
              : row.kind !== "skill",
        ),
        query,
      ),
    [rows, query, section],
  );
  // Resolved from the whole list, not the filtered one: narrowing the search
  // while a sheet is open must not yank the sheet closed.
  const openSheetModel =
    rows.find((row) => row.detail.kind === "sheet" && row.id === openSheetId)?.detail ?? null;

  const loading = source.loading;
  // A load that failed says nothing about what is installed. The error banner
  // above already owns that state, so the empty state must stand down rather
  // than claim an inventory nobody managed to read.
  const failed = source.loadError !== null;
  const searching = query.trim().length > 0;

  /**
   * A footer action that opens the import stepper or a removal confirmation
   * replaces the detail rather than stacking on top of it: one modal surface at
   * a time, and cancelling returns the reader to the list they came from.
   */
  function leaveSheet(action: () => void) {
    setOpenSheetId(null);
    action();
  }

  function open(row: BundleRow, element: EventTarget | null) {
    // `document.body` is what `document.activeElement` reports when nothing is
    // focused; restoring focus to it is the same as dropping focus, so it is
    // not an opener. Matches the Integrations rows in the same route.
    openerRef.current =
      element instanceof HTMLElement && element !== document.body ? element : null;
    if (row.detail.kind === "sheet") {
      setOpenSheetId(row.id);
      return;
    }

    onOpenCatalogItem(row.detail.item);
  }

  return (
    <section
      ref={removalFallbackRef}
      tabIndex={-1}
      className="space-y-3"
      aria-label={section === "plugins" ? "Plugins" : "Skills and plugins"}
    >
      {discoveryEnabled && section !== "plugins" ? (
        <SkillDiscovery
          {...(onShowCategory
            ? {
                resultLimit: 6,
                onShowMore: () => onShowCategory("skills"),
                localSkills:
                  overviewSkills ??
                  visible
                    .filter((row) => row.kind === "skill")
                    .map((row) => ({
                      id: row.id,
                      name: row.name,
                      ...(row.description ? { description: row.description } : {}),
                      onOpen: () => open(row, document.activeElement),
                    })),
              }
            : {})}
          client={client}
          workspaceId={workspaceId}
          query={query}
          canManage={canManage}
          installedSkills={source.skills}
          onSearch={onSearchSkills}
          onImport={(url) => source.importSkill(url)}
        />
      ) : null}
      <details
        hidden={
          Boolean(onShowCategory) ||
          section === "plugins" ||
          (!visible.length && !loading && !failed)
        }
        className="space-y-3"
      >
        <summary className="cursor-pointer py-2 text-sm text-fg-muted">
          Manage installed packages
        </summary>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="bundles-heading" className="mt-1 text-base font-semibold text-fg">
              {section === "all"
                ? "Skills & plugins"
                : section === "skills"
                  ? "Installed packages"
                  : "Installed plugins"}
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
              {section === "skills"
                ? "Manage imported skills and their updates."
                : "Skills and connections installed together."}
            </p>
            {!canManage ? (
              <p className="mt-1 text-2xs leading-4 text-fg-subtle">
                Workspace administrators can install, update, and remove these items.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canManage}
              hidden={section !== "plugins"}
              onClick={source.installPlugin}
            >
              <PuzzleIcon />
              Import plugin
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/*
          A live region tied to the search box: narrowing the list is otherwise
          a silent change for a reader who cannot see the grid shrink.
        */}
          <span
            id={BUNDLE_COUNT_ID}
            role="status"
            aria-label="Search results"
            className="shrink-0 text-xs text-fg-muted"
            data-bundle-count
          >
            {visible.length} results
          </span>
        </div>

        {source.loadError ? (
          <LoadErrorState
            title="Couldn't load installed Skills and Plugins"
            error={source.loadError}
            onRetry={source.reload}
          />
        ) : null}

        {visible.length > 0 ? (
          <div className="og-capability-catalog-grid" data-bundle-list>
            {visible.map((row) => (
              <IntegrationRow
                key={row.id}
                model={row}
                busy={row.busy}
                icon={row.kind === "skill" ? <BookOpenIcon aria-hidden="true" /> : undefined}
                onOpen={() => open(row, document.activeElement)}
              />
            ))}
          </div>
        ) : loading ? (
          <div className="grid gap-2" aria-label="Loading items" aria-busy="true">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : failed ? null : section === "plugins" ? (
          <p className="py-2 text-sm text-fg-muted">
            {searching ? "No matching installed plugins." : "No plugins installed yet."}
          </p>
        ) : searching ? (
          <p className="py-4 text-sm text-fg-muted">No matching installed items.</p>
        ) : (
          <EmptyState
            icon={<PackagePlusIcon />}
            title={searching ? "No matching skills or plugins" : "No skills or plugins yet"}
            description={
              searching
                ? "Try another search, or import a Skill or Plugin."
                : "Import a Skill or Plugin to get started."
            }
          />
        )}
      </details>
      {section === "plugins" ? (
        <div>
          <CatalogHeader
            title="Plugins"
            action={
              <Button disabled={!canManage} onClick={source.installPlugin}>
                <PlusIcon />
                Import plugin
              </Button>
            }
          />
          {source.loadError ? (
            <LoadErrorState
              title="Couldn’t load installed plugins"
              error={source.loadError}
              onRetry={source.reload}
            />
          ) : null}
          {discoveryEnabled ? (
            <PluginDiscovery
              installedPlugins={source.plugins}
              onManageInstalled={(plugin, element) => {
                const row = rows.find((candidate) => candidate.id === `plugin:${plugin.pluginKey}`);
                if (row) open(row, element);
              }}
              onOpenConnection={onOpenCatalogItem}
              client={client}
              workspaceId={workspaceId}
              query={query}
              canManage={canManage}
              onChanged={() => {
                source.reload();
                onChanged();
              }}
            />
          ) : null}
        </div>
      ) : discoveryEnabled && section === "all" ? (
        <PluginDiscovery
          {...(onShowCategory
            ? { resultLimit: 6, onShowMore: () => onShowCategory("plugins") }
            : {})}
          installedPlugins={source.plugins}
          onOpenConnection={onOpenCatalogItem}
          client={client}
          workspaceId={workspaceId}
          query={query}
          canManage={canManage}
          onChanged={() => {
            source.reload();
            onChanged();
          }}
        />
      ) : null}
      <IntegrationSheet
        model={openSheetModel?.kind === "sheet" ? openSheetModel.model : null}
        open={openSheetModel?.kind === "sheet"}
        restoreFocusRef={openerRef}
        onOpenChange={(next) => {
          if (!next) setOpenSheetId(null);
        }}
      />

      {source.dialogs}
    </section>
  );
}

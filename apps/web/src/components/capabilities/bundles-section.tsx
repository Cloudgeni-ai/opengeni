import { PluginDiscovery } from "./plugin-discovery";
import { SkillDiscovery } from "./skill-discovery";
import { InstalledStrip } from "./installed-strip";
/**
 * Bundles: one section, one uniform row, for every Skill, Plugin, and Pack.
 *
 * A Bundle is a named collection of tools and instructions, not a live
 * connection to anything, so it does not belong in the Connectors
 * Enabled/Browse grid. All three kinds share the same `IntegrationRow` the
 * Integrations list uses and the page-wide search, so the list can be
 * scanned as one thing. Only the detail differs, and only where it genuinely
 * must: imported Skills and Plugins open the four-block `IntegrationSheet`, a
 * catalog Skill keeps the catalog detail sheet that owns its reviewed library
 * identity, and a Pack opens `PackDetailDialog`, because choosing a Rig and a
 * Variable Set does not compress into four blocks.
 *
 * Installing a Bundle is never a zero-confirmation action, so no row is given a
 * quick-connect fast path: the trailing state indicator stays decorative.
 */
import type { usePacks } from "@opengeni/react";
import { PackagePlusIcon, PlusIcon, PuzzleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  catalogSkillBundleRow,
  filterBundleRows,
  importedSkillBundleRow,
  packBundleProvenance,
  packBundleRow,
  pluginBundleRow,
  sortBundleRows,
  type BundleRow,
} from "@/components/capabilities/bundles";
import { IntegrationRow } from "@/components/capabilities/integration-row";
import { IntegrationSheet } from "@/components/capabilities/integration-sheet";
import {
  PackDetailDialog,
  PackManifestDialog,
  type RigOption,
} from "@/components/capabilities/pack-dialogs";
import { isWorkspaceImportedSkill } from "@/components/capabilities/source-import-flow";
import { useSourcePackages } from "@/components/capabilities/use-source-packages";
import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  CapabilityCatalogItem,
  CapabilityPack,
  ConnectionMetadata,
  PackInstallationPreview,
  PackUninstallPreview,
} from "@/types";

export type PackSelectionInput = { rigId?: string; variableSetId?: string };

/** Stable identity for the bundle search result count. */
const BUNDLE_COUNT_ID = "bundles-visible-count";

export function BundlesSection({
  query,
  importSkillRef,
  onSearchSkills,
  section = "plugins",
  client,
  workspaceId,
  connections,
  canManage,
  items,
  logoUrl,
  busyCatalogId,
  onOpenCatalogItem,
  packs,
  variableSets,
  rigs,
  busyPackId,
  onRegisterPack,
  onPreviewPackInstall,
  onInstallPack,
  onPreviewPackUninstall,
  onUninstallPack,
  onUnregisterPack,
  onStartPackSession,
  onChanged,
}: {
  query: string;
  importSkillRef?: RefObject<(() => void) | null>;
  onSearchSkills?: (() => void) | undefined;
  section?: "skills" | "plugins" | "all";
  client: OpenGeniBrowserClient;
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  /** Workspace administrator authority: install, update, remove, register. */
  canManage: boolean;
  /** The live catalog, for catalog Skills and for each Pack manifest's origin. */
  items: CapabilityCatalogItem[];
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  busyCatalogId: string | null;
  onOpenCatalogItem: (item: CapabilityCatalogItem) => void;
  packs: ReturnType<typeof usePacks>;
  variableSets: Array<{ id: string; name: string }>;
  rigs: RigOption[];
  busyPackId: string | null;
  onRegisterPack: (manifestDraft: string) => Promise<boolean>;
  onPreviewPackInstall: (
    pack: CapabilityPack,
    selection: PackSelectionInput,
  ) => Promise<PackInstallationPreview | null>;
  onInstallPack: (
    pack: CapabilityPack,
    preview: PackInstallationPreview,
    selection: PackSelectionInput,
    idempotencyKey: string,
  ) => Promise<boolean>;
  onPreviewPackUninstall: (pack: CapabilityPack) => Promise<PackUninstallPreview | null>;
  onUninstallPack: (
    pack: CapabilityPack,
    preview: PackUninstallPreview,
    idempotencyKey: string,
  ) => Promise<boolean>;
  onUnregisterPack: (pack: CapabilityPack) => Promise<boolean>;
  onStartPackSession: (skillCapabilityId: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const source = useSourcePackages({
    client,
    workspaceId,
    connections,
    canManage,
    onChanged,
  });
  const [openSheetId, setOpenSheetId] = useState<string | null>(null);
  useEffect(() => {
    if (!importSkillRef) return;
    importSkillRef.current = source.importSkill;
    return () => {
      importSkillRef.current = null;
    };
  }, [importSkillRef, source.importSkill]);
  const [openPackId, setOpenPackId] = useState<string | null>(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  // Captured synchronously when a row opens something, so closing returns focus
  // to that exact row instead of dropping it on the body.
  const openerRef = useRef<HTMLElement | null>(null);

  const catalogSkills = useMemo(
    () =>
      items.filter(
        (item) => item.kind === "skill" && item.enabled && !isWorkspaceImportedSkill(item),
      ),
    [items],
  );

  const rows = useMemo(() => {
    const collected: BundleRow[] = [
      ...packs.packs.map((pack) =>
        packBundleRow(pack, {
          installation: packs.installationFor(pack.id),
          provenance: packBundleProvenance(pack.id, items),
          busy: busyPackId === pack.id,
        }),
      ),
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
    packs.packs,
    packs.installationFor,
    items,
    busyPackId,
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
  const openPack = packs.packs.find((pack) => pack.id === openPackId) ?? null;
  const loading = source.loading || packs.loading;
  // A load that failed says nothing about what is installed. The error banner
  // above already owns that state, so the empty state must stand down rather
  // than claim an inventory nobody managed to read.
  const failed = source.loadError !== null || packs.error !== null;
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
    if (row.detail.kind === "pack-dialog") {
      setOpenPackId(row.detail.pack.id);
      return;
    }
    onOpenCatalogItem(row.detail.item);
  }

  return (
    <section
      className="mt-6 space-y-3"
      aria-label={section === "plugins" ? "Plugins" : "Skills and plugins"}
    >
      {section !== "plugins" ? (
        <SkillDiscovery
          client={client}
          workspaceId={workspaceId}
          query={query}
          canManage={canManage}
          installedSkills={source.skills}
          onSearch={onSearchSkills}
          onImport={(url) => source.importSkill(url)}
        />
      ) : null}
      <div
        hidden={section === "plugins" || (!visible.length && !loading && !failed)}
        className="space-y-3"
      >
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
            <Button
              type="button"
              size="sm"
              disabled={!canManage}
              hidden={section !== "plugins"}
              onClick={(event) => {
                openerRef.current = event.currentTarget;
                setManifestOpen(true);
              }}
            >
              <PlusIcon />
              Add workflow template
            </Button>
          </div>
        </div>

        <InstalledStrip
          items={visible
            .filter(
              (row) =>
                (section === "all" ||
                  (section === "skills" ? row.kind === "skill" : row.kind !== "skill")) &&
                ["Installed", "Update available"].includes(row.chip.label),
            )
            .map((row) => ({
              id: row.id,
              name: row.name,
              status: row.chip.label,
              logoSrc: "logoSrc" in row.mark ? row.mark.logoSrc : null,
              onOpen: () => open(row, document.activeElement),
            }))}
        />
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
        {packs.error ? (
          <LoadErrorState
            title="Couldn't load Packs"
            error={packs.error}
            onRetry={() => void packs.refresh()}
          />
        ) : null}

        {visible.length > 0 ? (
          <div className="grid gap-2" data-bundle-list>
            {visible.map((row) => (
              <IntegrationRow
                key={row.id}
                model={
                  row.kind === "pack"
                    ? {
                        ...row,
                        description: row.description.replace(/^Pack/, "Workflow template"),
                        accessibleDetail: row.accessibleDetail?.replace(
                          /^Pack/,
                          "Workflow template",
                        ),
                      }
                    : row
                }
                busy={row.busy}
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
                ? "Try another search, or install a skill, plugin, or workflow template."
                : "Import skills, install a plugin, or add a workflow template."
            }
          />
        )}
      </div>
      {section === "plugins" ? (
        <div className="space-y-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-fg">Plugins</h2>
              <p className="mt-1 text-sm text-fg-muted">Tools and skills, together.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={source.installPlugin}
            >
              <PlusIcon />
              Import plugin
            </Button>
          </div>
          {source.loadError ? (
            <LoadErrorState
              title="Couldn’t load installed plugins"
              error={source.loadError}
              onRetry={source.reload}
            />
          ) : null}
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
          <details className="border-t border-border pt-5">
            <summary className="cursor-pointer text-sm font-medium text-fg-muted">
              Workflow templates
            </summary>

            <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
              {visible
                .filter((row) => row.kind === "pack")
                .map((row) => (
                  <button
                    type="button"
                    key={row.id}
                    data-workflow-template={row.id}
                    className="min-w-0 rounded-lg px-2 py-3 text-left hover:bg-surface-2"
                    onClick={(event) => open(row, event.currentTarget)}
                  >
                    <span className="flex items-center justify-between gap-2 text-sm font-medium">
                      {row.name}
                      <span className="text-xs font-normal text-fg-muted">{row.chip.label}</span>
                    </span>
                    <span className="mt-1 block line-clamp-2 text-xs leading-5 text-fg-muted">
                      {row.description}
                    </span>
                  </button>
                ))}
            </div>
            <Button
              className="mt-3"
              variant="ghost"
              size="sm"
              disabled={!canManage}
              onClick={() => setManifestOpen(true)}
            >
              <PlusIcon />
              Add workflow template
            </Button>
          </details>
        </div>
      ) : section === "all" ? (
        <PluginDiscovery
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

      {openPack ? (
        <PackDetailDialog
          key={openPack.id}
          open
          pack={openPack}
          installation={packs.installationFor(openPack.id)}
          variableSets={variableSets}
          rigs={rigs}
          busy={busyPackId === openPack.id}
          restoreFocusRef={openerRef}
          onOpenChange={(next) => {
            if (!next) setOpenPackId(null);
          }}
          onPreviewInstall={(selection) => onPreviewPackInstall(openPack, selection)}
          onInstall={(preview, selection, idempotencyKey) =>
            onInstallPack(openPack, preview, selection, idempotencyKey)
          }
          onPreviewUninstall={() => onPreviewPackUninstall(openPack)}
          onUninstall={(preview, idempotencyKey) =>
            onUninstallPack(openPack, preview, idempotencyKey)
          }
          onUnregister={() => onUnregisterPack(openPack)}
          onStartSession={onStartPackSession}
        />
      ) : null}

      <PackManifestDialog
        open={manifestOpen}
        restoreFocusRef={openerRef}
        onOpenChange={setManifestOpen}
        onRegister={onRegisterPack}
      />

      {source.dialogs}
    </section>
  );
}

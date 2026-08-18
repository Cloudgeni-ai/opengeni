/**
 * Bundles: one section, one uniform row, for every Skill, Plugin, and Pack.
 *
 * A Bundle is a named collection of tools and instructions, not a live
 * connection to anything, so it does not belong in the Connectors
 * Enabled/Browse grid. All three kinds share the same `IntegrationRow` the
 * Integrations list uses and the same bundle-scoped search, so the list can be
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
import { PackagePlusIcon, PlusIcon, PuzzleIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { OpenGeniCoreClient } from "@opengeni/sdk/core";

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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  CapabilityCatalogItem,
  CapabilityPack,
  ConnectionMetadata,
  PackInstallationPreview,
  PackUninstallPreview,
} from "@/types";

export type PackSelectionInput = { rigId?: string; variableSetId?: string };

export function BundlesSection({
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
  onChanged,
}: {
  client: OpenGeniCoreClient;
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
  onChanged: () => void | Promise<void>;
}) {
  const source = useSourcePackages({
    client,
    workspaceId,
    connections,
    canManage,
    onChanged,
  });
  const [query, setQuery] = useState("");
  const [openSheetId, setOpenSheetId] = useState<string | null>(null);
  const [openPackId, setOpenPackId] = useState<string | null>(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  // Captured synchronously when a row opens something, so closing returns focus
  // to that exact row instead of dropping it on the body.
  const openerRef = useRef<HTMLElement | null>(null);

  const catalogSkills = useMemo(
    () => items.filter((item) => item.kind === "skill" && !isWorkspaceImportedSkill(item)),
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

  const visible = useMemo(() => filterBundleRows(rows, query), [rows, query]);
  // Resolved from the whole list, not the filtered one: narrowing the search
  // while a sheet is open must not yank the sheet closed.
  const openSheetModel =
    rows.find((row) => row.detail.kind === "sheet" && row.id === openSheetId)?.detail ?? null;
  const openPack = packs.packs.find((pack) => pack.id === openPackId) ?? null;
  const loading = source.loading || packs.loading;
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
    openerRef.current = element instanceof HTMLElement ? element : null;
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
    <section className="mt-10 space-y-3" aria-labelledby="bundles-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Skills, plugins &amp; packs
          </p>
          <h2 id="bundles-heading" className="mt-1 text-base font-semibold text-fg">
            Bundles
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
            A named collection of tools and instructions, not a live connection to anything. Install
            one and everything inside it becomes available together.
          </p>
          {!canManage ? (
            <p className="mt-1 text-2xs leading-4 text-fg-subtle">
              Workspace administrators can install, update, and remove Bundles.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canManage}
            onClick={source.importSkill}
          >
            <SparklesIcon />
            Import Skill
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canManage}
            onClick={source.installPlugin}
          >
            <PuzzleIcon />
            Install Plugin
          </Button>
          <Button type="button" size="sm" onClick={() => setManifestOpen(true)}>
            <PlusIcon />
            Add manifest
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search installed skills, plugins, and packs"
            className="h-10 rounded-xl pl-9 transition-none"
            aria-label="Search bundles"
          />
        </div>
        <span className="shrink-0 text-xs text-fg-muted" data-bundle-count>
          {visible.length} of {rows.length}
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
              model={row}
              busy={row.busy}
              onOpen={() => open(row, document.activeElement)}
            />
          ))}
        </div>
      ) : loading ? (
        <div className="grid gap-2" aria-label="Loading bundles" aria-busy="true">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : (
        <EmptyState
          icon={<PackagePlusIcon />}
          title={searching ? "No bundles match" : "No bundles yet"}
          description={
            searching
              ? "Try another search, or install a Skill, Plugin, or Pack."
              : "Import a reviewed Skill, install a Plugin bill of materials, or register a Pack manifest."
          }
        />
      )}

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
        />
      ) : null}

      <PackManifestDialog
        open={manifestOpen}
        busy={busyPackId !== null}
        onOpenChange={setManifestOpen}
        onRegister={onRegisterPack}
      />

      {source.dialogs}
    </section>
  );
}

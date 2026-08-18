// Packs compose pinned Plugins, Skills, Integrations, Facet bindings, and an
// explicit Rig requirement. Every mutation is review-fenced: the UI shows the
// exact component/Rig plan before install and the shared-owner outcome before
// uninstall. Legacy inline Skills and sandboxImage fields are disclosed as
// migrations into ordinary Skill and Rig ownership rather than hidden runtime
// overrides.
import type { usePacks } from "@opengeni/react";
import {
  BoxesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  Loader2Icon,
  PackageCheckIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  Share2Icon,
  SparkleIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listViewState } from "@/lib/load-state";
import { scheduleLabel } from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type {
  CapabilityPack,
  PackComponentResolution,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
} from "@/types";

type PackSelection = { rigId?: string; variableSetId?: string };
type RigOption = {
  id: string;
  name: string;
  image: string | null;
  available: boolean;
  verified: boolean;
};

export function PacksSection(props: {
  packs: ReturnType<typeof usePacks>;
  variableSets: Array<{ id: string; name: string }>;
  rigs: RigOption[];
  busyPackId: string | null;
  onRegister: (manifestDraft: string) => Promise<boolean>;
  onPreviewInstall: (
    pack: CapabilityPack,
    selection: PackSelection,
  ) => Promise<PackInstallationPreview | null>;
  onInstall: (
    pack: CapabilityPack,
    preview: PackInstallationPreview,
    selection: PackSelection,
    idempotencyKey: string,
  ) => Promise<boolean>;
  onPreviewUninstall: (pack: CapabilityPack) => Promise<PackUninstallPreview | null>;
  onUninstall: (
    pack: CapabilityPack,
    preview: PackUninstallPreview,
    idempotencyKey: string,
  ) => Promise<boolean>;
  onUnregister: (pack: CapabilityPack) => Promise<boolean>;
}) {
  const { packs } = props;
  const [registerOpen, setRegisterOpen] = useState(false);
  const [manifestDraft, setManifestDraft] = useState("");
  const [registering, setRegistering] = useState(false);
  const packsView = listViewState({
    loading: packs.loading,
    error: packs.error,
    count: packs.packs.length,
  });

  async function register() {
    if (registering) return;
    setRegistering(true);
    try {
      const registered = await props.onRegister(manifestDraft);
      if (registered) {
        setRegisterOpen(false);
        setManifestDraft("");
      }
    } finally {
      setRegistering(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">Packs</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
            Solution bundles that add Skills, Integrations, and templates as one reviewed plan.
            Install multiple Packs safely; shared components stay active until their final owner is
            removed.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRegisterOpen((open) => !open)}
        >
          <PlusIcon />
          Add manifest
        </Button>
      </div>

      {registerOpen ? (
        <div className="grid gap-2 rounded-xl border border-border bg-surface/50 p-4">
          <p className="text-xs leading-5 text-fg-subtle">
            Paste a Pack manifest as JSON. Registration does not install anything; you review its
            additions and any account, compute, or configuration requirements in the next step.
          </p>
          <textarea
            value={manifestDraft}
            onChange={(event) => setManifestDraft(event.target.value)}
            placeholder='{"id": "my-pack", "name": "My pack", "version": "1.0.0", "components": […]}'
            className="min-h-40 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            aria-label="Pack manifest JSON"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setRegisterOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={registering || !manifestDraft.trim()}
              onClick={() => void register()}
            >
              {registering ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Register Pack
            </Button>
          </div>
        </div>
      ) : null}

      {packsView === "loading" ? (
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      ) : packsView === "error" ? (
        <LoadErrorState
          title="Couldn't load Packs"
          error={packs.error}
          onRetry={() => void packs.refresh()}
        />
      ) : packsView === "empty" ? (
        <EmptyState
          icon={<PackageIcon className="size-4" />}
          title="No Packs yet"
          description="Register a Pack manifest, review its pinned dependencies, and install it into this workspace."
          action={
            <Button type="button" size="sm" onClick={() => setRegisterOpen(true)}>
              <PlusIcon />
              Add manifest
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {packs.packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              installation={packs.installationFor(pack.id)}
              variableSets={props.variableSets}
              rigs={props.rigs}
              busy={props.busyPackId === pack.id}
              onPreviewInstall={(selection) => props.onPreviewInstall(pack, selection)}
              onInstall={(preview, selection, idempotencyKey) =>
                props.onInstall(pack, preview, selection, idempotencyKey)
              }
              onPreviewUninstall={() => props.onPreviewUninstall(pack)}
              onUninstall={(preview, idempotencyKey) =>
                props.onUninstall(pack, preview, idempotencyKey)
              }
              onUnregister={() => props.onUnregister(pack)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PackCard(props: {
  pack: CapabilityPack;
  installation: PackInstallation | null;
  variableSets: Array<{ id: string; name: string }>;
  rigs: RigOption[];
  busy: boolean;
  onPreviewInstall: (selection: PackSelection) => Promise<PackInstallationPreview | null>;
  onInstall: (
    preview: PackInstallationPreview,
    selection: PackSelection,
    idempotencyKey: string,
  ) => Promise<boolean>;
  onPreviewUninstall: () => Promise<PackUninstallPreview | null>;
  onUninstall: (preview: PackUninstallPreview, idempotencyKey: string) => Promise<boolean>;
  onUnregister: () => Promise<boolean>;
}) {
  const { pack, installation } = props;
  const installed = Boolean(installation && installation.status !== "disabled");
  const [expanded, setExpanded] = useState(false);
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [selection, setSelection] = useState<PackSelection>(() =>
    initialPackSelection(pack, installation),
  );
  const [preview, setPreview] = useState<PackInstallationPreview | null>(null);
  const [reviewedSelectionKey, setReviewedSelectionKey] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const [installOperationId, setInstallOperationId] = useState(newOperationId);
  const reviewRevision = useRef(0);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallPreview, setUninstallPreview] = useState<PackUninstallPreview | null>(null);
  const [uninstallLoading, setUninstallLoading] = useState(false);
  const [uninstallOperationId, setUninstallOperationId] = useState(newOperationId);

  async function reviewInstallation(nextSelection: PackSelection) {
    const revision = ++reviewRevision.current;
    setReviewing(true);
    setReviewFailed(false);
    try {
      const result = await props.onPreviewInstall(nextSelection);
      if (revision !== reviewRevision.current) return;
      setPreview(result);
      setReviewedSelectionKey(result ? selectionKey(nextSelection) : null);
      setReviewFailed(result === null);
    } finally {
      if (revision === reviewRevision.current) setReviewing(false);
    }
  }

  async function openInstall() {
    const nextSelection = initialPackSelection(pack, installation);
    setSelection(nextSelection);
    setPreview(null);
    setReviewedSelectionKey(null);
    setReviewFailed(false);
    setInstallOperationId(newOperationId());
    setInstallOpen(true);
    await reviewInstallation(nextSelection);
  }

  function updateSelection(nextSelection: PackSelection) {
    reviewRevision.current += 1;
    setSelection(nextSelection);
    setReviewedSelectionKey(null);
    setReviewFailed(false);
    setReviewing(false);
    setInstallOperationId(newOperationId());
  }

  async function installReviewedPack(): Promise<void> {
    if (!preview || reviewedSelectionKey !== selectionKey(selection) || !preview.ready) return;
    const completed = await props.onInstall(preview, selection, installOperationId);
    if (completed) setInstallOpen(false);
  }

  async function openUninstall() {
    setUninstallOpen(true);
    setUninstallPreview(null);
    setUninstallOperationId(newOperationId());
    setUninstallLoading(true);
    try {
      setUninstallPreview(await props.onPreviewUninstall());
    } finally {
      setUninstallLoading(false);
    }
  }

  const status = packInstallationStatus(installation);
  const currentSelectionReviewed = reviewedSelectionKey === selectionKey(selection);
  const installReady = Boolean(preview?.ready && currentSelectionReviewed);
  const installLabel = preview
    ? preview.action === "install"
      ? "Install Pack"
      : preview.action === "update"
        ? "Update Pack"
        : "Repair Pack"
    : "Review plan";

  return (
    <article className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2/70 text-brand">
              <PackageIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-medium">{pack.name}</h3>
                <MetaChip className="font-mono">v{pack.version}</MetaChip>
                {status ? <MetaChip dot={status.tone}>{status.label}</MetaChip> : null}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-fg-subtle">
                <span>{pack.role}</span>
                <span aria-hidden className="text-fg-subtle/50">
                  ·
                </span>
                <span>{pack.category}</span>
                {installation?.manifestDigest ? (
                  <>
                    <span aria-hidden className="text-fg-subtle/50">
                      ·
                    </span>
                    <span className="font-mono">{installation.manifestDigest.slice(0, 10)}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-fg-muted">{pack.description}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pack.components.length > 0 ? (
              <MetaChip>
                <BoxesIcon className="size-3 shrink-0" />
                {pack.components.length} pinned component{pack.components.length === 1 ? "" : "s"}
              </MetaChip>
            ) : null}
            {pack.skills.length > 0 ? (
              <MetaChip>
                <SparkleIcon className="size-3 shrink-0" />
                {pack.skills.length} inline Skill{pack.skills.length === 1 ? "" : "s"}
              </MetaChip>
            ) : null}
            {pack.rig || pack.sandboxImage ? (
              <MetaChip>
                <ServerCogIcon className="size-3 shrink-0" />
                Special compute
              </MetaChip>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
            Contents
          </Button>
          <Button type="button" size="sm" disabled={props.busy} onClick={() => void openInstall()}>
            {props.busy ? (
              <Loader2Icon className="animate-spin" />
            ) : installation?.status === "needs_attention" ? (
              <WrenchIcon />
            ) : installed ? (
              <RefreshCwIcon />
            ) : (
              <PackageCheckIcon />
            )}
            {installation?.status === "needs_attention"
              ? "Repair"
              : installed
                ? "Review"
                : "Review install"}
          </Button>
          {installed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.busy}
              onClick={() => void openUninstall()}
            >
              <Trash2Icon />
              Uninstall
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Unregister ${pack.name}`}
            className="text-fg-subtle hover:text-status-failed"
            disabled={props.busy || installed}
            title={
              installed
                ? "Uninstall this Pack before unregistering its manifest"
                : "Unregister this Pack (built-ins cannot be removed)"
            }
            onClick={() => setConfirmUnregister(true)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>

      {expanded ? <PackContents pack={pack} /> : null}

      <PackInstallationDialog
        open={installOpen}
        pack={pack}
        installation={installation}
        variableSets={props.variableSets}
        rigs={props.rigs}
        selection={selection}
        preview={preview}
        reviewing={reviewing}
        reviewFailed={reviewFailed}
        busy={props.busy}
        selectionReviewed={currentSelectionReviewed}
        installReady={installReady}
        installLabel={installLabel}
        onOpenChange={(open) => {
          // Close on outside click / Escape even mid-review or mid-install; a
          // busy submit disables its own button rather than suppressing close.
          if (!open) setInstallOpen(false);
        }}
        onSelectionChange={updateSelection}
        onReview={() => void reviewInstallation(selection)}
        onInstall={() => void installReviewedPack()}
      />

      <ConfirmDialog
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        title={`Uninstall ${pack.name}?`}
        description="This releases the Pack's ownership. Shared components remain active; components with no other owner are disabled."
        confirmLabel="Uninstall Pack"
        onConfirm={async () => {
          if (!uninstallPreview?.installed || uninstallPreview.installationVersion === null) {
            return false;
          }
          return await props.onUninstall(uninstallPreview, uninstallOperationId);
        }}
      >
        <PackUninstallPlan loading={uninstallLoading} preview={uninstallPreview} />
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmUnregister}
        onOpenChange={setConfirmUnregister}
        title={`Unregister ${pack.name}?`}
        description="This removes the manifest from the workspace. No installed component is changed, and you can register the manifest again later."
        confirmLabel="Unregister Pack"
        onConfirm={props.onUnregister}
      />
    </article>
  );
}

function PackInstallationDialog(props: {
  open: boolean;
  pack: CapabilityPack;
  installation: PackInstallation | null;
  variableSets: Array<{ id: string; name: string }>;
  rigs: RigOption[];
  selection: PackSelection;
  preview: PackInstallationPreview | null;
  reviewing: boolean;
  reviewFailed: boolean;
  busy: boolean;
  selectionReviewed: boolean;
  installReady: boolean;
  installLabel: string;
  onOpenChange: (open: boolean) => void;
  onSelectionChange: (selection: PackSelection) => void;
  onReview: () => void;
  onInstall: () => void;
}) {
  const { pack, preview, selection } = props;
  const showsRig = Boolean(pack.rig || pack.sandboxImage);
  const hardcodedRigId = pack.rig?.rigId;
  const selectedRig = props.rigs.find((rig) => rig.id === selection.rigId);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {preview?.action === "update"
              ? `Update ${pack.name}`
              : preview?.action === "repair"
                ? `Repair ${pack.name}`
                : `Install ${pack.name}`}
          </DialogTitle>
          <DialogDescription>
            Review what this Pack adds and any setup it needs. It never changes workspace defaults
            or stores account credentials.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
          {pack.variableSet || showsRig ? (
            <div className="grid gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:grid-cols-2">
              {pack.variableSet ? (
                <label className="grid gap-1.5 text-xs font-medium text-fg">
                  Configuration &amp; secrets{" "}
                  {pack.variableSet.required ? "· required" : "· optional"}
                  <Select
                    value={selection.variableSetId ?? ""}
                    onChange={(event) =>
                      props.onSelectionChange(
                        compactSelection(selection.rigId, event.target.value || undefined),
                      )
                    }
                  >
                    <option value="">
                      {pack.variableSet.required
                        ? "Choose saved configuration"
                        : "No extra configuration"}
                    </option>
                    {props.variableSets.map((variableSet) => (
                      <option key={variableSet.id} value={variableSet.id}>
                        {variableSet.name}
                      </option>
                    ))}
                  </Select>
                  <span className="font-normal leading-4 text-fg-subtle">
                    {pack.variableSet.description} Stored in an existing encrypted Variable Set.
                  </span>
                </label>
              ) : null}

              {showsRig ? (
                <label className="grid gap-1.5 text-xs font-medium text-fg">
                  Compute environment{" "}
                  {pack.rig?.required !== false || pack.sandboxImage ? "· required" : "· optional"}
                  <Select
                    value={selection.rigId ?? ""}
                    disabled={Boolean(hardcodedRigId)}
                    onChange={(event) =>
                      props.onSelectionChange(
                        compactSelection(event.target.value || undefined, selection.variableSetId),
                      )
                    }
                  >
                    <option value="">Choose compute</option>
                    {hardcodedRigId && !props.rigs.some((rig) => rig.id === hardcodedRigId) ? (
                      <option value={hardcodedRigId}>{hardcodedRigId}</option>
                    ) : null}
                    {props.rigs.map((rig) => (
                      <option key={rig.id} value={rig.id}>
                        {rig.name}
                        {!rig.available ? " · no active version" : ""}
                        {rig.available && !rig.verified ? " · unverified" : ""}
                      </option>
                    ))}
                  </Select>
                  <span className="font-normal leading-4 text-fg-subtle">
                    {selectedRig?.image ??
                      pack.rig?.description ??
                      "Used only by work created from this Pack. Backed by a versioned Rig."}
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {!props.selectionReviewed && preview ? (
            <Notice tone="waiting" title="Selections changed">
              Review the plan again before installing.
            </Notice>
          ) : null}
          {props.reviewFailed ? (
            <Notice tone="failed" title="Plan unavailable">
              The preview request failed. Retry without closing this dialog.
            </Notice>
          ) : null}
          {props.reviewing ? <PackPlanSkeleton /> : null}
          {!props.reviewing && preview ? <PackInstallationPlan preview={preview} /> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={props.reviewing || props.busy}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={props.selectionReviewed ? "outline" : "default"}
            disabled={props.reviewing || props.busy}
            onClick={props.onReview}
          >
            {props.reviewing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            {preview ? "Review again" : "Review plan"}
          </Button>
          <Button
            type="button"
            disabled={!props.installReady || props.reviewing || props.busy}
            onClick={props.onInstall}
          >
            {props.busy ? <Loader2Icon className="animate-spin" /> : <PackageCheckIcon />}
            {props.installLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PackInstallationPlan({ preview }: { preview: PackInstallationPreview }) {
  const readyComponents = preview.components.filter((component) => component.status === "ready");
  return (
    <div className="grid gap-3">
      {preview.blockers.length > 0 ? (
        <Notice tone="failed" title="Resolve before installing">
          <ul className="list-disc space-y-1 pl-4">
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <Notice tone="success" title="Ready to install">
          {readyComponents.length} component{readyComponents.length === 1 ? "" : "s"} and the
          selected workspace attachments match this manifest.
        </Notice>
      )}

      {preview.legacyInlineSkillCount > 0 || preview.legacySandboxImage ? (
        <Notice tone="info" title="Legacy fields will be migrated">
          {preview.legacyInlineSkillCount > 0
            ? `${preview.legacyInlineSkillCount} inline Skill${preview.legacyInlineSkillCount === 1 ? "" : "s"} become ordinary immutable Skill components. `
            : ""}
          {preview.legacySandboxImage
            ? "The previous sandbox image is checked against the selected compute environment; it will not replace workspace defaults."
            : ""}
        </Notice>
      ) : null}

      <section className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="text-xs font-semibold">Pinned components</div>
          <div className="text-2xs text-fg-subtle">{preview.components.length} reviewed</div>
        </div>
        {preview.components.length > 0 ? (
          <div className="divide-y divide-border">
            {preview.components.map((component) => (
              <PackComponentRow key={component.key} component={component} />
            ))}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs text-fg-subtle">
            No component dependency is declared. The Pack still freezes its manifest and
            attachments.
          </div>
        )}
      </section>

      <section className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
        <span className="flex size-8 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
          <ServerCogIcon className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-xs font-medium">
            {preview.rig.name ?? "No special compute required"}
          </div>
          <div className="truncate text-2xs text-fg-subtle">
            {preview.rig.image ?? "Uses the normal compute selected when work starts"}
          </div>
        </div>
        <MetaChip
          dot={
            preview.rig.status === "ready"
              ? "idle"
              : preview.rig.status === "not_required"
                ? "cancelled"
                : "waiting"
          }
        >
          {humanize(preview.rig.status)}
        </MetaChip>
      </section>
    </div>
  );
}

function PackComponentRow({ component }: { component: PackComponentResolution }) {
  const Icon =
    component.status === "ready"
      ? CheckCircle2Icon
      : component.status === "missing"
        ? CircleDashedIcon
        : TriangleAlertIcon;
  const iconClass =
    component.status === "ready"
      ? "text-status-idle"
      : component.status === "missing"
        ? "text-fg-subtle"
        : "text-status-waiting";
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
      <Icon className={cn("size-4", iconClass)} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium">{component.label}</span>
          <MetaChip>{component.kind}</MetaChip>
          {!component.required ? <MetaChip>Optional</MetaChip> : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-2xs text-fg-subtle">
          {component.capabilityId} · {component.expectedDigest.slice(0, 12)}
        </div>
      </div>
      <span className="text-2xs font-medium text-fg-muted">{humanize(component.status)}</span>
    </div>
  );
}

export function PackUninstallPlan({
  loading,
  preview,
}: {
  loading: boolean;
  preview: PackUninstallPreview | null;
}) {
  if (loading) return <PackPlanSkeleton />;
  if (!preview) {
    return (
      <Notice tone="failed" title="Uninstall plan unavailable">
        Close and retry the uninstall preview.
      </Notice>
    );
  }
  if (!preview.installed) {
    return <Notice tone="muted">This Pack is not installed.</Notice>;
  }
  const retained = preview.components.filter((component) => component.retainedByOtherOwners);
  const disabled = preview.components.filter((component) => !component.retainedByOtherOwners);
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Notice
          tone="info"
          title={`${retained.length} shared`}
          icon={<Share2Icon className="size-4" />}
        >
          Retained by another Pack, Plugin, or direct installation.
        </Notice>
        <Notice
          tone={disabled.length > 0 ? "waiting" : "muted"}
          title={`${disabled.length} released`}
        >
          Disabled only when no effective owner remains.
        </Notice>
      </div>
      {preview.components.length > 0 ? (
        <div className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {preview.components.map((component) => (
            <div key={component.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{component.capabilityId}</div>
                <div className="text-2xs text-fg-subtle">
                  {component.kind} · {component.key}
                </div>
              </div>
              <MetaChip dot={component.retainedByOtherOwners ? "idle" : "waiting"}>
                {component.retainedByOtherOwners ? "Retained" : "Released"}
              </MetaChip>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PackPlanSkeleton() {
  return (
    <div
      className="grid gap-3 rounded-lg border border-border p-3"
      aria-label="Reviewing Pack plan"
    >
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Loader2Icon className="size-4 animate-spin" />
        Resolving pinned components and workspace attachments…
      </div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-3/4" />
    </div>
  );
}

function PackContents({ pack }: { pack: CapabilityPack }) {
  return (
    <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2">
      <PackSection title="Pinned components">
        {pack.components.length > 0 ? (
          <div className="grid gap-1.5">
            {pack.components.map((component) => (
              <div key={component.key} className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium">
                    {packComponentCapabilityId(component)}
                  </span>
                  <MetaChip>{component.kind}</MetaChip>
                  {!component.required ? <MetaChip>Optional</MetaChip> : null}
                </div>
                <div className="truncate font-mono text-2xs text-fg-subtle">{component.key}</div>
              </div>
            ))}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      <PackSection title="Tools">
        {pack.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {pack.tools.map((tool) => (
              <MetaChip key={`${tool.kind}:${tool.id}`} className="font-mono">
                {tool.id}
              </MetaChip>
            ))}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      <PackSection title="Legacy inline Skills">
        {pack.skills.length > 0 ? (
          <div className="grid gap-1.5">
            {pack.skills.map((skill) => (
              <div key={skill.name} className="min-w-0">
                <div className="truncate text-xs font-medium">{skill.name}</div>
                <div className="text-2xs text-fg-subtle">
                  Migrates to an immutable Skill · {skill.files.length} file
                  {skill.files.length === 1 ? "" : "s"}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      <PackSection title="Compute requirement">
        {pack.rig || pack.sandboxImage ? (
          <div className="grid gap-1 text-2xs text-fg-subtle">
            <div className="text-xs font-medium text-fg">
              {pack.rig?.rigId ? "Preselected compute environment" : "Compatible compute required"}
            </div>
            {pack.rig?.description ? <div>{pack.rig.description}</div> : null}
            {pack.rig?.rigId ? <div className="font-mono">Rig {pack.rig.rigId}</div> : null}
            {pack.sandboxImage ? (
              <div className="truncate font-mono" title={pack.sandboxImage}>
                Must match {pack.sandboxImage}
              </div>
            ) : null}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      <PackSection title="Connectors">
        {pack.connectors.length > 0 ? (
          <div className="grid gap-1.5">
            {pack.connectors.map((connector) => (
              <div key={connector.id} className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{connector.name}</span>
                  {connector.required ? <MetaChip dot="waiting">Required</MetaChip> : null}
                </div>
                <div className="text-2xs text-fg-subtle">
                  {[
                    connector.authModel,
                    connector.providers.join(", "),
                    connector.scopes.length ? `${connector.scopes.length} scopes` : null,
                  ]
                    .filter(Boolean)
                    .join(" / ")}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      <PackSection title="Knowledge">
        {pack.knowledge.length > 0 ? (
          <div className="grid gap-1.5">
            {pack.knowledge.map((knowledge) => (
              <div key={knowledge.id} className="min-w-0">
                <div className="truncate text-xs font-medium">{knowledge.name}</div>
                {knowledge.description ? (
                  <div className="line-clamp-2 text-2xs text-fg-subtle">
                    {knowledge.description}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      <PackSection title="Schedule templates">
        {pack.scheduledTaskTemplates.length > 0 ? (
          <div className="grid gap-1.5">
            {pack.scheduledTaskTemplates.map((template) => (
              <div key={template.id} className="min-w-0">
                <div className="truncate text-xs font-medium">{template.name}</div>
                <div className="text-2xs text-fg-subtle">
                  {scheduleLabel(template.defaultSchedule)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <PackNone />
        )}
      </PackSection>

      {pack.variableSet ? (
        <PackSection title="Configuration requirements">
          <div className="text-2xs text-fg-subtle">
            {pack.variableSet.description} Values come from an encrypted Variable Set selected
            during installation.
          </div>
          {pack.variableSet.requiredVariables.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pack.variableSet.requiredVariables.map((name) => (
                <MetaChip key={name} className="font-mono">
                  {name}
                </MetaChip>
              ))}
            </div>
          ) : null}
        </PackSection>
      ) : null}
    </div>
  );
}

function initialPackSelection(
  pack: CapabilityPack,
  installation: PackInstallation | null,
): PackSelection {
  const storedVariableSetId =
    typeof installation?.metadata.variableSetId === "string"
      ? installation.metadata.variableSetId
      : typeof installation?.metadata.environmentId === "string"
        ? installation.metadata.environmentId
        : undefined;
  return compactSelection(
    pack.rig?.rigId ?? installation?.selectedRigId ?? undefined,
    storedVariableSetId,
  );
}

function compactSelection(rigId?: string, variableSetId?: string): PackSelection {
  return {
    ...(rigId ? { rigId } : {}),
    ...(variableSetId ? { variableSetId } : {}),
  };
}

function selectionKey(selection: PackSelection): string {
  return `${selection.rigId ?? ""}\u0000${selection.variableSetId ?? ""}`;
}

function newOperationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function packInstallationStatus(
  installation: PackInstallation | null,
): { label: string; tone: "idle" | "running" | "waiting" | "cancelled" } | null {
  if (!installation || installation.status === "disabled") return null;
  if (installation.status === "active") return { label: "Installed", tone: "idle" };
  if (installation.status === "installing") return { label: "Installing", tone: "running" };
  return { label: "Needs attention", tone: "waiting" };
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

function packComponentCapabilityId(component: CapabilityPack["components"][number]): string {
  return component.kind === "plugin" ? `plugin:${component.pluginKey}` : component.capabilityId;
}

function PackSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
        {title}
      </div>
      {children}
    </section>
  );
}

function PackNone() {
  return <div className="text-2xs text-fg-subtle">None declared</div>;
}

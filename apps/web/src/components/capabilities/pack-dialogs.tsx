// Packs compose pinned Plugins, Skills, Integrations, Facet bindings, and an
// explicit Rig requirement. Every mutation is review-fenced: the UI shows the
// exact component/Rig plan before install and the shared-owner outcome before
// uninstall. Legacy inline Skills and sandboxImage fields are disclosed as
// migrations into ordinary Skill and Rig ownership rather than hidden runtime
// overrides.
//
// A Pack is a Bundle, so it lists through the same uniform row as every Skill
// and Plugin (see `bundles-section.tsx`). Only its detail differs: installing
// one means choosing a Rig and a Variable Set and reviewing an exact component
// plan, which does not compress into the four-block Integration sheet, so a
// Pack row opens `PackDetailDialog` instead.
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  Loader2Icon,
  PackageCheckIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  Share2Icon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

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
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { scheduleLabel } from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type {
  CapabilityPack,
  PackComponentResolution,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
} from "@/types";

export type PackSelection = { rigId?: string; variableSetId?: string };
export type RigOption = {
  id: string;
  name: string;
  image: string | null;
  available: boolean;
  verified: boolean;
};

/**
 * Register a Pack manifest. Any workspace admin may publish their own manifest
 * here, so this is a first-class entry point rather than an OpenGeni-only one.
 * Registration installs nothing: the additions and any account, compute, or
 * configuration requirements are reviewed in the Pack's own detail dialog.
 */
export function PackManifestDialog({
  open,
  onOpenChange,
  onRegister,
  restoreFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegister: (manifestDraft: string) => Promise<boolean>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [manifestDraft, setManifestDraft] = useState("");
  const [registering, setRegistering] = useState(false);

  async function register() {
    if (registering) return;
    setRegistering(true);
    try {
      const registered = await onRegister(manifestDraft);
      if (registered) {
        setManifestDraft("");
        onOpenChange(false);
      }
    } finally {
      setRegistering(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onCloseAutoFocus={(event) => restoreOpenerFocus(event, restoreFocusRef)}
      >
        <DialogHeader>
          <DialogTitle>Add a Pack manifest</DialogTitle>
          <DialogDescription>
            Paste a Pack manifest as JSON. Registration does not install anything; you review its
            additions and any account, compute, or configuration requirements in the next step.
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={manifestDraft}
          onChange={(event) => setManifestDraft(event.target.value)}
          placeholder={
            '{"id": "my-pack", "name": "My pack", "version": "1.0.0", "components": […]}'
          }
          className="min-h-40 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          aria-label="Pack manifest JSON"
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            // Only this dialog's own submit gates it. Another Pack installing
            // elsewhere in the section says nothing about registering a manifest.
            disabled={registering || !manifestDraft.trim()}
            onClick={() => void register()}
          >
            {registering ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
            Register Pack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One Pack's whole detail flow: Rig and Variable Set selection, the reviewed
 * component plan, its contents, and the install/update/repair, uninstall, and
 * unregister actions. Mounted only for the Pack whose row is open.
 */
export function PackDetailDialog(props: {
  open: boolean;
  pack: CapabilityPack;
  installation: PackInstallation | null;
  variableSets: Array<{ id: string; name: string }>;
  rigs: RigOption[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onPreviewInstall: (selection: PackSelection) => Promise<PackInstallationPreview | null>;
  onInstall: (
    preview: PackInstallationPreview,
    selection: PackSelection,
    idempotencyKey: string,
  ) => Promise<boolean>;
  onPreviewUninstall: () => Promise<PackUninstallPreview | null>;
  onUninstall: (preview: PackUninstallPreview, idempotencyKey: string) => Promise<boolean>;
  onUnregister: () => Promise<boolean>;
  onStartSession: (skillCapabilityId: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { pack, installation } = props;
  const installed = Boolean(installation && installation.status !== "disabled");
  const [confirmUnregister, setConfirmUnregister] = useState(false);
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
  const previewInstall = props.onPreviewInstall;
  const openedFor = useRef<string | null>(null);

  async function reviewInstallation(nextSelection: PackSelection) {
    const revision = ++reviewRevision.current;
    setReviewing(true);
    setReviewFailed(false);
    try {
      const result = await previewInstall(nextSelection);
      if (revision !== reviewRevision.current) return;
      setPreview(result);
      setReviewedSelectionKey(result ? selectionKey(nextSelection) : null);
      setReviewFailed(result === null);
    } finally {
      if (revision === reviewRevision.current) setReviewing(false);
    }
  }

  // Opening the row is the review request: the reader asked to see the plan,
  // not to press a second button for it.
  useEffect(() => {
    if (!props.open) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === pack.id) return;
    openedFor.current = pack.id;
    const nextSelection = initialPackSelection(pack, installation);
    setSelection(nextSelection);
    setPreview(null);
    setReviewedSelectionKey(null);
    setReviewFailed(false);
    setInstallOperationId(newOperationId());
    void reviewInstallation(nextSelection);
    // Re-running on selection/preview state would loop; the pack identity and
    // open state are the only inputs that may start a fresh review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, pack.id]);

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
    if (completed) props.onOpenChange(false);
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
    <>
      <PackInstallationDialog
        open={props.open}
        pack={pack}
        installation={installation}
        variableSets={props.variableSets}
        rigs={props.rigs}
        selection={selection}
        preview={preview}
        reviewing={reviewing}
        reviewFailed={reviewFailed}
        busy={props.busy}
        installed={installed}
        selectionReviewed={currentSelectionReviewed}
        installReady={installReady}
        installLabel={installLabel}
        {...(props.restoreFocusRef ? { restoreFocusRef: props.restoreFocusRef } : {})}
        onOpenChange={(open) => {
          // Close on outside click / Escape even mid-review or mid-install; a
          // busy submit disables its own button rather than suppressing close.
          if (!open) props.onOpenChange(false);
        }}
        onSelectionChange={updateSelection}
        onReview={() => void reviewInstallation(selection)}
        onInstall={() => void installReviewedPack()}
        onUninstall={() => void openUninstall()}
        onUnregister={() => setConfirmUnregister(true)}
        onStartSession={props.onStartSession}
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
    </>
  );
}

/**
 * Return focus to the element that opened a dialog. The dialogs here are
 * controlled and have no Radix trigger, so without this the closing focus scope
 * has nothing to return to and focus falls to the body.
 */
function restoreOpenerFocus(event: Event, restoreFocusRef?: RefObject<HTMLElement | null>): void {
  const opener = restoreFocusRef?.current ?? null;
  if (restoreFocusRef) restoreFocusRef.current = null;
  if (!opener?.isConnected) return;
  event.preventDefault();
  opener.focus();
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
  installed: boolean;
  selectionReviewed: boolean;
  installReady: boolean;
  installLabel: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onSelectionChange: (selection: PackSelection) => void;
  onReview: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onUnregister: () => void;
  onStartSession: (skillCapabilityId: string) => void;
}) {
  const { pack, preview, selection } = props;
  const showsRig = Boolean(pack.rig || pack.sandboxImage);
  const hardcodedRigId = pack.rig?.rigId;
  const selectedRig = props.rigs.find((rig) => rig.id === selection.rigId);
  const [contentsOpen, setContentsOpen] = useState(false);
  const sessionSelectedSkillNames = new Set(
    pack.skills
      .filter((skill) => skill.activationMode === "session_selected")
      .map((skill) => skill.name.toLowerCase()),
  );
  const sessionSelectedSkillIds = (preview?.components ?? [])
    .filter(
      (component) =>
        component.kind === "inline_skill" &&
        component.status === "ready" &&
        sessionSelectedSkillNames.has(component.label.toLowerCase()),
    )
    .map((component) => component.capabilityId);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        data-pack-dialog={pack.id}
        onCloseAutoFocus={(event) => restoreOpenerFocus(event, props.restoreFocusRef)}
      >
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

        <PackIdentity pack={pack} installation={props.installation} />

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

          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={contentsOpen}
              onClick={() => setContentsOpen((open) => !open)}
            >
              <ChevronDownIcon
                className={cn("transition-transform", contentsOpen && "rotate-180")}
              />
              Contents
            </Button>
            {contentsOpen ? <PackContents pack={pack} /> : null}
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <PackDetailActions
            busy={props.busy}
            installed={props.installed}
            reviewing={props.reviewing}
            reviewed={props.selectionReviewed}
            hasPreview={preview !== null}
            installReady={props.installReady}
            installLabel={props.installLabel}
            canStartSession={props.installed && sessionSelectedSkillIds.length === 1}
            onCancel={() => props.onOpenChange(false)}
            onReview={props.onReview}
            onInstall={props.onInstall}
            onUninstall={props.onUninstall}
            onUnregister={props.onUnregister}
            onStartSession={() => props.onStartSession(sessionSelectedSkillIds[0]!)}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The installed identity a repair or a two-version comparison actually turns
 * on: which manifest version this row is, what role and category it claims,
 * which digest is installed right now, and the Pack's own description in full.
 * Rendered as its own strip because the dialog title only ever carries a name.
 */
export function PackIdentity({
  pack,
  installation,
}: {
  pack: CapabilityPack;
  installation: PackInstallation | null;
}) {
  return (
    <div data-pack-identity={pack.id} className="grid gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-fg-subtle">
        <MetaChip className="font-mono">v{pack.version}</MetaChip>
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
            <span className="font-mono" title={installation.manifestDigest}>
              {installation.manifestDigest.slice(0, 12)}
            </span>
          </>
        ) : null}
      </div>
      {pack.description.trim() ? (
        <p className="line-clamp-2 text-xs leading-5 text-fg-muted">{pack.description}</p>
      ) : null}
    </div>
  );
}

/**
 * The Pack dialog's footer. Extracted from the dialog frame so the two
 * destructive, ownership-releasing verbs - Uninstall and Unregister - are unit
 * testable: Radix portals the dialog itself out of reach of the DOM shim, but
 * the buttons that fire the callbacks do not have to live in there.
 */
export function PackDetailActions(props: {
  busy: boolean;
  installed: boolean;
  reviewing: boolean;
  /** True while the reviewed plan still describes the current selections. */
  reviewed: boolean;
  hasPreview: boolean;
  installReady: boolean;
  installLabel: string;
  canStartSession?: boolean;
  onCancel: () => void;
  onReview: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onUnregister: () => void;
  onStartSession?: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {props.installed ? (
          <>
            {props.canStartSession ? (
              <Button
                type="button"
                variant="outline"
                disabled={props.busy}
                onClick={props.onStartSession}
              >
                <SparklesIcon />
                Start with Pack
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={props.busy}
              onClick={props.onUninstall}
            >
              <Trash2Icon />
              Uninstall
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="text-fg-subtle hover:text-status-failed"
          disabled={props.busy || props.installed}
          title={
            props.installed
              ? "Uninstall this Pack before unregistering its manifest"
              : "Unregister this Pack (built-ins cannot be removed)"
          }
          onClick={props.onUnregister}
        >
          Unregister
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          disabled={props.reviewing || props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={props.reviewed ? "outline" : "default"}
          disabled={props.reviewing || props.busy}
          onClick={props.onReview}
        >
          {props.reviewing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          {props.hasPreview ? "Review again" : "Review plan"}
        </Button>
        <Button
          type="button"
          disabled={!props.installReady || props.reviewing || props.busy}
          onClick={props.onInstall}
        >
          {props.busy ? <Loader2Icon className="animate-spin" /> : <PackageCheckIcon />}
          {props.installLabel}
        </Button>
      </div>
    </>
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
        <Notice tone="info" title="Installation details">
          {preview.legacyInlineSkillCount > 0
            ? `${preview.legacyInlineSkillCount} Pack Skill${preview.legacyInlineSkillCount === 1 ? "" : "s"} become ordinary immutable Skill components. `
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

export function PackContents({ pack }: { pack: CapabilityPack }) {
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

      <PackSection title="Skills">
        {pack.skills.length > 0 ? (
          <div className="grid gap-1.5">
            {pack.skills.map((skill) => (
              <div key={skill.name} className="min-w-0">
                <div className="truncate text-xs font-medium">{skill.name}</div>
                <div className="text-2xs text-fg-subtle">
                  {skill.activationMode === "session_selected"
                    ? "Installed, then selected per session"
                    : "Installs as an immutable Skill"}{" "}
                  · {skill.files.length} included file
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

      <PackSection title="Event automations">
        {(pack.automationTemplates?.length ?? 0) > 0 ? (
          <div className="grid gap-1.5">
            {pack.automationTemplates?.map((template) => (
              <div key={template.id} className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{template.name}</span>
                  {template.connectionRequirement ? (
                    <MetaChip dot="waiting">Setup required</MetaChip>
                  ) : null}
                </div>
                <div className="line-clamp-2 text-2xs text-fg-subtle">{template.description}</div>
                <div className="truncate font-mono text-2xs text-fg-subtle">
                  {template.eventTypes.join(", ")}
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

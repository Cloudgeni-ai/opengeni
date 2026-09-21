/**
 * The two dialogs the immutable-source flows need: the URL-paste -> preview ->
 * review -> install stepper, and the version-fenced removal confirmation with
 * its exact shared-ownership impact. Lazily loaded, because neither is needed
 * until an admin actually starts one of those flows.
 */
import { ShieldCheckIcon } from "lucide-react";
import type { RefObject } from "react";
import { PluginRemovalImpact } from "./plugin-removal-impact";

import { SourceImportDialog } from "@/components/capabilities/source-import-dialog";
import type { SourceImportState } from "@/components/capabilities/source-import-flow";
import type { SourceRemoveTarget } from "@/components/capabilities/use-source-packages";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ConnectionMetadata } from "@/types";

export function SourcePackageDialogs({
  sourceImport,
  connections,
  canManage,
  removeTarget,
  onSourceImportOpenChange,
  onKindChange,
  onUrlChange,
  onPreview,
  onBindingChange,
  onInstall,
  onBack,
  onRemoveClose,
  onRemoveConfirm,
  removeNotice,
  restoreFocusRef,
  restoreFocusFallbackRef,
}: {
  sourceImport: SourceImportState;
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  removeTarget: SourceRemoveTarget | null;
  onSourceImportOpenChange: (open: boolean) => void;
  onKindChange: (kind: SourceImportState["kind"]) => void;
  onUrlChange: (url: string) => void;
  onPreview: () => void;
  onBindingChange: (componentKey: string, connectionId: string) => void;
  onInstall: () => void;
  onBack: () => void;
  onRemoveClose: () => void;
  onRemoveConfirm: () => Promise<boolean>;
  removeNotice?: string | null;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <>
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
        confirmLabel={removeTarget?.kind === "skill" ? "Remove direct Skill" : "Remove plugin"}
        confirmDisabled={
          removeTarget?.kind === "plugin" &&
          removeTarget.preview.components.some((component) =>
            component.retentionReasons.includes("registry_unavailable"),
          )
        }
        pendingLabel="Removing…"
        restoreFocusRef={restoreFocusRef}
        restoreFocusFallbackRef={restoreFocusFallbackRef}
        cancelAutoFocus
        onConfirm={onRemoveConfirm}
      >
        <RemoveImpact target={removeTarget} />
        {removeNotice ? (
          <p role="alert" className="text-sm leading-5 text-fg-muted">
            {removeNotice}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
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
  return <PluginRemovalImpact preview={target.preview} />;
}

function removeDialogTitle(target: SourceRemoveTarget | null): string {
  if (!target) return "Remove source package?";
  return target.kind === "skill"
    ? `Remove direct Skill “${target.skill.name}”?`
    : `Remove ${target.plugin.name}?`;
}

function removeDialogDescription(target: SourceRemoveTarget | null): string {
  if (!target) return "Review the exact ownership impact before removal.";
  return target.kind === "skill"
    ? "This removes only the direct workspace owner. Shared ownership is retained and no Connection is deleted."
    : "Remove this plugin from your workspace.";
}

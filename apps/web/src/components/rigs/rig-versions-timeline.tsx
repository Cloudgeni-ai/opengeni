// The rig's version history: append-only, newest-first, exactly one active.
// Rollback = activate an older version (mints nothing). Each row expands to the
// immutable content that version pinned.
import { ChevronDownIcon, HistoryIcon, Loader2Icon, RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MetaChip } from "@/components/ui/meta-chip";
import { StatusDot } from "@/components/ui/status-dot";
import { formatTimestamp } from "@/lib/format";
import { rigActorLabel, type DeferredRigVerificationView } from "@/lib/rig-status";
import { withOccurrenceKeys } from "@/lib/react-key";
import { cn } from "@/lib/utils";
import type { RigVersion } from "@/types";

export function RigVersionsTimeline({
  versions,
  activeVersionId,
  variableSetName,
  canManage,
  mutating,
  deferredVerification,
  onRecoverDeferred,
  onActivate,
}: {
  versions: RigVersion[];
  activeVersionId: string | null;
  variableSetName: (id: string) => string;
  canManage: boolean;
  mutating: boolean;
  deferredVerification: DeferredRigVerificationView;
  onRecoverDeferred: () => Promise<unknown>;
  onActivate: (versionId: string) => Promise<unknown>;
}) {
  const [confirmVersion, setConfirmVersion] = useState<RigVersion | null>(null);
  if (versions.length === 0) {
    return (
      <EmptyState
        icon={<HistoryIcon className="size-4" />}
        title="No versions yet"
        description="Every promoted change mints a new immutable version here."
      />
    );
  }
  const ordered = [...versions].sort((a, b) => b.version - a.version);

  return (
    <>
      <ol className="relative grid gap-2.5">
        {ordered.map((version) => (
          <VersionRow
            key={version.id}
            version={version}
            isActive={version.id === activeVersionId}
            variableSetName={variableSetName}
            canManage={canManage}
            mutating={mutating}
            canRecover={
              deferredVerification.state === "available" &&
              deferredVerification.versionId === version.id
            }
            recoveryAmbiguous={
              deferredVerification.state === "ambiguous" && version.verificationStatus === "pending"
            }
            onRecoverDeferred={onRecoverDeferred}
            onRequestActivate={() => setConfirmVersion(version)}
          />
        ))}
      </ol>

      <ConfirmDialog
        open={confirmVersion !== null}
        onOpenChange={(next) => setConfirmVersion(next ? confirmVersion : null)}
        title={confirmVersion ? `Make version ${confirmVersion.version} active?` : ""}
        description="New sessions will materialize this version. In-flight sessions keep the version they started on. Nothing is deleted — you can roll forward again anytime."
        confirmLabel="Activate version"
        destructive={false}
        onConfirm={async () => {
          const version = confirmVersion;
          if (!version) {
            return false;
          }
          const result = await onActivate(version.id);
          if (result) {
            toast.success(`Version ${version.version} is now active`);
          }
          return Boolean(result);
        }}
      />
    </>
  );
}

function VersionRow({
  version,
  isActive,
  variableSetName,
  canManage,
  mutating,
  canRecover,
  recoveryAmbiguous,
  onRecoverDeferred,
  onRequestActivate,
}: {
  version: RigVersion;
  isActive: boolean;
  variableSetName: (id: string) => string;
  canManage: boolean;
  mutating: boolean;
  canRecover: boolean;
  recoveryAmbiguous: boolean;
  onRecoverDeferred: () => Promise<unknown>;
  onRequestActivate: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className={cn(
        "rounded-lg border bg-surface/45",
        isActive ? "border-brand/40" : "border-border",
      )}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-1 shrink-0">
          <StatusDot tone={isActive ? "idle" : "cancelled"} />
        </span>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Version {version.version}</span>
            {isActive ? (
              <MetaChip dot="idle" title="Materialized by new sessions">
                Active
              </MetaChip>
            ) : null}
            {!isActive && version.verificationStatus === "pending" ? (
              <MetaChip dot="queued">Verification pending</MetaChip>
            ) : null}
            {!isActive && version.verificationStatus === "failed" ? (
              <MetaChip dot="failed">Verification failed</MetaChip>
            ) : null}
            {recoveryAmbiguous ? <MetaChip>Manager choice required</MetaChip> : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">
            {version.changelog ?? "No changelog"}
          </span>
          <span className="mt-0.5 block truncate text-2xs text-fg-subtle">
            {rigActorLabel(version.createdBy)} · {formatTimestamp(version.createdAt)}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {canRecover ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-8"
              disabled={mutating}
              onClick={async () => {
                const result = await onRecoverDeferred();
                if (result) {
                  toast.success(`Resumed verification for version ${version.version}`);
                }
              }}
            >
              {mutating ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RotateCwIcon className="size-3.5" />
              )}
              Resume verification
            </Button>
          ) : null}
          {!isActive && canManage && version.verificationStatus === "passed" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-8"
              disabled={mutating}
              onClick={onRequestActivate}
            >
              Activate
            </Button>
          ) : null}
          <button
            type="button"
            aria-label={open ? "Collapse version" : "Expand version"}
            onClick={() => setOpen((current) => !current)}
            className="grid size-8 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ChevronDownIcon
              className={cn("size-4 transition-transform", open ? "rotate-180" : "")}
            />
          </button>
        </div>
      </div>

      {open ? (
        <div className="grid gap-3 border-t border-border/70 px-3.5 py-3">
          <DetailRow label="Base image">
            <span className="text-xs">
              Deployment-managed platform image
              {version.image ? (
                <span className="text-fg-subtle"> · legacy override ignored</span>
              ) : null}
            </span>
          </DetailRow>
          <DetailRow label="Setup script">
            {version.setupScript ? (
              <pre className="max-h-56 overflow-auto rounded-md border border-border/70 bg-bg/40 p-2.5 font-mono text-2xs leading-4">
                {version.setupScript}
              </pre>
            ) : (
              <span className="text-xs text-fg-subtle">None</span>
            )}
          </DetailRow>
          <DetailRow label="Checks">
            {version.checks.length === 0 ? (
              <span className="text-xs text-fg-subtle">None declared</span>
            ) : (
              <div className="grid gap-1">
                {withOccurrenceKeys(
                  version.checks,
                  (check) => `${check.name}\u0000${check.command}`,
                ).map(({ key, item: check }) => (
                  <div
                    key={key}
                    className="rounded-md border border-border/70 bg-bg/25 px-2.5 py-1.5"
                  >
                    <div className="truncate text-xs font-medium">{check.name}</div>
                    <div className="truncate font-mono text-2xs text-fg-subtle">
                      {check.command}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DetailRow>
          {version.defaultVariableSetIds.length > 0 ? (
            <DetailRow label="Default variable sets">
              <div className="flex flex-wrap gap-1.5">
                {version.defaultVariableSetIds.map((id) => (
                  <MetaChip key={id}>{variableSetName(id)}</MetaChip>
                ))}
              </div>
            </DetailRow>
          ) : null}
          {version.credentialHooks.length > 0 ? (
            <DetailRow label="Credential hooks">
              <div className="flex flex-wrap gap-1.5">
                {version.credentialHooks.map((hook) => (
                  <MetaChip key={hook}>{hook}</MetaChip>
                ))}
              </div>
            </DetailRow>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      {children}
    </div>
  );
}

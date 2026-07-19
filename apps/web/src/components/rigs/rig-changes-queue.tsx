// The rig's change queue: proposed → verifying → merged / rejected. Each change
// is a literal command (or a full definition edit) that must reproduce from a
// clean sandbox before a manager may promote it. Verification never merges or
// activates by itself, including for setup commands proposed by agents.
import {
  ChevronDownIcon,
  GitBranchIcon,
  Loader2Icon,
  RotateCwIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RigStatusChip } from "@/components/rigs/rig-status-chip";
import { VerificationLog } from "@/components/rigs/verification-log";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { formatTimestamp } from "@/lib/format";
import {
  changeIsPromotable,
  rigActorLabel,
  rigChangeKindLabel,
  rigChangeStatusView,
} from "@/lib/rig-status";
import { cn } from "@/lib/utils";
import type { RigChange } from "@/types";

export function RigChangesQueue({
  changes,
  versionLabel,
  canManage,
  mutating,
  onVerify,
  onPromote,
}: {
  changes: RigChange[];
  /** Map a version id to its human "v{n}" label (or null if unknown). */
  versionLabel: (versionId: string | null) => string | null;
  canManage: boolean;
  mutating: boolean;
  onVerify: (changeId: string) => Promise<RigChange | null>;
  onPromote: (changeId: string) => Promise<unknown>;
}) {
  if (changes.length === 0) {
    return (
      <EmptyState
        icon={<GitBranchIcon className="size-4" />}
        title="No changes yet"
        description="When an agent or teammate proposes a durable change to this machine, it lands here to be verified in a clean sandbox before it merges."
      />
    );
  }
  const ordered = [...changes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="grid gap-2.5">
      {ordered.map((change) => (
        <ChangeRow
          key={change.id}
          change={change}
          versionLabel={versionLabel}
          canManage={canManage}
          mutating={mutating}
          onVerify={onVerify}
          onPromote={onPromote}
        />
      ))}
    </div>
  );
}

function ChangeRow({
  change,
  versionLabel,
  canManage,
  mutating,
  onVerify,
  onPromote,
}: {
  change: RigChange;
  versionLabel: (versionId: string | null) => string | null;
  canManage: boolean;
  mutating: boolean;
  onVerify: (changeId: string) => Promise<RigChange | null>;
  onPromote: (changeId: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const status = rigChangeStatusView(change);
  const kindLabel = rigChangeKindLabel(change.kind);
  const promotable = changeIsPromotable(change);
  const canReverify =
    change.status === "proposed" || change.status === "rejected" || change.status === "failed";
  const isVerifying = change.status === "verifying";
  const mergedLabel = change.resultVersionId ? versionLabel(change.resultVersionId) : null;

  return (
    <article className="rounded-lg border border-border bg-surface/45">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left"
      >
        <span className="mt-0.5 shrink-0 text-fg-subtle">
          {change.kind === "setup_append" ? (
            <TerminalIcon className="size-4" />
          ) : (
            <GitBranchIcon className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{kindLabel}</span>
            <RigStatusChip view={status} />
            {change.status === "merged" && mergedLabel ? (
              <MetaChip title="The version this change produced">Merged as {mergedLabel}</MetaChip>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-2xs text-fg-subtle">
            Proposed by {rigActorLabel(change.proposedBy)} · {formatTimestamp(change.createdAt)}
          </span>
        </span>
        <ChevronDownIcon
          className={cn(
            "mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform",
            open ? "rotate-180" : "",
          )}
        />
      </button>

      {open ? (
        <div className="grid gap-3 border-t border-border/70 px-3.5 py-3">
          <ChangePayload change={change} versionLabel={versionLabel} />

          <div className="text-xs leading-5 text-fg-muted">{status.description}</div>

          {change.verification ? (
            <div className="rounded-md border border-border/70 bg-bg/20 p-2.5">
              <VerificationLog verification={change.verification} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {canReverify ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8"
                disabled={mutating || isVerifying}
                onClick={async () => {
                  const result = await onVerify(change.id);
                  if (result) {
                    toast.success("Verification started", {
                      description: "Replaying the change in a clean sandbox.",
                    });
                  }
                }}
              >
                {isVerifying ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RotateCwIcon className="size-3.5" />
                )}
                {change.status === "proposed" ? "Verify" : "Re-verify"}
              </Button>
            ) : null}
            {promotable ? (
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={mutating || !canManage}
                title={
                  canManage
                    ? "Promote this verified change into a new active version"
                    : "Requires the Rigs manage permission"
                }
                onClick={async () => {
                  const result = await onPromote(change.id);
                  if (result) {
                    toast.success("Change promoted", {
                      description: "A new active rig version was minted.",
                    });
                  }
                }}
              >
                Promote to new version
              </Button>
            ) : null}
          </div>
          {promotable && !canManage ? (
            <p className="text-right text-2xs text-fg-subtle">
              Verified only — promotion needs the Rigs manage permission.
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ChangePayload({
  change,
  versionLabel,
}: {
  change: RigChange;
  versionLabel: (versionId: string | null) => string | null;
}) {
  const baseLabel = versionLabel(change.baseVersionId);
  if (change.kind === "setup_append") {
    const command = typeof change.payload.command === "string" ? change.payload.command : "";
    const note = typeof change.payload.note === "string" ? change.payload.note : "";
    return (
      <div className="grid gap-1.5">
        <PayloadLabel>Command to append{baseLabel ? ` (from ${baseLabel})` : ""}</PayloadLabel>
        <pre className="overflow-auto rounded-md border border-border/70 bg-bg/40 p-2.5 font-mono text-2xs leading-4">
          {command || "—"}
        </pre>
        {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
      </div>
    );
  }
  // definition_edit: summarize which fields the next version would change.
  const payload = change.payload as Record<string, unknown>;
  const touched: string[] = [];
  if (typeof payload.image === "string" || payload.image === null) touched.push("base image");
  if (typeof payload.setupScript === "string" || payload.setupScript === null)
    touched.push("setup script");
  if (Array.isArray(payload.checks)) touched.push(`checks (${payload.checks.length})`);
  if (Array.isArray(payload.defaultVariableSetIds)) touched.push("default variable sets");
  if (Array.isArray(payload.credentialHooks)) touched.push("credential hooks");
  const setupScript = typeof payload.setupScript === "string" ? payload.setupScript : null;
  return (
    <div className="grid gap-1.5">
      <PayloadLabel>Proposed edits{baseLabel ? ` (from ${baseLabel})` : ""}</PayloadLabel>
      {touched.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {touched.map((field) => (
            <MetaChip key={field}>{field}</MetaChip>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fg-subtle">No content fields set.</p>
      )}
      {setupScript ? (
        <pre className="mt-1 max-h-56 overflow-auto rounded-md border border-border/70 bg-bg/40 p-2.5 font-mono text-2xs leading-4">
          {setupScript}
        </pre>
      ) : null}
    </div>
  );
}

function PayloadLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">{children}</div>
  );
}

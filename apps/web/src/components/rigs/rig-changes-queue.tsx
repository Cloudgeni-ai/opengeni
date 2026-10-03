// The environment's change queue: proposed → verifying → merged / rejected.
// Each change is a literal command (or a full definition edit) that must
// reproduce from a clean sandbox before it merges. Setup commands merge on
// green; a verified definition edit waits here for a human to promote it.
import { GitBranchIcon, Loader2Icon, RotateCwIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { SetupScript } from "@/components/rigs/rig-versions-timeline";
import { VerificationLog } from "@/components/rigs/verification-log";
import { Button } from "@/components/ui/button";
import { DetailInline, DetailSection } from "@/components/ui/detail-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  changeIsPromotable,
  rigActorLabel,
  rigChangeKindLabel,
  rigChangeStatusView,
} from "@/lib/rig-status";
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
  const [open, setOpen] = useState<string | null>(null);
  if (changes.length === 0) {
    return (
      <EmptyState
        variant="page"
        icon={<GitBranchIcon />}
        title="No changes yet"
        description="When an agent or a teammate proposes a change to this environment, it's checked in a clean sandbox here before it merges."
        className="pt-8 pb-6"
      />
    );
  }
  const ordered = [...changes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <RowList label="Changes" flush>
      {ordered.map((change) => {
        const status = rigChangeStatusView(change);
        const mergedLabel = change.resultVersionId ? versionLabel(change.resultVersionId) : null;
        return (
          <ListRow
            key={change.id}
            leading={
              <LogoTile
                icon={change.kind === "setup_append" ? <TerminalIcon /> : <GitBranchIcon />}
              />
            }
            title={rigChangeKindLabel(change.kind)}
            titleAddon={
              <MetaChip dot={status.tone} title={status.description}>
                {change.status === "merged" && mergedLabel
                  ? `Merged as ${mergedLabel}`
                  : status.label}
              </MetaChip>
            }
            meta={[
              `Proposed by ${rigActorLabel(change.proposedBy)}`,
              <RelativeTime key="time" date={change.createdAt} />,
            ]}
            indicator="expand"
            expanded={open === change.id}
            onOpen={() => setOpen((current) => (current === change.id ? null : change.id))}
            panel={
              <DetailInline>
                <ChangeContent
                  change={change}
                  versionLabel={versionLabel}
                  canManage={canManage}
                  mutating={mutating}
                  onVerify={onVerify}
                  onPromote={onPromote}
                />
              </DetailInline>
            }
          />
        );
      })}
    </RowList>
  );
}

function ChangeContent({
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
  const status = rigChangeStatusView(change);
  const promotable = changeIsPromotable(change);
  const canReverify =
    change.status === "proposed" || change.status === "rejected" || change.status === "failed";
  const isVerifying = change.status === "verifying";
  return (
    <div className="px-4 [&>section+section]:border-t [&>section+section]:border-border">
      <DetailSection title={status.label} description={status.description}>
        <ChangePayload change={change} versionLabel={versionLabel} />
      </DetailSection>
      {change.verification ? (
        <DetailSection title="Verification">
          <VerificationLog verification={change.verification} />
        </DetailSection>
      ) : null}
      {canReverify || promotable ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border py-4">
          {promotable && !canManage ? (
            <p className="mr-auto text-xs leading-4.5 text-fg-muted">
              Someone who can manage sandbox environments can promote it.
            </p>
          ) : null}
          {canReverify ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
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
                <Loader2Icon aria-hidden="true" className="animate-spin" />
              ) : (
                <RotateCwIcon aria-hidden="true" />
              )}
              {change.status === "proposed" ? "Verify" : "Verify again"}
            </Button>
          ) : null}
          {promotable ? (
            <Button
              type="button"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={mutating || !canManage}
              onClick={async () => {
                const result = await onPromote(change.id);
                if (result) {
                  toast.success("Change promoted", {
                    description: "It's now the environment's active version.",
                  });
                }
              }}
            >
              Promote to new version
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const from = baseLabel ? ` Based on ${baseLabel}.` : "";
  if (change.kind === "setup_append") {
    const command = typeof change.payload.command === "string" ? change.payload.command : "";
    const note = typeof change.payload.note === "string" ? change.payload.note : "";
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm leading-5 text-fg-muted">
          Adds this command to the setup script.{from}
        </p>
        <SetupScript script={command || null} />
        {note ? <p className="text-sm leading-5 text-fg-muted">{note}</p> : null}
      </div>
    );
  }
  // definition_edit: which parts of the next version would change.
  const payload = change.payload as Record<string, unknown>;
  const touched: string[] = [];
  if (typeof payload.setupScript === "string" || payload.setupScript === null)
    touched.push("setup script");
  if (Array.isArray(payload.checks)) {
    touched.push(`checks (${payload.checks.length})`);
  }
  if (Array.isArray(payload.defaultVariableSetIds)) touched.push("default variable sets");
  const setupScript = typeof payload.setupScript === "string" ? payload.setupScript : null;
  const changelog = typeof payload.changelog === "string" ? payload.changelog : "";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm leading-5 text-fg-muted">
        {touched.length > 0 ? `Changes the ${touched.join(", ")}.` : "Changes nothing."}
        {from}
      </p>
      {changelog ? <p className="text-sm leading-5 text-fg">{changelog}</p> : null}
      {setupScript ? <SetupScript script={setupScript} /> : null}
    </div>
  );
}

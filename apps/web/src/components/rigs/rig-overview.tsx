// Rig overview: what this machine IS at a glance — image, active version,
// default variable sets, credential hooks — plus the most recent verification of
// the active version's checks (derived from the change that produced it).
import { Loader2Icon, RotateCwIcon } from "lucide-react";
import { toast } from "sonner";

import { RigStatusChip } from "@/components/rigs/rig-status-chip";
import { VerificationLog } from "@/components/rigs/verification-log";
import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { formatTimestamp } from "@/lib/format";
import { rigActorLabel, rigCheckHealthView, versionHasChecks } from "@/lib/rig-status";
import type { Rig, RigChange, RigChangeVerification } from "@/types";

export function RigOverview({
  rig,
  changes,
  variableSetName,
  canUse,
  mutating,
  onVerify,
}: {
  rig: Rig;
  changes: RigChange[];
  variableSetName: (id: string) => string;
  canUse: boolean;
  mutating: boolean;
  onVerify: () => Promise<{ ok: boolean; versionId: string } | null>;
}) {
  const active = rig.activeVersion;
  if (!active) {
    return (
      <Notice tone="waiting" title="This rig has no active version">
        Create a version by proposing and promoting a change, then it will materialize into sandboxes.
      </Notice>
    );
  }

  // The active version's most recent verification: the newest change that
  // produced this version (resultVersionId) and captured check results.
  const latestVerification: RigChangeVerification | null = changes
    .filter((change) => change.resultVersionId === active.id && change.verification)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.verification ?? null;

  const health = !versionHasChecks(active)
    ? null
    : latestVerification
      ? latestVerification.passed === false
        ? "failing"
        : "passing"
      : "unknown";

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Base image">
          <span className="font-mono text-xs">{active.image ?? "Default image"}</span>
        </Field>
        <Field label="Active version">
          <span className="text-sm">
            Version {active.version}
            <span className="text-fg-subtle"> · {rigActorLabel(active.createdBy)} · {formatTimestamp(active.createdAt)}</span>
          </span>
        </Field>
        <Field label="Default variable sets">
          {active.defaultVariableSetIds.length === 0 ? (
            <span className="text-xs text-fg-subtle">None</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {active.defaultVariableSetIds.map((id) => (
                <MetaChip key={id}>{variableSetName(id)}</MetaChip>
              ))}
            </div>
          )}
        </Field>
        <Field label="Credential hooks">
          {active.credentialHooks.length === 0 ? (
            <span className="text-xs text-fg-subtle">None</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {active.credentialHooks.map((hook) => (
                <MetaChip key={hook}>{hook}</MetaChip>
              ))}
            </div>
          )}
        </Field>
      </div>

      <div className="grid gap-2.5 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Health checks</h3>
            {health ? <RigStatusChip view={rigCheckHealthView(health)} /> : null}
          </div>
          {canUse ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              disabled={mutating}
              onClick={async () => {
                const result = await onVerify();
                if (result) {
                  toast.success("Verification started", { description: "The checks are re-running in a clean sandbox; the outcome lands in this rig's activity." });
                }
              }}
            >
              {mutating ? <Loader2Icon className="size-3.5 animate-spin" /> : <RotateCwIcon className="size-3.5" />}
              Re-run checks
            </Button>
          ) : null}
        </div>

        {!versionHasChecks(active) ? (
          <p className="text-xs text-fg-subtle">This version declares no checks. Add checks via a definition edit to make the machine self-verifying.</p>
        ) : latestVerification ? (
          <div className="rounded-md border border-border/70 bg-bg/20 p-2.5">
            <VerificationLog verification={latestVerification} />
          </div>
        ) : (
          <div className="grid gap-1">
            <p className="text-xs text-fg-subtle">Not verified yet. The declared checks:</p>
            {active.checks.map((check, index) => (
              <div key={`${check.name}-${index}`} className="flex items-center gap-2 rounded-md border border-border/70 bg-bg/25 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{check.name}</span>
                <span className="min-w-0 flex-[2] truncate font-mono text-2xs text-fg-subtle">{check.command}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      {children}
    </div>
  );
}

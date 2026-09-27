// An environment at a glance: the active version's health checks and their
// last run, its setup script, and the variable sets it adds by default.
import { Loader2Icon, RotateCwIcon, VariableIcon } from "lucide-react";
import { toast } from "sonner";

import { rigHealth } from "@/components/rigs/rig-health";
import { CheckList, SetupScript } from "@/components/rigs/rig-versions-timeline";
import { VerificationLog } from "@/components/rigs/verification-log";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { StatusDot } from "@/components/ui/status-dot";
import { versionHasChecks } from "@/lib/rig-status";
import type { Rig, RigChange, RigChangeVerification } from "@/types";

export function RigOverview({
  rig,
  changes,
  variableSetName,
  canUse,
  mutating,
  onVerify,
  onOpenVariableSet,
}: {
  rig: Rig;
  changes: RigChange[];
  variableSetName: (id: string) => string;
  canUse: boolean;
  mutating: boolean;
  onVerify: () => Promise<{ ok: boolean; versionId: string } | null>;
  onOpenVariableSet: (id: string) => void;
}) {
  const active = rig.activeVersion;
  if (!active) {
    return (
      <DetailSection title="No active version yet">
        <p className="text-sm leading-5 text-fg-muted">
          Propose a change and promote it once it passes. Sessions start using the environment after
          that.
        </p>
      </DetailSection>
    );
  }

  // The active version's most recent verification: the newest change that
  // produced this version (resultVersionId) and captured check results.
  const latestVerification: RigChangeVerification | null =
    changes
      .filter((change) => change.resultVersionId === active.id && change.verification)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.verification ?? null;
  // The server-derived summary (the same one the list uses), so the page never
  // disagrees with the list.
  const health = rigHealth(rig);
  const hasChecks = versionHasChecks(active);

  return (
    <>
      <DetailSection
        title="Health checks"
        description={
          hasChecks
            ? "Commands that must succeed in a clean sandbox for the environment to count as healthy."
            : "This version declares no checks. Add some with Edit setup."
        }
        action={
          canUse && hasChecks ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={mutating}
              onClick={async () => {
                const result = await onVerify();
                if (result) {
                  toast.success("Running the checks again", {
                    description: "They run in a clean sandbox. This can take a moment.",
                  });
                }
              }}
            >
              {mutating ? (
                <Loader2Icon aria-hidden="true" className="animate-spin" />
              ) : (
                <RotateCwIcon aria-hidden="true" />
              )}
              Run checks
            </Button>
          ) : null
        }
      >
        {hasChecks ? (
          <div className="flex min-w-0 flex-col gap-4">
            <p className="inline-flex items-center gap-1.5 text-sm leading-5 font-medium text-fg">
              <StatusDot tone={health.tone} size="sm" />
              {health.label}
            </p>
            {latestVerification ? (
              <VerificationLog verification={latestVerification} />
            ) : (
              <CheckList checks={active.checks} />
            )}
          </div>
        ) : null}
      </DetailSection>

      <DetailSection title="Setup script" description="Runs once when a sandbox starts.">
        <SetupScript script={active.setupScript} />
      </DetailSection>

      <DetailSection
        title="Default variable sets"
        description="Added to new sessions that use this environment."
      >
        {active.defaultVariableSetIds.length === 0 ? (
          <p className="text-sm leading-5 text-fg-muted">None. Sessions pick their own.</p>
        ) : (
          <RowList label="Default variable sets" flush>
            {active.defaultVariableSetIds.map((id) => (
              <ListRow
                key={id}
                leading={<LogoTile icon={<VariableIcon />} />}
                title={variableSetName(id)}
                indicator="open"
                onOpen={() => onOpenVariableSet(id)}
              />
            ))}
          </RowList>
        )}
      </DetailSection>
    </>
  );
}

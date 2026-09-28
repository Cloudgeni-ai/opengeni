// The environment's version history: append-only, newest first, exactly one
// active. Rollback = activate an older version (mints nothing). Each row
// expands in place to the content that version pinned.
import { HistoryIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DetailInline, DetailSection } from "@/components/ui/detail-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, RowList } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { rigActorLabel } from "@/lib/rig-status";
import { withOccurrenceKeys } from "@/lib/react-key";
import type { RigCheck, RigVersion } from "@/types";

export function RigVersionsTimeline({
  versions,
  activeVersionId,
  variableSetName,
  canManage,
  mutating,
  onActivate,
}: {
  versions: RigVersion[];
  activeVersionId: string | null;
  variableSetName: (id: string) => string;
  canManage: boolean;
  mutating: boolean;
  onActivate: (versionId: string) => Promise<unknown>;
}) {
  const [confirmVersion, setConfirmVersion] = useState<RigVersion | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (versions.length === 0) {
    return (
      <EmptyState
        variant="page"
        icon={<HistoryIcon />}
        title="No versions yet"
        description="Every promoted change becomes a new version here."
        className="pt-8 pb-6"
      />
    );
  }
  const ordered = [...versions].sort((a, b) => b.version - a.version);

  return (
    <>
      <RowList label="Versions" flush>
        {ordered.map((version) => {
          const isActive = version.id === activeVersionId;
          return (
            <ListRow
              key={version.id}
              title={`Version ${version.version}`}
              titleAddon={isActive ? <MetaChip dot="idle">Active</MetaChip> : null}
              description={version.changelog ?? "No changelog"}
              meta={[
                rigActorLabel(version.createdBy),
                <RelativeTime key="time" date={version.createdAt} />,
              ]}
              control={
                !isActive && canManage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    disabled={mutating}
                    onClick={() => setConfirmVersion(version)}
                  >
                    Activate
                  </Button>
                ) : undefined
              }
              indicator="expand"
              expanded={open === version.id}
              onOpen={() => setOpen((current) => (current === version.id ? null : version.id))}
              panel={
                <DetailInline>
                  <VersionContent version={version} variableSetName={variableSetName} />
                </DetailInline>
              }
            />
          );
        })}
      </RowList>

      <ConfirmDialog
        open={confirmVersion !== null}
        onOpenChange={(next) => setConfirmVersion(next ? confirmVersion : null)}
        title={confirmVersion ? `Make version ${confirmVersion.version} active?` : ""}
        description="New sessions start from this version. Sessions already running keep theirs. Nothing is deleted, so you can switch back at any time."
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

function VersionContent({
  version,
  variableSetName,
}: {
  version: RigVersion;
  variableSetName: (id: string) => string;
}) {
  return (
    <div className="px-4 [&>section+section]:border-t [&>section+section]:border-border">
      <DetailSection title="Setup script">
        <SetupScript script={version.setupScript} />
      </DetailSection>
      <DetailSection title="Checks">
        <CheckList checks={version.checks} />
      </DetailSection>
      {version.defaultVariableSetIds.length > 0 ? (
        <DetailSection title="Default variable sets">
          <p className="text-sm leading-5 text-fg">
            {version.defaultVariableSetIds.map(variableSetName).join(", ")}
          </p>
        </DetailSection>
      ) : null}
    </div>
  );
}

export function SetupScript({ script }: { script: string | null | undefined }) {
  return script ? (
    <pre className="max-h-72 overflow-auto rounded-[10px] bg-surface-2 p-3 font-mono text-xs leading-[18px] text-fg">
      {script}
    </pre>
  ) : (
    <p className="text-sm leading-5 text-fg-muted">
      None. Sandboxes start from the platform image unchanged.
    </p>
  );
}

export function CheckList({ checks }: { checks: RigCheck[] }) {
  if (checks.length === 0) {
    return <p className="text-sm leading-5 text-fg-muted">None.</p>;
  }
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">
      {withOccurrenceKeys(checks, (check) => `${check.name}\u0000${check.command}`).map(
        ({ key, item: check }) => (
          <li key={key} className="min-w-0 py-2 first:pt-0 last:pb-0">
            <div className="truncate text-sm leading-5 font-medium text-fg">{check.name}</div>
            <div className="truncate font-mono text-xs leading-[18px] text-fg-muted">
              {check.command}
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

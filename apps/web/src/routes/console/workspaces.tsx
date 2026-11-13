import type { ConsoleRange, ConsoleWorkspace, ConsoleWorkspaceKind } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { Building2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { userErrorText } from "@opengeni/react/ui/api-error";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { Toolbar } from "@opengeni/react/ui/toolbar";

import {
  ConsoleLoadError,
  ConsolePage,
  formatCount,
  formatMicros,
  rangeLabel,
  useConsole,
  useConsoleQuery,
} from "./console-shared";
import { RangeControl } from "./overview";

type KindFilter = "all" | ConsoleWorkspaceKind;

export function workspaceKindLabel(kind: ConsoleWorkspaceKind): string {
  return kind === "managed" ? "Managed by product" : "Team";
}

export function ConsoleWorkspacesRoute() {
  const { client, organizationId, search } = useConsole();
  const navigate = useNavigate();
  const [range, setRange] = useState<ConsoleRange>("30d");
  const [kind, setKind] = useState<KindFilter>("all");
  const [switching, setSwitching] = useState<ConsoleWorkspace | null>(null);
  const workspaces = useConsoleQuery(
    (signal) => client.listConsoleWorkspaces(organizationId, { range, kind, signal }),
    [client, organizationId, range, kind],
  );
  const keys = useConsoleQuery(
    () => client.listOrganizationApiKeys(organizationId),
    [client, organizationId],
  );
  const keyNames = useMemo(
    () => new Map((keys.data ?? []).map((key) => [key.id, key.name])),
    [keys.data],
  );
  const rows = workspaces.data?.workspaces ?? [];
  const nextKind: ConsoleWorkspaceKind = switching?.kind === "managed" ? "team" : "managed";

  return (
    <ConsolePage>
      <PageHeader
        title="Workspaces"
        icon={<Building2Icon />}
        description={rangeLabel(range)}
        actions={<RangeControl value={range} onChange={setRange} />}
      />
      <Toolbar>
        <SegmentedControl
          aria-label="Workspace kind"
          size="sm"
          options={[
            { value: "all", label: "All" },
            { value: "managed", label: "Managed by product" },
            { value: "team", label: "Team" },
          ]}
          value={kind}
          onValueChange={(value) => setKind(value as KindFilter)}
        />
      </Toolbar>
      {workspaces.error ? (
        <ConsoleLoadError error={workspaces.error} onRetry={workspaces.reload} />
      ) : workspaces.loading && rows.length === 0 ? (
        <ListRowSkeleton count={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<Building2Icon />}
          title="No workspaces here"
          description={
            kind === "managed"
              ? "Workspaces your product creates with an API key show up here."
              : undefined
          }
        />
      ) : (
        <RowList
          variant="table"
          label="Workspaces"
          nameLabel="Workspace"
          columns={[
            { id: "kind", label: "Kind", width: 160 },
            { id: "key", label: "Created by key", width: 140 },
            { id: "sessions", label: "Sessions", width: 80, align: "end" },
            { id: "spend", label: "Spend", width: 88, align: "end", leadsWhenFolded: true },
            { id: "activity", label: "Last activity", width: 112, align: "end" },
          ]}
        >
          {rows.map((workspace) => (
            <ListRow
              key={workspace.id}
              title={workspace.name}
              cells={{
                kind: <MetaChip variant="soft">{workspaceKindLabel(workspace.kind)}</MetaChip>,
                key: workspace.createdByApiKeyId
                  ? (keyNames.get(workspace.createdByApiKeyId) ?? "—")
                  : "—",
                sessions: formatCount(workspace.sessions),
                spend: formatMicros(workspace.spendMicros),
                activity: workspace.lastActivityAt ? (
                  <RelativeTime date={workspace.lastActivityAt} />
                ) : (
                  "—"
                ),
              }}
              {...(workspace.kind === "managed"
                ? {
                    onOpen: () =>
                      void navigate({
                        to: "/console/sessions",
                        search: { ...search, workspace: workspace.id },
                      }),
                  }
                : {})}
              menu={
                <DropdownMenuItem onSelect={() => setSwitching(workspace)}>
                  {workspace.kind === "managed"
                    ? "Mark as team workspace"
                    : "Mark as managed by product"}
                </DropdownMenuItem>
              }
            />
          ))}
        </RowList>
      )}
      <ConfirmDialog
        open={switching !== null}
        onOpenChange={(open) => {
          if (!open) setSwitching(null);
        }}
        destructive={false}
        title={
          switching
            ? `Mark ${switching.name} as ${nextKind === "managed" ? "managed by product" : "a team workspace"}?`
            : ""
        }
        description={
          nextKind === "managed"
            ? "Its sessions become reviewable in Console, at your organization's review level."
            : "Its sessions leave Console. Only counts and spend stay here."
        }
        confirmLabel={nextKind === "managed" ? "Mark as managed" : "Mark as team"}
        pendingLabel="Saving…"
        onConfirm={async () => {
          if (!switching) return;
          try {
            await client.updateConsoleWorkspace(organizationId, switching.id, { kind: nextKind });
            toast.success(`${switching.name} is now ${workspaceKindLabel(nextKind).toLowerCase()}`);
            workspaces.reload();
          } catch (error) {
            toast.error("The workspace wasn't changed", { description: userErrorText(error) });
            return false;
          }
        }}
      />
    </ConsolePage>
  );
}

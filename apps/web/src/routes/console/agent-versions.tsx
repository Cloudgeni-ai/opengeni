// An agent's Versions tab: every version with where it came from, its config
// hash and when it was published; a diff between two versions; and the
// Publish and Roll back dialog with the running-chats choice.
import type { OrgAgent, OrgAgentPublishOperation, OrgAgentVersion } from "@opengeni/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { userErrorText } from "@opengeni/react/ui/api-error";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DiffView } from "@opengeni/react/ui/diff-view";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { SelectMenu } from "@opengeni/react/ui/select-menu";

import {
  shortConfigHash,
  versionConfigText,
  versionSourceLabel,
  type OrgAgentsApi,
} from "@/lib/organization-agents";
import { ConsoleLoadError, formatCount, useConsoleQuery } from "./console-shared";

export const MOVE_COST_NOTE = "Moving breaks the prompt cache and can raise cost slightly.";

const OPERATION_POLL_MS = 1_500;

/** "Publish v4" for a newer version, "Roll back to v2" for an older one. */
export function publishActionLabel(agent: Pick<OrgAgent, "publishedVersion">, version: number) {
  return agent.publishedVersion !== null && version < agent.publishedVersion
    ? `Roll back to v${version}`
    : `Publish v${version}`;
}

export function operationText(operation: OrgAgentPublishOperation): string {
  const moved = `${formatCount(operation.movedCount)} ${operation.movedCount === 1 ? "chat" : "chats"} moved`;
  const failed =
    operation.failedCount > 0 ? `, ${formatCount(operation.failedCount)} couldn't move` : "";
  switch (operation.status) {
    case "pending":
    case "running":
      return `Moving running chats to v${operation.toVersion}: ${moved}${failed}.`;
    case "succeeded":
      return `v${operation.toVersion} is published. ${moved}${failed}.`;
    case "failed":
      return `Moving chats to v${operation.toVersion} stopped: ${moved}${failed}.`;
  }
}

/** Follows a publish that moves running chats until it finishes. */
export function usePublishOperation(
  api: OrgAgentsApi,
  agentId: string,
  initial: OrgAgentPublishOperation | null,
): OrgAgentPublishOperation | null {
  const [operation, setOperation] = useState(initial);
  useEffect(() => setOperation(initial), [initial]);
  const id = operation?.id ?? null;
  const done = operation ? operation.status === "succeeded" || operation.status === "failed" : true;
  useEffect(() => {
    if (!id || done) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.getPublishOperation(agentId, id, controller.signal).then(
        (next) => {
          if (!controller.signal.aborted) setOperation(next);
        },
        () => {
          if (!controller.signal.aborted)
            setOperation((current) => (current ? { ...current } : current));
        },
      );
    }, OPERATION_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [agentId, api, done, id, operation]);
  return operation;
}

/** Publish or Roll back: new chats only (default), or also move running chats. */
export function PublishDialog({
  agent,
  api,
  version,
  onOpenChange,
  onPublished,
}: {
  agent: OrgAgent;
  api: OrgAgentsApi;
  /** The version to publish; null closes the dialog. */
  version: number | null;
  onOpenChange: (open: boolean) => void;
  onPublished: (agent: OrgAgent, operation: OrgAgentPublishOperation) => void;
}) {
  const [move, setMove] = useState<"new" | "move">("new");
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setMove("new");
    setCount(null);
    if (version === null) return;
    const controller = new AbortController();
    api.movableChats(agent.id, version, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setCount(response.count);
      },
      () => {},
    );
    return () => controller.abort();
  }, [agent.id, api, version]);
  if (version === null) return null;
  const label = publishActionLabel(agent, version);
  const chats =
    count === null
      ? "Running chats move to this version on their next turn."
      : count === 0
        ? "No running chats would move."
        : `${formatCount(count)} running ${count === 1 ? "chat moves" : "chats move"} to v${version} on ${count === 1 ? "its" : "their"} next turn.`;
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      destructive={false}
      title={`${label}?`}
      confirmLabel={label}
      pendingLabel="Publishing…"
      onConfirm={async () => {
        try {
          const result = await api.publish(agent.id, {
            version,
            moveRunningChats: move === "move",
            expectedVersion: agent.rowVersion,
          });
          toast.success(`v${version} is published`, {
            description: move === "move" ? "Running chats are moving." : "New chats use it.",
          });
          onPublished(result.agent, result.operation);
        } catch (error) {
          toast.error(`Couldn't publish v${version}`, { description: userErrorText(error) });
          return false;
        }
      }}
    >
      <ChoiceCards
        aria-label="Which chats use it"
        variant="radio"
        value={move}
        onValueChange={(value) => setMove(value === "move" ? "move" : "new")}
      >
        <ChoiceCard
          value="new"
          title="New chats only"
          description="Running chats stay on the version they started with."
        />
        <ChoiceCard
          value="move"
          title="Also move running chats"
          description={
            <>
              {chats} {MOVE_COST_NOTE}
            </>
          }
        />
      </ChoiceCards>
    </ConfirmDialog>
  );
}

export function AgentVersions({
  agent,
  api,
  from,
  to,
  onCompare,
  onPublish,
  operation,
}: {
  agent: OrgAgent;
  api: OrgAgentsApi;
  from: number | undefined;
  to: number | undefined;
  onCompare: (from: number, to: number) => void;
  onPublish: (version: number) => void;
  operation: OrgAgentPublishOperation | null;
}) {
  const versions = useConsoleQuery(
    (signal) => api.listVersions(agent.id, signal),
    [api, agent.id, agent.latestVersion, agent.publishedVersion],
  );
  const rows = [...(versions.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const editable = agent.managedBy === "console";
  const newest = rows[0]?.version;
  const right = to ?? newest;
  const left = from ?? (right !== undefined ? previous(rows, right) : undefined);
  const before = rows.find((version) => version.version === left) ?? null;
  const after = rows.find((version) => version.version === right) ?? null;
  const options = rows.map((version) => ({
    value: String(version.version),
    label: `v${version.version}`,
  }));

  return (
    <div className="flex min-w-0 flex-col">
      {operation ? (
        <Notice
          className="mt-6"
          tone={
            operation.status === "failed"
              ? "failed"
              : operation.status === "succeeded"
                ? "success"
                : "waiting"
          }
          live="polite"
        >
          {operationText(operation)}
        </Notice>
      ) : null}
      <DetailSection title="Versions">
        {versions.error ? (
          <ConsoleLoadError error={versions.error} onRetry={versions.reload} />
        ) : versions.loading && rows.length === 0 ? (
          <ListRowSkeleton count={3} />
        ) : (
          <RowList
            variant="table"
            label="Versions"
            nameLabel="Version"
            columns={[
              { id: "source", label: "Source", width: 96 },
              { id: "hash", label: "Config hash", width: 128 },
              { id: "created", label: "Created", width: 112 },
            ]}
          >
            {rows.map((version) => {
              const published = version.version === agent.publishedVersion;
              const draft =
                agent.publishedVersion === null || version.version > agent.publishedVersion;
              return (
                <ListRow
                  key={version.version}
                  title={`v${version.version}`}
                  titleAddon={
                    published ? (
                      <MetaChip variant="soft" dot="idle">
                        Published
                      </MetaChip>
                    ) : draft && version.version === newest ? (
                      <MetaChip variant="outline">Draft</MetaChip>
                    ) : null
                  }
                  meta={[
                    version.publishedAt && !published ? (
                      <span key="published">
                        Published <RelativeTime date={version.publishedAt} />
                      </span>
                    ) : null,
                  ]}
                  cells={{
                    source: versionSourceLabel(version.source),
                    hash: (
                      <span translate="no" className="font-mono text-xs" title={version.configHash}>
                        {shortConfigHash(version.configHash)}
                      </span>
                    ),
                    created: <RelativeTime date={version.createdAt} />,
                  }}
                  onOpen={() => {
                    const earlier = previous(rows, version.version);
                    if (earlier !== undefined) onCompare(earlier, version.version);
                  }}
                  {...(editable && !published
                    ? {
                        menu: (
                          <DropdownMenuItem onSelect={() => onPublish(version.version)}>
                            {publishActionLabel(agent, version.version)}
                          </DropdownMenuItem>
                        ),
                      }
                    : {})}
                />
              );
            })}
          </RowList>
        )}
      </DetailSection>
      {rows.length > 1 && left !== undefined && right !== undefined ? (
        <DetailSection
          title="Changes"
          action={
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <SelectMenu
                size="sm"
                aria-label="Compare from"
                className="w-24"
                options={options}
                value={String(left)}
                onValueChange={(value) => onCompare(Number(value), right)}
              />
              to
              <SelectMenu
                size="sm"
                aria-label="Compare to"
                className="w-24"
                options={options}
                value={String(right)}
                onValueChange={(value) => onCompare(left, Number(value))}
              />
            </div>
          }
        >
          {before && after ? <VersionDiff before={before} after={after} /> : null}
        </DetailSection>
      ) : null}
    </div>
  );
}

function previous(rows: readonly OrgAgentVersion[], version: number): number | undefined {
  return rows
    .map((row) => row.version)
    .filter((value) => value < version)
    .sort((a, b) => b - a)[0];
}

/** Instructions as text and the settings as JSON, each as a diff. */
export function VersionDiff({
  before,
  after,
}: {
  before: OrgAgentVersion;
  after: OrgAgentVersion;
}) {
  const drift = catalogDrift(before, after);
  return (
    <div className="flex flex-col gap-4">
      <DiffView
        title="Instructions"
        before={before.instructions}
        after={after.instructions}
        format="text"
        emptyMessage="Instructions didn't change."
      />
      <DiffView
        title="Settings"
        before={versionConfigText(before)}
        after={versionConfigText(after)}
        format="code"
        emptyMessage="Settings didn't change."
      />
      {drift.length > 0 ? (
        <Notice tone="info" title="Tools the servers offer changed">
          {drift.join(" ")}
        </Notice>
      ) : null}
    </div>
  );
}

/** Tools a server added or dropped between the two versions' catalogs. */
export function catalogDrift(before: OrgAgentVersion, after: OrgAgentVersion): string[] {
  if (!before.toolCatalog || !after.toolCatalog) return [];
  const lines: string[] = [];
  const keys = new Set([...Object.keys(before.toolCatalog), ...Object.keys(after.toolCatalog)]);
  for (const key of [...keys].sort()) {
    const old = new Set((before.toolCatalog[key] ?? []).map((tool) => tool.name));
    const now = new Set((after.toolCatalog[key] ?? []).map((tool) => tool.name));
    const added = [...now].filter((name) => !old.has(name)).sort();
    const removed = [...old].filter((name) => !now.has(name)).sort();
    if (added.length > 0) lines.push(`${key} added ${added.join(", ")}.`);
    if (removed.length > 0) lines.push(`${key} dropped ${removed.join(", ")}.`);
  }
  return lines;
}

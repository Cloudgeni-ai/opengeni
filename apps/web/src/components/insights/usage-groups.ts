/**
 * Breakdown rows from the usage response: display names, merging of
 * rows that read the same (a model served by both an organization and a
 * workspace Claude plan is one row), and what clicking a row does.
 */
import {
  modelFilterKey,
  sumMeasures,
  type UsageFilterField,
  type UsageGroup,
  type UsageGroupBy,
  type UsageMeasures,
  type UsageResponse,
} from "./usage-contract";
import { modelDisplayName, providerDisplayName, type ModelLabelSource } from "./model-display";
import { costMicros, payerName } from "./usage-format";

export const GROUP_LABELS: Record<UsageGroupBy, string> = {
  model: "Model",
  provider: "Provider",
  payer: "Paid with",
  workspace: "Workspace",
  project: "Project",
  rootSession: "Session",
  person: "Person",
  schedule: "Schedule",
};

/** Group-bys in menu order, per scope. */
export const GROUP_ORDER: readonly UsageGroupBy[] = [
  "model",
  "provider",
  "payer",
  "workspace",
  "project",
  "rootSession",
  "person",
  "schedule",
];

export const FILTER_FIELD_OF: Record<UsageGroupBy, UsageFilterField> = {
  model: "model",
  provider: "provider",
  payer: "payer",
  workspace: "workspaceId",
  project: "projectId",
  rootSession: "rootSessionId",
  person: "person",
  schedule: "scheduleId",
};

/** Where a click on a row goes next: filter to it, then look one level down. */
export const DRILL_NEXT: Record<UsageGroupBy, UsageGroupBy> = {
  workspace: "model",
  model: "rootSession",
  provider: "model",
  payer: "model",
  project: "rootSession",
  rootSession: "model",
  person: "rootSession",
  schedule: "model",
};

export type BreakdownRow = {
  id: string;
  label: string;
  /** Muted words after the title ("ChatGPT plan", "Ada Lovelace"). */
  detail?: string;
  kind: UsageGroup["kind"];
  you?: boolean;
  /** Filter values a click applies; null when the row can't be filtered (private, deleted, other). */
  filter: { field: UsageFilterField; values: string[] } | null;
  /** The session to open, for session rows the viewer can read. */
  sessionId?: string;
  workspaceId?: string;
  measures: UsageMeasures;
  cost: number;
};

function rowLabel(
  group: UsageGroup,
  groupBy: UsageGroupBy,
  catalog?: ModelLabelSource,
): { label: string; detail?: string } {
  switch (group.kind) {
    case "private":
      return {
        label: "Private chats",
        ...(group.label && group.label !== "Private chats" ? { detail: group.label } : {}),
      };
    case "deleted":
      return { label: "Deleted chats" };
    case "personal":
      return {
        label:
          group.label && group.label !== "Personal workspaces"
            ? `${group.label}'s Personal`
            : "Personal workspaces",
      };
    case "unfiled":
      return { label: groupBy === "project" ? "No project" : group.label };
    case "service":
      return { label: "Automations", detail: "Schedules and agent-started work" };
    case "other":
    case "restricted":
      return { label: group.label };
    case "item":
      break;
  }
  if (groupBy === "model" && group.provider && group.model) {
    return {
      label: modelDisplayName(group.provider, group.model, catalog),
      detail: providerDisplayName(group.provider),
    };
  }
  if (groupBy === "provider" && group.provider) {
    return { label: providerDisplayName(group.provider) };
  }
  if (groupBy === "payer" && group.payer) {
    return {
      label: payerName(group.payer),
    };
  }
  return { label: group.label };
}

/** The response's groups as display rows, merged by what they read as, biggest cost first. */
export function breakdownRows(
  response: Pick<UsageResponse, "groups" | "groupBy">,
  catalog?: ModelLabelSource,
): BreakdownRow[] {
  const merged = new Map<
    string,
    { row: Omit<BreakdownRow, "measures" | "cost">; parts: UsageMeasures[] }
  >();
  const field = FILTER_FIELD_OF[response.groupBy];
  for (const group of response.groups) {
    const { label, detail } = rowLabel(group, response.groupBy, catalog);
    const filterable =
      group.kind === "item" || (group.kind === "unfiled" && response.groupBy === "project");
    const filterValue =
      response.groupBy === "model" && group.provider && group.model
        ? modelFilterKey(group.provider, group.model)
        : group.key;
    const identity =
      group.kind === "item" && (response.groupBy === "model" || response.groupBy === "provider")
        ? `item:${label}:${detail ?? ""}`
        : `${group.kind}:${group.key}`;
    const existing = merged.get(identity);
    if (existing) {
      existing.parts.push(group.measures);
      if (existing.row.filter && filterable) existing.row.filter.values.push(filterValue);
      continue;
    }
    merged.set(identity, {
      row: {
        id: identity,
        label,
        ...(detail ? { detail } : {}),
        kind: group.kind,
        ...(group.you ? { you: true } : {}),
        filter: filterable ? { field, values: [filterValue] } : null,
        ...(response.groupBy === "rootSession" && group.kind === "item"
          ? { sessionId: group.key }
          : {}),
        ...(group.workspaceId ? { workspaceId: group.workspaceId } : {}),
      },
      parts: [group.measures],
    });
  }
  const rows = [...merged.values()].map(({ row, parts }) => {
    const measures = parts.length === 1 ? parts[0]! : sumMeasures(parts);
    return { ...row, measures, cost: costMicros(measures) };
  });
  // Folded and amount-only rows sit after the named ones.
  const rank = (row: BreakdownRow) => (row.kind === "item" ? 0 : row.kind === "other" ? 2 : 1);
  return rows.sort(
    (a, b) => rank(a) - rank(b) || b.cost - a.cost || b.measures.calls - a.measures.calls,
  );
}

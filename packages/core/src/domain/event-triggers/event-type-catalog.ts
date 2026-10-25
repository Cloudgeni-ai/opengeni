import type { EventTypeDescriptor, WebhookEventAdapter } from "@opengeni/contracts";

/**
 * The event types a webhook adapter is known to produce, for trigger pickers
 * and agents. Standard webhooks name their own types, so their catalog is the
 * types the source actually delivered recently.
 */

type CatalogEntry = { type: string; description: string; fields?: Array<[string, string]> };

const LINEAR_ISSUE_FIELDS: Array<[string, string]> = [
  ["data.team.key", "The team key, such as ENG"],
  ["data.state.name", "The workflow state, such as In Progress"],
  ["data.priority", "Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low"],
  ["data.assignee.name", "Who the issue is assigned to"],
];

const LINEAR_TYPES: CatalogEntry[] = [
  { type: "Issue.create", description: "An issue was created", fields: LINEAR_ISSUE_FIELDS },
  { type: "Issue.update", description: "An issue changed", fields: LINEAR_ISSUE_FIELDS },
  { type: "Issue.remove", description: "An issue was deleted or archived" },
  {
    type: "Comment.create",
    description: "Someone commented on an issue",
    fields: [["data.issue.identifier", "The issue the comment is on, such as ENG-42"]],
  },
  { type: "Comment.update", description: "A comment was edited" },
  { type: "Project.create", description: "A project was created" },
  { type: "Project.update", description: "A project changed" },
  { type: "ProjectUpdate.create", description: "A project update was posted" },
  { type: "Cycle.create", description: "A cycle was created" },
  { type: "Cycle.update", description: "A cycle changed" },
  { type: "IssueLabel.create", description: "A label was created" },
  { type: "Reaction.create", description: "Someone reacted to an issue or comment" },
];

const SENTRY_ISSUE_FIELDS: Array<[string, string]> = [
  ["data.issue.project.slug", "The Sentry project"],
  ["data.issue.level", "error, warning, info or fatal"],
  ["data.issue.status", "The issue status"],
];

const SENTRY_TYPES: CatalogEntry[] = [
  { type: "issue.created", description: "A new issue was first seen", fields: SENTRY_ISSUE_FIELDS },
  { type: "issue.resolved", description: "An issue was resolved", fields: SENTRY_ISSUE_FIELDS },
  {
    type: "issue.unresolved",
    description: "A resolved issue came back",
    fields: SENTRY_ISSUE_FIELDS,
  },
  { type: "issue.assigned", description: "An issue was assigned", fields: SENTRY_ISSUE_FIELDS },
  { type: "issue.archived", description: "An issue was archived", fields: SENTRY_ISSUE_FIELDS },
  { type: "error.created", description: "An error event was recorded" },
  { type: "event_alert.triggered", description: "An issue alert rule fired" },
  { type: "metric_alert.critical", description: "A metric alert became critical" },
  { type: "metric_alert.warning", description: "A metric alert reached its warning level" },
  { type: "metric_alert.resolved", description: "A metric alert resolved" },
  { type: "comment.created", description: "Someone commented on an issue" },
];

const CATALOG: Partial<Record<WebhookEventAdapter, CatalogEntry[]>> = {
  linear: LINEAR_TYPES,
  sentry: SENTRY_TYPES,
};

function descriptor(entry: CatalogEntry): EventTypeDescriptor {
  return {
    type: entry.type,
    description: entry.description,
    fields: (entry.fields ?? []).map(([field, description]) => ({ field, description })),
    argumentsSchema: null,
    available: true,
    unavailableReason: null,
    unavailableReasonCode: null,
    unavailableReasonDetail: null,
  };
}

/**
 * A webhook source's event types: the adapter's known types, then any other
 * type the source delivered recently.
 */
export function webhookEventTypeCatalog(
  adapter: WebhookEventAdapter,
  recent: ReadonlyArray<{ type: string; count: number }>,
): EventTypeDescriptor[] {
  const known = (CATALOG[adapter] ?? []).map(descriptor);
  const seen = new Set(known.map((entry) => entry.type));
  const observed = recent
    .filter((entry) => !seen.has(entry.type))
    .map((entry) =>
      descriptor({
        type: entry.type,
        description: `Received ${entry.count} time${entry.count === 1 ? "" : "s"} recently`,
      }),
    );
  return [...known, ...observed];
}

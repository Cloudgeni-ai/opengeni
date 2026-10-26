import {
  webhookPresetOf,
  type EventTypeDescriptor,
  type WebhookEventAdapter,
} from "@opengeni/contracts";

/**
 * The event types a webhook preset's app is known to send, for trigger
 * pickers and agents. Standard webhooks and formats written out by hand name
 * their own types, so their catalog is the types the source actually
 * delivered recently.
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

const TAILSCALE_DEVICE_FIELDS: Array<[string, string]> = [
  ["data.deviceName", "The device's name, such as laptop.example.ts.net"],
  ["data.nodeID", "The device's node ID"],
  ["data.managedBy", "Who the device belongs to"],
  ["data.actor", "Who made the change"],
];

const TAILSCALE_KEY_FIELDS: Array<[string, string]> = [
  ...TAILSCALE_DEVICE_FIELDS,
  ["data.expiration", "When the device's key expires"],
];

const TAILSCALE_TYPES: CatalogEntry[] = [
  {
    type: "nodeCreated",
    description: "A device was added to the tailnet",
    fields: TAILSCALE_DEVICE_FIELDS,
  },
  {
    type: "nodeNeedsApproval",
    description: "A device is waiting for an admin to approve it",
    fields: TAILSCALE_DEVICE_FIELDS,
  },
  { type: "nodeApproved", description: "A device was approved", fields: TAILSCALE_DEVICE_FIELDS },
  {
    type: "nodeDeleted",
    description: "A device was removed, including ephemeral devices removed automatically",
    fields: TAILSCALE_DEVICE_FIELDS,
  },
  {
    type: "nodeKeyExpiringInOneDay",
    description: "A device's key expires in less than a day",
    fields: TAILSCALE_KEY_FIELDS,
  },
  { type: "nodeKeyExpired", description: "A device's key expired", fields: TAILSCALE_KEY_FIELDS },
  {
    type: "nodeNeedsSignature",
    description: "A device needs a signature from a trusted device (Tailnet Lock)",
    fields: TAILSCALE_DEVICE_FIELDS,
  },
  {
    type: "nodeSigned",
    description: "A trusted device signed a device (Tailnet Lock)",
    fields: TAILSCALE_DEVICE_FIELDS,
  },
  {
    type: "policyUpdate",
    description: "The tailnet policy file changed",
    fields: [
      ["data.actor", "Who changed it"],
      ["data.newPolicy", "The new policy file"],
      ["data.oldPolicy", "The policy file before the change"],
    ],
  },
  { type: "userCreated", description: "A user was added to the tailnet" },
  { type: "userNeedsApproval", description: "A user is waiting for an admin to approve them" },
  { type: "userApproved", description: "A user was approved" },
  {
    type: "userRoleUpdated",
    description: "A user's role changed",
    fields: [
      ["data.user", "The user, by login name"],
      ["data.actor", "Who changed the role"],
      ["data.oldRoles", "The roles before, such as Member"],
      ["data.newRoles", "The roles after, such as Member and IT admin"],
    ],
  },
  {
    type: "subnetIPForwardingNotEnabled",
    description: "A subnet router has IP forwarding turned off",
  },
  {
    type: "exitNodeIPForwardingNotEnabled",
    description: "An exit node has IP forwarding turned off",
  },
  { type: "webhookUpdated", description: "This webhook was changed in Tailscale" },
  { type: "webhookDeleted", description: "This webhook was deleted in Tailscale" },
  { type: "test", description: "A test event sent from the Tailscale admin console" },
];

/**
 * The documented types of apps a custom webhook preset fills in, keyed by the
 * format's `preset`. A custom source without a known preset lists the types it
 * actually received.
 */
const PRESET_CATALOG: Record<string, CatalogEntry[]> = {
  linear: LINEAR_TYPES,
  sentry: SENTRY_TYPES,
  tailscale: TAILSCALE_TYPES,
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
 * A webhook source's event types: its preset's known types, then any other
 * type the source delivered recently.
 */
export function webhookEventTypeCatalog(
  source: { adapter: WebhookEventAdapter | null; format: { preset?: string | undefined } | null },
  recent: ReadonlyArray<{ type: string; count: number }>,
): EventTypeDescriptor[] {
  const { preset } = webhookPresetOf({ adapter: source.adapter, preset: source.format?.preset });
  const entries =
    preset !== null && Object.hasOwn(PRESET_CATALOG, preset) ? PRESET_CATALOG[preset] : [];
  const known = (entries ?? []).map(descriptor);
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

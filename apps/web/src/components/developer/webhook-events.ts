import type { WorkspaceWebhookEventType } from "@opengeni/sdk";

export type WebhookEventOption = {
  type: WorkspaceWebhookEventType;
  label: string;
  /** What happened, for the picker. */
  description: string;
};

export type WebhookEventGroup = {
  label: string;
  events: readonly WebhookEventOption[];
  /** Usage events exist only for workspace webhooks. */
  workspaceOnly?: boolean;
};

export const WEBHOOK_EVENT_GROUPS: readonly WebhookEventGroup[] = [
  {
    label: "Work",
    events: [
      {
        type: "turn.completed",
        label: "Turn completed",
        description: "The agent finished replying to a message.",
      },
      {
        type: "turn.failed",
        label: "Turn failed",
        description: "A reply stopped with an error.",
      },
      {
        type: "turn.cancelled",
        label: "Turn cancelled",
        description: "Someone stopped a reply.",
      },
      {
        type: "session.status.changed",
        label: "Status changed",
        description: "A chat started, finished or began waiting.",
      },
    ],
  },
  {
    label: "Needs someone",
    events: [
      {
        type: "session.requiresAction",
        label: "Needs approval",
        description: "The agent waits for someone to approve a tool.",
      },
      {
        type: "session.humanInput.requested",
        label: "Question for the user",
        description: "The agent asked a question and waits for the answer.",
      },
    ],
  },
  {
    label: "Usage",
    workspaceOnly: true,
    events: [
      {
        type: "usage.threshold_reached",
        label: "Usage threshold reached",
        description: "An allowance passed one of its warning levels.",
      },
      {
        type: "usage.exhausted",
        label: "Usage used up",
        description: "An allowance ran out, so new work is refused.",
      },
      {
        type: "usage.period_reset",
        label: "Usage period reset",
        description: "An allowance started a new period.",
      },
    ],
  },
];

const ALL_EVENTS = WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events);

export const DEFAULT_WEBHOOK_EVENTS: readonly WorkspaceWebhookEventType[] = [
  "turn.completed",
  "turn.failed",
  "session.requiresAction",
  "session.humanInput.requested",
];

export function webhookEventLabel(type: string): string {
  if (type === "webhook.test") return "Test event";
  return ALL_EVENTS.find((event) => event.type === type)?.label ?? type;
}

/** "Turn completed, Turn failed and 2 more", for a row's one line. */
export function webhookEventsSummary(types: readonly string[], shown = 2): string {
  const labels = WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events)
    .filter((event) => types.includes(event.type))
    .map((event) => event.label);
  const unknown = types.filter((type) => !ALL_EVENTS.some((event) => event.type === type));
  const all = [...labels, ...unknown];
  if (all.length <= shown + 1) return all.join(", ");
  return `${all.slice(0, shown).join(", ")} and ${all.length - shown} more`;
}

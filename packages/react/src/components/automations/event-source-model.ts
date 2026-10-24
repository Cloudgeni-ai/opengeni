/**
 * Event sources in the product's words: what each kind is, where its events
 * come from, its status, and its deliveries. Pure.
 */
import type {
  CreateEventSourceRequest,
  EventActor,
  EventDelivery,
  EventSource,
  WebhookEventAdapter,
} from "@opengeni/sdk";

import type { ProductStatus } from "../../ui/status-badge";

/** What a person picks when adding a source. One per kind and webhook adapter. */
export type EventSourceChoice =
  | "webhook"
  | "linear"
  | "sentry"
  | "github"
  | "slack"
  | "gmail"
  | "mcp";

export interface EventSourceChoiceMeta {
  choice: EventSourceChoice;
  /** "GitHub", "Linear", "Your own app". */
  name: string;
  /** One sentence: what arrives and how it connects. */
  description: string;
  /** For the brand logo, when the host has one. */
  providerDomain: string | null;
  /** How it connects: Opengeni sets it up, or a person pastes a URL and secret. */
  setup: "automatic" | "paste";
  /** Who can see it and its events. */
  audience: "workspace" | "personal" | "choice";
}

export const EVENT_SOURCE_CHOICES: readonly EventSourceChoiceMeta[] = [
  {
    choice: "github",
    name: "GitHub",
    description:
      "Pull requests, issues, pushes, reviews and checks in the repositories you connected.",
    providerDomain: "github.com",
    setup: "automatic",
    audience: "workspace",
  },
  {
    choice: "slack",
    name: "Slack",
    description: "Mentions, messages and reactions in channels the Opengeni bot is in.",
    providerDomain: "slack.com",
    setup: "automatic",
    audience: "workspace",
  },
  {
    choice: "gmail",
    name: "Gmail",
    description: "New messages in your connected mailbox. Only you can see them.",
    providerDomain: "mail.google.com",
    setup: "automatic",
    audience: "personal",
  },
  {
    choice: "linear",
    name: "Linear",
    description: "Issues, comments and projects. You paste a webhook URL into Linear once.",
    providerDomain: "linear.app",
    setup: "paste",
    audience: "choice",
  },
  {
    choice: "sentry",
    name: "Sentry",
    description: "New and changed issues and alerts. You paste a webhook URL into Sentry once.",
    providerDomain: "sentry.io",
    setup: "paste",
    audience: "choice",
  },
  {
    choice: "mcp",
    name: "MCP server",
    description:
      "Events from a connected MCP server that offers them, such as new tickets or orders.",
    providerDomain: null,
    setup: "automatic",
    audience: "personal",
  },
  {
    choice: "webhook",
    name: "Your own app",
    description: "Anything that can send a signed webhook, using the Standard Webhooks format.",
    providerDomain: null,
    setup: "paste",
    audience: "choice",
  },
];

export function eventSourceChoiceMeta(choice: EventSourceChoice): EventSourceChoiceMeta {
  return EVENT_SOURCE_CHOICES.find((entry) => entry.choice === choice)!;
}

/** True for a known choice, for example a `?kind=` link parameter. */
export function isEventSourceChoice(value: unknown): value is EventSourceChoice {
  return EVENT_SOURCE_CHOICES.some((entry) => entry.choice === value);
}

export function eventSourceChoiceOf(
  source: Pick<EventSource, "kind" | "adapter">,
): EventSourceChoice {
  if (source.kind !== "webhook") return source.kind;
  return source.adapter === "linear" || source.adapter === "sentry" ? source.adapter : "webhook";
}

export const WEBHOOK_ADAPTER_OF: Partial<Record<EventSourceChoice, WebhookEventAdapter>> = {
  webhook: "standard",
  linear: "linear",
  sentry: "sentry",
};

/** A stand-in source of the chosen kind, for its tile before one exists. */
export function eventSourceSubjectOfChoice(
  choice: EventSourceChoice,
): Pick<EventSource, "kind" | "adapter" | "name" | "mcp"> {
  const adapter = WEBHOOK_ADAPTER_OF[choice] ?? null;
  return {
    kind: adapter
      ? "webhook"
      : (choice as Exclude<EventSourceChoice, "webhook" | "linear" | "sentry">),
    adapter,
    name: eventSourceChoiceMeta(choice).name,
    mcp: null,
  };
}

/** What adding one is called: "Add GitHub", "Add a webhook". */
export function eventSourceAddLabel(choice: EventSourceChoice): string {
  if (choice === "webhook") return "Add a webhook";
  if (choice === "mcp") return "Add an MCP server";
  return `Add ${eventSourceChoiceMeta(choice).name}`;
}

/** "GitHub", "Linear webhook", "Webhook", "MCP server": the kind, not the name. */
export function eventSourceKindLabel(source: Pick<EventSource, "kind" | "adapter">): string {
  const choice = eventSourceChoiceOf(source);
  if (choice === "linear") return "Linear webhook";
  if (choice === "sentry") return "Sentry webhook";
  if (choice === "webhook") return "Webhook";
  return eventSourceChoiceMeta(choice).name;
}

/** The domain whose logo stands for the source, when it has one. */
export function eventSourceProviderDomain(
  source: Pick<EventSource, "kind" | "adapter">,
): string | null {
  return eventSourceChoiceMeta(eventSourceChoiceOf(source)).providerDomain;
}

/** The badge a source's row shows; a healthy source shows none. */
export function eventSourceStatusBadge(
  source: Pick<EventSource, "status" | "statusReason">,
): { status: ProductStatus; label: string; reason: string | null } | null {
  if (source.status === "blocked") {
    return { status: "needs_you", label: "Needs attention", reason: source.statusReason };
  }
  if (source.status === "disabled") {
    return { status: "off", label: "Off", reason: source.statusReason };
  }
  return null;
}

/** How a pasted webhook is connected: the app gets the URL, Opengeni gets its secret. */
export interface PastedWebhookSetup {
  /** "Linear". */
  app: string;
  /** What the app calls the secret: "signing secret", "client secret". */
  secretName: string;
  /** Where to paste the URL in the app, in one sentence. */
  urlStep: string;
  /** Where the app shows the secret, in one sentence. */
  secretStep: string;
}

export function pastedWebhookSetup(
  source: Pick<EventSource, "kind" | "adapter">,
): PastedWebhookSetup | null {
  if (source.kind !== "webhook") return null;
  if (source.adapter === "linear") {
    return {
      app: "Linear",
      secretName: "signing secret",
      urlStep:
        "In Linear, open Settings, then API, and add a webhook with this URL. Pick what it sends, such as issues and comments.",
      secretStep: "Linear then shows the webhook's signing secret. Copy it and paste it here.",
    };
  }
  if (source.adapter === "sentry") {
    return {
      app: "Sentry",
      secretName: "client secret",
      urlStep:
        "In Sentry, open Settings, then Custom Integrations, and create an internal integration with this webhook URL. Turn on the issue and alert events you want.",
      secretStep: "Sentry then shows the integration's client secret. Copy it and paste it here.",
    };
  }
  return null;
}

/** The request that adds a source of the chosen kind. */
export function createEventSourceRequest(input: {
  choice: EventSourceChoice;
  name: string;
  visibility: "private" | "workspace";
  signingSecret?: string | undefined;
  mcpServerId?: string | undefined;
  connectionId?: string | undefined;
}): CreateEventSourceRequest {
  const name = input.name.trim();
  const adapter = WEBHOOK_ADAPTER_OF[input.choice];
  if (adapter) {
    return {
      kind: "webhook",
      adapter,
      name: name || eventSourceChoiceMeta(input.choice).name,
      visibility: input.visibility,
      ...(adapter !== "standard" && input.signingSecret
        ? { signingSecret: input.signingSecret.trim() }
        : {}),
    };
  }
  if (input.choice === "mcp") {
    return {
      kind: "mcp",
      serverId: input.mcpServerId ?? "",
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (input.choice === "gmail") {
    return {
      kind: "gmail",
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(name ? { name } : {}),
    };
  }
  return { kind: input.choice as "github" | "slack", ...(name ? { name } : {}) };
}

/* ----------------------------------------------------------------------------
   Deliveries and events.
   -------------------------------------------------------------------------- */

export const EVENT_DELIVERY_STATUS: Record<
  EventDelivery["status"],
  { status: ProductStatus; label: string }
> = {
  accepted: { status: "succeeded", label: "Accepted" },
  ignored: { status: "off", label: "Ignored" },
  rejected: { status: "failed", label: "Rejected" },
  failed: { status: "failed", label: "Failed" },
};

/** "3 events", "No events", "1 event". */
export function deliveryEventsLabel(delivery: Pick<EventDelivery, "eventIds">): string {
  const count = delivery.eventIds.length;
  if (count === 0) return "No events";
  return count === 1 ? "1 event" : `${count} events`;
}

/** "1.2 KB". */
export function byteSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Who caused an event, in words; null when unknown. */
export function eventActorLabel(actor: EventActor): string | null {
  if (actor.kind === "opengeni") return actor.name ? `${actor.name} (Opengeni)` : "Opengeni";
  if (actor.name) return actor.kind === "bot" ? `${actor.name} (bot)` : actor.name;
  return actor.kind === "bot" ? "A bot" : null;
}

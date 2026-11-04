/**
 * Event sources in the product's words: what each kind is, where its events
 * come from, its status, and its deliveries. Pure; text comes from the host's
 * message catalog through the `t` each function takes first.
 */
import type {
  CreateEventSourceRequest,
  EventActor,
  EventDelivery,
  EventSource,
  WebhookEventAdapter,
} from "@opengeni/sdk";
import {
  isEventStatusReasonCode,
  WEBHOOK_FORMAT_PRESETS,
  webhookPresetOf,
  type EventStatusReasonCode,
  type WebhookFormatPreset,
} from "@opengeni/contracts/event-triggers";

import type { OpenGeniText } from "../../messages/runtime";
import type { ProductStatus } from "../../ui/status-badge";
import { eventTypeLabel } from "./event-trigger-model";

/** What a person picks when adding a source. One per kind and webhook adapter. */
export type EventSourceChoice =
  | "webhook"
  | "linear"
  | "sentry"
  | "tailscale"
  | "github"
  | "slack"
  | "gmail"
  | "mcp"
  | "workspace";

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

type EventSourceChoiceFacts = Omit<EventSourceChoiceMeta, "name" | "description">;

/** Every choice in the order "Add a source" offers them. */
const CHOICE_FACTS: readonly EventSourceChoiceFacts[] = [
  { choice: "workspace", providerDomain: null, setup: "automatic", audience: "personal" },
  { choice: "github", providerDomain: "github.com", setup: "automatic", audience: "workspace" },
  { choice: "slack", providerDomain: "slack.com", setup: "automatic", audience: "workspace" },
  { choice: "gmail", providerDomain: "mail.google.com", setup: "automatic", audience: "personal" },
  { choice: "linear", providerDomain: "linear.app", setup: "paste", audience: "choice" },
  { choice: "sentry", providerDomain: "sentry.io", setup: "paste", audience: "choice" },
  { choice: "tailscale", providerDomain: "tailscale.com", setup: "paste", audience: "choice" },
  { choice: "mcp", providerDomain: null, setup: "automatic", audience: "personal" },
  { choice: "webhook", providerDomain: null, setup: "paste", audience: "choice" },
];

function choiceFacts(choice: EventSourceChoice): EventSourceChoiceFacts {
  // A kind from a newer server than this client still shows, plainly.
  return (
    CHOICE_FACTS.find((entry) => entry.choice === choice) ?? {
      choice,
      providerDomain: null,
      setup: "automatic",
      audience: "personal",
    }
  );
}

/** The choice's name: the app's own name, or what the kind is called. */
export function eventSourceChoiceName(t: OpenGeniText, choice: EventSourceChoice): string {
  switch (choice) {
    case "github":
      return "GitHub";
    case "slack":
      return "Slack";
    case "gmail":
      return "Gmail";
    case "linear":
      return "Linear";
    case "sentry":
      return "Sentry";
    case "tailscale":
      return "Tailscale";
    case "mcp":
      return t("automations.source.mcp.name");
    case "webhook":
      return t("automations.source.webhook.name");
    case "workspace":
      return t("automations.source.workspace.name");
    default:
      return String(choice);
  }
}

function choiceDescription(t: OpenGeniText, choice: EventSourceChoice): string {
  switch (choice) {
    case "github":
      return t("automations.source.github.description");
    case "slack":
      return t("automations.source.slack.description");
    case "gmail":
      return t("automations.source.gmail.description");
    case "linear":
      return t("automations.source.linear.description");
    case "sentry":
      return t("automations.source.sentry.description");
    case "tailscale":
      return t("automations.source.tailscale.description");
    case "mcp":
      return t("automations.source.mcp.description");
    case "webhook":
      return t("automations.source.webhook.description");
    case "workspace":
      return t("automations.source.workspace.description");
    default:
      return "";
  }
}

export function eventSourceChoiceMeta(
  t: OpenGeniText,
  choice: EventSourceChoice,
): EventSourceChoiceMeta {
  return {
    ...choiceFacts(choice),
    name: eventSourceChoiceName(t, choice),
    description: choiceDescription(t, choice),
  };
}

/** Every kind of source a person can add, in the order to offer them. */
export function eventSourceChoices(t: OpenGeniText): EventSourceChoiceMeta[] {
  return CHOICE_FACTS.map((facts) => eventSourceChoiceMeta(t, facts.choice));
}

/** True for a known choice, for example a `?kind=` link parameter. */
export function isEventSourceChoice(value: unknown): value is EventSourceChoice {
  return CHOICE_FACTS.some((entry) => entry.choice === value);
}

/**
 * Apps whose own webhook a person pastes a URL into: each is a custom webhook
 * made with the app's preset.
 */
const APP_WEBHOOK_CHOICES = ["linear", "sentry", "tailscale"] as const;
type AppWebhookChoice = (typeof APP_WEBHOOK_CHOICES)[number];

function isAppWebhookChoice(value: unknown): value is AppWebhookChoice {
  return APP_WEBHOOK_CHOICES.includes(value as AppWebhookChoice);
}

/** The custom webhook preset each app choice is made with. */
const PRESET_OF: Record<AppWebhookChoice, WebhookFormatPreset> = {
  linear: "linear",
  sentry: "sentry",
  tailscale: "tailscale",
};

/** The facts about a source that say which choice it is. */
export type EventSourceChoiceSubject = Pick<EventSource, "kind" | "adapter"> & {
  format?:
    | {
        preset?: string | undefined;
        signature?: { scheme: string; parameter?: string | undefined } | undefined;
      }
    | null
    | undefined;
};

/**
 * The choice a source is: its kind, its app for a custom webhook made with an
 * app's preset (or a server's older `linear` or `sentry` adapter), else a
 * webhook.
 */
export function eventSourceChoiceOf(source: EventSourceChoiceSubject): EventSourceChoice {
  if (source.kind !== "webhook") return source.kind;
  const { preset } = webhookPresetOf({ adapter: source.adapter, preset: source.format?.preset });
  return isAppWebhookChoice(preset) ? preset : "webhook";
}

export const WEBHOOK_ADAPTER_OF: Partial<Record<EventSourceChoice, WebhookEventAdapter>> = {
  webhook: "standard",
  linear: "custom",
  sentry: "custom",
  tailscale: "custom",
};

/** A stand-in source of the chosen kind, for its tile before one exists. */
export function eventSourceSubjectOfChoice(
  t: OpenGeniText,
  choice: EventSourceChoice,
): Pick<EventSource, "kind" | "adapter" | "name" | "mcp"> & {
  format: { preset: string } | null;
} {
  const adapter = WEBHOOK_ADAPTER_OF[choice] ?? null;
  const preset = isAppWebhookChoice(choice) ? PRESET_OF[choice] : undefined;
  return {
    kind: adapter
      ? "webhook"
      : (choice as Exclude<EventSourceChoice, "webhook" | AppWebhookChoice>),
    adapter,
    format: preset ? { preset } : null,
    name: eventSourceChoiceName(t, choice),
    mcp: null,
  };
}

/** What adding one is called: "Add GitHub", "Add a webhook". */
export function eventSourceAddLabel(t: OpenGeniText, choice: EventSourceChoice): string {
  if (choice === "webhook") return t("automations.source.addWebhook");
  if (choice === "mcp") return t("automations.source.addMcp");
  if (choice === "workspace") return t("automations.source.addWorkspace");
  return t("automations.source.add", { name: eventSourceChoiceName(t, choice) });
}

/**
 * "GitHub", "Linear webhook", "Webhook", "MCP server", "Workspace events": the
 * kind, not the name.
 */
export function eventSourceKindLabel(t: OpenGeniText, source: EventSourceChoiceSubject): string {
  const choice = eventSourceChoiceOf(source);
  if (isAppWebhookChoice(choice))
    return t("automations.source.kind.appWebhook", { app: eventSourceChoiceName(t, choice) });
  if (choice === "webhook") return t("automations.source.kind.webhook");
  if (choice === "workspace") return t("automations.source.kind.workspace");
  return eventSourceChoiceName(t, choice);
}

/** The domain whose logo stands for the source, when it has one. */
export function eventSourceProviderDomain(source: EventSourceChoiceSubject): string | null {
  return choiceFacts(eventSourceChoiceOf(source)).providerDomain;
}

/**
 * Why a source or trigger is held back, or why a source can't send an event
 * type, as the server reported it: a code, the same reason as an English
 * sentence, and what the app or server said, when it said something.
 */
export interface EventStatusReasonParts {
  /** The server's sentence, shown when the code is missing or unknown here. */
  text: string | null;
  code?: string | null | undefined;
  detail?: string | null | undefined;
}

type SourceNamedReason = Exclude<
  EventStatusReasonCode,
  | "turned_off"
  | "awaiting_secret"
  | "connector_removed"
  | "account_changed"
  | "github_event_not_subscribed"
>;

const SOURCE_NAMED_REASONS: Record<SourceNamedReason, (t: OpenGeniText, source: string) => string> =
  {
    reconnect: (t, source) => t("automations.statusReason.reconnect", { source }),
    missing_permission: (t, source) => t("automations.statusReason.missingPermission", { source }),
    app_not_enabled: (t, source) => t("automations.statusReason.appNotEnabled", { source }),
    host_sign_in: (t, source) => t("automations.statusReason.hostSignIn", { source }),
    events_unsupported: (t, source) => t("automations.statusReason.eventsUnsupported", { source }),
    event_type_gone: (t, source) => t("automations.statusReason.eventTypeGone", { source }),
    forbidden: (t, source) => t("automations.statusReason.forbidden", { source }),
    invalid_arguments: (t, source) => t("automations.statusReason.invalidArguments", { source }),
    needs_public_address: (t, source) =>
      t("automations.statusReason.needsPublicAddress", { source }),
    push_only: (t, source) => t("automations.statusReason.pushOnly", { source }),
    delivery_mode_unsupported: (t, source) =>
      t("automations.statusReason.deliveryModeUnsupported", { source }),
    callback_unreachable: (t, source) =>
      t("automations.statusReason.callbackUnreachable", { source }),
    not_answering: (t, source) => t("automations.statusReason.notAnswering", { source }),
    unavailable: (t, source) => t("automations.statusReason.unavailable", { source }),
  };

/** Codes whose detail is what the app or server said, quoted after the reason. */
const QUOTES_DETAIL: ReadonlySet<EventStatusReasonCode> = new Set([
  "forbidden",
  "invalid_arguments",
  "callback_unreachable",
]);

/**
 * A held-back reason in the viewer's language. Known codes are worded from
 * the catalog, naming the source when `sourceName` is given; anything else,
 * such as a code from a newer server, shows the server's sentence.
 */
export function eventStatusReasonText(
  t: OpenGeniText,
  reason: EventStatusReasonParts,
  sourceName?: string | null,
): string | null {
  const code = reason.code;
  if (!isEventStatusReasonCode(code)) return reason.text;
  const detail = reason.detail?.trim() || null;
  const source = sourceName?.trim() || null;
  switch (code) {
    case "turned_off":
      return t("automations.statusReason.turnedOff");
    case "awaiting_secret":
      return t("automations.statusReason.awaitingSecret");
    case "connector_removed":
      return t("automations.statusReason.connectorRemoved");
    case "github_event_not_subscribed":
      return detail
        ? t("automations.statusReason.githubEventNotSubscribed", { event: detail })
        : reason.text;
    case "account_changed":
      return detail && source
        ? t("automations.statusReason.accountChanged", { source, account: detail })
        : reason.text;
  }
  if (!source) return reason.text;
  const sentence = SOURCE_NAMED_REASONS[code](t, source);
  return detail && QUOTES_DETAIL.has(code)
    ? t("automations.statusReason.withDetail", { reason: sentence, detail })
    : sentence;
}

/**
 * The badge a source's or trigger's row shows; a healthy one shows none.
 * `sourceName` names the source in the reason; a source's own name is used
 * when the item is a source.
 */
export function eventSourceStatusBadge(
  t: OpenGeniText,
  item: Pick<EventSource, "status" | "statusReason"> &
    Partial<Pick<EventSource, "statusReasonCode" | "statusReasonDetail" | "name">>,
  sourceName?: string | null,
): { status: ProductStatus; label: string; reason: string | null } | null {
  const reason = () =>
    eventStatusReasonText(
      t,
      { text: item.statusReason, code: item.statusReasonCode, detail: item.statusReasonDetail },
      sourceName ?? item.name,
    );
  if (item.status === "blocked") {
    return {
      status: "needs_you",
      label: t("automations.source.status.blocked"),
      reason: reason(),
    };
  }
  if (item.status === "disabled") {
    return {
      status: "off",
      label: t("automations.source.status.off"),
      reason: reason(),
    };
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
  t: OpenGeniText,
  source: EventSourceChoiceSubject,
): PastedWebhookSetup | null {
  if (source.kind !== "webhook") return null;
  const app = eventSourceChoiceOf(source);
  if (!isAppWebhookChoice(app)) {
    if (source.adapter !== "custom") return null;
    // Any other app's webhook: the same two steps, in that app's settings,
    // worded for how it proves a delivery is its own.
    const signature = source.format?.signature;
    const scheme = signature?.scheme;
    if (scheme === "url_token") {
      return {
        app: t("automations.paste.custom.app"),
        secretName: t("automations.paste.urlToken.secretName"),
        urlStep: t("automations.paste.urlToken.urlStep", {
          parameter: signature?.parameter ?? "token",
        }),
        secretStep: t("automations.paste.urlToken.secretStep"),
      };
    }
    if (scheme === "ed25519") {
      return {
        app: t("automations.paste.custom.app"),
        secretName: t("automations.paste.publicKey.secretName"),
        urlStep: t("automations.paste.custom.urlStep"),
        secretStep: t("automations.paste.publicKey.secretStep"),
      };
    }
    return {
      app: t("automations.paste.custom.app"),
      secretName: t("automations.paste.custom.secretName"),
      urlStep: t("automations.paste.custom.urlStep"),
      secretStep: t("automations.paste.custom.secretStep"),
    };
  }
  return { app: eventSourceChoiceName(t, app), ...APP_PASTE_STEPS[app](t) };
}

/** Each app's paste wording, with literal catalog keys so key usage stays checkable. */
const APP_PASTE_STEPS: Record<
  AppWebhookChoice,
  (t: OpenGeniText) => Omit<PastedWebhookSetup, "app">
> = {
  linear: (t) => ({
    secretName: t("automations.paste.linear.secretName"),
    urlStep: t("automations.paste.linear.urlStep"),
    secretStep: t("automations.paste.linear.secretStep"),
  }),
  sentry: (t) => ({
    secretName: t("automations.paste.sentry.secretName"),
    urlStep: t("automations.paste.sentry.urlStep"),
    secretStep: t("automations.paste.sentry.secretStep"),
  }),
  tailscale: (t) => ({
    secretName: t("automations.paste.tailscale.secretName"),
    urlStep: t("automations.paste.tailscale.urlStep"),
    secretStep: t("automations.paste.tailscale.secretStep"),
  }),
};

/** The request that adds a source of the chosen kind; an unnamed webhook takes the kind's name. */
export function createEventSourceRequest(
  t: OpenGeniText,
  input: {
    choice: EventSourceChoice;
    name: string;
    visibility: "private" | "workspace";
    signingSecret?: string | undefined;
    mcpServerId?: string | undefined;
    connectionId?: string | undefined;
  },
): CreateEventSourceRequest {
  const name = input.name.trim();
  const adapter = WEBHOOK_ADAPTER_OF[input.choice];
  if (adapter) {
    const preset = isAppWebhookChoice(input.choice) ? PRESET_OF[input.choice] : undefined;
    return {
      kind: "webhook",
      adapter,
      name: name || eventSourceChoiceName(t, input.choice),
      visibility: input.visibility,
      ...(preset ? { format: WEBHOOK_FORMAT_PRESETS[preset] } : {}),
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
  if (input.choice === "workspace") return { kind: "workspace", ...(name ? { name } : {}) };
  return { kind: input.choice as "github" | "slack", ...(name ? { name } : {}) };
}

/* ----------------------------------------------------------------------------
   Deliveries and events.
   -------------------------------------------------------------------------- */

/** What became of a delivery, as its badge. */
export function eventDeliveryStatusBadge(
  t: OpenGeniText,
  status: EventDelivery["status"],
): { status: ProductStatus; label: string } {
  switch (status) {
    case "accepted":
      return { status: "succeeded", label: t("automations.delivery.accepted") };
    case "ignored":
      return { status: "off", label: t("automations.delivery.ignored") };
    case "rejected":
      return { status: "failed", label: t("automations.delivery.rejected") };
    case "failed":
      return { status: "failed", label: t("automations.delivery.failed") };
  }
}

/** "3 events", "No events", "1 event". */
export function deliveryEventsLabel(
  t: OpenGeniText,
  delivery: Pick<EventDelivery, "eventIds">,
): string {
  const count = delivery.eventIds.length;
  if (count === 0) return t("automations.delivery.noEvents");
  return t("automations.delivery.events", { count });
}

/**
 * What a delivery became, as its row's title: "pull_request.opened",
 * "issues.opened and issue_comment.created", "push and 2 more", or the count
 * when the server does not say which types.
 */
export function deliveryTitle(
  t: OpenGeniText,
  delivery: Pick<EventDelivery, "eventIds"> & { eventTypes?: readonly string[] | undefined },
): string {
  const types = delivery.eventTypes ?? [];
  if (types.length === 0) return deliveryEventsLabel(t, delivery);
  const [first, second] = types as [string, ...string[]];
  if (types.length === 1) return eventTypeLabel(t, first);
  if (types.length === 2)
    return t("automations.delivery.titleTwo", {
      first: eventTypeLabel(t, first),
      second: eventTypeLabel(t, second!),
    });
  return t("automations.eventTypes.firstAndMore", {
    first: eventTypeLabel(t, first),
    count: types.length - 1,
  });
}

/** "1.2 KB", with the host locale's decimal separator. */
export function byteSizeLabel(t: OpenGeniText, bytes: number): string {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(t.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  if (bytes < 1024) return t("automations.bytes.bytes", { size: number(bytes, 0) });
  if (bytes < 1024 * 1024)
    return t("automations.bytes.kilobytes", {
      size: number(bytes / 1024, bytes < 10 * 1024 ? 1 : 0),
    });
  return t("automations.bytes.megabytes", { size: number(bytes / (1024 * 1024), 1) });
}

/** Who caused an event, in words; null when unknown. */
export function eventActorLabel(t: OpenGeniText, actor: EventActor): string | null {
  if (actor.kind === "opengeni")
    return actor.name
      ? t("automations.actor.selfNamed", { name: actor.name })
      : t("automations.actor.self");
  if (actor.name)
    return actor.kind === "bot"
      ? t("automations.actor.botNamed", { name: actor.name })
      : actor.name;
  return actor.kind === "bot" ? t("automations.actor.bot") : null;
}

import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Event sources, normalized events and event triggers.
 *
 * An event source delivers events into a workspace: a webhook endpoint a person
 * pastes into another app, an app Opengeni receives events from directly, or an
 * MCP connection whose server offers the MCP Events extension. Every source
 * produces the same normalized event. An automation (a scheduled task) runs
 * when one of its event triggers matches an event.
 *
 * This module must not import `./index`: the scheduled-task schemas there
 * embed these schemas.
 */

/**
 * `workspace` is "This workspace": things that happen in Opengeni itself, such
 * as a meeting's transcript becoming ready, as one person may see them.
 */
export const EVENT_SOURCE_KINDS = [
  "webhook",
  "github",
  "slack",
  "gmail",
  "mcp",
  "workspace",
] as const;
export const EventSourceKind = /* @__PURE__ */ defineSchema(() => z.enum(EVENT_SOURCE_KINDS));
export type EventSourceKind = z.infer<typeof EventSourceKind>;

/**
 * How a webhook endpoint verifies and reads deliveries: `standard` is
 * Opengeni's own format (Standard Webhooks with an Opengeni secret), and
 * `custom` reads any app's webhooks as the source's `format` describes.
 * `linear` and `sentry` are older names for `custom` with that app's preset:
 * a request may still use them, and sources made with them read as `custom`.
 */
export const WEBHOOK_EVENT_ADAPTERS = ["standard", "linear", "sentry", "custom"] as const;
export const WebhookEventAdapter = /* @__PURE__ */ defineSchema(() =>
  z.enum(WEBHOOK_EVENT_ADAPTERS),
);
export type WebhookEventAdapter = z.infer<typeof WebhookEventAdapter>;

/** An HTTP header name, matched without regard to case. */
export const WebhookHeaderName = /* @__PURE__ */ defineSchema(() =>
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u, "A header name such as X-Signature"),
);

/** A dot-separated path into a JSON object, such as `data.object.id`. */
export const WebhookJsonPath = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .max(200)
    .regex(/^[^.\s]+(?:\.[^.\s]+)*$/u, "A dot-separated path such as data.object.id"),
);

/** Where a value comes from: a JSON path in the event, or a request header. */
export const WebhookValueSource = /* @__PURE__ */ defineSchema(() =>
  z.union([
    z.object({ path: WebhookJsonPath }).strict(),
    z.object({ header: WebhookHeaderName }).strict(),
  ]),
);
export type WebhookValueSource = z.infer<typeof WebhookValueSource>;

/** A query parameter name, such as `token`. */
export const WebhookQueryParameter = /* @__PURE__ */ defineSchema(() =>
  z.string().regex(/^[A-Za-z0-9_.~-]{1,64}$/u, "A query parameter name such as token"),
);

/**
 * The exact bytes an app signs, when it is more than the body: the raw body
 * as `{body}` (exactly once) and a request header's value as `{header:Name}`,
 * around literal text. Slack's is `v0:{header:X-Slack-Request-Timestamp}:{body}`.
 */
export const WebhookSignedContent = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(6)
    .max(200)
    .superRefine((layout, context) => {
      const parts = parseWebhookSignedContent(layout);
      if (typeof parts === "string") context.addIssue({ code: "custom", message: parts });
    }),
);

/** One piece of a signed-content layout: literal text, the raw body, or a header's value. */
export type WebhookSignedContentPart =
  | { kind: "text"; text: string }
  | { kind: "body" }
  | { kind: "header"; header: string };

const SIGNED_CONTENT_TOKEN = /\{([^{}]*)\}/gu;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u;

/**
 * The pieces of a signed-content layout, or why it is not one: `{body}` must
 * appear exactly once, and every other `{…}` must name a header.
 */
export function parseWebhookSignedContent(layout: string): WebhookSignedContentPart[] | string {
  const parts: WebhookSignedContentPart[] = [];
  let bodies = 0;
  let last = 0;
  for (const match of layout.matchAll(SIGNED_CONTENT_TOKEN)) {
    const text = layout.slice(last, match.index);
    if (/[{}]/u.test(text)) return "Braces may only wrap {body} or {header:Name}";
    if (text) parts.push({ kind: "text", text });
    const token = match[1] ?? "";
    if (token === "body") {
      bodies += 1;
      parts.push({ kind: "body" });
    } else if (token.startsWith("header:") && HEADER_NAME_PATTERN.test(token.slice(7))) {
      parts.push({ kind: "header", header: token.slice(7) });
    } else {
      return `{${token}} is neither {body} nor {header:Name}`;
    }
    last = (match.index ?? 0) + match[0].length;
  }
  const rest = layout.slice(last);
  if (/[{}]/u.test(rest)) return "Braces may only wrap {body} or {header:Name}";
  if (rest) parts.push({ kind: "text", text: rest });
  if (bodies !== 1) return "The signed content must hold {body} exactly once";
  return parts;
}

/**
 * How a custom webhook proves it came from the app, always over the exact raw
 * body and with the source's secret:
 * - `standard_webhooks`: Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 *   `webhook-signature`) with a `whsec_` secret, as Svix-based apps send.
 * - `hmac_sha256`: the HMAC-SHA256 of the body in `header`, hex or base64,
 *   after an optional `prefix` such as `sha256=`. With `signedContent`, of
 *   that layout instead of the body alone.
 * - `timestamped_hmac_sha256`: a `t=<unix seconds>,v1=<hex>` header whose
 *   signature is the HMAC-SHA256 of `<t>.<body>`, as Stripe and Tailscale
 *   send; deliveries signed more than `toleranceSeconds` away are refused.
 * - `token`: the secret itself in `header`, after an optional `prefix` such
 *   as `Bearer ` (a shared token, as GitLab sends).
 * - `ed25519`: an Ed25519 signature in `header` over the body, or over
 *   `signedContent`; the source's secret is the app's public key (hex, base64
 *   or PEM), as Discord sends.
 * - `url_token`: for apps that can't sign: the secret in the webhook address's
 *   query, as `?<parameter>=<secret>`.
 */
export const WebhookSignatureFormat = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("scheme", [
    z.object({ scheme: z.literal("standard_webhooks") }).strict(),
    z
      .object({
        scheme: z.literal("hmac_sha256"),
        header: WebhookHeaderName,
        encoding: z.enum(["hex", "base64"]).default("hex"),
        prefix: z.string().max(32).default(""),
        signedContent: WebhookSignedContent.optional(),
      })
      .strict(),
    z
      .object({
        scheme: z.literal("timestamped_hmac_sha256"),
        header: WebhookHeaderName,
        toleranceSeconds: z.number().int().min(60).max(3600).default(300),
      })
      .strict(),
    z
      .object({
        scheme: z.literal("token"),
        header: WebhookHeaderName,
        prefix: z.string().max(32).default(""),
      })
      .strict(),
    z
      .object({
        scheme: z.literal("ed25519"),
        header: WebhookHeaderName,
        encoding: z.enum(["hex", "base64"]).default("hex"),
        prefix: z.string().max(32).default(""),
        signedContent: WebhookSignedContent.optional(),
      })
      .strict(),
    z
      .object({
        scheme: z.literal("url_token"),
        parameter: WebhookQueryParameter.default("token"),
      })
      .strict(),
  ]),
);
export type WebhookSignatureFormat = z.infer<typeof WebhookSignatureFormat>;

export const EventSourceStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "disabled", "blocked"]),
);
export type EventSourceStatus = z.infer<typeof EventSourceStatus>;

/**
 * Why an event source or trigger is not active, or why a source can't send
 * an event type, as a code clients word in their own language. Each comes
 * with the same reason as an English sentence (`statusReason`,
 * `unavailableReason`) and, for some, what the app or server said
 * (`…Detail`). The wire carries a plain string: a client reads a code it
 * doesn't know, or none, as "show the sentence".
 *
 * - `turned_off`: someone turned it off.
 * - `awaiting_secret`: a pasted Linear, Sentry or custom webhook waits for its signing secret.
 * - `reconnect`: the owner's connection to the app has to be signed in again.
 * - `missing_permission`: the connection no longer allows reading what the events need.
 * - `app_not_enabled`: the app isn't turned on for the connected account.
 * - `account_changed`: the connection now signs in as another account (the detail names it).
 * - `connector_removed`: the app or connector is no longer added to the workspace.
 * - `host_sign_in`: the server signs in through the app that embeds Opengeni, which automations can't use.
 * - `events_unsupported`: the server doesn't offer events.
 * - `event_type_gone`: the server no longer offers this event type.
 * - `forbidden`: the server won't let the owner's account receive these events with these settings.
 * - `invalid_arguments`: the server rejected the trigger's subscription arguments.
 * - `needs_public_address`: the server sends this type only to a public https address, which the deployment lacks.
 * - `push_only`: the server sends this type only over a held-open connection, which isn't supported yet.
 * - `delivery_mode_unsupported`: the server won't send this type in a way the deployment can receive.
 * - `callback_unreachable`: the server can't reach the deployment's webhook address.
 * - `not_answering`: the app or server hasn't answered for over an hour.
 * - `github_event_not_subscribed`: the GitHub App isn't subscribed to the event (the detail names it).
 * - `unavailable`: the source can't receive events for another reason.
 */
export const EVENT_STATUS_REASON_CODES = [
  "turned_off",
  "awaiting_secret",
  "reconnect",
  "missing_permission",
  "app_not_enabled",
  "account_changed",
  "connector_removed",
  "host_sign_in",
  "events_unsupported",
  "event_type_gone",
  "forbidden",
  "invalid_arguments",
  "needs_public_address",
  "push_only",
  "delivery_mode_unsupported",
  "callback_unreachable",
  "not_answering",
  "github_event_not_subscribed",
  "unavailable",
] as const;
export type EventStatusReasonCode = (typeof EVENT_STATUS_REASON_CODES)[number];

/** Whether `code` is one this version of the contract knows. */
export function isEventStatusReasonCode(code: unknown): code is EventStatusReasonCode {
  return (
    typeof code === "string" && (EVENT_STATUS_REASON_CODES as readonly string[]).includes(code)
  );
}

/** Who can use a source and see its events: only its owner, or the workspace. */
export const EventSourceVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["private", "workspace"]),
);
export type EventSourceVisibility = z.infer<typeof EventSourceVisibility>;

export const EVENT_SOURCE_NAME_MAX_LENGTH = 120;
export const EVENT_TYPE_MAX_LENGTH = 200;
export const EVENT_SUMMARY_MAX_LENGTH = 500;
export const EVENT_SUBJECT_MAX_LENGTH = 300;
/** Serialized UTF-8 bytes of an event's stored `data`; larger data is cut. */
export const EVENT_DATA_MAX_BYTES = 64 * 1024;
/** Raw request bodies above this size are refused before verification. */
export const EVENT_DELIVERY_BODY_MAX_BYTES = 1024 * 1024;
export const EVENT_TRIGGERS_PER_AUTOMATION_MAX = 16;
export const EVENT_TRIGGER_TYPES_MAX = 32;
export const EVENT_TRIGGER_CONDITIONS_MAX = 16;
export const DEFAULT_EVENT_RUNS_PER_HOUR = 30;
export const MAX_EVENT_RUNS_PER_HOUR = 1000;
/** Raw delivery bodies are deleted after this many days; delivery rows stay. */
export const EVENT_DELIVERY_BODY_RETENTION_DAYS = 7;
/** Normalized events and delivery rows are deleted after this many days. */
export const EVENT_RETENTION_DAYS = 30;

const Uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());
const Timestamp = /* @__PURE__ */ defineSchema(() => z.string());

export const EventSourceName = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(EVENT_SOURCE_NAME_MAX_LENGTH),
);

export const EventTypeName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(EVENT_TYPE_MAX_LENGTH)
    .regex(/^[\x21-\x7e]+$/u, "Event types are printable ASCII without spaces"),
);

/**
 * A text value read from an event: a JSON path, or a list of paths where the
 * first that holds text wins (apps put the same thing in different places
 * for different events).
 */
export const WebhookTextPaths = /* @__PURE__ */ defineSchema(() =>
  z.union([WebhookJsonPath, z.array(WebhookJsonPath).min(1).max(8)]),
);
export type WebhookTextPaths = z.infer<typeof WebhookTextPaths>;

/** Several values joined into one, each a path in the event or a header. */
function webhookJoinedParts() {
  return z
    .object({
      parts: z.array(WebhookValueSource).min(2).max(4),
      separator: z
        .string()
        .max(4)
        .regex(/^[\x21-\x7e]*$/u)
        .default("."),
    })
    .strict();
}

/**
 * How a custom webhook source reads another app's deliveries. Paths are read
 * in each event: the body, or each item of the list `batch` names.
 */
export const WebhookFormat = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The preset that filled this in, such as `tailscale`: names the app and its documented event types. */
      preset: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
        .optional(),
      signature: WebhookSignatureFormat,
      /**
       * A send time the delivery must be close to, so an old delivery can't
       * be sent again: an ISO time or Unix seconds or milliseconds at a body
       * `path` or in a `header`. Checked after the signature.
       */
      freshness: z
        .union([
          z
            .object({
              path: WebhookJsonPath,
              toleranceSeconds: z.number().int().min(30).max(3600).default(300),
            })
            .strict(),
          z
            .object({
              header: WebhookHeaderName,
              toleranceSeconds: z.number().int().min(30).max(3600).default(300),
            })
            .strict(),
        ])
        .optional(),
      /**
       * Present when one delivery holds several events: the body is a JSON
       * list of them, or holds one at `path`. Absent: the body is one event.
       */
      batch: z.object({ path: WebhookJsonPath.optional() }).strict().optional(),
      /**
       * The event type: a path or header, one `value` for every delivery, or
       * `parts` joined with `separator` (such as a header's `issue` and the
       * body's `created` as `issue.created`).
       */
      type: z.union([
        z.object({ path: WebhookJsonPath }).strict(),
        z.object({ header: WebhookHeaderName }).strict(),
        z.object({ value: EventTypeName }).strict(),
        webhookJoinedParts(),
      ]),
      /** The delivery's id, so a retried delivery is kept once; else the body's hash. */
      deliveryId: WebhookValueSource.optional(),
      /**
       * Each event's own id, so an event delivered twice runs automations
       * once: a path, a list of paths where the first with text wins, or
       * `parts` joined with `separator` (such as an alert's status,
       * fingerprint and start time). An event missing a part has no id.
       */
      eventId: z.union([WebhookTextPaths, webhookJoinedParts()]).optional(),
      /** When it happened: an ISO time or Unix seconds or milliseconds. */
      occurredAt: WebhookTextPaths.optional(),
      /** A one-line description; the event type when absent. */
      summary: WebhookTextPaths.optional(),
      /** What it is about, such as a device or order name. */
      subject: WebhookTextPaths.optional(),
      /** A link to it in the app. */
      url: WebhookTextPaths.optional(),
      /** Who did it. */
      actor: WebhookTextPaths.optional(),
      /**
       * Whether the actor is a person: the values at `path` that mean a
       * person, such as `user`; any other value means a bot. Without it, the
       * actor's kind is unknown.
       */
      actorKind: z
        .object({
          path: WebhookJsonPath,
          person: z.array(z.string().min(1).max(64)).min(1).max(8),
        })
        .strict()
        .optional(),
    })
    .strict(),
);
export type WebhookFormat = z.infer<typeof WebhookFormat>;
export type WebhookFormatInput = z.input<typeof WebhookFormat>;

/**
 * Formats for apps whose webhooks are well known, keyed by their `preset`.
 * A custom source made with one is the same as one that spells it out.
 */
export const WEBHOOK_FORMAT_PRESETS = {
  /**
   * Linear: `Linear-Signature` over the body, a `webhookTimestamp` (ms)
   * within a minute, and `<type>.<action>` such as `Issue.create`.
   */
  linear: {
    preset: "linear",
    signature: { scheme: "hmac_sha256", header: "Linear-Signature" },
    freshness: { path: "webhookTimestamp", toleranceSeconds: 60 },
    type: { parts: [{ path: "type" }, { path: "action" }] },
    deliveryId: { header: "Linear-Delivery" },
    occurredAt: "createdAt",
    summary: ["data.title", "data.name", "data.issue.title", "data.label.name", "data.body"],
    subject: ["data.identifier", "data.issue.identifier", "data.id"],
    url: "url",
    actor: ["actor.name", "actor.email"],
    actorKind: { path: "actor.type", person: ["user"] },
  },
  /**
   * Sentry integration webhooks: `Sentry-Hook-Signature` with the client
   * secret, and the `Sentry-Hook-Resource` header's resource with the body's
   * action, such as `issue.created`.
   */
  sentry: {
    preset: "sentry",
    signature: { scheme: "hmac_sha256", header: "Sentry-Hook-Signature" },
    type: { parts: [{ header: "Sentry-Hook-Resource" }, { path: "action" }] },
    deliveryId: { header: "Request-ID" },
    occurredAt: ["data.issue.lastSeen", "data.event.datetime", "data.error.datetime"],
    summary: [
      "data.issue.title",
      "data.error.title",
      "data.event.title",
      "data.description_title",
      "data.metric_alert.title",
      "data.comment",
    ],
    subject: [
      "data.issue.shortId",
      "data.issue.short_id",
      "data.issue.id",
      "data.event.issue_id",
      "data.error.issue_id",
    ],
    url: [
      "data.issue.web_url",
      "data.event.web_url",
      "data.error.web_url",
      "data.metric_alert.web_url",
      "data.web_url",
    ],
    actor: "actor.name",
    actorKind: { path: "actor.type", person: ["user"] },
  },
  /** Tailscale: a JSON list of events, signed `t=…,v1=…` over `<t>.<body>`. */
  tailscale: {
    preset: "tailscale",
    signature: { scheme: "timestamped_hmac_sha256", header: "Tailscale-Webhook-Signature" },
    batch: {},
    type: { path: "type" },
    occurredAt: "timestamp",
    summary: "message",
    subject: "data.deviceName",
    url: "data.url",
    actor: "data.actor",
  },
} satisfies Record<string, WebhookFormatInput>;
export type WebhookFormatPreset = keyof typeof WEBHOOK_FORMAT_PRESETS;
export const WEBHOOK_FORMAT_PRESET_NAMES = Object.keys(
  WEBHOOK_FORMAT_PRESETS,
) as WebhookFormatPreset[];

/** Whether `name` is a preset this version knows. */
export function isWebhookFormatPreset(name: unknown): name is WebhookFormatPreset {
  return typeof name === "string" && Object.hasOwn(WEBHOOK_FORMAT_PRESETS, name);
}

/** A preset's format, parsed with its defaults. */
export function webhookFormatOfPreset(preset: WebhookFormatPreset): WebhookFormat {
  return WebhookFormat.parse(WEBHOOK_FORMAT_PRESETS[preset]);
}

/**
 * A webhook source as one of the two adapters: `standard`, or `custom` with
 * its format. A source stored with an older adapter name (`linear`,
 * `sentry`) reads as `custom` with that app's preset.
 */
export function currentWebhookAdapter(source: {
  adapter: WebhookEventAdapter | null;
  format: WebhookFormat | null;
}): { adapter: "standard" | "custom" | null; format: WebhookFormat | null } {
  if (source.adapter === "linear" || source.adapter === "sentry") {
    return { adapter: "custom", format: source.format ?? webhookFormatOfPreset(source.adapter) };
  }
  return { adapter: source.adapter, format: source.format };
}

/**
 * Which webhook something names, for telling whether a source is the one a
 * template wants: `standard`, or `custom` with its preset (null for a format
 * written out by hand). The older `linear` and `sentry` are custom with that
 * preset.
 */
export function webhookPresetOf(input: {
  adapter?: WebhookEventAdapter | null | undefined;
  preset?: string | null | undefined;
}): { adapter: "standard" | "custom"; preset: string | null } {
  if (input.adapter === "linear" || input.adapter === "sentry") {
    return { adapter: "custom", preset: input.adapter };
  }
  return input.adapter === "custom"
    ? { adapter: "custom", preset: input.preset ?? null }
    : { adapter: "standard", preset: null };
}

export const EventSourceMcpBinding = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The MCP server id as configured for the workspace. */
      serverId: z.string().min(1).max(256),
      /** The owner's connection used for every events/* request. */
      connectionId: Uuid.nullable(),
    })
    .strict(),
);
export type EventSourceMcpBinding = z.infer<typeof EventSourceMcpBinding>;

export const EventSource = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    workspaceId: Uuid,
    kind: EventSourceKind,
    /** Webhook sources only. */
    adapter: WebhookEventAdapter.nullable(),
    /** How a `custom` webhook source reads its app's deliveries; null otherwise. */
    format: WebhookFormat.nullable().default(null),
    name: z.string(),
    /** The person the source belongs to; null for workspace app sources. */
    ownerSubjectId: z.string().nullable(),
    visibility: EventSourceVisibility,
    status: EventSourceStatus,
    /** Why the source is blocked or disabled, in plain language. */
    statusReason: z.string().nullable(),
    /**
     * The same reason as a code (`EVENT_STATUS_REASON_CODES`) a client words
     * in its own language; null when active or from an older server.
     */
    statusReasonCode: z.string().nullable().default(null),
    /** What the app or server said about it, verbatim, when it said something. */
    statusReasonDetail: z.string().nullable().default(null),
    /** The URL to paste into the sending app. Webhook sources only. */
    webhookUrl: z.string().nullable(),
    /**
     * A Linear, Sentry or custom webhook whose secret is not pasted yet: it
     * refuses deliveries until the secret is set with an update.
     */
    awaitingSigningSecret: z.boolean().default(false),
    /** MCP sources only. */
    mcp: EventSourceMcpBinding.nullable(),
    lastDeliveryAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /**
     * What the reading person can do with the source: `manage` (its owner or
     * a workspace admin: edit, rotate, test, replay, delete) or `use` (point
     * triggers at it and read its log). Set on REST reads.
     */
    viewerAccess: z.enum(["manage", "use"]).optional(),
  }),
);
export type EventSource = z.infer<typeof EventSource>;

/**
 * Linear and Sentry generate the secret once they have the webhook URL, so it
 * is pasted on create or afterwards; a custom webhook takes the secret its app
 * shows or the one a person chose there. Standard sources get one from
 * Opengeni.
 */
export const EventSourceSigningSecretInput = /* @__PURE__ */ defineSchema(() =>
  z.string().min(8).max(512),
);

export const CreateEventSourceRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("webhook"),
          adapter: WebhookEventAdapter,
          name: EventSourceName,
          visibility: EventSourceVisibility.default("private"),
          signingSecret: EventSourceSigningSecretInput.optional(),
          /** Required for, and only for, the `custom` adapter. */
          format: WebhookFormat.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.enum(["github", "slack"]),
          name: EventSourceName.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("gmail"),
          /** The mailbox connection; defaults to the caller's only Gmail connection. */
          connectionId: Uuid.optional(),
          name: EventSourceName.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("mcp"),
          serverId: z.string().min(1).max(256),
          connectionId: Uuid.optional(),
          name: EventSourceName.optional(),
        })
        .strict(),
      z
        .object({
          /**
           * The caller's own "This workspace" source. There is one per person,
           * so creating it again returns the existing one.
           */
          kind: z.literal("workspace"),
          name: EventSourceName.optional(),
        })
        .strict(),
    ])
    .superRefine((value, context) => {
      if (
        value.kind === "webhook" &&
        value.adapter === "standard" &&
        value.signingSecret !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["signingSecret"],
          message: "Opengeni generates the signing secret for standard webhooks",
        });
      }
      if (
        value.kind === "webhook" &&
        (value.adapter === "custom") !== (value.format !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["format"],
          message:
            value.adapter === "custom"
              ? "A custom webhook needs a format"
              : "Only a custom webhook takes a format",
        });
      }
    }),
);
/** What a caller sends; a webhook source's `visibility` defaults to `private`. */
export type CreateEventSourceRequest = z.input<typeof CreateEventSourceRequest>;
export type ParsedCreateEventSourceRequest = z.output<typeof CreateEventSourceRequest>;

export const CreateEventSourceResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: EventSource,
      /** Standard webhook sources only; shown once. */
      signingSecret: z.string().optional(),
    })
    .strict(),
);
export type CreateEventSourceResponse = z.infer<typeof CreateEventSourceResponse>;

export const UpdateEventSourceRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: EventSourceName.optional(),
      visibility: EventSourceVisibility.optional(),
      status: z.enum(["active", "disabled"]).optional(),
      /** Replace a pasted Linear, Sentry or custom webhook secret. */
      signingSecret: EventSourceSigningSecretInput.optional(),
      /** Replace a custom webhook's format. */
      format: WebhookFormat.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "Supply at least one field"),
);
export type UpdateEventSourceRequest = z.infer<typeof UpdateEventSourceRequest>;

export const RotateEventSourceSecretResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ signingSecret: z.string() }).strict(),
);
export type RotateEventSourceSecretResponse = z.infer<typeof RotateEventSourceSecretResponse>;

export const ListEventSourcesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ sources: z.array(EventSource) }).strict(),
);
export type ListEventSourcesResponse = z.infer<typeof ListEventSourcesResponse>;

/**
 * Sources that need no setting up, named by a key until they are used: an
 * MCP server the person is signed in to that offers events
 * (`mcp-server:<serverId>`), a Gmail account they connected
 * (`gmail:<connectionId>`), and "This workspace" (`workspace`). A trigger may
 * name one by its key: the person's own source is added the first time it is
 * used, and using the key again finds that same source.
 */
export const READY_EVENT_SOURCE_KINDS = ["mcp", "gmail", "workspace"] as const;
export type ReadyEventSourceKind = (typeof READY_EVENT_SOURCE_KINDS)[number];

/** What adds a ready source: the matching create request. */
export type ReadyEventSourceRequest =
  | { kind: "mcp"; serverId: string }
  | { kind: "gmail"; connectionId: string }
  | { kind: "workspace" };

const MCP_SERVER_KEY_PREFIX = "mcp-server:";
const GMAIL_KEY_PREFIX = "gmail:";
const WORKSPACE_KEY = "workspace";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SERVER_ID_MAX_LENGTH = 256;

export function readyEventSourceKey(request: ReadyEventSourceRequest): string {
  if (request.kind === "mcp") return `${MCP_SERVER_KEY_PREFIX}${request.serverId}`;
  if (request.kind === "gmail") return `${GMAIL_KEY_PREFIX}${request.connectionId}`;
  return WORKSPACE_KEY;
}

/** The source a key names, or null when it is not a ready source's key. */
export function readyEventSourceRequest(key: string): ReadyEventSourceRequest | null {
  if (key === WORKSPACE_KEY) return { kind: "workspace" };
  if (key.startsWith(MCP_SERVER_KEY_PREFIX)) {
    const serverId = key.slice(MCP_SERVER_KEY_PREFIX.length);
    return serverId.length > 0 && serverId.length <= SERVER_ID_MAX_LENGTH
      ? { kind: "mcp", serverId }
      : null;
  }
  if (key.startsWith(GMAIL_KEY_PREFIX)) {
    const connectionId = key.slice(GMAIL_KEY_PREFIX.length);
    return UUID_PATTERN.test(connectionId) ? { kind: "gmail", connectionId } : null;
  }
  return null;
}

export const ReadyEventSource = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Use it wherever a trigger names a source; see `readyEventSourceRequest`. */
      key: z.string(),
      kind: z.enum(READY_EVENT_SOURCE_KINDS),
      name: z.string(),
    })
    .strict(),
);
export type ReadyEventSource = z.infer<typeof ReadyEventSource>;

export const ListReadyEventSourcesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ sources: z.array(ReadyEventSource) }).strict(),
);
export type ListReadyEventSourcesResponse = z.infer<typeof ListReadyEventSourcesResponse>;

/** A source's id, or a ready source's key. */
export const EventSourceRef = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(MCP_SERVER_KEY_PREFIX.length + SERVER_ID_MAX_LENGTH)
    .refine(
      (ref) => UUID_PATTERN.test(ref) || readyEventSourceRequest(ref) !== null,
      "Use an event source's id or a ready source's key",
    ),
);

/** Whether a trigger's source names a ready source by its key rather than an id. */
export function isReadyEventSourceKey(ref: string): boolean {
  return !UUID_PATTERN.test(ref) && readyEventSourceRequest(ref) !== null;
}

/**
 * Who caused an event. `opengeni` marks Opengeni's own identities (its GitHub
 * App bot, its Slack bot); triggers ignore those events unless they opt in.
 */
export const EventActorKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["person", "bot", "opengeni", "unknown"]),
);
export type EventActorKind = z.infer<typeof EventActorKind>;

export const EventActor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: EventActorKind,
      name: z.string().max(200).nullable(),
    })
    .strict(),
);
export type EventActor = z.infer<typeof EventActor>;

export const InboundEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    sourceId: Uuid,
    sourceKind: EventSourceKind,
    type: z.string(),
    occurredAt: Timestamp,
    receivedAt: Timestamp,
    /** What the event is about, such as `acme/api#42`. */
    subject: z.string().nullable(),
    /** One line a person or agent can read. */
    summary: z.string(),
    /** A link to the thing in its app, when known. */
    url: z.string().nullable(),
    actor: EventActor,
    data: z.record(z.string(), z.unknown()),
    /** The source's data was larger than the stored budget and was cut. */
    dataTruncated: z.boolean(),
    /** Events from this source may have been missed just before this one. */
    gapBefore: z.boolean(),
  }),
);
export type InboundEvent = z.infer<typeof InboundEvent>;

export const InboundEventSummary = /* @__PURE__ */ defineSchema(() =>
  InboundEvent.pick({
    id: true,
    sourceId: true,
    sourceKind: true,
    type: true,
    occurredAt: true,
    subject: true,
    summary: true,
    url: true,
    actor: true,
  }),
);
export type InboundEventSummary = z.infer<typeof InboundEventSummary>;

export const ListInboundEventsResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      events: z.array(InboundEvent),
      nextCursor: z.string().nullable(),
    })
    .strict(),
);
export type ListInboundEventsResponse = z.infer<typeof ListInboundEventsResponse>;

export const EventDeliveryStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["accepted", "ignored", "rejected", "failed"]),
);
export type EventDeliveryStatus = z.infer<typeof EventDeliveryStatus>;

export const EventDelivery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    sourceId: Uuid,
    receivedAt: Timestamp,
    status: EventDeliveryStatus,
    /** Why a delivery was ignored, rejected or failed, in plain language. */
    reason: z.string().nullable(),
    eventIds: z.array(Uuid),
    /** The types of the events it became, each once, in order. */
    eventTypes: z.array(z.string()),
    bodyBytes: z.number().int().nonnegative(),
    /** The raw body is kept for a few days so a delivery can be replayed. */
    bodyRetained: z.boolean(),
    /** How many times the sender delivered this same delivery again. */
    duplicateCount: z.number().int().nonnegative(),
    replayOfDeliveryId: Uuid.nullable(),
  }),
);
export type EventDelivery = z.infer<typeof EventDelivery>;

export const ListEventDeliveriesResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      deliveries: z.array(EventDelivery),
      nextCursor: z.string().nullable(),
    })
    .strict(),
);
export type ListEventDeliveriesResponse = z.infer<typeof ListEventDeliveriesResponse>;

export const ReplayEventDeliveryResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ delivery: EventDelivery }).strict(),
);
export type ReplayEventDeliveryResponse = z.infer<typeof ReplayEventDeliveryResponse>;

export const SendTestEventRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: EventTypeName.default("opengeni.test"),
      data: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
);
/** What a caller sends; `type` defaults to `opengeni.test` and `data` to `{}`. */
export type SendTestEventRequest = z.input<typeof SendTestEventRequest>;
export type ParsedSendTestEventRequest = z.output<typeof SendTestEventRequest>;

export const SendTestEventResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ event: InboundEvent, matchedAutomationIds: z.array(Uuid) }).strict(),
);
export type SendTestEventResponse = z.infer<typeof SendTestEventResponse>;

/** A field an event condition can read. */
export const EVENT_CONDITION_FIELD_PATTERN =
  /^(?:type|subject|summary|url|actor\.kind|actor\.name|data(?:\.[A-Za-z0-9_@$-]{1,64}){1,8})$/u;

export const EventConditionOperator = /* @__PURE__ */ defineSchema(() =>
  z.enum(["equals", "not_equals", "in", "not_in", "contains", "exists", "not_exists"]),
);
export type EventConditionOperator = z.infer<typeof EventConditionOperator>;

const EventConditionScalar = /* @__PURE__ */ defineSchema(() =>
  z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
);

export const EventCondition = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** `type`, `subject`, `summary`, `url`, `actor.kind`, `actor.name`, or `data.<path>`. */
      field: z.string().regex(EVENT_CONDITION_FIELD_PATTERN, "Unsupported event field"),
      op: EventConditionOperator,
      value: z.union([EventConditionScalar, z.array(EventConditionScalar).max(50)]).optional(),
    })
    .strict()
    .superRefine((condition, context) => {
      const presence = condition.op === "exists" || condition.op === "not_exists";
      const list = condition.op === "in" || condition.op === "not_in";
      if (presence && condition.value !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} takes no value`,
        });
      }
      if (!presence && condition.value === undefined) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} needs a value`,
        });
      }
      if (list && !Array.isArray(condition.value)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} needs a list`,
        });
      }
      if (!list && Array.isArray(condition.value)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} needs one value`,
        });
      }
    }),
);
export type EventCondition = z.infer<typeof EventCondition>;

export const EventTriggerInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The source's id, or a ready source's key: the owner's source is added on first use. */
      sourceId: EventSourceRef,
      /** Event types that fire the trigger. An MCP trigger names exactly one. */
      eventTypes: z.array(EventTypeName).min(1).max(EVENT_TRIGGER_TYPES_MAX),
      /** All conditions must hold. */
      conditions: z.array(EventCondition).max(EVENT_TRIGGER_CONDITIONS_MAX).default([]),
      /** Also fire on events made by Opengeni's own bots. */
      includeOwnEvents: z.boolean().default(false),
      /** MCP subscription arguments, validated against the event type's inputSchema. */
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
);
export type EventTriggerInput = z.input<typeof EventTriggerInput>;
export type ParsedEventTriggerInput = z.output<typeof EventTriggerInput>;

export const EventTriggerStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "blocked", "disabled"]),
);
export type EventTriggerStatus = z.infer<typeof EventTriggerStatus>;

export const EventTrigger = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    sourceId: Uuid,
    sourceKind: EventSourceKind,
    eventTypes: z.array(z.string()),
    conditions: z.array(EventCondition),
    includeOwnEvents: z.boolean(),
    arguments: z.record(z.string(), z.unknown()).nullable(),
    status: EventTriggerStatus,
    statusReason: z.string().nullable(),
    /** The reason as a code a client words itself; see `EVENT_STATUS_REASON_CODES`. */
    statusReasonCode: z.string().nullable().default(null),
    /** What the source's server said about it, verbatim, when it said something. */
    statusReasonDetail: z.string().nullable().default(null),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
);
export type EventTrigger = z.infer<typeof EventTrigger>;

/**
 * What the automations that continue a chat are waiting for, as the chat list
 * and header show it: the soonest scheduled run and the events that can start
 * a run. Only automations the reader can see contribute; a chat that waits
 * only on someone else's private automation has none.
 */
export const SessionAutomationWaitSummary = /* @__PURE__ */ defineSchema(() => {
  const waitEvent = z
    .object({
      source: z.object({ kind: EventSourceKind, name: z.string() }).strict().nullable(),
      eventTypes: z.array(z.string()),
    })
    .strict();
  return z
    .object({
      /** The soonest scheduled run into the chat, or null when none is ahead. */
      nextRunAt: z.string().datetime({ offset: true }).nullable(),
      /**
       * The first active event trigger that can start a run: its event types
       * and its source, null when the reader can't see the source. Null when
       * no event can start a run. `events` names them all.
       */
      event: waitEvent.nullable(),
      /**
       * Every event that can start a run, one entry per source in the order
       * the automations were made: the event types its active triggers wait
       * for (just `*` when one takes every event). Sources the reader can't
       * see share one entry with a null source. Empty when no event can start
       * a run; absent from servers that only send `event`.
       */
      events: z.array(waitEvent).optional(),
      /** How many automations can still start a run in the chat, this one included. */
      automations: z.number().int().positive(),
    })
    .strict();
});
export type SessionAutomationWaitSummary = z.infer<typeof SessionAutomationWaitSummary>;

/** Event triggers and the event run policy of an automation. */
export const ScheduledTaskEventsInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      triggers: z.array(EventTriggerInput).max(EVENT_TRIGGERS_PER_AUTOMATION_MAX),
      /** Storm guard: at most this many event runs in a rolling hour. */
      maxRunsPerHour: z.number().int().min(1).max(MAX_EVENT_RUNS_PER_HOUR).optional(),
      /** Finish the automation after its first run, whichever trigger fires first. */
      once: z.boolean().optional(),
    })
    .strict(),
);
export type ScheduledTaskEventsInput = z.input<typeof ScheduledTaskEventsInput>;
export type ParsedScheduledTaskEventsInput = z.output<typeof ScheduledTaskEventsInput>;

export const ScheduledTaskEvents = /* @__PURE__ */ defineSchema(() =>
  z.object({
    triggers: z.array(EventTrigger),
    maxRunsPerHour: z.number().int(),
    once: z.boolean(),
    /** When a once-automation finished. */
    completedAt: Timestamp.nullable(),
    /** When the storm guard last held events back; null when it is not holding any. */
    throttledSince: Timestamp.nullable(),
  }),
);
export type ScheduledTaskEvents = z.infer<typeof ScheduledTaskEvents>;

/** The events an event run carried. */
export const ScheduledTaskRunEventOccurrence = /* @__PURE__ */ defineSchema(() =>
  z.object({
    triggerIds: z.array(Uuid),
    eventCount: z.number().int().nonnegative(),
    events: z.array(InboundEventSummary),
  }),
);
export type ScheduledTaskRunEventOccurrence = z.infer<typeof ScheduledTaskRunEventOccurrence>;

/** Bytes of a run's chat update spent on its events at most. */
export const SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES = 12 * 1024;
/** Bytes of one carried event's `data` at most; the full event stays fetchable by id. */
export const SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES = 2 * 1024;

export const ScheduledOccurrenceEvent = /* @__PURE__ */ defineSchema(() =>
  InboundEventSummary.extend({
    data: z.record(z.string(), z.unknown()),
    /** The data was cut to fit; the stored event has more. */
    dataTruncated: z.boolean(),
  }),
);
export type ScheduledOccurrenceEvent = z.infer<typeof ScheduledOccurrenceEvent>;

/**
 * The events an event run delivers into its chat, bounded to fit the chat
 * update. `events` holds the oldest that fit; `eventCount` counts them all.
 */
export const ScheduledOccurrenceEvents = /* @__PURE__ */ defineSchema(() =>
  z.object({
    occurrenceId: Uuid,
    eventCount: z.number().int().nonnegative(),
    events: z.array(ScheduledOccurrenceEvent),
    /** The source may have missed events just before these. */
    gapBefore: z.boolean(),
  }),
);
export type ScheduledOccurrenceEvents = z.infer<typeof ScheduledOccurrenceEvents>;

/** An event type a source offers, for trigger pickers and agents. */
export const EventTypeDescriptor = /* @__PURE__ */ defineSchema(() =>
  z.object({
    type: z.string(),
    description: z.string(),
    /** Fields worth matching in conditions, such as `data.repository`. */
    fields: z.array(z.object({ field: z.string(), description: z.string() })),
    /** MCP sources: the subscription arguments the server accepts. */
    argumentsSchema: z.record(z.string(), z.unknown()).nullable(),
    /** False when Opengeni cannot receive this type from this source. */
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
    /** The reason as a code a client words itself; see `EVENT_STATUS_REASON_CODES`. */
    unavailableReasonCode: z.string().nullable().default(null),
    /** What the reason names, such as the GitHub App event to subscribe to. */
    unavailableReasonDetail: z.string().nullable().default(null),
  }),
);
export type EventTypeDescriptor = z.infer<typeof EventTypeDescriptor>;

export const ListEventTypesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ sourceId: Uuid, eventTypes: z.array(EventTypeDescriptor) }).strict(),
);
export type ListEventTypesResponse = z.infer<typeof ListEventTypesResponse>;

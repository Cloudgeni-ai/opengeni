import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Webhooks into apps (docs/app-webhooks.md) and notifications from apps
 * (`site.notify`, docs/site-runtime-api.md). A webhook is an inbound address
 * of one app: each delivery becomes records of one shared collection of the
 * app's data, mapped like a data sync's tool result.
 */

/** Largest delivery body a webhook accepts. */
export const APP_WEBHOOK_BODY_MAX_BYTES = 256 * 1024;
/** Records one delivery may write. */
export const APP_WEBHOOK_MAX_RECORDS = 100;
/** Deliveries one webhook accepts per minute. */
export const APP_WEBHOOK_DELIVERIES_PER_MINUTE = 120;
/** How far a signed delivery's time may be from now. */
export const APP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
/** The header carrying a delivery's `t=<unix seconds>,v1=<hex HMAC-SHA256>` signature. */
export const APP_WEBHOOK_SIGNATURE_HEADER = "x-opengeni-signature";

const Collection = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)
    .describe("The shared collection of the app's data a delivery fills."),
);
const Path = /* @__PURE__ */ defineSchema(() => z.string().trim().min(1).max(256));

export const AppWebhookStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "paused"]).describe("A paused webhook refuses deliveries."),
);
export type AppWebhookStatus = z.infer<typeof AppWebhookStatus>;

const SettingsShape = () => ({
  name: z.string().trim().min(1).max(200).describe("A short name people recognize."),
  collection: Collection,
  recordsPath: Path.nullable()
    .optional()
    .describe(
      "Dot path to the record or list of records in the delivery's JSON body (for example `data.items`). Omitted: the body itself (each element of a list body).",
    ),
  key: Path.nullable()
    .optional()
    .describe(
      "Dot path to each record's unique key (for example `id`). With a key a delivery puts (upserts) the record; without one it inserts a new record.",
    ),
  fields: z
    .array(Path)
    .max(100)
    .nullable()
    .optional()
    .describe(
      "Dot paths of the fields to keep, stored under the same path. Omit to keep whole records.",
    ),
  status: AppWebhookStatus.optional(),
});

export const AppWebhookCreateRequest = /* @__PURE__ */ defineSchema(() =>
  z.object(SettingsShape()).strict(),
);
export type AppWebhookCreateRequest = z.infer<typeof AppWebhookCreateRequest>;

export const AppWebhookUpdateRequest = /* @__PURE__ */ defineSchema(() => {
  const shape = SettingsShape();
  return z
    .object({
      name: shape.name.optional(),
      collection: shape.collection.optional(),
      recordsPath: shape.recordsPath,
      key: shape.key,
      fields: shape.fields,
      status: shape.status,
      rotateSecret: z
        .boolean()
        .optional()
        .describe("Replace the secret; the new one is shown once and the old one stops working."),
    })
    .strict();
});
export type AppWebhookUpdateRequest = z.infer<typeof AppWebhookUpdateRequest>;

export const AppWebhook = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    appId: z.string().uuid(),
    name: z.string(),
    collection: z.string(),
    recordsPath: z.string().nullable(),
    key: z.string().nullable(),
    fields: z.array(z.string()).nullable(),
    status: AppWebhookStatus,
    /** The address senders post to; null when the deployment has no public address. */
    url: z.string().nullable(),
    createdBySubjectId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastDeliveryAt: z.string().nullable(),
    lastStatus: z.enum(["succeeded", "failed", "rejected"]).nullable(),
    lastError: z.string().nullable(),
  }),
);
export type AppWebhook = z.infer<typeof AppWebhook>;

/** A saved webhook; `secret` only on create and rotate, shown once. */
export const AppWebhookSaveResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ webhook: AppWebhook, secret: z.string().optional() }),
);
export type AppWebhookSaveResponse = z.infer<typeof AppWebhookSaveResponse>;

export const AppWebhookListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ webhooks: z.array(AppWebhook) }),
);
export type AppWebhookListResponse = z.infer<typeof AppWebhookListResponse>;

/** What one delivery wrote. */
export const AppWebhookDeliveryResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    written: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    records: z.array(z.object({ id: z.string(), key: z.string().nullable() })),
  }),
);
export type AppWebhookDeliveryResponse = z.infer<typeof AppWebhookDeliveryResponse>;

// --- notifications from apps --------------------------------------------------

/** Recipients a send to `"workspace"` reaches at most. */
export const APP_NOTIFY_MAX_RECIPIENTS = 200;
/** Sends one person may make from one app per window (`APP_NOTIFY_WINDOW_SECONDS`). */
export const APP_NOTIFY_SENDS_PER_WINDOW = 30;
/** Of those, sends to `"workspace"`. */
export const APP_NOTIFY_WORKSPACE_SENDS_PER_WINDOW = 3;
export const APP_NOTIFY_WINDOW_SECONDS = 600;

export const AppNotifyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      title: z.string().trim().min(1).max(200),
      body: z.string().max(2000).optional(),
      to: z
        .string()
        .trim()
        .min(1)
        .max(320)
        .optional()
        .describe(
          'Omitted: the viewer. A member\'s email or subject id, or "workspace" for everyone who can open the app.',
        ),
      path: z
        .string()
        .max(512)
        .regex(/^\/(?![/\\])[^\s#\u0000-\u001f\u007f]*$/u)
        .optional()
        .describe("The app's own address the notification opens, such as /tasks/42."),
      key: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{1,120}$/u)
        .optional()
        .describe("Sending the same key again updates the person's notification in place."),
    })
    .strict(),
);
export type AppNotifyRequest = z.infer<typeof AppNotifyRequest>;

export const AppNotifyResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: z.string(),
    /** People it reached. */
    delivered: z.number().int().nonnegative(),
    /** For `"workspace"`: members left out because they don't allow notifications from others. */
    skipped: z.number().int().nonnegative(),
    /** For `"workspace"`: members left out past the recipient limit (APP_NOTIFY_MAX_RECIPIENTS). */
    overLimit: z.number().int().nonnegative(),
  }),
);
export type AppNotifyResponse = z.infer<typeof AppNotifyResponse>;

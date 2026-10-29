import { describe, expect, test } from "bun:test";
import {
  CreateEventSourceRequest,
  UpdateEventSourceRequest,
  webhookFormatSignatureHeaderReads,
  WebhookFormat,
} from "../src/event-triggers";

// A format that read the event type or an id from the header its signature
// is in would store the signature, or a token scheme's secret itself, in
// events and the delivery log.
const token = { scheme: "token", header: "X-Gitlab-Token" } as const;
const custom = (format: Record<string, unknown>) => ({
  kind: "webhook",
  adapter: "custom",
  name: "GitLab",
  signingSecret: "glpat-0123456789",
  format,
});
const issuePaths = (result: { success: boolean; error?: { issues: { path: unknown[] }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path);

describe("webhook formats never read the signature header", () => {
  const bad = [
    {
      format: { signature: token, type: { header: "x-gitlab-token" } },
      path: ["format", "type", "header"],
    },
    {
      format: {
        signature: token,
        type: { path: "kind" },
        deliveryId: { header: "X-GITLAB-TOKEN" },
      },
      path: ["format", "deliveryId", "header"],
    },
    {
      format: {
        signature: token,
        type: { path: "kind" },
        eventId: { parts: [{ path: "id" }, { header: "X-Gitlab-Token" }] },
      },
      path: ["format", "eventId", "parts", 1, "header"],
    },
    {
      format: {
        signature: { scheme: "hmac_sha256", header: "X-Signature" },
        type: { header: "x-signature" },
      },
      path: ["format", "type", "header"],
    },
    {
      format: { signature: { scheme: "standard_webhooks" }, type: { header: "Webhook-Signature" } },
      path: ["format", "type", "header"],
    },
  ];

  test("create and change refuse them, whatever the header's case", () => {
    for (const { format, path } of bad) {
      expect(issuePaths(CreateEventSourceRequest.safeParse(custom(format)))).toEqual([path]);
      expect(issuePaths(UpdateEventSourceRequest.safeParse({ format }))).toEqual([path]);
    }
  });

  test("other headers and paths stay allowed", () => {
    const fine = {
      signature: token,
      type: { header: "X-Gitlab-Event" },
      deliveryId: { header: "X-Gitlab-Event-UUID" },
      eventId: { parts: [{ path: "id" }, { header: "X-Gitlab-Instance" }] },
    };
    expect(CreateEventSourceRequest.safeParse(custom(fine)).success).toBe(true);
    expect(UpdateEventSourceRequest.safeParse({ format: fine }).success).toBe(true);
    const svix = {
      signature: { scheme: "standard_webhooks" },
      type: { path: "type" },
      deliveryId: { header: "webhook-id" },
    };
    expect(UpdateEventSourceRequest.safeParse({ format: svix }).success).toBe(true);
    expect(webhookFormatSignatureHeaderReads(WebhookFormat.parse(fine))).toEqual([]);
  });
});

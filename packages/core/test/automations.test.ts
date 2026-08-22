import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AutomationSessionTemplate } from "@opengeni/contracts";
import {
  SIGNED_JSON_AUTOMATION_ADAPTER_ID,
  automationRequestDigest,
  buildAutomationAcceptedExecution,
  signedJsonAutomationAdapter,
} from "../src";

const source = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  name: "CI",
  adapterId: SIGNED_JSON_AUTOMATION_ADAPTER_ID,
  configuration: {},
  status: "active" as const,
  version: 3,
  hasWebhookSecret: true,
  webhookPath: "/v1/webhooks/automations/opaque",
  createdBySubjectId: "owner",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const sessionTemplate = AutomationSessionTemplate.parse({
  prompt: "Investigate the event and report the result.",
});

const trigger = {
  id: "44444444-4444-4444-8444-444444444444",
  accountId: source.accountId,
  workspaceId: source.workspaceId,
  sourceId: source.id,
  name: "Failure triage",
  adapterId: source.adapterId,
  eventTypes: ["build.failed"],
  configuration: {},
  parameters: {},
  sessionTemplate,
  status: "active" as const,
  revision: 7,
  packInstallationId: null,
  packTemplateId: null,
  createdBySubjectId: "owner",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("signed JSON automation adapter", () => {
  test("authenticates exact raw bytes and rejects modified bytes", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const rawBody = new TextEncoder().encode('{"type":"build.failed","data":{"id":4}}');
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    const headers = new Headers({ "x-opengeni-signature-256": `sha256=${signature}` });
    expect(
      signedJsonAutomationAdapter.verify({ rawBody, headers, secret, sourceConfiguration: {} }),
    ).toBe(true);
    expect(
      signedJsonAutomationAdapter.verify({
        rawBody: new TextEncoder().encode('{"type":"build.failed","data":{"id":5}}'),
        headers,
        secret,
        sourceConfiguration: {},
      }),
    ).toBe(false);
  });

  test("normalizes one logical occurrence independently from its delivery", () => {
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        id: "delivery-1",
        type: "build.failed",
        occurrenceKey: "repository:main:abc123",
        subject: "main",
        data: { head: "abc123" },
      }),
    );
    const event = signedJsonAutomationAdapter.normalize({
      rawBody,
      headers: new Headers(),
      sourceConfiguration: {},
    });
    expect(event.occurrenceKey).toBe("repository:main:abc123");
    expect(signedJsonAutomationAdapter.matches({ event, trigger })).toBe(true);
    expect(automationRequestDigest(source.adapterId, rawBody)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("freezes source and trigger authority into accepted execution", () => {
    const event = signedJsonAutomationAdapter.normalize({
      rawBody: new TextEncoder().encode(
        JSON.stringify({ type: "build.failed", occurrenceKey: "repo:abc", data: {} }),
      ),
      headers: new Headers(),
      sourceConfiguration: {},
    });
    const render = signedJsonAutomationAdapter.render({ event, trigger, source });
    const accepted = buildAutomationAcceptedExecution({
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      source,
      trigger,
      eventId: "55555555-5555-4555-8555-555555555555",
      event,
      render,
    });
    expect(accepted.sourceVersion).toBe(3);
    expect(accepted.triggerRevision).toBe(7);
    expect(accepted.initialMessage).toContain("untrusted event data");
    expect(accepted.initialMessage).toContain("repo:abc");
  });
});

import { describe, expect, test } from "bun:test";
import {
  AutomationSessionTemplate,
  AutomationSessionTemplateWrite,
  StoredAutomationSessionTemplate,
  AutomationAcceptedExecution,
  StoredAutomationAcceptedExecution,
  CreateAutomationTriggerRequest,
  UpdateAutomationTriggerRequest,
  AutomationNormalizedEvent,
  TriggerAutomationManuallyRequest,
} from "../src";

describe("automation contracts", () => {
  test("public templates remain required strict objects after ignoring the private marker", () => {
    expect(AutomationSessionTemplateWrite.isOptional()).toBe(false);
    const request = {
      sourceId: "11111111-1111-4111-8111-111111111111",
      name: "Review",
      eventTypes: ["test.event"],
    };
    expect(CreateAutomationTriggerRequest.safeParse(request).success).toBe(false);
    for (const sessionTemplate of [null, [], "prompt", { prompt: "Review", unexpected: true }]) {
      expect(
        CreateAutomationTriggerRequest.safeParse({ ...request, sessionTemplate }).success,
      ).toBe(false);
    }
    expect(AutomationSessionTemplateWrite.safeParse({ prompt: "x".repeat(65_537) }).success).toBe(
      false,
    );
  });

  test("stored events retain the server-owned caller flag but manual request JSON cannot supply it", () => {
    const event = AutomationNormalizedEvent.parse({
      adapterId: "signed-json.v1",
      eventType: "test.event",
      occurrenceKey: "test:one",
      payload: {},
      credentialRestriction: "developer_setup",
    });
    expect(AutomationNormalizedEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(
      TriggerAutomationManuallyRequest.safeParse({
        eventType: event.eventType,
        occurrenceKey: event.occurrenceKey,
        credentialRestriction: "developer_setup",
      }).success,
    ).toBe(false);
    expect(
      AutomationNormalizedEvent.safeParse({ ...event, credentialRestriction: "none" }).success,
    ).toBe(false);
  });

  test("rejects removed Pack ownership fields", () => {
    const base = {
      sourceId: "11111111-1111-4111-8111-111111111111",
      name: "Review",
      eventTypes: ["pull_request.opened"],
      sessionTemplate: AutomationSessionTemplate.parse({ prompt: "Review it" }),
    };
    expect(CreateAutomationTriggerRequest.safeParse(base).success).toBe(true);
    expect(
      CreateAutomationTriggerRequest.safeParse({
        ...base,
        packInstallationId: "22222222-2222-4222-8222-222222222222",
        packTemplateId: "review",
      }).success,
    ).toBe(false);
  });

  test("read and stored templates retain a server-owned restriction without changing defaults", () => {
    const ordinary = AutomationSessionTemplate.parse({ prompt: "Review it" });
    const restricted = { ...ordinary, credentialRestriction: "developer_setup" as const };
    expect(AutomationSessionTemplate.parse(restricted)).toEqual(restricted);
    expect(StoredAutomationSessionTemplate.parse(restricted)).toEqual(restricted);
    expect(AutomationSessionTemplate.parse(ordinary)).not.toHaveProperty("credentialRestriction");
    expect(
      AutomationSessionTemplate.safeParse({ ...ordinary, credentialRestriction: "none" }).success,
    ).toBe(false);
  });

  test("public create/update template JSON cannot manufacture or downgrade the marker", () => {
    const ordinary = AutomationSessionTemplate.parse({ prompt: "Review it" });
    for (const credentialRestriction of ["developer_setup"]) {
      const sessionTemplate = { ...ordinary, credentialRestriction };
      const created = CreateAutomationTriggerRequest.parse({
        sourceId: "11111111-1111-4111-8111-111111111111",
        name: "Review",
        eventTypes: ["test.event"],
        sessionTemplate,
      });
      const updated = UpdateAutomationTriggerRequest.parse({
        expectedRevision: 1,
        sessionTemplate,
      });
      expect(created.sessionTemplate).toEqual(ordinary);
      expect(updated.sessionTemplate).toEqual(ordinary);
    }
    for (const credentialRestriction of ["none", null, false]) {
      const sessionTemplate = { ...ordinary, credentialRestriction };
      expect(
        CreateAutomationTriggerRequest.safeParse({
          sourceId: "11111111-1111-4111-8111-111111111111",
          name: "Review",
          eventTypes: ["test.event"],
          sessionTemplate,
        }).success,
      ).toBe(false);
      expect(
        UpdateAutomationTriggerRequest.safeParse({ expectedRevision: 1, sessionTemplate }).success,
      ).toBe(false);
    }
  });

  test("accepted execution parsing retains the restriction through durable replay", () => {
    const accepted = {
      version: 1,
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      sourceVersion: 1,
      triggerId: "44444444-4444-4444-8444-444444444444",
      triggerRevision: 1,
      eventId: "55555555-5555-4555-8555-555555555555",
      adapterId: "signed-json.v1",
      occurrenceKey: "test:one",
      initialMessage: "Review it",
      sessionTemplate: AutomationSessionTemplate.parse({
        prompt: "Review it",
        credentialRestriction: "developer_setup",
      }),
      serviceSubjectId: "automation:fixture",
      serviceLabel: "Fixture",
      provenance: {},
    };
    const parsed = AutomationAcceptedExecution.parse(accepted);
    expect(StoredAutomationAcceptedExecution.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
    expect(parsed.sessionTemplate.credentialRestriction).toBe("developer_setup");
  });
});

import { describe, expect, test } from "bun:test";
import { AutomationSessionTemplate, CreateAutomationTriggerRequest } from "../src";

describe("automation contracts", () => {
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
});

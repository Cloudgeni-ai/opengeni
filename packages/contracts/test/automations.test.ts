import { describe, expect, test } from "bun:test";
import { AutomationSessionTemplate, CapabilityPack, CreateAutomationTriggerRequest } from "../src";

describe("automation contracts", () => {
  test("requires Pack installation and template identities together", () => {
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
      }).success,
    ).toBe(false);
  });

  test("parses Pack automation templates", () => {
    const pack = CapabilityPack.parse({
      id: "review",
      name: "Review",
      description: "Review changes",
      role: "engineering",
      category: "development",
      version: "1.0.0",
      skills: [],
      components: [],
      tools: [],
      connectors: [],
      knowledge: [],
      schedules: [],
      automationTemplates: [
        {
          id: "pull-request",
          name: "Pull request",
          description: "Review pull requests",
          adapterId: "source-control.pull-request.v1",
          eventTypes: ["pull_request.opened"],
          sessionTemplate: { prompt: "Review it" },
          connectionRequirement: "source-control-review-app",
        },
      ],
      metadata: {},
    });
    expect(pack.automationTemplates?.[0]?.id).toBe("pull-request");
  });
});

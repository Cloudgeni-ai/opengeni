import { describe, expect, test } from "bun:test";

import { createOnboardingJourney } from "./onboarding-analytics";

describe("onboarding journey", () => {
  test("reports each step once and nothing after the final step", () => {
    const events: Array<[string, Record<string, string>]> = [];
    const journey = createOnboardingJourney((name, properties) => events.push([name, properties]));
    journey.viewed("organization_name");
    journey.viewed("organization_name");
    journey.completed("organization_name", "created");
    journey.viewed("model_access", "credits");
    journey.completed("model_access", "start_chatting");
    journey.left();
    expect(events).toEqual([
      ["onboarding_step_viewed", { step: "organization_name" }],
      ["onboarding_step_completed", { step: "organization_name", via: "created" }],
      ["onboarding_step_viewed", { step: "model_access", variant: "credits" }],
      ["onboarding_step_completed", { step: "model_access", via: "start_chatting" }],
    ]);
  });

  test("leaving before the final step reports the last step once", () => {
    const events: Array<[string, Record<string, string>]> = [];
    const journey = createOnboardingJourney((name, properties) => events.push([name, properties]));
    journey.left();
    journey.viewed("organization_name");
    journey.completed("organization_name", "created");
    journey.viewed("model_access", "choose");
    journey.left();
    journey.left();
    expect(events.at(-1)).toEqual(["onboarding_abandoned", { last_step: "model_access" }]);
    expect(events.filter(([name]) => name === "onboarding_abandoned")).toHaveLength(1);
  });

  test("choosing to embed keeps the journey open through developer setup", () => {
    const events: Array<[string, Record<string, string>]> = [];
    const journey = createOnboardingJourney((name, properties) => events.push([name, properties]));
    journey.viewed("use_case");
    journey.completed("use_case", "embed");
    journey.completed("organization_name", "created");
    journey.completed("model_access", "start_chatting");
    journey.viewed("developer_setup");
    journey.completed("developer_setup", "implement_with_opengeni");
    journey.left();
    expect(events.slice(-2)).toEqual([
      ["onboarding_step_viewed", { step: "developer_setup" }],
      ["onboarding_step_completed", { step: "developer_setup", via: "implement_with_opengeni" }],
    ]);
  });

  test("the cloud path still finishes at the model step", () => {
    const events: Array<[string, Record<string, string>]> = [];
    const journey = createOnboardingJourney((name, properties) => events.push([name, properties]));
    journey.completed("use_case", "cloud");
    journey.completed("model_access", "skipped");
    journey.viewed("developer_setup");
    expect(events.at(-1)).toEqual([
      "onboarding_step_completed",
      { step: "model_access", via: "skipped" },
    ]);
  });
});

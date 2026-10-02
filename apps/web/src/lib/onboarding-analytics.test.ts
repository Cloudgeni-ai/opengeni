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
});

import { describe, expect, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import { InteractionRouteStages } from "../src/interaction-route-stages";

describe("InteractionRouteStages", () => {
  test("splits wall time into sequential stages and accumulates repeats", () => {
    let now = 100;
    const stages = new InteractionRouteStages("act", () => now);
    now = 112;
    stages.mark("auth");
    now = 150;
    stages.mark("control");
    now = 151;
    stages.mark("dispatch");
    now = 160;
    stages.mark("dispatch");
    now = 165;
    stages.mark("passkey_post");
    expect(stages.entries()).toEqual([
      ["auth", 12],
      ["control", 38],
      ["dispatch", 10],
      ["passkey_post", 5],
    ]);
    expect(stages.serverTiming()).toBe(
      "browser-auth;dur=12.0, browser-control;dur=38.0, browser-dispatch;dur=10.0, browser-passkey-post;dur=5.0",
    );
  });

  test("reports each stage to the bounded histogram and never throws", () => {
    const observed: Array<{ labels?: Record<string, string>; value: number }> = [];
    let now = 0;
    const stages = new InteractionRouteStages("observe", () => now);
    now = 20;
    stages.mark("auth");
    stages.observe({
      observeHistogram: (input: { labels?: Record<string, string>; value: number }) => {
        observed.push(input);
      },
    } as unknown as Observability);
    expect(observed).toEqual([
      expect.objectContaining({
        labels: { resource: "browser", operation: "observe", stage: "auth" },
        value: 0.02,
      }),
    ]);
    expect(() =>
      stages.observe({
        observeHistogram: () => {
          throw new Error("metrics down");
        },
      } as unknown as Observability),
    ).not.toThrow();
  });
});

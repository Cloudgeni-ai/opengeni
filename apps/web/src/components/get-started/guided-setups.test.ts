import { describe, expect, test } from "bun:test";
import type { AgentSummary, AgentTemplate, ScheduledTask } from "@opengeni/sdk";

import {
  GUIDED_SETUPS,
  agentForSetup,
  catalogConnectHref,
  guidedSetupByKey,
  needsLine,
  setupNeeds,
  setupTriggerTask,
} from "./guided-setups";

function agent(id: string, templateKey: string | null, canEdit: boolean): AgentSummary {
  return { id, name: id, templateKey, viewer: { canEdit } } as unknown as AgentSummary;
}

describe("guided setups", () => {
  test("at most four, each with a unique key", () => {
    expect(GUIDED_SETUPS.length).toBeLessThanOrEqual(4);
    expect(new Set(GUIDED_SETUPS.map((setup) => setup.key)).size).toBe(GUIDED_SETUPS.length);
    expect(guidedSetupByKey("pr-reviews")?.agentTemplateKey).toBe("pr-reviewer");
    expect(guidedSetupByKey("nope")).toBeNull();
    expect(guidedSetupByKey(undefined)).toBeNull();
  });

  test("each setup has an example of what it produces, with three lines", () => {
    for (const setup of GUIDED_SETUPS) {
      expect(setup.example.subject.length).toBeGreaterThan(0);
      expect(setup.example.lines).toHaveLength(3);
    }
  });

  test("what a setup needs comes from its agent's connections, plus its own", () => {
    const template = {
      setup: {
        connections: [
          { provider: "github.com", name: "GitHub", required: false, why: "x" },
          { provider: "linear.app", name: "Linear", required: false, why: "x" },
        ],
      },
    } as unknown as AgentTemplate;
    expect(setupNeeds({ requireProviders: [] }, template)).toEqual([]);
    expect(setupNeeds({ requireProviders: ["linear.app"] }, template)).toEqual(["Linear"]);
    expect(setupNeeds({ requireProviders: [] }, null)).toEqual([]);
    expect(needsLine([])).toBeNull();
    expect(needsLine(["GitHub"])).toBe("Needs GitHub");
    expect(needsLine(["GitHub", "Linear", "Slack"])).toBe("Needs GitHub, Linear and Slack");
  });

  test("a setup never requires another agent, only its own agent's connections", () => {
    for (const setup of GUIDED_SETUPS) {
      expect(setup.requireProviders.every((provider) => provider.includes("."))).toBe(true);
    }
  });

  test("picks the agent from the template, one the reader can edit first", () => {
    const setup = { agentTemplateKey: "triage" };
    expect(agentForSetup([agent("a", "pr-reviewer", true)], setup)).toBeNull();
    expect(
      agentForSetup([agent("b", "triage", false), agent("c", "triage", true)], setup)?.id,
    ).toBe("c");
    expect(agentForSetup([agent("b", "triage", false)], setup)?.id).toBe("b");
  });

  test("finds the agent's task named after the trigger, an active one first", () => {
    const task = (agentId: string, name: string, status = "active", id = name) =>
      ({ id, name, status, agentConfig: { agentId } }) as unknown as ScheduledTask;
    const setup = { triggerName: "Every Monday morning" };
    const name = "Product analyst: Every Monday morning";
    expect(setupTriggerTask([task("a", name)], "a", setup)?.status).toBe("active");
    expect(setupTriggerTask([task("b", "Every Monday morning")], "a", setup)).toBeNull();
    expect(setupTriggerTask([task("a", "Something else")], "a", setup)).toBeNull();
    expect(setupTriggerTask([task("a", name, "paused")], "a", setup)?.status).toBe("paused");
    expect(
      setupTriggerTask(
        [task("a", name, "paused", "p"), task("a", name, "active", "on")],
        "a",
        setup,
      )?.id,
    ).toBe("on");
  });

  test("connect links open the connector on Capabilities", () => {
    expect(catalogConnectHref("w 1", "item-1")).toBe(
      "/workspaces/w%201/plugins?open=item%3Aitem-1",
    );
    expect(catalogConnectHref("w", null)).toBe("/workspaces/w/plugins");
    expect(
      catalogConnectHref("w", "item-1", { path: "/workspaces/w/enable?agent=x", label: "X" }),
    ).toBe(
      "/workspaces/w/plugins?open=item%3Aitem-1&from=%2Fworkspaces%2Fw%2Fenable%3Fagent%3Dx&fromLabel=X",
    );
  });
});

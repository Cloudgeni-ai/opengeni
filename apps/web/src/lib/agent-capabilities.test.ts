import { describe, expect, test } from "bun:test";
import {
  AGENT_CAPABILITY_DESCRIPTIONS,
  AGENT_CAPABILITY_IDS,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  type AgentCapabilities,
  type ScheduledTask,
} from "@opengeni/contracts";

import {
  AGENT_CAPABILITY_GROUPS,
  agentConfigErrorText,
  capabilityAvailability,
  capabilitySummary,
  draftFromRequest,
  draftsEqual,
  requestFromDraft,
  withCapability,
  withStartingPoint,
} from "./agent-capabilities";
import { workspaceAgentDefaultsSummary } from "./agent-defaults-summary";
import { agentConfigFromFormState, formStateFromScheduledTask } from "./scheduled-tasks";
import {
  emptySessionDraft,
  fitToolPolicyToAgentCapabilities,
  newSessionDraftOptionsFromSessionDraft,
  sessionDraftFromNewSessionDraftOptions,
  submissionFromSessionDraft,
} from "./session-create";

const everything = capabilityAvailability(null);

describe("agent capability groups", () => {
  test("every capability appears in exactly one group, in product words", () => {
    const grouped = AGENT_CAPABILITY_GROUPS.flatMap((group) => group.capabilities);
    expect([...grouped].sort()).toEqual([...AGENT_CAPABILITY_IDS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const id of AGENT_CAPABILITY_IDS) {
      const { label, description } = AGENT_CAPABILITY_DESCRIPTIONS[id];
      // Tool ids never leak into labels: no snake_case or camelCase words.
      expect(`${label} ${description}`).not.toMatch(/[a-z]_[a-z]|[a-z][A-Z]/);
    }
  });
});

describe("drafts and requests", () => {
  test("omitted and starting points round-trip to the smallest request", () => {
    expect(requestFromDraft(draftFromRequest(undefined))).toBe("all");
    expect(requestFromDraft(draftFromRequest("none"))).toBe("none");
    const custom: AgentCapabilities = { from: "none", webSearch: true, skills: "manage" };
    expect(requestFromDraft(draftFromRequest(custom))).toEqual(custom);
  });

  test("toggling back to the starting value drops the toggle", () => {
    const draft = withCapability(draftFromRequest("all"), "browser", false);
    expect(requestFromDraft(draft)).toEqual({ from: "all", browser: false });
    expect(requestFromDraft(withCapability(draft, "browser", true))).toBe("all");
  });

  test("switching the starting point resets every capability to it", () => {
    const draft = withStartingPoint(
      withCapability(draftFromRequest("all"), "media", false),
      "none",
    );
    expect(requestFromDraft(draft)).toBe("none");
    expect(draftsEqual(draft, draftFromRequest("none"))).toBe(true);
  });

  test("a capability this server doesn't offer is never sent as on", () => {
    const availability = capabilityAvailability({
      capabilities: [{ id: "webSearch", available: false, reason: "off" }],
    });
    const draft = withCapability(draftFromRequest("none"), "webSearch", true);
    expect(requestFromDraft(draft, availability)).toBe("none");
    expect(capabilitySummary(draftFromRequest("all").values, availability)).toBe(
      "All capabilities",
    );
  });

  test("the workspace's older Ask questions switch still turns the default off", () => {
    expect(draftFromRequest(undefined, { legacyHumanInputOff: true }).values.humanInput).toBe(
      false,
    );
    expect(
      draftFromRequest({ from: "all", humanInput: true }, { legacyHumanInputOff: true }).values
        .humanInput,
    ).toBe(true);
    expect(workspaceAgentDefaultsSummary({ agentHumanInputEnabled: false }, null)).toBe(
      "12 of 13 capabilities",
    );
  });

  test("summaries count what is on", () => {
    expect(capabilitySummary(draftFromRequest("all").values, everything)).toBe("All capabilities");
    expect(capabilitySummary(draftFromRequest("none").values, everything)).toBe(
      "2 of 13 capabilities",
    );
  });
});

describe("new chat with its own capabilities", () => {
  test("sends agent.capabilities only when customized, and restores it from the draft", () => {
    const plain = emptySessionDraft();
    expect(submissionFromSessionDraft(plain).extras.agent).toBeUndefined();
    expect(newSessionDraftOptionsFromSessionDraft(plain).agent).toBeUndefined();

    const custom = { ...plain, agentCapabilities: { from: "none", knowledge: true } as const };
    expect(submissionFromSessionDraft(custom).extras.agent).toEqual({
      capabilities: { from: "none", knowledge: true },
    });
    const options = newSessionDraftOptionsFromSessionDraft(custom);
    expect(options.agent).toEqual({ capabilities: { from: "none", knowledge: true } });
    expect(sessionDraftFromNewSessionDraftOptions(options).agentCapabilities).toEqual({
      from: "none",
      knowledge: true,
    });
  });

  test("never names a built-in tool of a capability that is off", () => {
    const draft = {
      ...emptySessionDraft(["goal_set", "knowledge_search", "set_session_title"]),
      firstPartyMcpTools: new Set(["goal_set", "knowledge_search", "set_session_title"] as const),
      agentCapabilities: { from: "none", knowledge: true } as const,
    };
    const tools = submissionFromSessionDraft(draft, ["goal_set"]).extras.firstPartyMcpTools ?? [];
    expect(tools.sort()).toEqual(["knowledge_search", "set_session_title"]);
    for (const tool of tools) {
      const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool];
      expect(owner === "runtime" || owner === "knowledge").toBe(true);
    }
  });

  test("Workspace connectors off sends no connector choice; other built-ins follow their capability", () => {
    const policy = {
      tools: [
        { kind: "mcp" as const, id: "linear" },
        { kind: "mcp" as const, id: "files" },
        { kind: "mcp" as const, id: "docs" },
      ],
      toolsProvided: true,
      excludedMcpServerIds: ["sentry"],
    };
    expect(fitToolPolicyToAgentCapabilities(policy, undefined)).toBe(policy);
    expect(fitToolPolicyToAgentCapabilities(policy, "none") as unknown).toEqual({
      tools: [],
      toolsProvided: false,
    });
    expect(
      fitToolPolicyToAgentCapabilities(policy, { from: "none", workspaceConnectors: true }),
    ).toEqual({ ...policy, tools: [{ kind: "mcp", id: "linear" }] });
  });
});

describe("schedules", () => {
  const task = {
    id: "task",
    name: "Digest",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    targetSessionId: null,
    schedule: { type: "interval", everySeconds: 3600 },
    agentConfig: {
      prompt: "Summarize",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: {},
      agent: { capabilities: { from: "none", knowledge: true }, identity: "Digest bot" },
    },
  } as unknown as ScheduledTask;

  test("a saved choice round-trips and keeps the fields the form doesn't edit", () => {
    const form = formStateFromScheduledTask(task);
    expect(form.agentCapabilities).toEqual({ from: "none", knowledge: true });
    expect(agentConfigFromFormState(form, task).agent).toEqual({
      capabilities: { from: "none", knowledge: true },
      identity: "Digest bot",
    });
    const { agentCapabilities: _dropped, ...defaults } = form;
    expect(agentConfigFromFormState(defaults, task).agent).toEqual({ identity: "Digest bot" });
  });

  test("a schedule that follows the workspace sends no agent", () => {
    const plain = { ...task, agentConfig: { ...task.agentConfig, agent: undefined } };
    expect(
      agentConfigFromFormState(formStateFromScheduledTask(plain), plain).agent,
    ).toBeUndefined();
  });
});

describe("error copy", () => {
  test("names what happened and what to do, without raw API text", () => {
    expect(agentConfigErrorText({ status: 409 }, "fallback")).toMatch(/Nothing was saved/);
    expect(
      agentConfigErrorText(
        { status: 422, details: { code: "agent_capability_unavailable", capability: "browser" } },
        "fallback",
      ),
    ).toBe("Browser and computer isn't enabled on this server. Turn it off and save again.");
    expect(agentConfigErrorText(new Error("OpenGeni API 500: boom"), "Couldn't save.")).toBe(
      "Couldn't save.",
    );
  });
});

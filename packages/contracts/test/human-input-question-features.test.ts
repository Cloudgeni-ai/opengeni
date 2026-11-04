import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AGENT_FUNCTION_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  HumanInputQuestion,
  RequestHumanInputToolInput,
  allAgentCapabilities,
  humanInputQuestionSchema,
  noneAgentCapabilities,
  requestHumanInputToolParameters,
  resolveAgentToolFamilies,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "../src/index";

const choice = {
  id: "send",
  kind: "single_select" as const,
  prompt: "Send the summary to Sam now?",
  options: [
    { id: "send", label: "Send it", recommended: true, preview: "Hi Sam, ..." },
    { id: "draft", label: "Keep it as a draft" },
  ],
};

const secretQuestion = {
  id: "key",
  kind: "secret" as const,
  prompt: "Paste the Acme API key.",
  secret: {
    item: "Acme",
    field: "api_key",
    fieldKind: "concealed",
    itemType: "api_key",
    saveTo: "user",
  },
};

describe("request_human_input parameters follow the enabled features", () => {
  test("with secrets and Skill reviews on, the schema is the complete one", () => {
    expect(requestHumanInputToolParameters({ secrets: true, skillReview: true })).toBe(
      RequestHumanInputToolInput,
    );
  });

  test("without secrets there is no secret kind or spec", () => {
    const schema = requestHumanInputToolParameters({ secrets: false, skillReview: true });
    const json = JSON.stringify(z.toJSONSchema(schema));
    expect(json).not.toContain('"secret"');
    expect(json).toContain("skillReview");
    expect(schema.safeParse({ questions: [secretQuestion] }).success).toBe(false);
    expect(RequestHumanInputToolInput.safeParse({ questions: [secretQuestion] }).success).toBe(
      true,
    );
  });

  test("without Skill management there is no skillReview reference", () => {
    const schema = requestHumanInputToolParameters({ secrets: true, skillReview: false });
    const json = JSON.stringify(z.toJSONSchema(schema));
    expect(json).not.toContain("skillReview");
    expect(schema.safeParse({ questions: [secretQuestion] }).success).toBe(true);
  });

  test("structured choices keep every field and rule in the smallest schema", () => {
    const question = humanInputQuestionSchema({ secrets: false, skillReview: false });
    const full = HumanInputQuestion;
    const cases = [
      { ...choice },
      { ...choice, confirm: true },
      { ...choice, kind: "multi_select" as const, confirm: true },
      {
        ...choice,
        confirm: true,
        options: [...choice.options, { id: "later", label: "Ask me later" }],
      },
      {
        ...choice,
        kind: "multi_select" as const,
        validation: { minSelections: 1, maxSelections: 2 },
      },
      { id: "why", kind: "text" as const, prompt: "Why?", allowOther: false },
    ];
    for (const candidate of cases) {
      expect(question.safeParse(candidate).success).toBe(full.safeParse(candidate).success);
    }
    const json = JSON.stringify(z.toJSONSchema(question));
    for (const field of ["recommended", "preview", "confirm", "allowOther", "validation"]) {
      expect(json).toContain(field);
    }
  });
});

function configured(capabilities: ResolvedAgentCapabilities): ResolvedAgentConfig {
  return {
    version: 1,
    from: "none",
    capabilities,
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

describe("tool families attach what can be used", () => {
  const none = configured(noneAgentCapabilities());

  test("wait_for_input needs something that can resume the agent", () => {
    const detached = { sandboxAttached: false };
    // Human input alone needs no wait: an answer resumes the paused turn and a
    // new message starts one.
    expect(none.capabilities.humanInput).toBe(true);
    expect(resolveAgentToolFamilies(none, detached).waitForInput).toBe(false);
    expect(resolveAgentToolFamilies(none, { sandboxAttached: true }).waitForInput).toBe(true);
    for (const id of ["subagents", "goals", "schedules", "browser", "media"] as const) {
      const caps = { ...noneAgentCapabilities(), [id]: true };
      expect(resolveAgentToolFamilies(configured(caps), detached).waitForInput).toBe(true);
    }
    // Legacy sessions keep it unconditionally.
    expect(resolveAgentToolFamilies(null, detached).waitForInput).toBe(true);
  });

  test("notifications are off under none and need human input", () => {
    expect(resolveAgentToolFamilies(none).notifications).toBe(false);
    const all = configured(allAgentCapabilities());
    expect(resolveAgentToolFamilies(all).notifications).toBe(true);
    expect(resolveAgentToolFamilies(all, { humanInput: false }).notifications).toBe(false);
    for (const name of [
      "notify_user",
      "notification_withdraw",
      "inbox_tidy",
      "call_user",
    ] as const) {
      expect(FIRST_PARTY_MCP_TOOL_CAPABILITIES[name]).toBe("notifications");
    }
  });

  test("privacy_facts follows its own capability", () => {
    expect(AGENT_FUNCTION_TOOL_CAPABILITIES.privacy_facts).toBe("privacyFacts");
    expect(noneAgentCapabilities().privacyFacts).toBe(false);
    expect(allAgentCapabilities().privacyFacts).toBe(true);
  });
});

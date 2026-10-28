import { afterEach, describe, expect, test } from "bun:test";
import type {
  HumanInputQuestion,
  SessionEvent,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { act, createElement } from "react";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";
import { createOpenGeniText } from "../src/messages/runtime";

registerDom();

const { HumanInputForm } = await import("../src");
const { humanInputAgentMayDecide } = await import("../src/human-input-model");
const { delegatedHumanInputRequestIds, humanInputDelegationMessage, parseHumanInputDelegation } =
  await import("../src/human-input-delegation");
const { buildTimeline } = await import("../src/timeline/projection");
const { HumanInputDelegationRecord } =
  await import("../src/app/components/session/human-input-delegation-record");

const englishText = createOpenGeniText();
const CHILD = "6f0e3b52-6a51-4d7e-9a0c-1d2e3f4a5b6c";
const REQUEST = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

const choice: HumanInputQuestion = {
  id: "branch",
  kind: "single_select",
  prompt: "Which branch should I deploy?",
  options: [
    { id: "main", label: "main" },
    { id: "release", label: "release/1.4" },
  ],
  required: true,
  allowOther: true,
};

const secretQuestion: HumanInputQuestion = {
  id: "token",
  kind: "secret",
  prompt: "API token",
  options: [],
  required: true,
  allowOther: false,
  secret: {
    item: "Deploy token",
    field: "token",
    fieldKind: "concealed",
    itemType: "api_key",
    username: null,
    website: null,
    looksLike: null,
    pattern: null,
    saveTo: "task",
    vault: null,
    allowGenerate: false,
    generate: null,
    autocomplete: "off",
  },
} as HumanInputQuestion;

function request(overrides: Partial<SessionHumanInputRequest> = {}): SessionHumanInputRequest {
  return {
    id: REQUEST,
    workspaceId: "workspace-1",
    sessionId: CHILD,
    turnId: "turn-1",
    turnGeneration: 1,
    creationAttemptId: "attempt-1",
    toolCallId: "call-1",
    status: "pending",
    questions: [choice],
    allowSkip: false,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: "2026-10-28T07:32:41.000Z",
    updatedAt: "2026-10-28T07:32:41.000Z",
    ...overrides,
  } as SessionHumanInputRequest;
}

function buttons(): string[] {
  return [...mounted!.container.querySelectorAll("button")]
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean);
}

function button(label: string): HTMLButtonElement | undefined {
  return [...mounted!.container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await flush(0);
}

describe("Let the agent decide", () => {
  test("is offered on an ordinary question, even one that cannot be skipped", async () => {
    const submissions: SubmitHumanInputResponseRequest[] = [];
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: request(),
        onSubmit: (response) => {
          submissions.push(response);
        },
        autoFocus: false,
      }),
    );
    expect(buttons()).toContain("Let the agent decide");
    expect(buttons()).not.toContain("Skip");
    await click(button("Let the agent decide")!);
    expect(submissions).toEqual([{ outcome: "skipped", agentDecides: true }]);
  });

  test("replaces Skip, and the hint that said the same, when skipping is allowed", async () => {
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: request({ allowSkip: true }),
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    expect(buttons().filter((label) => label === "Let the agent decide")).toHaveLength(1);
    expect(buttons()).not.toContain("Skip");
    expect(mounted.container.textContent).not.toContain("Or skip and let the agent decide");
  });

  test("is never offered for secrets, Skill reviews or secret approvals", async () => {
    expect(humanInputAgentMayDecide(request({ questions: [secretQuestion] }))).toBe(false);
    expect(humanInputAgentMayDecide(request({ questions: [choice, secretQuestion] }))).toBe(false);
    expect(
      humanInputAgentMayDecide(
        request({
          questions: [
            {
              ...choice,
              skillReview: {
                sourceOperationId: "op",
                skillId: "skill",
                revisionId: "rev",
                expectedRevisionId: null,
                expectedScopeVersion: 1,
              },
            } as HumanInputQuestion,
          ],
        }),
      ),
    ).toBe(false);
    expect(
      humanInputAgentMayDecide(
        request({ questions: [{ ...choice, id: `secret-approval:${REQUEST}` }] }),
      ),
    ).toBe(false);
    expect(humanInputAgentMayDecide(request({ origin: "secret_use_approval" }))).toBe(false);
    expect(humanInputAgentMayDecide(request({ status: "answered" }))).toBe(false);
    expect(humanInputAgentMayDecide(request())).toBe(true);

    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: request({ questions: [secretQuestion], allowSkip: true }),
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    expect(buttons()).not.toContain("Let the agent decide");
    expect(buttons()).toContain("Skip");
  });

  test("a host can hand the question to another agent and show that it is deciding", async () => {
    const submissions: SubmitHumanInputResponseRequest[] = [];
    let handed = 0;
    const props = {
      request: request(),
      onSubmit: (response: SubmitHumanInputResponseRequest) => {
        submissions.push(response);
      },
      onLetAgentDecide: () => {
        handed += 1;
      },
      autoFocus: false,
    };
    mounted = await renderComponent(createElement(HumanInputForm, props));
    await click(button("Let the agent decide")!);
    expect(handed).toBe(1);
    expect(submissions).toEqual([]);

    await mounted.rerender(createElement(HumanInputForm, { ...props, agentDeciding: true }));
    await flush(0);
    expect(button("Let the agent decide")).toBeUndefined();
    expect(
      mounted.container.querySelector("[data-human-input-agent-deciding]")?.textContent,
    ).toContain("Your agent is deciding");
    // The person can still answer.
    expect(button("Send answer")).toBeDefined();
  });
});

describe("handing a sub-session's question to the agent", () => {
  test("the message names the exact request for the agent and reads back", () => {
    const message = humanInputDelegationMessage(englishText, {
      sessionId: CHILD,
      sessionTitle: "Build portable Git merge batcher core",
      request: request(),
    });
    expect(message.text).toBe("Let the agent decide: Which branch should I deploy?");
    expect(message.modelContext).toContain(`sessionId ${CHILD}`);
    expect(message.modelContext).toContain(`requestId ${REQUEST}`);
    expect(message.modelContext).toContain("session_human_input_respond");
    expect(message.modelContext).toContain("main (main), release (release/1.4)");
    expect(parseHumanInputDelegation(message.modelContext)).toEqual({
      sessionId: CHILD,
      requestId: REQUEST,
    });
    expect(parseHumanInputDelegation("Hello")).toBeNull();
    expect(parseHumanInputDelegation(undefined)).toBeNull();
    expect(
      parseHumanInputDelegation(
        'opengeni:human-input-delegation {"sessionId":"x","requestId":"y"}',
      ),
    ).toBeNull();

    const events = [
      {
        id: "event-1",
        workspaceId: "workspace-1",
        sessionId: "parent",
        sequence: 1,
        type: "user.message",
        payload: message,
        occurredAt: "2026-10-28T07:40:00.000Z",
        turnId: null,
      },
    ] as SessionEvent[];
    expect([...delegatedHumanInputRequestIds(events)]).toEqual([REQUEST]);
    const [item] = buildTimeline(englishText, events);
    expect(item).toMatchObject({
      kind: "user-message",
      humanInputDelegation: { sessionId: CHILD, requestId: REQUEST },
    });
  });

  test("the chat shows the agent deciding, then what it chose", async () => {
    const message = humanInputDelegationMessage(englishText, {
      sessionId: CHILD,
      sessionTitle: "Child",
      request: request(),
    });
    const item = {
      kind: "user-message" as const,
      id: "event-1",
      text: message.text,
      resources: [],
      tools: [],
      occurredAt: "2026-10-28T07:40:00.000Z",
      humanInputDelegation: { sessionId: CHILD, requestId: REQUEST },
    };
    const client = {
      getHumanInputRequest: async () => {
        throw new Error("supplied");
      },
    };
    mounted = await renderComponent(
      createElement(HumanInputDelegationRecord, {
        client,
        workspaceId: "workspace-1",
        item,
        request: request(),
      }),
    );
    expect(mounted.container.textContent).toContain("You let the agent decide");
    expect(mounted.container.textContent).toContain("Which branch should I deploy?");
    expect(mounted.container.textContent).toContain("Your agent is deciding");

    await mounted.rerender(
      createElement(HumanInputDelegationRecord, {
        client,
        workspaceId: "workspace-1",
        item,
        request: request({
          status: "answered",
          respondedBy: "agent_attempt:attempt-2",
          response: {
            outcome: "answered",
            answers: [{ questionId: "branch", values: ["release"] }],
          },
        }),
      }),
    );
    await flush(0);
    expect(mounted.container.textContent).toContain("Agent decided: release/1.4");
  });
});

describe("the settled question", () => {
  test("says the person let the agent decide", async () => {
    const events = [
      {
        id: "event-1",
        workspaceId: "workspace-1",
        sessionId: CHILD,
        sequence: 1,
        type: "session.humanInput.requested",
        payload: { request: request() },
        occurredAt: "2026-10-28T07:32:41.000Z",
        turnId: "turn-1",
      },
      {
        id: "event-2",
        workspaceId: "workspace-1",
        sessionId: CHILD,
        sequence: 2,
        type: "user.humanInputResponse",
        payload: { requestId: REQUEST, response: { outcome: "skipped", agentDecides: true } },
        occurredAt: "2026-10-28T07:33:00.000Z",
        turnId: "turn-1",
      },
    ] as SessionEvent[];
    const item = buildTimeline(englishText, events).find((entry) => entry.kind === "human-input");
    expect(item).toMatchObject({ response: { outcome: "skipped", agentDecides: true } });
  });
});

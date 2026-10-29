import { afterEach, describe, expect, jest, test } from "bun:test";
import type { HumanInputQuestion, SessionHumanInputRequest } from "@opengeni/sdk";
import { createElement } from "react";
import { actRun, flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const { HumanInputForm } = await import("../src");
const { defaultHumanInputFormMessages } = await import("../src/human-input-model");
const { createOpenGeniText, OpenGeniMessagesProvider } = await import("../src/messages/runtime");
const { humanInputDelegationMessage } = await import("../src/human-input-delegation");
const { HumanInputDelegationRecord } =
  await import("../src/app/components/session/human-input-delegation-record");

import type { HumanInputFormMessages } from "../src/human-input-model";

const CHILD = "6f0e3b52-6a51-4d7e-9a0c-1d2e3f4a5b6c";
const REQUEST = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
/** The record's read interval. */
const POLL_MS = 10_000;

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  jest.useRealTimers();
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

const decided = () =>
  request({
    status: "answered",
    respondedBy: "agent_attempt:attempt-2",
    response: { outcome: "answered", answers: [{ questionId: "branch", values: ["release"] }] },
  });

function delegationItem(sender?: { subjectId: string; label: string | null }) {
  return {
    kind: "user-message" as const,
    id: "event-1",
    text: "Let the agent decide: Which branch should I deploy?",
    resources: [],
    tools: [],
    occurredAt: "2026-10-28T07:40:00.000Z",
    humanInputDelegation: { sessionId: CHILD, requestId: REQUEST },
    ...(sender ? { sender } : {}),
  };
}

function countingClient(answer: () => SessionHumanInputRequest) {
  const client = {
    reads: 0,
    getHumanInputRequest: async () => {
      client.reads += 1;
      return answer();
    },
  };
  return client;
}

describe("the hand-off record", () => {
  test("stops reading once the question is settled", async () => {
    jest.useFakeTimers();
    const client = countingClient(decided);
    mounted = await renderComponent(
      createElement(HumanInputDelegationRecord, {
        client,
        workspaceId: "workspace-1",
        item: delegationItem(),
      }),
    );
    await actRun(() => jest.advanceTimersByTime(0));
    await flush(0);
    expect(mounted.container.textContent).toContain("Agent decided: release/1.4");
    expect(client.reads).toBe(1);
    for (let poll = 0; poll < 4; poll += 1) {
      await actRun(() => jest.advanceTimersByTime(POLL_MS));
      await flush(0);
    }
    expect(client.reads).toBe(1);
  });

  test("keeps reading while the agent is still deciding", async () => {
    jest.useFakeTimers();
    const client = countingClient(() => request());
    mounted = await renderComponent(
      createElement(HumanInputDelegationRecord, {
        client,
        workspaceId: "workspace-1",
        item: delegationItem(),
      }),
    );
    await actRun(() => jest.advanceTimersByTime(0));
    await flush(0);
    expect(mounted.container.textContent).toContain("Your agent is deciding");
    for (let poll = 0; poll < 2; poll += 1) {
      await actRun(() => jest.advanceTimersByTime(POLL_MS));
      await flush(0);
    }
    expect(client.reads).toBeGreaterThan(1);
  });

  test('a hand-off another member sent is not "You"', async () => {
    const client = countingClient(decided);
    mounted = await renderComponent(
      createElement(HumanInputDelegationRecord, {
        client,
        workspaceId: "workspace-1",
        item: delegationItem({ subjectId: "user:kari", label: "kari@example.com" }),
        viewerSubjectId: "user:ola",
        request: decided(),
      }),
    );
    expect(mounted.container.textContent).not.toContain("You let the agent decide");
    expect(mounted.container.textContent).toContain("Let the agent decide");

    await mounted.rerender(
      createElement(HumanInputDelegationRecord, {
        client,
        workspaceId: "workspace-1",
        item: delegationItem({ subjectId: "user:ola", label: "ola@example.com" }),
        viewerSubjectId: "user:ola",
        request: decided(),
      }),
    );
    expect(mounted.container.textContent).toContain("You let the agent decide");
  });

  test("its words come from the host's text", async () => {
    const messages = {
      "humanInputDelegation.message": "La agenten bestemme: {question}",
      "messageTimeline.agentDecidedSummary": "Agenten valgte: {summary}",
      "messageTimeline.youLetTheAgentDecide": "Du lot agenten bestemme",
    };
    const t = createOpenGeniText({ messages });
    const sent = humanInputDelegationMessage(t, {
      sessionId: CHILD,
      sessionTitle: "Child",
      request: request(),
    });
    expect(sent.text).toBe("La agenten bestemme: Which branch should I deploy?");
    mounted = await renderComponent(
      createElement(
        OpenGeniMessagesProvider,
        { messages },
        createElement(HumanInputDelegationRecord, {
          client: countingClient(decided),
          workspaceId: "workspace-1",
          item: { ...delegationItem(), text: sent.text },
          request: decided(),
        }),
      ),
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Du lot agenten bestemme");
    expect(text).toContain("Agenten valgte: release/1.4");
    // The question is shown once, without the lead-in.
    expect(text).not.toContain("La agenten bestemme:");
    expect(text).toContain("Which branch should I deploy?");
  });
});

describe("a host's own form messages", () => {
  test("a complete set written before the new action still fits, and the card fills it in", async () => {
    const {
      letAgentDecide: _letAgentDecide,
      agentDeciding: _agentDeciding,
      ...older
    } = defaultHumanInputFormMessages(createOpenGeniText());
    // Typed as the host typed it: every key the form had before.
    const hostMessages: HumanInputFormMessages = { ...older, submitOne: "Send it" };
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: request(),
        onSubmit: () => undefined,
        autoFocus: false,
        messages: { ...hostMessages, letAgentDecide: undefined, agentDeciding: undefined },
      }),
    );
    const labels = [...mounted.container.querySelectorAll("button")].map(
      (element) => element.textContent?.trim() ?? "",
    );
    expect(labels).toContain("Let the agent decide");
    expect(labels).toContain("Send it");
  });
});

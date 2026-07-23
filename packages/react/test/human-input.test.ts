import { afterEach, describe, expect, test } from "bun:test";
import type { HumanInputQuestion, SessionEvent } from "@opengeni/sdk";
import { act, createElement } from "react";
import {
  answersFromDrafts,
  HumanInputForm,
  humanInputRequestFromEvent,
  projectPendingHumanInputRequests,
} from "../src";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

function event(
  sequence: number,
  type: string,
  payload: unknown,
  turnId: string | null = "turn-1",
): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(sequence * 1_000).toISOString(),
    turnId,
  };
}

const questions: HumanInputQuestion[] = [
  {
    id: "summary",
    kind: "text",
    prompt: "What should happen?",
    options: [],
    required: true,
    allowOther: false,
    validation: { minLength: 3 },
  },
  {
    id: "targets",
    kind: "multi_select",
    prompt: "Where?",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    required: true,
    allowOther: true,
    validation: { minSelections: 1, maxSelections: 2 },
  },
];

describe("structured human-input projection", () => {
  test("parses a request and removes it after a durable response", () => {
    const requested = event(1, "session.humanInput.requested", {
      request: { id: "request-1", questions, allowSkip: true, expiresAt: null },
    });
    expect(humanInputRequestFromEvent(requested)).toMatchObject({
      id: "request-1",
      turnId: "turn-1",
      allowSkip: true,
    });
    expect(projectPendingHumanInputRequests([requested])).toHaveLength(1);
    expect(
      projectPendingHumanInputRequests([
        requested,
        event(2, "user.humanInputResponse", {
          requestId: "request-1",
          response: { outcome: "answered", answers: [] },
        }),
      ]),
    ).toEqual([]);
  });

  test("terminal events clear only requests owned by that turn", () => {
    const first = event(1, "session.humanInput.requested", {
      request: { id: "request-1", questions, allowSkip: false, expiresAt: null },
    });
    const second = event(
      2,
      "session.humanInput.requested",
      { request: { id: "request-2", questions, allowSkip: false, expiresAt: null } },
      "turn-2",
    );
    expect(
      projectPendingHumanInputRequests([
        first,
        second,
        event(3, "turn.cancelled", {}, "turn-1"),
      ]).map((request) => request.id),
    ).toEqual(["request-2"]);
  });
});

describe("answersFromDrafts", () => {
  test("normalizes text, selections, and Other into the SDK response shape", () => {
    expect(
      answersFromDrafts(questions, {
        summary: { values: ["Ship it"], other: "", otherSelected: false },
        targets: { values: ["staging"], other: "canary", otherSelected: true },
      }),
    ).toEqual({
      answers: [
        { questionId: "summary", values: ["Ship it"] },
        { questionId: "targets", values: ["staging"], other: "canary" },
      ],
      errors: {},
    });
  });

  test("rejects missing required and invalid minimum-length answers locally", () => {
    const missing = answersFromDrafts(questions, {});
    expect(Object.keys(missing.errors)).toEqual(["summary", "targets"]);
    expect(
      answersFromDrafts(questions.slice(0, 1), {
        summary: { values: ["no"], other: "", otherSelected: false },
      }).errors.summary,
    ).toContain("at least 3");
  });
});

describe("HumanInputForm async host boundary", () => {
  const request = {
    id: "request-form",
    questions: [
      {
        id: "optional-note",
        kind: "text" as const,
        prompt: "Anything else?",
        options: [],
        required: false,
        allowOther: false,
      },
    ],
    allowSkip: false,
    expiresAt: null,
  };

  test("captures a rejecting host callback as an accessible form error", async () => {
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request,
        onSubmit: async () => {
          throw new Error("Host submission failed");
        },
      }),
    );
    const form = mounted.container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Host submission failed",
    );
  });

  test("admits only one callback while the first submission is unresolved", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request,
        onSubmit: async () => {
          calls += 1;
          await pending;
        },
      }),
    );
    const form = mounted.container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(mounted.container.querySelector('button[type="submit"]')?.textContent).toContain(
      "Submitting",
    );
    release();
    await act(async () => {
      await pending;
    });
  });
});

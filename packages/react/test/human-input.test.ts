import { afterEach, describe, expect, test } from "bun:test";
import type {
  HumanInputQuestion,
  SessionEvent,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { act, createElement } from "react";
import {
  answersFromDrafts,
  HumanInputForm,
  HumanInputSurface,
  humanInputRequestFromEvent,
  projectPendingHumanInputRequests,
} from "../src";
import type { SessionHumanInputRequest } from "@opengeni/sdk";
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

function typeIntoInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!reactPropsKey) throw new Error("React input props were not attached");
  const onChange = (
    input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>
  )[reactPropsKey]?.onChange;
  if (!onChange) throw new Error("React input change handler was not attached");
  onChange({ target: input });
}

const questions: HumanInputQuestion[] = [
  {
    id: "summary",
    kind: "text",
    prompt: "What should happen?",
    options: [],
    required: true,
    allowOther: false,
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

  test("rejects missing required answers locally; text has no char min", () => {
    const missing = answersFromDrafts(questions, {});
    expect(Object.keys(missing.errors)).toEqual(["summary", "targets"]);
    expect(
      answersFromDrafts(questions.slice(0, 1), {
        summary: { values: ["no"], other: "", otherSelected: false },
      }).errors,
    ).toEqual({});
  });

  test("uses host validation copy without replacing the native validator", () => {
    expect(
      answersFromDrafts(questions.slice(0, 1), {}, { required: "Dette feltet er påkrevd." }).errors
        .summary,
    ).toBe("Dette feltet er påkrevd.");
  });

  test("Other selected with empty text prefers otherRequired over required", () => {
    expect(
      answersFromDrafts(questions.slice(1), {
        targets: { values: [], other: "", otherSelected: true },
      }).errors.targets,
    ).toBe("Enter a value for Other.");
  });

  test("keeps exact Other text for a legacy choice that did not advertise it", () => {
    expect(
      answersFromDrafts(
        [
          {
            id: "environment",
            kind: "single_select",
            prompt: "Where should this run?",
            options: [{ id: "staging", label: "Staging" }],
            required: true,
            allowOther: false,
          },
        ],
        {
          environment: {
            values: [],
            other: "  Customer sandbox eu-42  ",
            otherSelected: true,
          },
        },
      ),
    ).toEqual({
      answers: [
        {
          questionId: "environment",
          values: [],
          other: "  Customer sandbox eu-42  ",
        },
      ],
      errors: {},
    });
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

  test("multi-question header shows count; invalid Send answers focuses first error", async () => {
    const multi = {
      id: "request-multi",
      questions: [
        {
          id: "q1",
          kind: "text" as const,
          prompt: "First?",
          options: [],
          required: true,
          allowOther: false,
        },
        {
          id: "q2",
          kind: "single_select" as const,
          prompt: "Second?",
          options: [{ id: "yes", label: "Yes" }],
          required: true,
          allowOther: false,
        },
      ],
      allowSkip: false,
      expiresAt: null,
    };
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: multi,
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    expect(mounted.container.textContent).toContain("2 questions");
    expect(mounted.container.querySelector('button[type="submit"]')?.textContent).toBe(
      "Send answers",
    );
    expect(mounted.container.querySelectorAll("[data-human-input-question]")).toHaveLength(2);
    expect(
      mounted.container.querySelector('[data-human-input-question="q1"] label')?.textContent,
    ).toMatch(/1\.\s*First\?/);
    const secondGroup = mounted.container.querySelector(
      '[data-human-input-question="q2"] [role="radiogroup"]',
    );
    const secondLabelId = secondGroup?.getAttribute("aria-labelledby");
    expect(secondLabelId).toBeTruthy();
    expect(document.getElementById(secondLabelId!)?.textContent).toMatch(/2\.\s*Second\?/);

    const form = mounted.container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(mounted.container.textContent).toContain("This question is required.");
    const firstField = mounted.container.querySelector(
      '[data-human-input-question="q1"] textarea, [data-human-input-question="q1"] input',
    );
    expect(document.activeElement).toBe(firstField);
  });

  test("always renders an accessible inline Other field for a choice question", async () => {
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: {
          id: "request-other",
          questions: [
            {
              id: "environment",
              kind: "single_select" as const,
              prompt: "Where should this run?",
              options: [{ id: "staging", label: "Staging" }],
              required: true,
              allowOther: false,
            },
          ],
          allowSkip: false,
          expiresAt: null,
        },
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    const group = mounted.container.querySelector('[data-human-input-question="environment"]');
    expect(group?.textContent).toContain("Other");
    const choiceGroup = group?.querySelector('[role="radiogroup"]');
    const choiceGroupLabelId = choiceGroup?.getAttribute("aria-labelledby");
    expect(choiceGroupLabelId).toBeTruthy();
    expect(document.getElementById(choiceGroupLabelId!)?.textContent).toContain(
      "Where should this run?",
    );
    const otherInput = group?.querySelector<HTMLInputElement>('input[type="text"]');
    expect(otherInput).not.toBeNull();
    expect(otherInput?.disabled).toBe(false);
    expect(otherInput?.labels).toHaveLength(1);
    expect(otherInput?.labels?.[0]?.textContent).toContain(
      "Other answer for Where should this run?",
    );
  });

  test("clicking or typing Other selects it and submits its exact text", async () => {
    const submissions: SubmitHumanInputResponseRequest[] = [];
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: {
          id: "request-other-focus",
          questions: [
            {
              id: "environment",
              kind: "single_select" as const,
              prompt: "Where should this run?",
              options: [{ id: "staging", label: "Staging" }],
              required: true,
              allowOther: true,
            },
          ],
          allowSkip: false,
          expiresAt: null,
        },
        onSubmit: (response) => {
          submissions.push(response);
        },
        autoFocus: false,
      }),
    );

    const staging = mounted.container.querySelector<HTMLInputElement>(
      'input[type="radio"]:not([aria-labelledby])',
    );
    const otherChoice = mounted.container.querySelector<HTMLInputElement>(
      'input[type="radio"][aria-labelledby]',
    );
    const otherInput = mounted.container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(staging).not.toBeNull();
    expect(otherChoice).not.toBeNull();
    expect(otherInput).not.toBeNull();

    await act(async () => {
      staging!.click();
    });
    expect(staging?.checked).toBe(true);
    expect(otherChoice?.checked).toBe(false);

    await act(async () => {
      otherInput!.click();
    });
    expect(staging?.checked).toBe(false);
    expect(otherChoice?.checked).toBe(true);

    await act(async () => {
      staging!.click();
    });
    expect(staging?.checked).toBe(true);
    expect(otherChoice?.checked).toBe(false);

    await act(async () => {
      typeIntoInput(otherInput!, "  Customer sandbox eu-42  ");
    });
    expect(otherInput?.value).toBe("  Customer sandbox eu-42  ");
    expect(staging?.checked).toBe(false);
    expect(otherChoice?.checked).toBe(true);

    await act(async () => {
      mounted!.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(submissions).toEqual([
      {
        outcome: "answered",
        answers: [
          {
            questionId: "environment",
            values: [],
            other: "  Customer sandbox eu-42  ",
          },
        ],
      },
    ]);
  });

  test("focusing Other preserves multi-select choices and normal choices still toggle", async () => {
    const submissions: SubmitHumanInputResponseRequest[] = [];
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: {
          id: "request-other-multi",
          questions: [questions[1]!],
          allowSkip: false,
          expiresAt: null,
        },
        onSubmit: (response) => {
          submissions.push(response);
        },
        autoFocus: false,
      }),
    );

    const staging = mounted.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const otherChoice =
      mounted.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2];
    const otherInput = mounted.container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(staging).not.toBeNull();
    expect(otherChoice).not.toBeNull();
    expect(otherInput).not.toBeNull();

    await act(async () => {
      staging!.click();
      otherInput!.focus();
      typeIntoInput(otherInput!, "canary");
    });
    expect(document.activeElement).toBe(otherInput);
    expect(staging?.checked).toBe(true);
    expect(otherChoice?.checked).toBe(true);

    await act(async () => {
      mounted!.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(submissions).toEqual([
      {
        outcome: "answered",
        answers: [{ questionId: "targets", values: ["staging"], other: "canary" }],
      },
    ]);
  });

  test("supports complete host copy and autofocus", async () => {
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request,
        onSubmit: () => undefined,
        // Explicit title/description win; single-question mode otherwise leads
        // with the question prompt instead of the generic messages.title.
        title: "Vi trenger svaret ditt",
        description: "Agenten venter på deg.",
        messages: {
          submit: "Fortsett",
          other: "Annet",
        },
      }),
    );
    expect(mounted.container.textContent).toContain("Vi trenger svaret ditt");
    expect(mounted.container.textContent).toContain("Agenten venter på deg.");
    expect(mounted.container.textContent).toContain("Fortsett");
    expect(document.activeElement).toBe(mounted.container.querySelector("textarea"));
  });

  test("preserves an in-progress answer when the same request is refreshed", async () => {
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request,
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    const textarea = mounted.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Keep this answer while the session updates.");
      const reactPropsKey = Object.keys(textarea!).find((key) => key.startsWith("__reactProps$"));
      expect(reactPropsKey).toBeDefined();
      const onChange = (
        textarea as unknown as Record<
          string,
          { onChange?: (event: { target: HTMLTextAreaElement }) => void }
        >
      )[reactPropsKey!]!.onChange;
      expect(typeof onChange).toBe("function");
      onChange!({ target: textarea! });
    });
    expect(textarea?.value).toBe("Keep this answer while the session updates.");

    await mounted.rerender(
      createElement(HumanInputForm, {
        request: {
          ...request,
          questions: request.questions.map((question) => ({
            ...question,
            options: [...question.options],
          })),
        },
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );

    const refreshedTextarea = mounted.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(refreshedTextarea).toBe(textarea);
    expect(refreshedTextarea?.value).toBe("Keep this answer while the session updates.");

    await mounted.rerender(
      createElement(HumanInputForm, {
        request: {
          ...request,
          id: "request-form-next",
          questions: request.questions.map((question) => ({
            ...question,
            prompt: "A different durable request",
          })),
        },
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    expect(mounted.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    expect(mounted.container.textContent).toContain("A different durable request");
  });

  test("HumanInputSurface shows one pending request at a time with progress", async () => {
    const base = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      turnGeneration: 1,
      creationAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "pending" as const,
      response: null,
      respondedBy: null,
      respondedAt: null,
      expiresAt: null,
      updatedAt: "2026-08-03T10:00:00.000Z",
      questions: request.questions,
      allowSkip: false,
    };
    const requests: SessionHumanInputRequest[] = [
      {
        ...base,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        toolCallId: "call-b",
        createdAt: "2026-08-03T10:00:02.000Z",
        questions: [
          {
            id: "later",
            kind: "text",
            prompt: "Second request prompt",
            options: [],
            required: true,
            allowOther: false,
          },
        ],
      },
      {
        ...base,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        toolCallId: "call-a",
        createdAt: "2026-08-03T10:00:01.000Z",
        questions: [
          {
            id: "earlier",
            kind: "text",
            prompt: "First request prompt",
            options: [],
            required: true,
            allowOther: false,
          },
        ],
      },
    ];
    mounted = await renderComponent(
      createElement(HumanInputSurface, {
        requests,
        onSubmit: () => undefined,
      }),
    );
    expect(mounted.container.textContent).toContain("First request prompt");
    expect(mounted.container.textContent).toContain("1 of 2");
    expect(mounted.container.textContent).not.toContain("Second request prompt");
    expect(mounted.container.querySelectorAll("[data-human-input-request]")).toHaveLength(1);
  });

  test("collapse hides the form body; expand brings the form back", async () => {
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: {
          id: "request-collapse",
          questions: [
            {
              id: "color",
              kind: "text",
              prompt: "Favorite color?",
              options: [],
              required: true,
              allowOther: false,
            },
          ],
          allowSkip: true,
          expiresAt: null,
        },
        onSubmit: () => undefined,
      }),
    );
    expect(mounted.container.querySelector("form")).not.toBeNull();
    const collapse = mounted.container.querySelector('button[aria-label="Collapse"]');
    expect(collapse).not.toBeNull();
    await act(async () => {
      (collapse as HTMLButtonElement).click();
    });
    expect(mounted.container.querySelector("[data-human-input-collapsed]")).not.toBeNull();
    expect(mounted.container.querySelector("form")).toBeNull();
    expect(mounted.container.textContent).toContain("Expand");
    await act(async () => {
      const expand = [...mounted!.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Expand"),
      );
      expand?.click();
    });
    expect(mounted.container.querySelector("form")).not.toBeNull();
    expect(mounted.container.querySelector("[data-human-input-collapsed]")).toBeNull();
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

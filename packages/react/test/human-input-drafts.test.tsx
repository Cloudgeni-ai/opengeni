import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  HumanInputQuestion,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { act, createElement } from "react";
import { registerDom, renderComponent, renderHook, type RenderedComponent } from "./render-hook";

registerDom();

const { HumanInputForm, HumanInputSurface, useHumanInputRequests } = await import("../src");
const {
  HUMAN_INPUT_DRAFT_MAX_AGE_MS,
  HUMAN_INPUT_DRAFT_MAX_ENTRIES,
  forgetHumanInputDraft,
  humanInputDraftKey,
  pruneHumanInputDrafts,
  readHumanInputDraft,
  resetHumanInputDraftMemoryForTests,
  writeHumanInputDraft,
} = await import("../src/human-input-draft-store");

let mounted: RenderedComponent | null = null;

beforeEach(() => {
  resetHumanInputDraftMemoryForTests();
  window.sessionStorage.clear();
});

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

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
  },
  {
    id: "token",
    kind: "secret",
    prompt: "API token",
    options: [],
    required: false,
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
  },
];

function pendingRequest(
  overrides: Partial<SessionHumanInputRequest> = {},
): SessionHumanInputRequest {
  return {
    id: "request-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    turnGeneration: 1,
    creationAttemptId: "attempt-1",
    toolCallId: "call-1",
    status: "pending",
    questions,
    allowSkip: true,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...overrides,
  };
}

const scope = { workspaceId: "workspace-1", sessionId: "session-1", requestId: "request-1" };

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!reactPropsKey) throw new Error("React props were not attached");
  const props = (element as unknown as Record<string, Record<string, unknown>>)[reactPropsKey]!;
  // Secret fields are uncontrolled: their value only lives in the input.
  (props.onChange as ((event: { target: typeof element }) => void) | undefined)?.({
    target: element,
  });
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => setNativeValue(element, value));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function container(): HTMLElement {
  return mounted!.container;
}

function summaryField(): HTMLTextAreaElement {
  return container().querySelector<HTMLTextAreaElement>(
    '[data-human-input-question="summary"] textarea',
  )!;
}

function checkbox(value: string): HTMLInputElement {
  const inputs = [
    ...container().querySelectorAll<HTMLInputElement>(
      '[data-human-input-question="targets"] input[type="checkbox"]',
    ),
  ];
  // The Other choice comes last and is labelled by a separate element.
  if (value === "Other") return inputs.at(-1)!;
  return inputs.find((input) => input.closest("label")?.textContent?.includes(value))!;
}

function otherText(): HTMLInputElement | null {
  return container().querySelector<HTMLInputElement>(
    '[data-human-input-question="targets"] input[type="text"]',
  );
}

function secretField(): HTMLInputElement {
  return container().querySelector<HTMLInputElement>(
    '[data-human-input-question="token"] input:not([type="checkbox"]):not([type="radio"])',
  )!;
}

async function renderForm(
  request: SessionHumanInputRequest = pendingRequest(),
  onSubmit: (response: SubmitHumanInputResponseRequest) => void | Promise<void> = () => undefined,
): Promise<void> {
  mounted = await renderComponent(
    createElement(HumanInputForm, { request, onSubmit, autoFocus: false }),
  );
}

async function remount(request?: SessionHumanInputRequest): Promise<void> {
  await mounted!.unmount();
  mounted = null;
  await renderForm(request);
}

async function fillEverything(): Promise<void> {
  await type(summaryField(), "Roll back the deploy");
  await click(checkbox("Staging"));
  await click(checkbox("Other"));
  await type(otherText()!, "QA cluster");
  await type(secretField(), "super-secret-token");
}

function storedRaw(): string {
  const values: string[] = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    values.push(window.sessionStorage.getItem(window.sessionStorage.key(index)!) ?? "");
  }
  return values.join("\n");
}

describe("HumanInputForm unsent answer drafts", () => {
  test("restores free text, selections and Other text after the card remounts", async () => {
    await renderForm();
    await fillEverything();

    await remount();

    expect(summaryField().value).toBe("Roll back the deploy");
    expect(checkbox("Staging").checked).toBe(true);
    expect(checkbox("Production").checked).toBe(false);
    expect(otherText()?.value).toBe("QA cluster");
  });

  test("never stores or restores a secret answer", async () => {
    await renderForm();
    await fillEverything();
    expect(storedRaw()).toContain("Roll back the deploy");
    expect(storedRaw()).not.toContain("super-secret-token");

    await remount();
    expect(secretField().value).toBe("");
  });

  test("survives a reload through tab-scoped storage", async () => {
    await renderForm();
    await type(summaryField(), "Keep this");
    await mounted!.unmount();
    mounted = null;
    resetHumanInputDraftMemoryForTests();

    await renderForm();
    expect(summaryField().value).toBe("Keep this");
  });

  test("keys drafts by workspace, session and request", async () => {
    await renderForm();
    await type(summaryField(), "Only for request one");

    await remount(pendingRequest({ id: "request-2" }));
    expect(summaryField().value).toBe("");
    await remount(pendingRequest({ sessionId: "session-2" }));
    expect(summaryField().value).toBe("");
    await remount(pendingRequest({ workspaceId: "workspace-2" }));
    expect(summaryField().value).toBe("");
    await remount();
    expect(summaryField().value).toBe("Only for request one");
  });

  test("clears the draft once the answer is accepted", async () => {
    const submissions: SubmitHumanInputResponseRequest[] = [];
    await renderForm(pendingRequest(), (response) => {
      submissions.push(response);
    });
    await type(summaryField(), "Ship it");
    await click(checkbox("Production"));
    await act(async () => {
      container()
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submissions).toHaveLength(1);
    expect(readHumanInputDraft(scope, { questions })).toBeNull();
    expect(window.sessionStorage.getItem(humanInputDraftKey(scope))).toBeNull();

    await remount();
    expect(summaryField().value).toBe("");
  });

  test("keeps the draft when sending fails so it can be retried", async () => {
    await renderForm(pendingRequest(), async () => {
      throw new Error("offline");
    });
    await type(summaryField(), "Ship it");
    await click(checkbox("Production"));
    await act(async () => {
      container()
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await remount();
    expect(summaryField().value).toBe("Ship it");
  });

  test("clears the draft when the request is skipped", async () => {
    const submissions: SubmitHumanInputResponseRequest[] = [];
    await renderForm(pendingRequest(), (response) => {
      submissions.push(response);
    });
    await type(summaryField(), "Never mind");
    const skip = [...container().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Skip",
    )!;
    await click(skip);
    expect(submissions).toEqual([{ outcome: "skipped" }]);
    expect(readHumanInputDraft(scope, { questions })).toBeNull();
  });

  test("does not restore an expired request's draft and forgets it", async () => {
    await renderForm();
    await type(summaryField(), "Too late");
    await remount(pendingRequest({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    expect(summaryField().value).toBe("");
    expect(window.sessionStorage.getItem(humanInputDraftKey(scope))).toBeNull();
  });

  test("forgets the draft when the card shows a request resolved elsewhere", async () => {
    await renderForm();
    await type(summaryField(), "Answered in another tab");
    await remount(pendingRequest({ status: "answered" }));
    expect(summaryField().value).toBe("");
    expect(readHumanInputDraft(scope, { questions })).toBeNull();
  });

  test("the session surface restores drafts for its active request", async () => {
    const request = pendingRequest();
    const surface = () =>
      createElement(HumanInputSurface, {
        requests: [request],
        onSubmit: () => undefined,
        autoFocus: false,
      });
    mounted = await renderComponent(surface());
    await type(summaryField(), "From the timeline card");
    await mounted.unmount();
    mounted = await renderComponent(surface());
    expect(summaryField().value).toBe("From the timeline card");
  });
});

describe("human-input draft store", () => {
  const draft = (text: string) => ({
    summary: { values: [text], other: "", otherSelected: false },
  });

  test("drops selections and Other text that no longer fit the question", () => {
    writeHumanInputDraft(scope, questions, {
      targets: { values: ["staging", "removed"], other: "x", otherSelected: true },
      token: { values: ["leak"], other: "", otherSelected: false },
    });
    expect(readHumanInputDraft(scope, { questions })).toEqual({
      targets: { values: ["staging"], other: "x", otherSelected: true },
    });
    expect(storedRaw()).not.toContain("leak");
  });

  test("an all-empty draft forgets the entry", () => {
    writeHumanInputDraft(scope, questions, draft("something"));
    writeHumanInputDraft(scope, questions, {
      summary: { values: [], other: "", otherSelected: false },
    });
    expect(window.sessionStorage.getItem(humanInputDraftKey(scope))).toBeNull();
  });

  test("keeps at most the newest entries per tab", () => {
    const now = Date.now();
    for (let index = 0; index < HUMAN_INPUT_DRAFT_MAX_ENTRIES + 5; index += 1) {
      writeHumanInputDraft(
        { ...scope, requestId: `r-${index}` },
        questions,
        draft(`t${index}`),
        now + index,
      );
    }
    let stored = 0;
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      if (window.sessionStorage.key(index)?.startsWith("opengeni.human-input-draft.v1:"))
        stored += 1;
    }
    expect(stored).toBe(HUMAN_INPUT_DRAFT_MAX_ENTRIES);
    expect(readHumanInputDraft({ ...scope, requestId: "r-0" }, { questions })).toBeNull();
    expect(
      readHumanInputDraft(
        { ...scope, requestId: `r-${HUMAN_INPUT_DRAFT_MAX_ENTRIES + 4}` },
        { questions },
      ),
    ).not.toBeNull();
  });

  test("discards entries older than the age limit", () => {
    const savedAt = Date.now() - HUMAN_INPUT_DRAFT_MAX_AGE_MS - 1;
    writeHumanInputDraft(scope, questions, draft("old"), savedAt);
    expect(readHumanInputDraft(scope, { questions })).toBeNull();
    expect(window.sessionStorage.getItem(humanInputDraftKey(scope))).toBeNull();
  });

  test("prune forgets resolved requests but keeps pending and newer drafts", () => {
    const readStartedAt = Date.now();
    writeHumanInputDraft(
      { ...scope, requestId: "pending" },
      questions,
      draft("a"),
      readStartedAt - 10,
    );
    writeHumanInputDraft(
      { ...scope, requestId: "resolved" },
      questions,
      draft("b"),
      readStartedAt - 10,
    );
    writeHumanInputDraft(
      { ...scope, requestId: "brand-new" },
      questions,
      draft("c"),
      readStartedAt + 5,
    );
    const otherSession = { ...scope, sessionId: "session-2", requestId: "elsewhere" };
    writeHumanInputDraft(otherSession, questions, draft("d"), readStartedAt - 10);

    pruneHumanInputDrafts("workspace-1", "session-1", ["pending"], readStartedAt);

    expect(readHumanInputDraft({ ...scope, requestId: "pending" }, { questions })).not.toBeNull();
    expect(readHumanInputDraft({ ...scope, requestId: "resolved" }, { questions })).toBeNull();
    expect(readHumanInputDraft({ ...scope, requestId: "brand-new" }, { questions })).not.toBeNull();
    expect(readHumanInputDraft(otherSession, { questions })).not.toBeNull();
    forgetHumanInputDraft(otherSession);
    expect(readHumanInputDraft(otherSession, { questions })).toBeNull();
  });

  test("the pending-request read forgets drafts for requests resolved elsewhere", async () => {
    const earlier = Date.now() - 60_000;
    writeHumanInputDraft({ ...scope, requestId: "still-open" }, questions, draft("a"), earlier);
    writeHumanInputDraft(
      { ...scope, requestId: "answered-elsewhere" },
      questions,
      draft("b"),
      earlier,
    );
    writeHumanInputDraft({ ...scope, requestId: "expired" }, questions, draft("c"), earlier);
    const client = {
      listHumanInputRequests: async () => [
        pendingRequest({ id: "still-open" }),
        pendingRequest({ id: "expired", expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      ],
      submitHumanInputResponse: async () => {
        throw new Error("unused");
      },
      getSession: async () => {
        throw new Error("unused");
      },
      streamEvents: async function* () {},
    };
    const hook = await renderHook(
      () => useHumanInputRequests("session-1", { client, workspaceId: "workspace-1", events: [] }),
      undefined,
    );
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(
      readHumanInputDraft({ ...scope, requestId: "still-open" }, { questions }),
    ).not.toBeNull();
    expect(
      readHumanInputDraft({ ...scope, requestId: "answered-elsewhere" }, { questions }),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(humanInputDraftKey({ ...scope, requestId: "expired" })),
    ).toBeNull();
    await hook.unmount();
  });
});

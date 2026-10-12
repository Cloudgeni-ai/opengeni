import { afterEach, describe, expect, test } from "bun:test";
import { tokenizeSecretText } from "@opengeni/contracts";
import type {
  HumanInputQuestion,
  HumanInputSecretSpec,
  SessionEvent,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

// Radix picks its layout-effect implementation at import time: load after the DOM exists.
const { HumanInputForm, MessageTimeline, SecretsUiProvider } = await import("../src");
const { SessionConversation } = await import("../src/components/session-conversation");
const {
  resolveSecretSaveTo,
  secretAnswerFromReading,
  secretAutocomplete,
  secretCanGenerate,
  secretFieldLabel,
  secretInputMode,
  secretPatternMismatch,
  secretVaultForTarget,
} = await import("../src/human-input-model");

const SECRET = "hunter2-Correct-Horse";
const GENERATED = "Gen3rated-Strong-Pass!";

const fakeUi = {
  tokenize: tokenizeSecretText,
  generatePassword: () => GENERATED,
};

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

function secretQuestion(
  secret: HumanInputSecretSpec,
  overrides: Partial<HumanInputQuestion> = {},
): HumanInputQuestion {
  return {
    id: "github",
    kind: "secret",
    prompt: "Your GitHub password",
    options: [],
    required: true,
    allowOther: false,
    secret,
    ...overrides,
  };
}

function requestWith(questions: HumanInputQuestion[], allowSkip = false) {
  return { id: "request-secret", questions, allowSkip, expiresAt: null };
}

type FormOptions = {
  provider?: boolean;
  allowedSaveTo?: Array<"user" | "task" | "workspace">;
  onSubmit?: (response: SubmitHumanInputResponseRequest) => void | Promise<void>;
};

async function renderForm(questions: HumanInputQuestion[], options: FormOptions = {}) {
  const submissions: SubmitHumanInputResponseRequest[] = [];
  const form = (
    <HumanInputForm
      request={requestWith(questions)}
      autoFocus={false}
      allowedSaveTo={options.allowedSaveTo}
      onSubmit={
        options.onSubmit ??
        ((response) => {
          submissions.push(response);
        })
      }
    />
  );
  const node: ReactNode = options.provider ? (
    <SecretsUiProvider value={fakeUi}>{form}</SecretsUiProvider>
  ) : (
    form
  );
  mounted = await renderComponent(node);
  return { container: mounted.container, submissions };
}

function secretAnswersOf(response: SubmitHumanInputResponseRequest | undefined) {
  return response && "secretAnswers" in response ? response.secretAnswers : undefined;
}

function secretInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[name^="secret-"]');
  if (!input) throw new Error("secret input not rendered");
  return input;
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`button ${text} not rendered`);
  return found;
}

async function typeSecret(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  const key = Object.keys(textarea).find((candidate) => candidate.startsWith("__reactProps$"));
  const props = (textarea as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
    key!
  ];
  props?.onChange?.({ target: textarea });
}

/**
 * Walk everything reachable from the React root (fibers, hook state, props,
 * refs) except DOM nodes, and report whether any string contains `needle`.
 */
function reactTreeContains(container: HTMLElement, needle: string): boolean {
  const rootKey = Object.keys(container).find((key) => key.startsWith("__reactContainer$"));
  if (!rootKey) throw new Error("React root not attached");
  const seen = new Set<object>();
  const stack: unknown[] = [(container as unknown as Record<string, unknown>)[rootKey]];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes(needle)) return true;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (value instanceof Node || value === globalThis || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof Map || value instanceof Set) {
      for (const entry of value instanceof Map ? value.entries() : value.values()) {
        stack.push(entry);
      }
      continue;
    }
    for (const key of Object.keys(value)) {
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return false;
}

function storageContains(needle: string): boolean {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index) ?? "";
      if (key.includes(needle) || (storage.getItem(key) ?? "").includes(needle)) return true;
    }
  }
  return false;
}

describe("secret ask card: the value stays out of React", () => {
  test("typed value never enters state, props or storage; submit reads the input", async () => {
    const note: HumanInputQuestion = {
      id: "note",
      kind: "text",
      prompt: "Anything else?",
      options: [],
      required: false,
      allowOther: false,
    };
    const { container, submissions } = await renderForm([secretQuestion({ item: "GitHub" }), note]);
    const input = secretInput(container);
    await typeSecret(input, SECRET);
    await act(async () => {
      typeIntoTextarea(container.querySelector("textarea")!, "visible-draft-marker");
    });

    // Positive control: the scanner does find an ordinary controlled draft.
    expect(reactTreeContains(container, "visible-draft-marker")).toBe(true);
    expect(reactTreeContains(container, SECRET)).toBe(false);
    expect(storageContains(SECRET)).toBe(false);

    await submit(container);
    expect(submissions).toEqual([
      {
        outcome: "answered",
        answers: [
          { questionId: "github", values: [] },
          { questionId: "note", values: ["visible-draft-marker"] },
        ],
        secretAnswers: [{ questionId: "github", value: SECRET, saveTo: "user" }],
      },
    ]);
    // Cleared after a successful submit, and still nowhere in React or storage.
    expect(input.value).toBe("");
    expect(reactTreeContains(container, SECRET)).toBe(false);
    expect(storageContains(SECRET)).toBe(false);
  });

  test("a failed submit keeps the value so the person can retry", async () => {
    const { container } = await renderForm([secretQuestion({ item: "GitHub" })], {
      onSubmit: async () => {
        throw new Error("Network down");
      },
    });
    const input = secretInput(container);
    await typeSecret(input, SECRET);
    await submit(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(input.value).toBe(SECRET);
    expect(reactTreeContains(container, SECRET)).toBe(false);
  });

  test("the input is cleared when the card unmounts", async () => {
    const { container } = await renderForm([secretQuestion({ item: "GitHub" })]);
    const input = secretInput(container);
    await typeSecret(input, SECRET);
    expect(input.value).toBe(SECRET);
    const current = mounted!;
    mounted = null;
    await current.unmount();
    expect(input.value).toBe("");
  });

  test("a required empty secret blocks submit with an error; an optional one is omitted", async () => {
    const required = await renderForm([secretQuestion({ item: "GitHub" })]);
    await submit(required.container);
    expect(required.submissions).toEqual([]);
    expect(required.container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(secretInput(required.container).getAttribute("aria-invalid")).toBe("true");
    // Typing clears the stale error.
    await typeSecret(secretInput(required.container), "x");
    expect(secretInput(required.container).getAttribute("aria-invalid")).toBe("false");
    const first = mounted!;
    mounted = null;
    await first.unmount();

    const optional = await renderForm([secretQuestion({ item: "GitHub" }, { required: false })]);
    await submit(optional.container);
    expect(optional.submissions).toEqual([{ outcome: "answered", answers: [] }]);
  });
});

describe("secret ask card: browser and password-manager attributes", () => {
  const cases: Array<{
    name: string;
    spec: HumanInputSecretSpec;
    autocomplete: string;
    inputMode: string | null;
    type: string;
    label: string;
    generate: boolean;
  }> = [
    {
      name: "plain password",
      spec: { item: "GitHub" },
      autocomplete: "current-password",
      inputMode: null,
      type: "password",
      label: "Password",
      generate: false,
    },
    {
      name: "generated password",
      spec: { item: "GitHub", allowGenerate: true },
      autocomplete: "new-password",
      inputMode: null,
      type: "password",
      label: "Password",
      generate: true,
    },
    {
      name: "generate spec without allowGenerate",
      spec: { item: "GitHub", generate: { length: 32 } },
      autocomplete: "new-password",
      inputMode: null,
      type: "password",
      label: "Password",
      generate: true,
    },
    {
      name: "explicit autocomplete wins",
      spec: { item: "GitHub", allowGenerate: true, autocomplete: "off" },
      autocomplete: "off",
      inputMode: null,
      type: "password",
      label: "Password",
      generate: true,
    },
    {
      name: "one-time code",
      spec: { item: "GitHub", fieldKind: "totp", allowGenerate: true },
      autocomplete: "one-time-code",
      inputMode: "numeric",
      type: "password",
      label: "One-time code",
      generate: false,
    },
    {
      name: "API key",
      spec: { item: "OpenAI", itemType: "api_key", looksLike: "sk-…" },
      autocomplete: "current-password",
      inputMode: null,
      type: "password",
      label: "API key",
      generate: false,
    },
    {
      name: "plain text field",
      spec: { item: "Server", field: "host_name", fieldKind: "text" },
      autocomplete: "current-password",
      inputMode: null,
      type: "text",
      label: "Host name",
      generate: false,
    },
  ];

  for (const variant of cases) {
    test(variant.name, async () => {
      const { container } = await renderForm([secretQuestion(variant.spec)]);
      const input = secretInput(container);
      expect(input.getAttribute("autocomplete")).toBe(variant.autocomplete);
      expect(input.getAttribute("inputmode")).toBe(variant.inputMode);
      expect(input.type).toBe(variant.type);
      expect(input.name).toBe("secret-github");
      expect(input.hasAttribute("value")).toBe(false);
      const label = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
      expect(label?.textContent).toBe(variant.label);
      const hasGenerate = [...container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === "Generate",
      );
      expect(hasGenerate).toBe(variant.generate);
      // Concealed fields get the show/hide toggle; plain text does not.
      const toggle = container.querySelector("button[aria-pressed]");
      expect(Boolean(toggle)).toBe(variant.type === "password");
    });
  }

  test("the model agrees with the rendered attributes", () => {
    expect(secretAutocomplete({ item: "a" })).toBe("current-password");
    expect(
      secretAutocomplete({ item: "a", autocomplete: "current-password", allowGenerate: true }),
    ).toBe("new-password");
    expect(secretAutocomplete({ item: "a", fieldKind: "totp" })).toBe("one-time-code");
    expect(secretInputMode({ item: "a", fieldKind: "totp" })).toBe("numeric");
    expect(secretInputMode({ item: "a", autocomplete: "one-time-code" })).toBe("numeric");
    expect(secretCanGenerate({ item: "a", fieldKind: "totp", allowGenerate: true })).toBe(false);
    expect(secretFieldLabel({ item: "a", field: "client-secret" })).toBe("Client secret");
    expect(secretFieldLabel({ item: "a", itemType: "note" })).toBe("Note");
  });

  test("username comes first, prefilled, paired for password managers inside the form", async () => {
    const { container, submissions } = await renderForm([
      secretQuestion({
        item: "GitHub",
        username: { prompt: "Username", value: "octocat" },
      }),
    ]);
    const username = container.querySelector<HTMLInputElement>('input[name="username"]')!;
    const password = secretInput(container);
    expect(username.getAttribute("autocomplete")).toBe("username");
    expect(username.value).toBe("octocat");
    expect(username.form).toBe(password.form);
    expect(username.form).not.toBeNull();
    expect(
      username.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector(`label[for="${username.id}"]`)?.textContent).toBe("Username");

    await typeSecret(password, SECRET);
    await submit(container);
    expect(secretAnswersOf(submissions[0])).toEqual([
      { questionId: "github", value: SECRET, username: "octocat", saveTo: "user" },
    ]);
  });

  test("show/hide toggles the input type and aria-pressed", async () => {
    const { container } = await renderForm([secretQuestion({ item: "GitHub" })]);
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show");
    expect(toggle.className).toContain("w-10");
    expect(toggle.className).toContain("pointer-coarse:w-11");
    await click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide");
    expect(secretInput(container).type).toBe("text");
  });
});

describe("secret ask card: Generate", () => {
  test("with a client generator: fills the input, reveals it and submits the value", async () => {
    const { container, submissions } = await renderForm(
      [secretQuestion({ item: "GitHub", allowGenerate: true })],
      { provider: true },
    );
    await click(button(container, "Generate"));
    const input = secretInput(container);
    expect(input.value).toBe(GENERATED);
    expect(input.type).toBe("text");
    expect(container.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(reactTreeContains(container, GENERATED)).toBe(false);
    await submit(container);
    expect(secretAnswersOf(submissions[0])).toEqual([
      { questionId: "github", value: GENERATED, saveTo: "user" },
    ]);
    expect(input.value).toBe("");
  });

  test("without a client generator: the server generates, with Undo", async () => {
    const { container, submissions } = await renderForm([
      secretQuestion({ item: "GitHub", generate: { length: 32, symbols: false } }),
    ]);
    await click(button(container, "Generate"));
    expect(container.querySelector('input[name^="secret-"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "A strong password will be generated",
    );
    await click(button(container, "Undo"));
    expect(secretInput(container)).toBeTruthy();
    await click(button(container, "Generate"));
    await submit(container);
    expect(submissions).toEqual([
      {
        outcome: "answered",
        answers: [{ questionId: "github", values: [] }],
        secretAnswers: [
          { questionId: "github", generate: { length: 32, symbols: false }, saveTo: "user" },
        ],
      },
    ]);
  });

  test("server generation defaults to an empty spec", async () => {
    const { container, submissions } = await renderForm([
      secretQuestion({ item: "GitHub", allowGenerate: true }),
    ]);
    await click(button(container, "Generate"));
    await submit(container);
    expect(secretAnswersOf(submissions[0])).toEqual([
      { questionId: "github", generate: {}, saveTo: "user" },
    ]);
  });
});

describe("secret ask card: hints and soft pattern warning", () => {
  test("looksLike is a hint and a pattern mismatch never blocks submit", async () => {
    const { container, submissions } = await renderForm([
      secretQuestion({
        item: "OpenAI",
        itemType: "api_key",
        looksLike: "sk-…",
        pattern: "^sk-[A-Za-z0-9]+$",
      }),
    ]);
    expect(container.textContent).toContain("Looks like sk-…");
    const input = secretInput(container);
    await typeSecret(input, "not-a-key");
    // The warning waits for blur, so it never flickers while typing.
    expect(container.textContent).not.toContain("doesn't look like");
    await blur(input);
    expect(container.textContent).toContain("This doesn't look like sk-…. You can still send it.");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await submit(container);
    expect(secretAnswersOf(submissions[0])).toEqual([
      { questionId: "github", value: "not-a-key", saveTo: "user" },
    ]);
  });

  test("a matching value shows no warning", async () => {
    const { container } = await renderForm([
      secretQuestion({ item: "OpenAI", pattern: "^sk-", looksLike: "sk-…" }),
    ]);
    const input = secretInput(container);
    await typeSecret(input, "sk-abc");
    await blur(input);
    expect(container.textContent).not.toContain("doesn't look like");
  });

  test("pattern check is unanchored and ignores invalid expressions", () => {
    expect(secretPatternMismatch("sk-", "xx sk-1")).toBe(false);
    expect(secretPatternMismatch("^sk-", "xx")).toBe(true);
    expect(secretPatternMismatch("([", "anything")).toBe(false);
    expect(secretPatternMismatch(undefined, "anything")).toBe(false);
    expect(secretPatternMismatch("^sk-", "")).toBe(false);
  });
});

describe("secret ask card: Save to", () => {
  function select(container: HTMLElement): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>("select")!;
  }

  test("defaults to Only me with all three choices and the private-vault hint", async () => {
    const { container } = await renderForm([secretQuestion({ item: "GitHub" })]);
    expect(select(container).value).toBe("user");
    expect([...select(container).options].map((option) => option.textContent)).toEqual([
      "Only me",
      "This task",
      "This workspace",
    ]);
    expect(container.textContent).toContain("Saves to your private vault");
    expect(container.querySelector(`label[for="${select(container).id}"]`)?.textContent).toBe(
      "Save to",
    );
  });

  test("uses the agent's target and the named vault for that target only", async () => {
    const { container, submissions } = await renderForm([
      secretQuestion({ item: "Deploy key", saveTo: "task", vault: "Release" }),
    ]);
    expect(select(container).value).toBe("task");
    expect(container.textContent).toContain("Saves to Release");
    await act(async () => {
      select(container).value = "workspace";
      select(container).dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Saves to the workspace vault");
    expect(container.textContent).not.toContain("Saves to Release");
    await typeSecret(secretInput(container), SECRET);
    await submit(container);
    expect(secretAnswersOf(submissions[0])).toEqual([
      { questionId: "github", value: SECRET, saveTo: "workspace" },
    ]);
  });

  test("a disallowed target downgrades to the most private allowed one, with a note", async () => {
    const { container, submissions } = await renderForm(
      [secretQuestion({ item: "Shared token", saveTo: "workspace" })],
      { allowedSaveTo: ["user", "task"] },
    );
    expect(select(container).value).toBe("user");
    expect([...select(container).options].map((option) => option.value)).toEqual(["user", "task"]);
    expect(container.textContent).toContain(
      "You can't save to this workspace, so it will be saved to Only me.",
    );
    await typeSecret(secretInput(container), SECRET);
    await submit(container);
    expect(secretAnswersOf(submissions[0])?.[0]?.saveTo).toBe("user");
  });

  test("resolveSecretSaveTo and secretVaultForTarget", () => {
    expect(resolveSecretSaveTo({ item: "a" })).toEqual({
      requested: "user",
      initial: "user",
      downgraded: false,
      options: ["user", "task", "workspace"],
    });
    expect(resolveSecretSaveTo({ item: "a", saveTo: "workspace" }, ["task"])).toEqual({
      requested: "workspace",
      initial: "task",
      downgraded: true,
      options: ["task"],
    });
    expect(resolveSecretSaveTo({ item: "a", saveTo: "task" }, [])).toMatchObject({
      initial: "task",
      downgraded: false,
    });
    expect(secretVaultForTarget({ item: "a", vault: "Ops" }, "user")).toBe("Ops");
    expect(secretVaultForTarget({ item: "a", vault: "Ops" }, "task")).toBeNull();
  });

  test("secretAnswerFromReading builds the write-only answer", () => {
    const question = secretQuestion({ item: "GitHub" });
    expect(
      secretAnswerFromReading(question, {
        value: SECRET,
        generate: null,
        username: "  octo  ",
        saveTo: "task",
      }),
    ).toEqual({
      answer: { questionId: "github", values: [] },
      secretAnswer: { questionId: "github", value: SECRET, username: "octo", saveTo: "task" },
    });
    expect(
      secretAnswerFromReading(question, {
        value: null,
        generate: null,
        username: null,
        saveTo: "user",
      }),
    ).toEqual({ error: "This question is required." });
  });
});

describe("secret ask card: answered history", () => {
  let sequence = 0;
  function event(type: string, payload: unknown): SessionEvent {
    sequence += 1;
    return {
      id: `secret-evt-${sequence}`,
      workspaceId: "ws-1",
      sessionId: "session-1",
      sequence,
      type,
      payload,
      occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
      turnId: "turn-1",
    };
  }

  test("an answered secret shows where it was saved, never a value", async () => {
    sequence = 0;
    mounted = await renderComponent(
      <MessageTimeline
        events={[
          event("session.humanInput.requested", {
            request: {
              id: "request-1",
              questions: [
                {
                  id: "github",
                  kind: "secret",
                  label: "GitHub password",
                  prompt: "Your GitHub password",
                  options: [],
                  required: true,
                  secret: { item: "GitHub", username: { prompt: "Username" } },
                },
              ],
            },
          }),
          event("user.humanInputResponse", {
            requestId: "request-1",
            response: {
              outcome: "answered",
              answers: [
                {
                  questionId: "github",
                  values: [],
                  secret: {
                    reference: "{{secret:Private/GitHub/password}}",
                    username: "octocat",
                    vaultName: "Private",
                    itemName: "GitHub",
                    saveTo: "user",
                  },
                },
              ],
            },
          }),
          event("turn.completed", {}),
        ]}
      />,
    );
    await flush();
    const chip = mounted.container.querySelector<HTMLElement>("[data-og-secret-answer]");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Saved to Private › GitHub");
    expect(chip!.textContent).toContain("octocat");
    expect(chip!.getAttribute("title")).toBe("{{secret:Private/GitHub/password}}");
    expect(chip!.tagName).toBe("SPAN");
  });

  test("a malformed secret result falls back to the ordinary answer", async () => {
    sequence = 0;
    mounted = await renderComponent(
      <MessageTimeline
        events={[
          event("user.humanInputResponse", {
            requestId: "request-2",
            response: {
              outcome: "answered",
              answers: [{ questionId: "github", values: [], secret: { reference: 42 } }],
            },
          }),
          event("turn.completed", {}),
        ]}
      />,
    );
    await flush();
    expect(mounted.container.querySelector("[data-og-secret-answer]")).toBeNull();
  });
});

describe("secret ask card in SessionConversation", () => {
  test("secretAnswers reach the client unchanged; a failed send keeps the value", async () => {
    const sent: SubmitHumanInputResponseRequest[] = [];
    let failNext = true;
    const client = fakeClient({
      getSession: async () => ({ id: SESSION_ID, status: "running" }) as never,
      getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
      listEvents: async () => [],
      streamEvents: async function* () {},
      listHumanInputRequests: async () => [
        {
          id: "request-live",
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          turnId: "turn-1",
          turnGeneration: 1,
          creationAttemptId: "attempt-1",
          toolCallId: "call-1",
          status: "pending",
          questions: [secretQuestion({ item: "GitHub", saveTo: "task" })],
          allowSkip: false,
          response: null,
          respondedBy: null,
          respondedAt: null,
          expiresAt: null,
          createdAt: "2026-10-12T10:00:00.000Z",
          updatedAt: "2026-10-12T10:00:00.000Z",
        },
      ],
      submitHumanInputResponse: async (_workspace, _session, _request, response) => {
        sent.push(response);
        if (failNext) {
          failNext = false;
          throw new Error("Network down");
        }
        return {
          id: "response-event",
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          sequence: 9,
          type: "user.humanInputResponse",
          payload: {},
          occurredAt: "2026-10-12T10:00:01.000Z",
          turnId: "turn-1",
        } as SessionEvent;
      },
    });
    mounted = await renderComponent(
      <SessionConversation
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        modelPicker={false}
      />,
    );
    const deadline = Date.now() + 3_000;
    while (!mounted.container.querySelector('input[name^="secret-"]')) {
      if (Date.now() > deadline) throw new Error("secret card did not render");
      await flush(10);
    }
    const input = secretInput(mounted.container);
    await typeSecret(input, SECRET);
    const form = input.form!;
    const send = async () => {
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await flush(20);
    };

    await send();
    expect(sent).toHaveLength(1);
    // The failed send kept the typed value for a retry.
    expect(input.value).toBe(SECRET);

    await send();
    expect(sent).toEqual([
      {
        outcome: "answered",
        answers: [{ questionId: "github", values: [] }],
        secretAnswers: [{ questionId: "github", value: SECRET, saveTo: "task" }],
      },
      {
        outcome: "answered",
        answers: [{ questionId: "github", values: [] }],
        secretAnswers: [{ questionId: "github", value: SECRET, saveTo: "task" }],
      },
    ]);
    expect(input.value).toBe("");
  });
});

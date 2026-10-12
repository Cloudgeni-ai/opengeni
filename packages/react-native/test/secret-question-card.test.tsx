import { describe, expect, mock, test } from "bun:test";
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ComponentType,
  type ReactNode,
} from "react";
import type {
  HumanInputQuestion,
  HumanInputSecretSpec,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements that record the props the card passes. The
 * card, the field and the submission code under test are the real ones.
 */
type Recorded = { props: Record<string, unknown>; clears: number };
const inputs = new Map<string, Recorded>();

function host(tag: string) {
  return function Host(props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    testID?: string;
  }) {
    return createElement(
      tag,
      {
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
        "data-testid": props.testID,
      },
      props.children,
    );
  };
}

mock.module("react-native", () => {
  const TextInput = forwardRef(function TextInput(props: Record<string, unknown>, ref) {
    const key = String(props.testID ?? props.accessibilityLabel);
    const entry = inputs.get(key) ?? { props, clears: 0 };
    entry.props = props;
    inputs.set(key, entry);
    useImperativeHandle(ref, () => ({
      clear: () => {
        entry.clears += 1;
      },
      focus: () => undefined,
    }));
    return createElement("input", { "data-key": key, "aria-label": props.accessibilityLabel });
  });
  function Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
  }) {
    return createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
        "data-checked": props.accessibilityState?.checked ? "true" : undefined,
      },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  }
  return {
    View: host("div"),
    Text: host("span"),
    ScrollView: host("div"),
    ActivityIndicator: () => null,
    Pressable,
    TextInput,
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: nothing,
    Circle: nothing,
    Line: nothing,
    Path: nothing,
    Polyline: nothing,
    Rect: nothing,
  };
});
mock.module("react-native-reanimated", () => ({
  default: { View: host("div"), Text: host("span") },
  cancelAnimation: () => undefined,
  Easing: { linear: (value: number) => value, inOut: () => (value: number) => value },
  interpolateColor: () => "#000",
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

registerDom();

const { HumanInputCard } = (await import("../src/timeline/decisions")) as {
  HumanInputCard: ComponentType<{
    requests: SessionHumanInputRequest[];
    onSubmit: (requestId: string, response: SubmitHumanInputResponseRequest) => Promise<void>;
  }>;
};

function request(questions: HumanInputQuestion[]): SessionHumanInputRequest {
  return {
    id: "req-1",
    workspaceId: "ws",
    sessionId: "s",
    turnId: "t",
    turnGeneration: 1,
    creationAttemptId: "a",
    toolCallId: "tc",
    status: "pending",
    questions,
    allowSkip: true,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: "2026-10-12T20:00:00.000Z",
    updatedAt: "2026-10-12T20:00:00.000Z",
  };
}

function secretQuestion(secret: HumanInputSecretSpec, id = "pw"): HumanInputQuestion {
  return {
    id,
    kind: "secret",
    prompt: "GitHub password",
    options: [],
    required: true,
    allowOther: false,
    secret,
  };
}

async function renderCard(questions: HumanInputQuestion[]) {
  inputs.clear();
  const submitted: SubmitHumanInputResponseRequest[] = [];
  const view = await renderComponent(
    <HumanInputCard
      requests={[request(questions)]}
      onSubmit={async (_id, response) => {
        submitted.push(structuredClone(response));
      }}
    />,
  );
  const button = (label: string) => {
    const found = [...view.container.querySelectorAll("button")].find(
      (element) =>
        element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no button ${label}`);
    return found;
  };
  const press = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  const type = async (key: string, text: string) => {
    const input = inputs.get(key);
    if (!input) throw new Error(`no input ${key}`);
    await act(async () => {
      (input.props.onChangeText as (value: string) => void)(text);
    });
  };
  return { view, submitted, button, press, type };
}

/** Every useState/useReducer value in the mounted tree (refs excluded). */
function reactStateValues(container: HTMLElement): unknown[] {
  const rootKey = Object.keys(container).find((key) => key.startsWith("__reactContainer$"));
  const values: unknown[] = [];
  type Hook = { memoizedState: unknown; queue: unknown; next: Hook | null };
  type Fiber = {
    memoizedState: unknown;
    child: Fiber | null;
    sibling: Fiber | null;
    stateNode: { current?: Fiber } | null;
  };
  const visit = (fiber: Fiber | null) => {
    for (let node = fiber; node; node = node.sibling) {
      let hook =
        node.memoizedState &&
        typeof node.memoizedState === "object" &&
        "queue" in node.memoizedState
          ? (node.memoizedState as Hook)
          : null;
      for (; hook; hook = hook.next) if (hook.queue) values.push(hook.memoizedState);
      visit(node.child);
    }
  };
  // The container keeps the first host-root fiber; the committed tree is the
  // FiberRoot's current one.
  const hostRoot = (container as unknown as Record<string, Fiber>)[rootKey!];
  visit(hostRoot?.stateNode?.current ?? null);
  return values;
}

function containsString(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsString(entry, needle, seen));
}

describe("native ask card: secret question", () => {
  test("renders a secure, autofill-aware input with a 44pt show/hide toggle", async () => {
    const { view, press } = await renderCard([
      secretQuestion({ item: "GitHub", username: { prompt: "GitHub username", value: "octo" } }),
    ]);
    const password = inputs.get("secret-input-pw")!.props;
    expect(password).toMatchObject({
      secureTextEntry: true,
      textContentType: "password",
      autoComplete: "password",
      importantForAutofill: "yes",
      autoCorrect: false,
      autoCapitalize: "none",
      keyboardType: "default",
      accessibilityLabel: "GitHub password",
    });
    // Uncontrolled: the value is never handed back to the input from state.
    expect("value" in password).toBe(false);
    expect("defaultValue" in password).toBe(false);

    const username = inputs.get("GitHub username")!.props;
    expect(username).toMatchObject({
      textContentType: "username",
      autoComplete: "username",
      value: "octo",
    });
    // Username comes before the password so the OS pairs them.
    const order = [...view.container.querySelectorAll("input")].map((input) =>
      input.getAttribute("data-key"),
    );
    expect(order).toEqual(["GitHub username", "secret-input-pw"]);

    await press("Show secret");
    expect(inputs.get("secret-input-pw")!.props.secureTextEntry).toBe(false);
    await press("Hide secret");
    expect(inputs.get("secret-input-pw")!.props.secureTextEntry).toBe(true);
    await view.unmount();
  });

  test("one-time codes get the OTP content type and the number pad", async () => {
    const { view } = await renderCard([
      secretQuestion({ item: "Acme", field: "code", autocomplete: "one-time-code" }),
    ]);
    expect(inputs.get("secret-input-pw")!.props).toMatchObject({
      secureTextEntry: true,
      textContentType: "oneTimeCode",
      autoComplete: "sms-otp",
      keyboardType: "number-pad",
    });
    await view.unmount();
  });

  test("submits the value only in secretAnswers, keeps it out of React state and clears it", async () => {
    const { view, submitted, press, type } = await renderCard([
      secretQuestion({ item: "GitHub", username: { prompt: "GitHub username", value: "octo" } }),
    ]);
    await type("secret-input-pw", "hunter2-correct-horse");
    const state = reactStateValues(view.container);
    // The walk does see state (the username is ordinary state)...
    expect(state.some((value) => containsString(value, "octo"))).toBe(true);
    // ...and no state holds the secret.
    expect(state.some((value) => containsString(value, "hunter2-correct-horse"))).toBe(false);

    await press("Send answers");
    expect(submitted).toEqual([
      {
        outcome: "answered",
        answers: [{ questionId: "pw", values: [] }],
        secretAnswers: [
          { questionId: "pw", value: "hunter2-correct-horse", username: "octo", saveTo: "user" },
        ],
      },
    ]);
    const first = submitted[0]!;
    expect(first.outcome === "answered" ? JSON.stringify(first.answers) : "").not.toContain(
      "hunter2",
    );
    // Cleared after the submit: the field is emptied and the ref forgets it.
    expect(inputs.get("secret-input-pw")!.clears).toBe(1);
    await press("Send answers");
    expect(submitted).toHaveLength(1);
    expect(view.container.textContent).toContain("This question is required.");
    await view.unmount();
  });

  test("Generate asks the server for a password and can be undone", async () => {
    const { view, submitted, press, type } = await renderCard([
      secretQuestion({ item: "Acme", allowGenerate: true, generate: { length: 32 } }),
    ]);
    expect(inputs.get("secret-input-pw")!.props.textContentType).toBe("newPassword");
    await type("secret-input-pw", "typed-first");
    await press("Generate");
    expect(view.container.textContent).toContain("A strong password will be generated");
    expect(view.container.querySelector("input")).toBeNull();

    await press("Undo");
    expect(view.container.querySelector("input")).not.toBeNull();
    await press("Generate");
    await press("Send answers");
    expect(submitted).toEqual([
      {
        outcome: "answered",
        answers: [{ questionId: "pw", values: [] }],
        secretAnswers: [{ questionId: "pw", generate: { length: 32 }, saveTo: "user" }],
      },
    ]);
    expect(JSON.stringify(submitted)).not.toContain("typed-first");
    await view.unmount();
  });

  test("Save to defaults to the spec and can be changed", async () => {
    const { view, submitted, button, press, type } = await renderCard([
      secretQuestion({ item: "Deploy key", saveTo: "task", vault: "Task vault" }),
    ]);
    expect(button("This task").getAttribute("data-checked")).toBe("true");
    expect(button("Only me").getAttribute("data-checked")).toBeNull();
    expect(view.container.textContent).toContain("Saves to Task vault");
    await press("Workspace");
    expect(button("Workspace").getAttribute("data-checked")).toBe("true");
    expect(view.container.textContent).not.toContain("Saves to Task vault");
    await type("secret-input-pw", "k");
    await press("Send answers");
    expect(submitted[0]).toMatchObject({
      secretAnswers: [{ questionId: "pw", value: "k", saveTo: "workspace" }],
    });
    await view.unmount();
  });

  test("looksLike and pattern are hints only; a mismatch still sends", async () => {
    const { view, submitted, press, type } = await renderCard([
      secretQuestion({ item: "OpenAI", itemType: "api_key", looksLike: "sk-…", pattern: "sk-.+" }),
    ]);
    expect(view.container.textContent).toContain("Looks like sk-…");
    expect(inputs.get("secret-input-pw")!.props.importantForAutofill).toBe("no");
    await type("secret-input-pw", "not-a-key");
    expect(view.container.textContent).toContain("doesn't match the expected format");
    await press("Send answers");
    expect(submitted).toHaveLength(1);
    await view.unmount();
  });

  test("mixed forms keep question order and send ordinary answers as before", async () => {
    const env: HumanInputQuestion = {
      id: "env",
      kind: "single_select",
      prompt: "Environment",
      options: [
        { id: "staging", label: "Staging" },
        { id: "prod", label: "Production" },
      ],
      required: true,
      allowOther: false,
    };
    const { view, submitted, press, type } = await renderCard([
      env,
      secretQuestion({ item: "GitHub" }),
    ]);
    await press("Staging");
    await type("secret-input-pw", "pw");
    await press("Send answers");
    expect(submitted).toEqual([
      {
        outcome: "answered",
        answers: [
          { questionId: "env", values: ["staging"] },
          { questionId: "pw", values: [] },
        ],
        secretAnswers: [{ questionId: "pw", value: "pw", saveTo: "user" }],
      },
    ]);
    await view.unmount();
  });
});

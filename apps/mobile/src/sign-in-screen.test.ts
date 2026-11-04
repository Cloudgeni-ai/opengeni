import { beforeEach, expect, mock, test } from "bun:test";
import * as React from "../../../packages/react/node_modules/react";
import * as JsxDevRuntime from "../../../packages/react/node_modules/react/jsx-dev-runtime";
import * as JsxRuntime from "../../../packages/react/node_modules/react/jsx-runtime";
import { normalizeServerUrl, serverLabel } from "@opengeni/sdk/app-links";
import { registerDom, renderComponent } from "../../../packages/react/test/render-hook";
import type { StoredAccount } from "./account-store";

/*
 * The sign-in screen a signed-out account lands on is never a dead end: it
 * lists the device's other accounts, and one tap goes back to a signed-in one.
 * The real screen renders with DOM stand-ins for the native host components.
 */
mock.module("react", () => React);
mock.module("react/jsx-dev-runtime", () => JsxDevRuntime);
mock.module("react/jsx-runtime", () => JsxRuntime);
const { act, createElement } = React;
type HostProps = {
  children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
  accessibilityLabel?: string;
  accessibilityRole?: string;
  onPress?: () => void;
  disabled?: boolean;
};
const host =
  (tag: string) =>
  ({ children, accessibilityLabel, accessibilityRole, onPress, disabled }: HostProps) =>
    createElement(
      onPress ? "button" : tag,
      {
        "aria-label": accessibilityLabel,
        "data-role": accessibilityRole,
        disabled,
        onClick: onPress,
      },
      typeof children === "function" ? children({ pressed: false }) : children,
    );
mock.module("react-native", () => ({
  KeyboardAvoidingView: host("div"),
  Platform: { OS: "ios" },
  Pressable: host("div"),
  ScrollView: host("div"),
  StyleSheet: { hairlineWidth: 1 },
  Text: host("span"),
  TextInput: () => null,
  View: host("div"),
}));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module("@opengeni/react-native/timeline", () => ({
  Button: ({ label, onPress }: { label: string; onPress?: () => void }) =>
    createElement("button", { onClick: onPress }, label),
  fontStyle: () => ({}),
  useNativeTimelineTheme: () => ({ colors: {}, radius: { md: 8, lg: 12 } }),
}));
mock.module("@/brand-mark", () => ({ BrandMark: () => null }));
mock.module("@/ui", () => ({ InitialTile: () => null }));
mock.module("@/account-store", () => ({ normalizeServerUrl, serverLabel }));
const routes: string[] = [];
let params: { account?: string } = {};
mock.module("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { back: () => routes.push("back") },
  useLocalSearchParams: () => params,
}));
mock.module("@/navigation", () => ({ dismissToHome: () => routes.push("home") }));
mock.module("@/theme", () => ({
  AppThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const account = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount => ({
  id,
  baseUrl: "https://app.opengeni.ai",
  subjectId: `user:${id}`,
  email: `${id}@example.com`,
  workspaceId: null,
  ...patch,
});
const work = account("work");
const picked = account("picked", { signedOut: true, baseUrl: "https://staging.opengeni.ai" });
const home = account("home");
const switched: string[] = [];
const retried: string[] = [];
type State = {
  account: StoredAccount | null;
  accounts: StoredAccount[];
  previousAccountId: string | null;
  unreadable: ReadonlySet<string>;
  retryOutcome: "ready" | "signIn" | "unreadable";
  signIn: Promise<{ kind: string }>;
};
let state: State;
beforeEach(() => {
  // Each test starts on the signed-out pick, having come from "work".
  state = {
    account: picked,
    accounts: [home, picked, work],
    previousAccountId: "work",
    unreadable: new Set(),
    retryOutcome: "ready",
    signIn: Promise.resolve({ kind: "cancelled" }),
  };
  switched.length = 0;
  retried.length = 0;
  routes.length = 0;
  params = {};
});
mock.module("@/account", () => ({
  DEFAULT_SERVER_URL: "https://app.opengeni.ai",
  useAccount: () => ({
    ...state,
    addAccount: () => state.signIn,
    switchAccount: (id: string) => switched.push(id),
    retrySignIn: async (id: string) => {
      retried.push(id);
      return state.retryOutcome;
    },
  }),
}));
const { SignInScreen } = await import("./sign-in-screen");
const { default: AddAccountScreen } = await import("../app/add-account");
registerDom();

const switchRows = (container: HTMLElement) =>
  [...container.querySelectorAll("button[aria-label^='Switch to']")].map((row) =>
    row.getAttribute("aria-label"),
  );
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((each) => each.textContent === label);

test("a signed-out pick lists the other accounts, and one tap goes back to where you were", async () => {
  const view = await renderComponent(createElement(SignInScreen, { target: picked }));
  try {
    expect(view.container.textContent).toContain("Sign in again");
    expect(view.container.textContent).toContain("Switch account");
    expect(switchRows(view.container)).toEqual([
      "Switch to work@example.com on app.opengeni.ai, signed in",
      "Switch to home@example.com on app.opengeni.ai, signed in",
    ]);
    const back = view.container.querySelector<HTMLButtonElement>(
      "button[aria-label^='Switch to work@']",
    );
    await act(async () => back?.click());
    expect(switched).toEqual(["work"]);
  } finally {
    await view.unmount();
  }
});

test("signed-out accounts in the list are marked, and a lone account has no list", async () => {
  state = { ...state, account: home, accounts: [home, picked], previousAccountId: null };
  const listed = await renderComponent(createElement(SignInScreen, { target: home }));
  try {
    expect(switchRows(listed.container)).toEqual([
      "Switch to picked@example.com on staging.opengeni.ai, signed out",
    ]);
  } finally {
    await listed.unmount();
  }
  state = { ...state, account: picked, accounts: [picked], previousAccountId: null };
  const alone = await renderComponent(createElement(SignInScreen, { target: picked }));
  try {
    expect(alone.container.textContent).not.toContain("Switch account");
  } finally {
    await alone.unmount();
  }
});

test("the sign-in sheet over an account keeps Cancel as its way back, without a list", async () => {
  state = { ...state, account: work, accounts: [work, picked, home], previousAccountId: null };
  const view = await renderComponent(
    createElement(SignInScreen, { target: picked, onCancel: () => undefined }),
  );
  try {
    expect(view.container.textContent).toContain("Cancel");
    expect(switchRows(view.container)).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("a signed-out account says so; an unreadable one offers a retry instead", async () => {
  const signedOut = await renderComponent(createElement(SignInScreen, { target: picked }));
  try {
    expect(signedOut.container.textContent).toContain(
      "picked@example.com was signed out on staging.opengeni.ai.",
    );
    expect(button(signedOut.container, "Try again")).toBeUndefined();
  } finally {
    await signedOut.unmount();
  }
  // The account in use, whose saved sign-in couldn't be read.
  state = { ...state, account: home, unreadable: new Set(["home"]), previousAccountId: null };
  let done = 0;
  const view = await renderComponent(
    createElement(SignInScreen, { target: home, onDone: () => done++ }),
  );
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Couldn't read your sign-in");
    expect(text).toContain(
      "couldn't read the saved sign-in for home@example.com on app.opengeni.ai",
    );
    expect(text).not.toContain("was signed out");
    expect(button(view.container, "Sign in again")).toBeDefined();
    // The list stays, so another account is still one tap away.
    expect(switchRows(view.container)).toHaveLength(2);
    state.retryOutcome = "unreadable";
    await act(async () => button(view.container, "Try again")?.click());
    expect(retried).toEqual(["home"]);
    expect(done).toBe(0);
    expect(view.container.textContent).toContain("Still couldn't read it.");
    state.retryOutcome = "ready";
    await act(async () => button(view.container, "Try again")?.click());
    expect(retried).toEqual(["home", "home"]);
    expect(done).toBe(1);
  } finally {
    await view.unmount();
  }
});

test("the list waits while a sign-in is in progress", async () => {
  let finish: (value: { kind: string }) => void = () => undefined;
  state.signIn = new Promise((resolve) => {
    finish = resolve;
  });
  const view = await renderComponent(createElement(SignInScreen, { target: picked }));
  const rows = () => [
    ...view.container.querySelectorAll<HTMLButtonElement>("button[aria-label^='Switch to']"),
  ];
  try {
    expect(rows().every((row) => !row.disabled)).toBe(true);
    await act(async () => button(view.container, "Continue with web sign-in")?.click());
    expect(rows()).toHaveLength(2);
    expect(rows().every((row) => row.disabled)).toBe(true);
    await act(async () => {
      finish({ kind: "cancelled" });
      await state.signIn;
    });
    expect(rows().every((row) => !row.disabled)).toBe(true);
  } finally {
    await view.unmount();
  }
});

test("the sheet for an account that is no longer on the device adds an account instead", async () => {
  state = { ...state, account: work, accounts: [work, home], previousAccountId: null };
  params = { account: "gone" };
  const view = await renderComponent(createElement(AddAccountScreen));
  try {
    expect(view.container.textContent).toContain("Add an account");
    expect(view.container.textContent).not.toContain("Sign in again");
    await act(async () => button(view.container, "Cancel")?.click());
    expect(routes).toEqual(["back"]);
  } finally {
    await view.unmount();
  }
  params = { account: "picked" };
  state = { ...state, accounts: [work, picked, home] };
  const known = await renderComponent(createElement(AddAccountScreen));
  try {
    expect(known.container.textContent).toContain("Sign in again");
  } finally {
    await known.unmount();
  }
});

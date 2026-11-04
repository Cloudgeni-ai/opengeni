import { expect, mock, test } from "bun:test";
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
let state = {
  account: picked as StoredAccount | null,
  accounts: [home, picked, work],
  previousAccountId: "work" as string | null,
};
mock.module("@/account", () => ({
  DEFAULT_SERVER_URL: "https://app.opengeni.ai",
  useAccount: () => ({
    ...state,
    addAccount: async () => ({ kind: "cancelled" }),
    switchAccount: (id: string) => switched.push(id),
  }),
}));
const { SignInScreen } = await import("./sign-in-screen");
registerDom();

const switchRows = (container: HTMLElement) =>
  [...container.querySelectorAll("button[aria-label^='Switch to']")].map((row) =>
    row.getAttribute("aria-label"),
  );

test("a signed-out pick lists the other accounts, and one tap goes back to where you were", async () => {
  switched.length = 0;
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
  state = { account: home, accounts: [home, picked], previousAccountId: null };
  const listed = await renderComponent(createElement(SignInScreen, { target: home }));
  try {
    expect(switchRows(listed.container)).toEqual([
      "Switch to picked@example.com on staging.opengeni.ai, signed out",
    ]);
  } finally {
    await listed.unmount();
  }
  state = { account: picked, accounts: [picked], previousAccountId: null };
  const alone = await renderComponent(createElement(SignInScreen, { target: picked }));
  try {
    expect(alone.container.textContent).not.toContain("Switch account");
  } finally {
    await alone.unmount();
  }
});

test("the sign-in sheet over an account keeps Cancel as its way back, without a list", async () => {
  state = { account: work, accounts: [work, picked, home], previousAccountId: null };
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

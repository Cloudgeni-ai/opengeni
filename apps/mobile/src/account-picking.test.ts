import { expect, mock, test } from "bun:test";
import * as React from "../../../packages/react/node_modules/react";
import * as JsxDevRuntime from "../../../packages/react/node_modules/react/jsx-dev-runtime";
import * as JsxRuntime from "../../../packages/react/node_modules/react/jsx-runtime";
import { flush, registerDom, renderComponent } from "../../../packages/react/test/render-hook";
import type { AccountsSnapshot, StoredAccount } from "./account-store";

/*
 * The account menus and Settings pick accounts through usePickAccount. A pick
 * of an account that is not signed in must leave the account in use, its
 * place in the list and every stored credential exactly as they were, and
 * open the picked account's sign-in over it instead.
 */
mock.module("react", () => React);
mock.module("react/jsx-dev-runtime", () => JsxDevRuntime);
mock.module("react/jsx-runtime", () => JsxRuntime);
const { act, createElement } = React;

const account = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount => ({
  id,
  baseUrl: "https://app.opengeni.ai",
  subjectId: `user:${id}`,
  email: `${id}@example.com`,
  workspaceId: "workspace",
  ...patch,
});
let stored: AccountsSnapshot = { accounts: [], activeId: null };
let tokens = new Map<string, string>();
const saved: AccountsSnapshot[] = [];
const tokenWrites: string[] = [];
const pushed: unknown[] = [];
// The screen on top: a push opens the sign-in sheet, as the router would.
let pathname = "/";
let unreadable = false;

mock.module("@/account-store", () => ({
  loadAccounts: async () => structuredClone(stored),
  saveAccounts: async (next: AccountsSnapshot) => {
    saved.push(structuredClone(next));
  },
  readAccountToken: async (id: string) => {
    if (unreadable) throw new Error("keychain locked");
    return tokens.get(id) ?? null;
  },
  writeAccountToken: async (id: string) => tokenWrites.push(`write:${id}`),
  forgetAccountToken: async (id: string) => tokenWrites.push(`forget:${id}`),
  sameIdentity: () => false,
}));
mock.module("expo-router", () => ({
  router: {
    push: (target: unknown) => {
      pushed.push(target);
      pathname = "/add-account";
    },
  },
  usePathname: () => pathname,
}));
mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
mock.module("@opengeni/react/messages", () => ({ useOpenGeniText: () => (key: string) => key }));
mock.module("@opengeni/react/organization-model", () => ({
  organizationLandingWorkspaceId: () => null,
  organizationsForSubject: () => [],
}));
mock.module("@opengeni/sdk", () => ({
  OpenGeniApiError: class extends Error {},
  OpenGeniClient: class {
    getAccessContext = async () => ({ subjectId: "user:work", defaultAccountId: null });
    listWorkspaces = async () => [{ id: "workspace", accountId: "org", name: "Work" }];
    getClientConfig = async () => null;
  },
}));
mock.module("@opengeni/react-native", () => ({ createHydratedPersistenceAdapter: () => ({}) }));
mock.module("@opengeni/react-native/expo", () => ({
  createExpoOpenGeniAdapters: () => ({}),
  expoStreamingFetch: fetch,
}));
mock.module("@/app-link-registry", () => ({ openLinkFromApp: () => undefined }));
mock.module("@/feedback/recent-errors", () => ({ recordingRequests: (each: unknown) => each }));
mock.module("@/web-sign-in", () => ({ signInThroughWeb: async () => ({ kind: "cancelled" }) }));

const { AccountProvider, useAccount, usePickAccount } = await import("./account");
registerDom();

type Probe = { state: ReturnType<typeof useAccount>; pick: ReturnType<typeof usePickAccount> };
async function mount(snapshot: AccountsSnapshot, credentials: Record<string, string>) {
  stored = snapshot;
  tokens = new Map(Object.entries(credentials));
  saved.length = 0;
  tokenWrites.length = 0;
  pushed.length = 0;
  pathname = "/";
  unreadable = false;
  const probe = {} as Probe;
  function Read() {
    probe.state = useAccount();
    probe.pick = usePickAccount();
    return null;
  }
  const view = await renderComponent(createElement(AccountProvider, null, createElement(Read)));
  await act(async () => flush());
  /** Cancel on the sheet: back to the screen underneath. */
  const closeSheet = async () => {
    pathname = "/";
    pushed.length = 0;
    await view.rerender(createElement(AccountProvider, null, createElement(Read)));
  };
  return { probe, view, closeSheet };
}
const pick = async (probe: Probe, id: string, onInUse?: () => void) => {
  await act(async () => {
    probe.pick(id, onInUse);
    await flush();
  });
};

const work = account("work");
const staging = account("staging", { baseUrl: "https://staging.app.opengeni.ai", signedOut: true });
const personal = account("personal");

test("a signed-out pick opens its sign-in over the account in use and changes nothing", async () => {
  const { probe, view } = await mount(
    { accounts: [work, staging, personal], activeId: "work" },
    { work: "ogapp_work", staging: "ogapp_old", personal: "ogapp_personal" },
  );
  try {
    expect(probe.state.status).toBe("ready");
    let inUse = 0;
    await pick(probe, "staging", () => inUse++);
    expect(pushed).toEqual([{ pathname: "/add-account", params: { account: "staging" } }]);
    expect(probe.state.account?.id).toBe("work");
    expect(probe.state.status).toBe("ready");
    // Nothing saved: the list, its order and the pick's own state are unchanged.
    expect(saved).toEqual([]);
    expect(probe.state.accounts).toEqual([work, staging, personal]);
    expect(tokenWrites).toEqual([]);
    expect(inUse).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("a missing credential opens the sign-in and marks the account; an unreadable one only opens it", async () => {
  const { probe, view, closeSheet } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work" },
  );
  const personalFlag = () => probe.state.accounts.find((each) => each.id === "personal")?.signedOut;
  try {
    unreadable = true;
    await pick(probe, "personal");
    expect(pushed).toEqual([{ pathname: "/add-account", params: { account: "personal" } }]);
    expect(probe.state.account?.id).toBe("work");
    expect(personalFlag()).toBeUndefined();
    await closeSheet();
    unreadable = false;
    await pick(probe, "personal");
    expect(pushed).toEqual([{ pathname: "/add-account", params: { account: "personal" } }]);
    expect(probe.state.account?.id).toBe("work");
    expect(personalFlag()).toBe(true);
    expect(tokenWrites).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("a signed-in pick switches at once and remembers the way back", async () => {
  const { probe, view } = await mount(
    { accounts: [work, staging, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
  );
  try {
    let inUse = 0;
    await pick(probe, "personal", () => inUse++);
    expect(pushed).toEqual([]);
    expect(probe.state.account?.id).toBe("personal");
    expect(probe.state.previousAccountId).toBe("work");
    expect(saved.at(-1)?.activeId).toBe("personal");
    expect(inUse).toBe(1);
    expect(tokenWrites).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("a second tap does not open a second sign-in sheet; after Cancel a pick works again", async () => {
  const { probe, view, closeSheet } = await mount(
    { accounts: [work, staging], activeId: "work" },
    { work: "ogapp_work" },
  );
  try {
    await act(async () => {
      probe.pick("staging");
      probe.pick("staging");
      await flush();
    });
    expect(pushed).toHaveLength(1);
    // Later, while the sheet is still on its way up or open.
    await pick(probe, "staging");
    expect(pushed).toHaveLength(1);
    await closeSheet();
    await pick(probe, "staging");
    expect(pushed).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

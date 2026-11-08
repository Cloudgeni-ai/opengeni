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
// React Native's development flag, as in a release build.
Object.assign(globalThis, { __DEV__: false });

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
let pushFails = false;
// When set, credential reads wait here until the test settles them.
let heldReads: Array<{ id: string; settle(value: string | null | Error): void }> | null = null;
let webSignIn: unknown = { kind: "cancelled" };
let signedInSubject = "user:work";
// When set, saving a credential waits for it.
let writeGate: Promise<void> | null = null;

mock.module("@/account-store", () => ({
  loadAccounts: async () => structuredClone(stored),
  saveAccounts: async (next: AccountsSnapshot) => {
    saved.push(structuredClone(next));
  },
  readAccountToken: async (id: string) => {
    if (unreadable) throw new Error("keychain locked");
    if (heldReads) {
      const held = heldReads;
      return new Promise<string | null>((resolve, reject) =>
        held.push({
          id,
          settle: (value) => (value instanceof Error ? reject(value) : resolve(value)),
        }),
      );
    }
    return tokens.get(id) ?? null;
  },
  writeAccountToken: async (id: string, value: string) => {
    if (writeGate) await writeGate;
    tokenWrites.push(`write:${id}`);
    tokens.set(id, value);
  },
  forgetAccountToken: async (id: string) => {
    if (writeGate) await writeGate;
    tokenWrites.push(`forget:${id}`);
  },
  sameIdentity: (a: StoredAccount, b: { baseUrl: string; subjectId: string }) =>
    a.baseUrl === b.baseUrl && a.subjectId === b.subjectId,
}));
mock.module("expo-router", () => ({
  router: {
    push: (target: unknown) => {
      if (pushFails) throw new Error("navigation not ready");
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
    apiKey?: string;
    constructor(options: { apiKey?: string }) {
      this.apiKey = options.apiKey;
    }
    getAccessContext = async () => ({ subjectId: signedInSubject, defaultAccountId: null });
    listWorkspaces = async () => [{ id: "workspace", accountId: "org", name: "Work" }];
    getClientConfig = async () => null;
    signOutNativeApp = async () => undefined;
    withSessionResponse = () => this;
  },
}));
mock.module("@opengeni/react-native", () => ({ createHydratedPersistenceAdapter: () => ({}) }));
mock.module("@opengeni/react-native/expo", () => ({
  createExpoOpenGeniAdapters: () => ({}),
  expoStreamingFetch: fetch,
}));
mock.module("@/app-link-registry", () => ({ openLinkFromApp: () => undefined }));
mock.module("@/feedback/recent-errors", () => ({ recordingRequests: (each: unknown) => each }));
mock.module("@/web-sign-in", () => ({ signInThroughWeb: async () => webSignIn }));

const { AccountProvider, useAccount, usePickAccount } = await import("./account");
registerDom();

type Probe = { state: ReturnType<typeof useAccount>; pick: ReturnType<typeof usePickAccount> };
async function mount(
  snapshot: AccountsSnapshot,
  credentials: Record<string, string>,
  options: { unreadable?: boolean; holdReads?: boolean } = {},
) {
  stored = snapshot;
  tokens = new Map(Object.entries(credentials));
  saved.length = 0;
  tokenWrites.length = 0;
  pushed.length = 0;
  pathname = "/";
  unreadable = options.unreadable ?? false;
  pushFails = false;
  heldReads = options.holdReads ? [] : null;
  writeGate = null;
  webSignIn = { kind: "cancelled" };
  signedInSubject = "user:work";
  const probe = {} as Probe;
  function Read() {
    probe.state = useAccount();
    probe.pick = usePickAccount();
    return null;
  }
  const view = await renderComponent(createElement(AccountProvider, null, createElement(Read)));
  await act(async () => flush());
  /** The router moved: screens re-render with the new pathname. */
  const settle = async () => {
    await view.rerender(createElement(AccountProvider, null, createElement(Read)));
  };
  /** Cancel on the sheet: back to the screen underneath. */
  const closeSheet = async () => {
    pathname = "/";
    pushed.length = 0;
    await settle();
  };
  return { probe, view, settle, closeSheet };
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
    expect(probe.state.accounts.find((each) => each.id === "staging")?.signedOut).toBe(true);
    expect(tokenWrites).toEqual([]);
    expect(inUse).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("a missing credential opens the sign-in and marks the account; an unreadable one only opens it", async () => {
  const { probe, view, closeSheet } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
  );
  const personalFlag = () => probe.state.accounts.find((each) => each.id === "personal")?.signedOut;
  try {
    unreadable = true;
    await pick(probe, "personal");
    expect(pushed).toEqual([{ pathname: "/add-account", params: { account: "personal" } }]);
    expect(probe.state.account?.id).toBe("work");
    expect(personalFlag()).toBeUndefined();
    expect([...probe.state.unreadable]).toEqual(["personal"]);
    await closeSheet();
    unreadable = false;
    tokens.delete("personal");
    await pick(probe, "personal");
    expect(pushed).toEqual([{ pathname: "/add-account", params: { account: "personal" } }]);
    expect(probe.state.account?.id).toBe("work");
    expect(personalFlag()).toBe(true);
    expect([...probe.state.unreadable]).toEqual([]);
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
  const { probe, view, settle, closeSheet } = await mount(
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
    // Later, with the sheet up.
    await settle();
    await pick(probe, "staging");
    expect(pushed).toHaveLength(1);
    await closeSheet();
    await pick(probe, "staging");
    expect(pushed).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

test("a sheet that failed to open does not block the next pick", async () => {
  const { probe, view } = await mount(
    { accounts: [work, staging], activeId: "work" },
    { work: "ogapp_work" },
  );
  try {
    pushFails = true;
    await pick(probe, "staging");
    expect(pushed).toEqual([]);
    pushFails = false;
    await pick(probe, "staging");
    expect(pushed).toEqual([{ pathname: "/add-account", params: { account: "staging" } }]);
  } finally {
    await view.unmount();
  }
});

test("picking the account in use leaves it as it is, whatever its credential read says", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
  );
  try {
    let inUse = 0;
    tokens.delete("work");
    await pick(probe, "work", () => inUse++);
    unreadable = true;
    await pick(probe, "work", () => inUse++);
    expect(inUse).toBe(2);
    expect(pushed).toEqual([]);
    expect(probe.state.status).toBe("ready");
    expect(probe.state.account?.signedOut).toBeUndefined();
    expect(probe.state.unreadable.size).toBe(0);
    expect(saved).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("only the newest read of an account may mark it", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
  );
  try {
    const held: NonNullable<typeof heldReads> = [];
    heldReads = held;
    let older: Promise<unknown> = Promise.resolve();
    let newer: Promise<unknown> = Promise.resolve();
    await act(async () => {
      older = probe.state.chooseAccount("personal");
      newer = probe.state.chooseAccount("personal");
      await flush();
    });
    expect(held.map((each) => each.id)).toEqual(["personal", "personal"]);
    // The newer read finds the credential; the older one, settling last, finds none.
    await act(async () => {
      held[1]?.settle("ogapp_personal");
      await newer;
      held[0]?.settle(null);
      await older;
      await flush();
    });
    expect(probe.state.account?.id).toBe("personal");
    expect(probe.state.accounts.find((each) => each.id === "personal")?.signedOut).toBeUndefined();
  } finally {
    heldReads = null;
    await view.unmount();
  }
});

const clientKey = (probe: Probe) => (probe.state.client as unknown as { apiKey?: string }).apiKey;

test("a credential read from before a sign-in never replaces the new token", async () => {
  const { probe, view } = await mount(
    { accounts: [staging, work], activeId: "staging" },
    { work: "ogapp_work" },
    { holdReads: true },
  );
  const held = heldReads ?? [];
  try {
    // The launch read of the account in use is still out; so is a retry's.
    let retry: Promise<string> = Promise.resolve("");
    await act(async () => {
      retry = probe.state.retrySignIn("staging");
      await flush();
    });
    const stale = held.filter((each) => each.id === "staging");
    expect(stale).toHaveLength(2);
    webSignIn = { kind: "signedIn", accessToken: "ogapp_staging" };
    signedInSubject = "user:staging";
    await act(async () => {
      await probe.state.addAccount("https://staging.app.opengeni.ai");
      await flush();
    });
    expect(clientKey(probe)).toBe("ogapp_staging");
    let outcome = "";
    await act(async () => {
      for (const each of stale) each.settle("ogapp_revoked");
      outcome = await retry;
      await flush();
    });
    expect(outcome).toBe("signIn");
    expect(clientKey(probe)).toBe("ogapp_staging");
    expect(probe.state.account?.id).toBe("staging");
    expect(probe.state.status).toBe("ready");
  } finally {
    heldReads = null;
    await view.unmount();
  }
});

test("signing in or out clears an account's unreadable mark", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
    { unreadable: true },
  );
  try {
    expect(probe.state.status).toBe("signedOut");
    expect([...probe.state.unreadable].sort()).toEqual(["personal", "work"]);
    unreadable = false;
    await act(async () => {
      await probe.state.signOut("personal");
      await flush();
    });
    expect([...probe.state.unreadable]).toEqual(["work"]);
    webSignIn = { kind: "signedIn", accessToken: "ogapp_work_again" };
    await act(async () => {
      await probe.state.addAccount("https://app.opengeni.ai");
      await flush();
    });
    expect(probe.state.unreadable.size).toBe(0);
    expect(probe.state.status).toBe("ready");
  } finally {
    await view.unmount();
  }
});

test("a sign-in that saves while the launch check marks another account keeps the mark", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work" },
    { holdReads: true },
  );
  const held = heldReads ?? [];
  try {
    let open: () => void = () => undefined;
    writeGate = new Promise((resolve) => {
      open = resolve;
    });
    webSignIn = { kind: "signedIn", accessToken: "ogapp_new" };
    signedInSubject = "user:new";
    let adding: Promise<unknown> = Promise.resolve();
    await act(async () => {
      adding = probe.state.addAccount("https://app.opengeni.ai");
      await flush();
    });
    // The launch check finds personal's credential missing while the new one saves.
    await act(async () => {
      held.find((each) => each.id === "personal")?.settle(null);
      await flush();
    });
    expect(probe.state.accounts.find((each) => each.id === "personal")?.signedOut).toBe(true);
    await act(async () => {
      open();
      await adding;
      await flush();
    });
    expect(probe.state.accounts.map((each) => each.email)).toEqual([
      "work@example.com",
      "personal@example.com",
      "user:new",
    ]);
    expect(probe.state.accounts.find((each) => each.id === "personal")?.signedOut).toBe(true);
    expect(saved.at(-1)?.accounts.find((each) => each.id === "personal")?.signedOut).toBe(true);
  } finally {
    heldReads = null;
    writeGate = null;
    await view.unmount();
  }
});

test("a sign-out that saves while the launch check marks another account keeps the mark", async () => {
  const home = account("home");
  const { probe, view } = await mount(
    { accounts: [work, personal, home], activeId: "work" },
    { work: "ogapp_work", home: "ogapp_home" },
    { holdReads: true },
  );
  const held = heldReads ?? [];
  try {
    let open: () => void = () => undefined;
    writeGate = new Promise((resolve) => {
      open = resolve;
    });
    let signingOut: Promise<unknown> = Promise.resolve();
    await act(async () => {
      signingOut = probe.state.signOut("home");
      await flush();
    });
    // Sign-out's own read of home's credential, then the launch check's verdicts.
    await act(async () => {
      held.filter((each) => each.id === "home").forEach((each) => each.settle("ogapp_home"));
      held.find((each) => each.id === "personal")?.settle(null);
      await flush();
    });
    expect(probe.state.accounts.find((each) => each.id === "personal")?.signedOut).toBe(true);
    await act(async () => {
      open();
      await signingOut;
      await flush();
    });
    expect(probe.state.accounts.map((each) => each.id)).toEqual(["work", "personal"]);
    expect(probe.state.accounts.find((each) => each.id === "personal")?.signedOut).toBe(true);
  } finally {
    heldReads = null;
    writeGate = null;
    await view.unmount();
  }
});

test("a retry for an account signed out meanwhile goes nowhere", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
  );
  try {
    const held: NonNullable<typeof heldReads> = [];
    heldReads = held;
    let retry: Promise<string> = Promise.resolve("");
    let signOut: Promise<void> = Promise.resolve();
    await act(async () => {
      retry = probe.state.retrySignIn("personal");
      signOut = probe.state.signOut("personal");
      await flush();
    });
    expect(held.map((each) => each.id)).toEqual(["personal", "personal"]);
    let outcome = "";
    await act(async () => {
      held[1]?.settle("ogapp_personal");
      await signOut;
      held[0]?.settle("ogapp_personal");
      outcome = await retry;
      await flush();
    });
    expect(outcome).toBe("signIn");
    expect(probe.state.accounts.map((each) => each.id)).toEqual(["work"]);
    expect(probe.state.account?.id).toBe("work");
    expect(probe.state.status).toBe("ready");
    expect(probe.state.unreadable.size).toBe(0);
  } finally {
    heldReads = null;
    await view.unmount();
  }
});

test("signing in or out makes reads already in flight for that account count for nothing", async () => {
  const { probe, view } = await mount(
    { accounts: [staging, work], activeId: "staging" },
    { work: "ogapp_work" },
  );
  try {
    expect(probe.state.status).toBe("signedOut");
    const held: NonNullable<typeof heldReads> = [];
    heldReads = held;
    // A retry's read of the signed-out account is still out when it signs in again.
    let retry: Promise<unknown> = Promise.resolve();
    await act(async () => {
      retry = probe.state.retrySignIn("staging");
      await flush();
    });
    webSignIn = { kind: "signedIn", accessToken: "ogapp_staging" };
    signedInSubject = "user:staging";
    await act(async () => {
      await probe.state.addAccount("https://staging.app.opengeni.ai");
      await flush();
    });
    expect(probe.state.status).toBe("ready");
    await act(async () => {
      held[0]?.settle(null);
      await retry;
      await flush();
    });
    expect(probe.state.account?.id).toBe("staging");
    expect(probe.state.account?.signedOut).toBeUndefined();
    expect(probe.state.status).toBe("ready");
    // A read of an account still out when it signs out doesn't mark it unreadable.
    let read: Promise<unknown> = Promise.resolve();
    await act(async () => {
      read = probe.state.chooseAccount("work");
      await flush();
    });
    const workRead = held.find((each) => each.id === "work");
    await act(async () => {
      const signingOut = probe.state.signOut("work");
      await flush();
      held
        .filter((each) => each.id === "work" && each !== workRead)
        .forEach((each) => each.settle("ogapp_work"));
      await signingOut;
      workRead?.settle(new Error("keychain locked"));
      await read;
      await flush();
    });
    expect(probe.state.accounts.map((each) => each.id)).toEqual(["staging"]);
    expect(probe.state.unreadable.has("work")).toBe(false);
  } finally {
    heldReads = null;
    await view.unmount();
  }
});

test("an account whose credential is missing shows as signed out from launch", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal, account("home")], activeId: "work" },
    { work: "ogapp_work" },
  );
  try {
    expect(probe.state.status).toBe("ready");
    expect(probe.state.accounts.find((each) => each.id === "personal")?.signedOut).toBe(true);
    expect(probe.state.accounts.find((each) => each.id === "home")?.signedOut).toBe(true);
    expect(probe.state.accounts.find((each) => each.id === "work")?.signedOut).toBeUndefined();
    // Both marks in one save, so a slower write can't undo the other.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.accounts.filter((each) => each.signedOut).map((each) => each.id)).toEqual([
      "personal",
      "home",
    ]);
  } finally {
    await view.unmount();
  }
});

test("the account in use without a credential lands on its sign-in, marked signed out", async () => {
  const { probe, view } = await mount({ accounts: [work, personal], activeId: "work" }, {});
  try {
    expect(probe.state.status).toBe("signedOut");
    expect(probe.state.account?.signedOut).toBe(true);
    expect([...probe.state.unreadable]).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("an unreadable credential for the account in use offers a retry instead of loading forever", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
    { unreadable: true },
  );
  try {
    expect(probe.state.status).toBe("signedOut");
    expect(probe.state.account?.id).toBe("work");
    expect(probe.state.account?.signedOut).toBeUndefined();
    expect(probe.state.unreadable.has("work")).toBe(true);
    // Still unreadable: nothing changes.
    let outcome = "";
    await act(async () => {
      outcome = await probe.state.retrySignIn("work");
    });
    expect(outcome).toBe("unreadable");
    expect(probe.state.status).toBe("signedOut");
    // Readable again: straight in, with no sign-in.
    unreadable = false;
    await act(async () => {
      outcome = await probe.state.retrySignIn("work");
      await flush();
    });
    expect(outcome).toBe("ready");
    expect(probe.state.status).toBe("ready");
    expect(probe.state.unreadable.has("work")).toBe(false);
    expect(tokenWrites).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("a retry from the sheet makes the readable account the one in use", async () => {
  const { probe, view } = await mount(
    { accounts: [work, personal], activeId: "work" },
    { work: "ogapp_work", personal: "ogapp_personal" },
  );
  try {
    let outcome = "";
    await act(async () => {
      outcome = await probe.state.retrySignIn("personal");
      await flush();
    });
    expect(outcome).toBe("ready");
    expect(probe.state.account?.id).toBe("personal");
    expect(probe.state.status).toBe("ready");
    expect(probe.state.previousAccountId).toBe("work");
    // An account removed while its read ran has nothing to go to.
    await act(async () => {
      outcome = await probe.state.retrySignIn("gone");
      await flush();
    });
    expect(outcome).toBe("signIn");
    expect(probe.state.account?.id).toBe("personal");
    expect(probe.state.status).toBe("ready");
  } finally {
    await view.unmount();
  }
});

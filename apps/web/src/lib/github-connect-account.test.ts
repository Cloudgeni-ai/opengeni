import { expect, test } from "bun:test";
import {
  ConnectController,
  ConnectPopupClosedError,
  type ConnectAttempt,
  type ConnectTransport,
} from "@opengeni/connect";
import { selectGitHubConnectAccount } from "./github-connect-account";

const selection: ConnectAttempt = {
  id: "attempt",
  workspaceId: "workspace",
  providerId: "github-app",
  ownership: "workspace",
  revision: 1,
  state: "account_selection",
  credentialsCommitted: false,
  integrationInstalled: false,
  completionRequirement: "connection",
  expiresAt: "2030-01-01T00:00:00Z",
  nextAction: {
    type: "select_account",
    accounts: [
      {
        id: "42",
        providerId: "github-app",
        label: "Organization",
        ownership: "workspace",
        status: "connected",
      },
    ],
  },
};
const authorization: ConnectAttempt = {
  ...selection,
  revision: 2,
  state: "requires_user_action",
  nextAction: { type: "authorize", url: "https://github.com/login/oauth/authorize?state=exact" },
};
const complete: ConnectAttempt = {
  ...authorization,
  revision: 3,
  state: "complete",
  nextAction: { type: "none" },
};

async function fixture({ completeOnNavigation = true }: { completeOnNavigation?: boolean } = {}) {
  let current = selection;
  let advance!: (value: ConnectAttempt) => void;
  let submitted: unknown;
  const calls: string[] = [];
  const transport: ConnectTransport = {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => current,
    get: async () => current,
    advance: async (_workspace, _id, input) => {
      calls.push("advance");
      submitted = input.action;
      return new Promise((resolve) => {
        advance = resolve;
      });
    },
    cancel: async () => current,
    disconnect: async () => {},
  };
  const controller = new ConnectController(transport, "workspace");
  await controller.recover(selection.id);
  let popupClosed = false;
  const popup = {
    opener: {} as unknown,
    get closed() {
      return popupClosed;
    },
    location: {
      replace(url: string) {
        expect(popup.opener).toBeNull();
        calls.push(url);
        if (completeOnNavigation) current = complete;
      },
    },
    close() {
      popupClosed = true;
      calls.push("close");
    },
  };
  const browser = {
    open(url: string) {
      calls.push(url);
      return popup;
    },
    location: {
      assign() {
        throw new Error("Must keep the chat open");
      },
    },
  };
  return {
    controller,
    calls,
    browser,
    popup,
    finish: (value = authorization) => {
      current = value;
      advance(value);
    },
    submitted: () => submitted,
  };
}

for (const accountId of ["42", "new"])
  test(`Continue reserves an isolated window and completes ${accountId} without a second click`, async () => {
    const f = await fixture();
    try {
      const pending = selectGitHubConnectAccount(
        f.controller,
        accountId,
        f.browser,
        new AbortController().signal,
      );
      expect(f.calls).toEqual(["about:blank", "advance"]);
      expect(f.submitted()).toEqual({ type: "account", accountId });
      f.finish();
      await pending;
      expect(f.calls).toContain("https://github.com/login/oauth/authorize?state=exact");
      expect(f.controller.getSnapshot().attempt?.state).toBe("complete");
      expect(f.calls.at(-1)).toBe("close");
    } finally {
      f.controller.dispose();
    }
  });

test("blocked popup does not commit account selection", async () => {
  const f = await fixture();
  try {
    await expect(
      selectGitHubConnectAccount(
        f.controller,
        "42",
        { ...f.browser, open: () => null },
        new AbortController().signal,
      ),
    ).rejects.toThrow("blocked");
    expect(f.submitted()).toBeUndefined();
  } finally {
    f.controller.dispose();
  }
});

test("closing setup during selection prevents late navigation", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const pending = selectGitHubConnectAccount(f.controller, "42", f.browser, abort.signal);
    abort.abort();
    f.finish();
    await expect(pending).rejects.toThrow();
    expect(f.calls.filter((value) => value.startsWith("https:"))).toEqual([]);
    expect(f.calls.at(-1)).toBe("close");
  } finally {
    f.controller.dispose();
  }
});

test("closing the GitHub authorization popup reports cancellation and keeps its attempt", async () => {
  const f = await fixture({ completeOnNavigation: false });
  try {
    const pending = selectGitHubConnectAccount(
      f.controller,
      "42",
      f.browser,
      new AbortController().signal,
    );
    f.finish();
    await Bun.sleep(0);
    expect(f.calls).toContain("https://github.com/login/oauth/authorize?state=exact");
    f.popup.close();
    await expect(pending).rejects.toBeInstanceOf(ConnectPopupClosedError);
    expect(f.controller.getSnapshot().attempt?.state).toBe("requires_user_action");
  } finally {
    f.controller.dispose();
  }
}, 5_000);

test("unsafe server navigation closes the reservation without loading it", async () => {
  const f = await fixture();
  try {
    const pending = selectGitHubConnectAccount(
      f.controller,
      "42",
      f.browser,
      new AbortController().signal,
    );
    f.finish({ ...authorization, nextAction: { type: "authorize", url: "javascript:alert(1)" } });
    await expect(pending).rejects.toThrow("HTTPS");
    expect(f.calls).not.toContain("javascript:alert(1)");
    expect(f.calls.at(-1)).toBe("close");
  } finally {
    f.controller.dispose();
  }
});

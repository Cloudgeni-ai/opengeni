import { expect, test } from "bun:test";
import { ConnectController, type ConnectAccount, type ConnectTransport } from "@opengeni/connect";
import { ConnectAccounts } from "../src/connect";
import { actRun, registerDom, renderComponent } from "./render-hook";
registerDom();
test("reconnect retains provider, ownership, account identity and exact host return", async () => {
  let submitted: unknown;
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  const source = new ConnectController(
    {
      accounts: async () => [account],
      catalog: unused,
      pending: unused,
      get: unused,
      advance: unused,
      cancel: unused,
      disconnect: unused,
      begin: async (workspaceId, input) => {
        submitted = input;
        return {
          id: "reconnect",
          workspaceId,
          providerId: input.providerId,
          ownership: input.ownership,
          revision: 1,
          state: "requires_user_action",
          credentialsCommitted: false,
          integrationInstalled: false,
          completionRequirement: "connection",
          nextAction: { type: "none" },
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
    },
    "workspace",
  );
  const returnUrl = "https://HOST.example:443/done?x=%2f#exact";
  const view = await renderComponent(<ConnectAccounts controller={source} returnUrl={returnUrl} />);
  try {
    await actRun(() => button(view.container, "Reconnect My account").click());
    expect(submitted).toMatchObject({
      providerId: account.providerId,
      ownership: account.ownership,
      reconnectAccountId: account.id,
      returnUrl,
    });
    expect(source.getSnapshot().attempt?.id).toBe("reconnect");
  } finally {
    await view.unmount();
    source.dispose();
  }
});
const account: ConnectAccount = {
  id: "account",
  providerId: "provider",
  version: 3,
  label: "My account",
  ownership: "personal",
  status: "connected",
};
function controller(
  accounts: ConnectTransport["accounts"],
  disconnect: ConnectTransport["disconnect"] = async () => {},
) {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  return new ConnectController(
    {
      accounts,
      disconnect,
      catalog: unused,
      pending: unused,
      begin: unused,
      get: unused,
      advance: unused,
      cancel: unused,
    },
    "workspace",
  );
}
function button(container: HTMLElement, text: string) {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
test("disconnect requires confirmation and forwards observed version then reloads", async () => {
  let calls = 0;
  let removed = false;
  const source = controller(
    async () => (removed ? [] : [account]),
    async (workspace, id, options) => {
      calls++;
      expect(workspace).toBe("workspace");
      expect(id).toBe("account");
      expect(options?.expectedVersion).toBe(3);
      removed = true;
    },
  );
  const view = await renderComponent(<ConnectAccounts controller={source} />);
  try {
    await actRun(() => button(view.container, "Disconnect My account").click());
    expect(calls).toBe(0);
    expect(view.container.textContent).toContain("does not revoke consent");
    await actRun(() => button(view.container, "Confirm disconnect").click());
    expect(calls).toBe(1);
    expect(view.container.textContent).toContain("No connected accounts");
  } finally {
    await view.unmount();
    source.dispose();
  }
});
test("unknown versions cannot disconnect and uncertain outcomes require a reload", async () => {
  const legacy = { ...account, id: "legacy", label: "Legacy" };
  delete legacy.version;
  const source = controller(
    async () => [account, legacy],
    async () => {
      throw new Error("private provider diagnostic");
    },
  );
  const view = await renderComponent(<ConnectAccounts controller={source} />);
  try {
    expect(button(view.container, "Disconnect Legacy").disabled).toBe(true);
    await actRun(() => button(view.container, "Disconnect My account").click());
    await actRun(() => button(view.container, "Confirm disconnect").click());
    expect(view.container.textContent).toContain("Reload before trying again");
    expect(view.container.textContent).not.toContain("private provider diagnostic");
    expect(view.container.textContent).not.toContain("Confirm disconnect");
  } finally {
    await view.unmount();
    source.dispose();
  }
});
test("actor replacement discards stale inventory even if transport ignores abort", async () => {
  let resolve!: (value: ConnectAccount[]) => void;
  const previous = controller(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const next = controller(async () => []);
  const view = await renderComponent(<ConnectAccounts controller={previous} />);
  try {
    await view.rerender(<ConnectAccounts controller={next} />);
    await actRun(() => resolve([account]));
    expect(view.container.textContent).not.toContain("My account");
    expect(view.container.textContent).toContain("No connected accounts");
  } finally {
    await view.unmount();
    previous.dispose();
    next.dispose();
  }
});

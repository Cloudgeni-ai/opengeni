import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectionMetadata } from "@opengeni/sdk";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OwnLoginsSharedHeadsUp, ownLoginsInUse } = await import("./own-logins-shared-heads-up");
const { stopOwnLoginsHere } = await import("./own-login-turned-on");

function login(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: "account",
    workspaceId: "personal",
    authorityId: crypto.randomUUID(),
    subjectId: "user:me",
    providerDomain: "mail.example",
    kind: "oauth2",
    status: "active",
    metadata: { email: "me@mail.example" },
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    createdBySubjectId: "user:me",
    updatedBySubjectId: "user:me",
    createdAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    turnedOnHere: true,
    turnedOnHereGrantId: crypto.randomUUID(),
    ...overrides,
  };
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: (node: React.ReactNode) => act(async () => root.render(node)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function trigger(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]");
  if (!button) throw new Error("The heads-up has no menu button.");
  return button;
}

async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    trigger(container).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  const menu = document.querySelector<HTMLElement>("[role=menu]");
  if (!menu) throw new Error("The menu did not open.");
  return menu;
}

test("only the viewer's own logins that this chat will use count", () => {
  const mine = login();
  const unchosen = login({ metadata: { email: "other@mail.example" } });
  const teammate = login({ subjectId: "user:teammate" });
  const shared = login({ subjectId: null });
  const tracker = login({ metadata: { email: "me@tracker.example" } });
  const groups = [
    { serverId: "mail", name: "Mail", accounts: [mine, unchosen, teammate, shared] },
    { serverId: "tracker", name: "Tracker", accounts: [tracker] },
  ];
  // An explicit choice narrows Mail to one account; no choice uses every eligible one.
  expect(ownLoginsInUse(groups, { mail: [mine.id, teammate.id] }, "user:me")).toEqual([
    { accounts: [mine], label: "Mail", connector: "Mail" },
    { accounts: [tracker], label: "Tracker", connector: "Tracker" },
  ]);
  // Two of your own accounts for one connector are told apart.
  expect(ownLoginsInUse(groups, {}, "user:me").map((entry) => entry.label)).toEqual([
    "Mail (me@mail.example)",
    "Mail (other@mail.example)",
    "Tracker",
  ]);
  expect(ownLoginsInUse(groups, { mail: [], tracker: [] }, "user:me")).toEqual([]);
});

test("one account connected twice is one login that holds both connections", () => {
  const first = login();
  const again = login({ metadata: { email: "Me@Mail.example" } });
  const tracker = login({ metadata: { email: "me@tracker.example" } });
  // Connections that name no account never merge: they may be different accounts.
  const unnamedA = login({ metadata: {} });
  const unnamedB = login({ metadata: {} });
  const used = ownLoginsInUse(
    [
      { serverId: "mail", name: "Mail", accounts: [first, again] },
      // The same connection reached through a second server counts once.
      { serverId: "mail-2", name: "Mail", accounts: [again] },
      { serverId: "tracker", name: "Tracker", accounts: [tracker] },
      { serverId: "notes", name: "Notes", accounts: [unnamedA, unnamedB] },
    ],
    {},
    "user:me",
  );
  expect(used.map((entry) => entry.label)).toEqual(["Mail", "Tracker", "Notes", "Notes"]);
  expect(used[0]!.accounts).toEqual([first, again]);
  expect(used.slice(2).map((entry) => entry.accounts)).toEqual([[unnamedA], [unnamedB]]);
});

test("the heads-up is one quiet line; the details and Stop wait in its menu", async () => {
  const view = await mount();
  const onStop = mock(async () => {});
  const mail = login();
  const tracker = login({ metadata: { email: "me@tracker.example" } });
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[
        { accounts: [mail], label: "Mail", connector: "Mail" },
        { accounts: [tracker], label: "Tracker", connector: "Tracker" },
      ]}
      onStop={onStop}
    />,
  );
  const line = view.container.querySelector<HTMLElement>(
    "[data-testid=own-logins-shared-heads-up]",
  )!;
  expect(line.textContent).toBe("Using your Mail and Tracker");
  // One action on the line: the menu button. No inline Stop links.
  expect(line.querySelectorAll("button")).toHaveLength(1);
  expect(trigger(line).querySelector(".truncate")).not.toBeNull();

  const menu = await openMenu(view.container);
  expect(menu.textContent).toContain(
    "They work for your messages here. People in this workspace see what the agent does with them.",
  );
  expect([...menu.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual([
    "Stop using Mail here",
    "Stop using Tracker here",
  ]);
  expect(onStop).not.toHaveBeenCalled();
  await view.unmount();
});

test("Stop on an account connected twice stops both of its connections", async () => {
  const view = await mount();
  const onStop = mock(async (_accounts: readonly ConnectionMetadata[]) => {});
  const first = login();
  const again = login();
  const logins = ownLoginsInUse(
    [{ serverId: "mail", name: "Mail", accounts: [first, again] }],
    {},
    "user:me",
  );
  await view.render(<OwnLoginsSharedHeadsUp logins={logins} onStop={onStop} />);
  expect(view.container.textContent).toBe("Using your Mail");
  const menu = await openMenu(view.container);
  expect(menu.textContent).toContain(
    "It works for your messages here. People in this workspace see what the agent does with it.",
  );
  const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
  expect(items.map((item) => item.textContent)).toEqual(["Stop using Mail here"]);
  await act(async () => items[0]!.click());
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(onStop.mock.calls[0]![0]).toEqual([first, again]);
  await view.unmount();
});

test("a failed Stop says so on the line", async () => {
  const view = await mount();
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[{ accounts: [login()], label: "Mail", connector: "Mail" }]}
      onStop={async () => {
        throw new Error("offline");
      }}
    />,
  );
  const menu = await openMenu(view.container);
  await act(async () => menu.querySelector<HTMLElement>("[role=menuitem]")!.click());
  expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
    "Couldn't stop it. Try again.",
  );
  await view.unmount();
});

test("stopping here revokes every grant behind the account once, even after a failure", async () => {
  const revoked: string[] = [];
  const client = {
    issueUserResourceGrant: mock(async () => {
      throw new Error("unused");
    }),
    revokeUserResourceGrant: mock(async (_workspaceId: string, grantId: string) => {
      revoked.push(grantId);
      if (grantId === "g1") throw new Error("offline");
      return undefined as never;
    }),
  };
  await expect(
    stopOwnLoginsHere(client as never, "ws", [
      { turnedOnHereGrantId: "g1" },
      { turnedOnHereGrantId: "g2" },
      { turnedOnHereGrantId: "g1" },
      { turnedOnHereGrantId: null },
    ]),
  ).rejects.toThrow("offline");
  expect(revoked).toEqual(["g1", "g2"]);
});

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
const { stopOwnLoginsHere, turnOnOwnLoginsHere } = await import("./own-login-turned-on");
type OwnLoginInUse = import("./own-logins-shared-heads-up").OwnLoginInUse;

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

function used(accounts: ConnectionMetadata[], label: string, key = `key-${label}`): OwnLoginInUse {
  return { key, serverId: `server-${label}`, connector: label, identity: "", accounts, label };
}

function lineOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-testid=own-logins-shared-heads-up]")!;
}

function liveMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[role=menu]");
}

function switches(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];
}

function states(menu: HTMLElement): string[] {
  return switches(menu).map((row) => `${row.title} ${row.getAttribute("aria-checked")}`);
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
  expect(
    ownLoginsInUse(groups, { mail: [mine.id, teammate.id] }, "user:me").map((entry) => [
      entry.serverId,
      entry.label,
      entry.accounts,
    ]),
  ).toEqual([
    ["mail", "Mail", [mine]],
    ["tracker", "Tracker", [tracker]],
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
  const logins = ownLoginsInUse(
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
  expect(logins.map((entry) => entry.label)).toEqual(["Mail", "Tracker", "Notes 1", "Notes 2"]);
  expect(logins[0]!.accounts).toEqual([first, again]);
  expect(logins.slice(2).map((entry) => entry.accounts)).toEqual([[unnamedA], [unnamedB]]);
  expect(new Set(logins.map((entry) => entry.key)).size).toBe(4);
});

test("accounts that only share a display name never merge", () => {
  const jane = login({ metadata: { name: "Jane Doe", username: "jane" } });
  const work = login({ metadata: { name: "Jane Doe", username: "jane-acme" } });
  // One email in two Slack teams is two accounts too.
  const teamA = login({ metadata: { email: "me@chat.example", teamName: "A" } });
  const teamB = login({ metadata: { email: "me@chat.example", teamName: "B" } });
  const logins = ownLoginsInUse(
    [
      { serverId: "code", name: "Code", accounts: [jane, work] },
      { serverId: "chat", name: "Chat", accounts: [teamA, teamB] },
    ],
    {},
    "user:me",
  );
  expect(logins.map((entry) => [entry.label, entry.accounts.length])).toEqual([
    ["Code 1", 1],
    ["Code 2", 1],
    ["Chat (me@chat.example · A)", 1],
    ["Chat (me@chat.example · B)", 1],
  ]);
});

test("the line only counts the personal connections; the menu has one switch per account", async () => {
  const view = await mount();
  const onChange = mock(async () => {});
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[used([login()], "Mail"), used([login()], "Tracker")]}
      onChange={onChange}
    />,
  );
  const line = view.container.querySelector<HTMLElement>(
    "[data-testid=own-logins-shared-heads-up]",
  )!;
  // It never names them, and holds one action: the menu button.
  expect(line.textContent).toBe("2 personal connections in this chat");
  expect(line.querySelectorAll("button")).toHaveLength(1);
  expect(trigger(line).querySelector(".truncate")).not.toBeNull();

  const menu = await openMenu(view.container);
  expect(menu.textContent).toContain(
    "People in this workspace see what the agent does with these.",
  );
  expect(menu.textContent).not.toContain("Stop");
  expect(states(menu)).toEqual(["Mail true", "Tracker true"]);
  expect(onChange).not.toHaveBeenCalled();

  await view.render(
    <OwnLoginsSharedHeadsUp logins={[used([login()], "Mail")]} onChange={onChange} />,
  );
  expect(trigger(view.container).textContent).toBe("1 personal connection in this chat");
  await view.unmount();
});

test("an account connected twice is one switch, and turning it off stops both connections", async () => {
  const view = await mount();
  const first = login();
  const again = login();
  const logins = ownLoginsInUse(
    [{ serverId: "mail", name: "Mail", accounts: [first, again] }],
    {},
    "user:me",
  );
  const onChange = mock(async (_login: OwnLoginInUse, _on: boolean) => {});
  await view.render(<OwnLoginsSharedHeadsUp logins={logins} onChange={onChange} />);
  expect(trigger(view.container).textContent).toBe("1 personal connection in this chat");
  const menu = await openMenu(view.container);
  expect(switches(menu)).toHaveLength(1);
  await act(async () => switches(menu)[0]!.click());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0]![0].accounts).toEqual([first, again]);
  expect(onChange.mock.calls[0]![1]).toBe(false);
  await view.unmount();
});

test("a login turned off stays in the open menu, off, and can go back on", async () => {
  const view = await mount();
  const mail = used([login()], "Mail");
  const tracker = used([login()], "Tracker");
  let on = new Set(["key-Mail", "key-Tracker"]);
  const calls: [string, boolean][] = [];
  const render = () =>
    view.render(
      <OwnLoginsSharedHeadsUp
        logins={[mail, tracker].filter((entry) => on.has(entry.key))}
        onChange={async (entry, next) => {
          calls.push([entry.label, next]);
          on = new Set(on);
          if (next) on.add(entry.key);
          else on.delete(entry.key);
        }}
      />,
    );
  await render();
  const menu = await openMenu(view.container);
  await act(async () => switches(menu)[0]!.click());
  // The inventory no longer lists Mail; it stays in place, off.
  await render();
  expect(states(menu)).toEqual(["Mail false", "Tracker true"]);
  expect(trigger(view.container).textContent).toBe("1 personal connection in this chat");
  // Both off: the line stays, so they can go back on.
  await act(async () => switches(menu)[1]!.click());
  await render();
  expect(trigger(view.container).textContent).toBe("No personal connections in this chat");
  expect(states(menu)).toEqual(["Mail false", "Tracker false"]);
  await act(async () => switches(menu)[0]!.click());
  await render();
  expect(states(menu)).toEqual(["Mail true", "Tracker false"]);
  expect(calls).toEqual([
    ["Mail", false],
    ["Tracker", false],
    ["Mail", true],
  ]);
  await view.unmount();
});

test("a switch changes at once and goes back with a plain error when the change fails", async () => {
  const view = await mount();
  let fail!: () => void;
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[used([login()], "Mail")]}
      onChange={() =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        })
      }
    />,
  );
  const menu = await openMenu(view.container);
  await act(async () => switches(menu)[0]!.click());
  // Optimistic: off while the change runs, and not clickable again meanwhile.
  expect(states(menu)).toEqual(["Mail false"]);
  expect(switches(menu)[0]!.getAttribute("aria-disabled")).toBe("true");
  await act(async () => fail());
  expect(states(menu)).toEqual(["Mail true"]);
  expect(menu.querySelector("[role=alert]")?.textContent).toBe("Couldn't change it. Try again.");
  await view.unmount();
});

test("a failure after the menu closed still shows, on the line", async () => {
  const view = await mount();
  let fail!: () => void;
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[used([login()], "Mail")]}
      onChange={() =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        })
      }
    />,
  );
  const menu = await openMenu(view.container);
  await act(async () => switches(menu)[0]!.click());
  await act(async () => {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(liveMenu()).toBeNull();
  await act(async () => fail());
  expect(lineOf(view.container).querySelector("[role=alert]")?.textContent).toBe(
    "Couldn't change it. Try again.",
  );
  expect(trigger(view.container).textContent).toBe("1 personal connection in this chat");
  await view.unmount();
});

test("the account list decides once a change is done, whoever changed it", async () => {
  const view = await mount();
  const mail = used([login()], "Mail");
  const render = (logins: OwnLoginInUse[] | null) =>
    view.render(<OwnLoginsSharedHeadsUp logins={logins} onChange={async () => {}} />);
  await render([mail]);
  const menu = await openMenu(view.container);
  await act(async () => switches(menu)[0]!.click());
  // Done, but the list hasn't caught up: off, and nothing up to date to act on.
  expect(states(menu)).toEqual(["Mail false"]);
  expect(switches(menu)[0]!.getAttribute("aria-disabled")).toBe("true");
  await render([]);
  expect(states(menu)).toEqual(["Mail false"]);
  expect(switches(menu)[0]!.getAttribute("aria-disabled")).toBeNull();
  // Turned back on elsewhere (the Connect card's "Use it here"): it shows on.
  await render([mail]);
  expect(states(menu)).toEqual(["Mail true"]);
  expect(trigger(view.container).textContent).toBe("1 personal connection in this chat");
  // While the list can't be read, the line keeps what it last knew.
  await render(null);
  expect(states(menu)).toEqual(["Mail true"]);
  expect(trigger(view.container).textContent).toBe("1 personal connection in this chat");
  await view.unmount();
});

test("a failed change leaves the switch as the list has it", async () => {
  const view = await mount();
  const mail = used([login()], "Mail");
  // Off in this view, then turning it on fails: it stays in the menu, off.
  let logins: OwnLoginInUse[] = [mail];
  let fail = false;
  const render = () =>
    view.render(
      <OwnLoginsSharedHeadsUp
        logins={logins}
        onChange={async (_entry, on) => {
          if (fail) throw new Error("offline");
          logins = on ? [mail] : [];
        }}
      />,
    );
  await render();
  const menu = await openMenu(view.container);
  await act(async () => switches(menu)[0]!.click());
  await render();
  expect(states(menu)).toEqual(["Mail false"]);
  fail = true;
  await act(async () => switches(menu)[0]!.click());
  expect(states(menu)).toEqual(["Mail false"]);
  expect(menu.querySelector("[role=alert]")).not.toBeNull();
  // Turning off an account connected twice fails halfway: one connection is
  // still on, so the list still has it, and it shows on.
  const both = used([login(), login()], "Tracker");
  logins = [both];
  fail = false;
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={logins}
      onChange={async () => {
        logins = [{ ...both, accounts: [both.accounts[1]!] }];
        throw new Error("offline");
      }}
    />,
  );
  const tracker = switches(menu).find((row) => row.title === "Tracker")!;
  await act(async () => tracker.click());
  await view.render(<OwnLoginsSharedHeadsUp logins={logins} onChange={async () => {}} />);
  expect(states(menu)).toEqual(["Mail false", "Tracker true"]);
  await view.unmount();
});

test("a switch toggles from the keyboard and the menu stays open", async () => {
  const view = await mount();
  const onChange = mock(async (_login: OwnLoginInUse, _on: boolean) => {});
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[used([login()], "Mail"), used([login()], "Tracker")]}
      onChange={onChange}
    />,
  );
  const menu = await openMenu(view.container);
  await act(async () => {
    switches(menu)[1]!.focus();
    switches(menu)[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0]![0].label).toBe("Tracker");
  expect(liveMenu()).not.toBeNull();
  await view.unmount();
});

test("labels follow the accounts in view", async () => {
  const view = await mount();
  const first = login();
  const second = login({ metadata: { email: "work@mail.example" } });
  const groups = (accounts: ConnectionMetadata[]) =>
    ownLoginsInUse([{ serverId: "mail", name: "Mail", accounts }], {}, "user:me");
  await view.render(<OwnLoginsSharedHeadsUp logins={groups([first])} onChange={async () => {}} />);
  const menu = await openMenu(view.container);
  expect(states(menu)).toEqual(["Mail true"]);
  await view.render(
    <OwnLoginsSharedHeadsUp logins={groups([first, second])} onChange={async () => {}} />,
  );
  expect(states(menu)).toEqual(["Mail (me@mail.example) true", "Mail (work@mail.example) true"]);
  await view.unmount();
});

test("many logins stay one line and scroll in the menu under the sentence", async () => {
  const view = await mount();
  const logins = Array.from({ length: 12 }, (_, index) =>
    used(
      [login({ metadata: { email: `person-${index}@example.com` } })],
      `Connector ${index} with a very long descriptive name (person-${index}@example.com)`,
    ),
  );
  await view.render(<OwnLoginsSharedHeadsUp logins={logins} onChange={async () => {}} />);
  expect(view.container.textContent).toBe("12 personal connections in this chat");
  const menu = await openMenu(view.container);
  const list = menu.querySelector<HTMLElement>("[data-testid=own-logins-list]")!;
  expect(list.className).toContain("overflow-y-auto");
  expect(list.textContent).not.toContain("People in this workspace");
  const rows = switches(list);
  expect(rows).toHaveLength(12);
  expect(rows[11]!.title).toBe(
    "Connector 11 with a very long descriptive name (person-11@example.com)",
  );
  expect(rows[11]!.querySelector(".truncate")).not.toBeNull();
  await view.unmount();
});

test("a login on without a grant here for every connection is locked on", async () => {
  const view = await mount();
  await view.render(
    <OwnLoginsSharedHeadsUp
      logins={[
        used([login({ turnedOnHereGrantId: null })], "Mail"),
        used([login(), login({ turnedOnHereGrantId: null })], "Tracker"),
        used([login()], "Notes"),
      ]}
      onChange={async () => {}}
    />,
  );
  const menu = await openMenu(view.container);
  expect(states(menu)).toEqual(["Mail true", "Tracker true", "Notes true"]);
  expect(switches(menu).map((row) => row.getAttribute("aria-disabled"))).toEqual([
    "true",
    "true",
    null,
  ]);
  await view.unmount();
});

test("turning an account off or on here covers each of its connections once", async () => {
  const revoked: string[] = [];
  const issued: string[] = [];
  const client = {
    issueUserResourceGrant: mock(
      async (_workspaceId: string, authorityId: string, _body: unknown) => {
        issued.push(authorityId);
        if (authorityId === "a1") throw new Error("offline");
        return { scope: "user", grant: { grantId: `grant-${authorityId}` } } as never;
      },
    ),
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
  await expect(
    stopOwnLoginsHere(client as never, "ws", [{ turnedOnHereGrantId: null }]),
  ).rejects.toThrow("can't be turned off here");
  await expect(
    turnOnOwnLoginsHere(client as never, "ws", [
      { authorityId: "a1" },
      { authorityId: "a2" },
      { authorityId: "a1" },
      { authorityId: undefined },
    ]),
  ).rejects.toThrow("offline");
  expect(issued).toEqual(["a1", "a2"]);
  expect(client.issueUserResourceGrant.mock.calls[1]).toEqual([
    "ws",
    "a2",
    {
      scope: "user",
      resourceKind: "connection",
      mode: "always",
      context: "workspace_shared",
      workspaceSharedAcknowledged: true,
    },
  ]);
});

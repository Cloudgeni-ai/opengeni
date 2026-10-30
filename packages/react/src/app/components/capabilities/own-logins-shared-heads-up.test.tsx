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
    turnedOnHereGrantId: "grant",
    ...overrides,
  };
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
    { account: mine, label: "Mail" },
    { account: tracker, label: "Tracker" },
  ]);
  // Two of your own accounts for one connector are told apart.
  expect(ownLoginsInUse(groups, {}, "user:me").map((entry) => entry.label)).toEqual([
    "Mail (me@mail.example)",
    "Mail (other@mail.example)",
    "Tracker",
  ]);
  expect(ownLoginsInUse(groups, { mail: [], tracker: [] }, "user:me")).toEqual([]);
});

test("the heads-up names the logins and stops one here without blocking anything", async () => {
  const mail = login();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onStop = mock(async () => {});
  await act(async () =>
    root.render(
      <OwnLoginsSharedHeadsUp logins={[{ account: mail, label: "Mail" }]} onStop={onStop} />,
    ),
  );
  expect(container.textContent).toContain(
    "Your Mail login works for your messages here. People in this workspace see what the agent does with it.",
  );
  const stop = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop using it here",
  );
  await act(async () => stop!.click());
  expect(onStop).toHaveBeenCalledWith(mail);

  // Several logins: each one can be stopped by name.
  const tracker = login({ metadata: { email: "me@tracker.example" } });
  await act(async () =>
    root.render(
      <OwnLoginsSharedHeadsUp
        logins={[
          { account: mail, label: "Mail" },
          { account: tracker, label: "Tracker" },
        ]}
        onStop={onStop}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "Your Mail and Tracker logins work for your messages here.",
  );
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Stop using Mail here",
    "Stop using Tracker here",
  ]);
  await act(async () => root.unmount());
  container.remove();
});

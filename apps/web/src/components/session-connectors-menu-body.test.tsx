import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionConnectorsMenuBody } from "./session-connectors-menu-body";
import { useState } from "react";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionToolSelection } from "./pickers";
import { useConnectionAccounts } from "./capabilities/use-connection-accounts";
import { getComposerSendBlocker } from "@/lib/composer-send-blocking";
import { connectionAccountLabel } from "./capabilities/connection-account-picker";
import type { ConnectionAccountChoices } from "./capabilities/session-connection-accounts";

let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

for (const status of ["connect", "reconnect", "unavailable"] as const) {
  test(`Customize can deselect a ${status} connector with no accounts and unblock send without reconnecting`, async () => {
    const recover = mock();
    const client = {
      listOwnConnectionAccounts: async () => [],
    } as unknown as OpenGeniBrowserClient;
    const catalog = [
      {
        enabled: true,
        name: "Mail",
        runtime: { mcpServerId: "mail" },
        connectionRef: { providerDomain: "example.com", kind: "oauth2", subjectScope: "subject" },
      },
    ] as CapabilityCatalogItem[];
    let current: SessionToolSelection;
    let blocked: ReturnType<typeof getComposerSendBlocker>;
    function Preview() {
      const [selection, setSelection] = useState<SessionToolSelection>({
        mcpServerIds: new Set(["mail", "files", "hidden"]),
        firstPartyToolIds: new Set(["session_get"]),
      });
      const [customizing, setCustomizing] = useState(false);
      const accountState = useConnectionAccounts(
        client,
        {
          id: "session",
          workspaceId: "workspace",
          selectedIds: [...selection.mcpServerIds],
        },
        catalog,
      );
      current = selection;
      blocked = getComposerSendBlocker({
        uploadPending: false,
        repositoryError: null,
        policyValid: true,
        variableSetBlocked: false,
        personalDecision: accountState.requiresAccountChoice,
        personalLoading: accountState.loading || accountState.error !== null,
      });
      return (
        <>
          <SessionConnectorsMenuBody
            presentation="dialog"
            servers={[{ id: "mail", name: "Mail", connectionStatus: status }]}
            firstPartyTools={[]}
            selection={selection}
            onChange={setSelection}
            customizing={customizing}
            onCustomizingChange={setCustomizing}
            onReconnect={recover}
            accountControls={{
              groups: accountState.availableAccountGroups,
              choices: accountState.accountChoices,
              onChoose: accountState.selectAccount,
            }}
          />
          <button type="button" disabled={blocked !== null}>
            Send
          </button>
        </>
      );
    }
    await act(async () => root.render(<Preview />));
    expect(blocked!).toBeNull();
    const send = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Send",
    )!;
    expect(send.disabled).toBe(false);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Customize connectors"]')!.click(),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Mail"]',
    )!;
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(current!.mcpServerIds).toEqual(new Set(["files", "hidden"]));
    expect(current!.firstPartyToolIds).toEqual(new Set(["session_get"]));
    expect(recover).not.toHaveBeenCalled();
    expect(blocked!).toBeNull();
    expect(send.disabled).toBe(false);
    const repairLabel =
      status === "connect"
        ? "Connect your Mail account"
        : status === "reconnect"
          ? "Reconnect Mail"
          : "Mail unavailable";
    const repair = container.querySelector<HTMLButtonElement>(`[aria-label="${repairLabel}"]`)!;
    expect(repair.hasAttribute("aria-checked")).toBe(false);
    await act(async () => repair.click());
    expect(recover).toHaveBeenCalledWith("mail");
    expect(current!.mcpServerIds.has("mail")).toBe(false);
    expect(send.disabled).toBe(false);
  });
}

test("missing personal accounts offer setup without toggling the session selection", async () => {
  const recover = mock();
  const change = mock();
  await act(async () =>
    root.render(
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[
          { id: "personal", name: "Calendar", connectionStatus: "connect" },
          { id: "expired", name: "Mail", connectionStatus: "reconnect" },
          { id: "unknown", name: "Drive", connectionStatus: "unknown" },
        ]}
        firstPartyTools={[]}
        selection={{ mcpServerIds: new Set(["personal"]), firstPartyToolIds: new Set() }}
        onChange={change}
        onReconnect={recover}
      />,
    ),
  );
  const setup = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Connect your Calendar account"]',
  )!;
  expect(container.textContent).toContain("No connected account");
  expect(setup.hasAttribute("aria-checked")).toBe(false);
  expect(container.querySelector('button[aria-label="Reconnect Mail"]')).not.toBeNull();
  expect(container.textContent).toContain("Status unavailable");
  await act(async () => setup.click());
  expect(recover).toHaveBeenCalledWith("personal");
  expect(change).not.toHaveBeenCalled();
});

const accounts = [
  { id: "personal-id", subjectId: "me", metadata: { email: "alex@example.com" } },
  { id: "workspace-id", subjectId: null, metadata: { team: { name: "Support team" } } },
] as unknown as ConnectionMetadata[];

test("connector settings attach multiple readable personal/workspace accounts without closing", async () => {
  const reconnect = mock();
  function Preview() {
    const [choices, setChoices] = useState<ConnectionAccountChoices>({});
    const [selection, setSelection] = useState<SessionToolSelection>({
      mcpServerIds: new Set(["mail"]),
      firstPartyToolIds: new Set(),
    });
    return (
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[{ id: "mail", name: "Mail" }]}
        firstPartyTools={[]}
        selection={selection}
        onChange={setSelection}
        onReconnect={reconnect}
        accountControls={{
          groups: [{ serverId: "mail", name: "Mail", accounts }],
          choices,
          onChoose: (id, ids) => setChoices({ [id]: ids }),
        }}
      />
    );
  }
  await act(async () => root.render(<Preview />));
  expect(container.textContent).not.toContain("alex@example.com");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Mail account settings"]')!.click(),
  );
  const personal = container.querySelector<HTMLButtonElement>(
    '[aria-label="alex@example.com, Only me"]',
  )!;
  const workspace = container.querySelector<HTMLButtonElement>(
    '[aria-label="Support team, This workspace"]',
  )!;
  expect(personal.getAttribute("aria-checked")).toBe("true");
  expect(workspace.getAttribute("aria-checked")).toBe("true");
  await act(async () => personal.click());
  expect(personal.getAttribute("aria-checked")).toBe("false");
  expect(workspace.getAttribute("aria-checked")).toBe("true");
  await act(async () => workspace.click());
  expect(container.textContent).toContain("No accounts selected.");
  await act(async () => personal.click());
  expect(personal.getAttribute("aria-checked")).toBe("true");
  expect(workspace.getAttribute("aria-checked")).toBe("false");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Back to connectors"]')!.click(),
  );
  expect(container.textContent).not.toContain("alex@example.com");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Mail account settings"]')!.click(),
  );
  expect(container.textContent).toContain("Connected accounts");
  expect(container.textContent).not.toContain("Connect another account");
  // Healthy chat settings contain only navigation and account attachment controls.
  expect(container.querySelectorAll("button")).toHaveLength(3);
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2);
  expect(reconnect).not.toHaveBeenCalled();
});

test("revoked account access shows ask-admin guidance without Retry in both composer menu views", async () => {
  let denied = false;
  const client = {
    listOwnConnectionAccounts: async () => {
      if (denied) throw { status: 403 };
      return [
        {
          id: "personal-id",
          subjectId: "me",
          authorityId: "authority",
          status: "active",
          providerDomain: "example.com",
          metadata: { email: "alex@example.com" },
        },
      ] as unknown as ConnectionMetadata[];
    },
  } as unknown as OpenGeniBrowserClient;
  const catalog = [
    {
      enabled: true,
      name: "Mail",
      runtime: { mcpServerId: "mail" },
      connectionRef: { providerDomain: "example.com", subjectScope: "subject" },
    },
  ] as CapabilityCatalogItem[];
  let refreshAccounts!: () => Promise<void>;
  function Preview() {
    const accountState = useConnectionAccounts(
      client,
      { id: "session", workspaceId: "workspace", selectedIds: ["mail"] },
      catalog,
    );
    refreshAccounts = accountState.refresh;
    return (
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[{ id: "mail", name: "Mail" }]}
        firstPartyTools={[]}
        selection={{ mcpServerIds: new Set(["mail"]), firstPartyToolIds: new Set() }}
        onChange={() => {}}
        accountControls={{
          groups: accountState.availableAccountGroups,
          choices: accountState.accountChoices,
          onChoose: accountState.selectAccount,
          error: accountState.error,
          accessDenied: accountState.accessDenied,
          onRefresh: () => void accountState.refresh(),
        }}
      />
    );
  }
  await act(async () => root.render(<Preview />));
  expect(container.querySelector('[aria-label="Mail account settings"]')).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Mail account settings"]')!.click(),
  );
  denied = true;
  await act(async () => refreshAccounts());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Ask a workspace admin for connection access",
  );
  expect(container.textContent).not.toContain("alex@example.com");
  expect(container.textContent).not.toContain("Retry accounts");

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Back to connectors"]')!.click(),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Ask a workspace admin for connection access",
  );
  expect(container.textContent).not.toContain("Retry accounts");
});

test("transient account failure still offers Retry in the composer menu", async () => {
  const retry = mock();
  await act(async () =>
    root.render(
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[{ id: "mail", name: "Mail" }]}
        firstPartyTools={[]}
        selection={{ mcpServerIds: new Set(["mail"]), firstPartyToolIds: new Set() }}
        onChange={() => {}}
        accountControls={{
          groups: [],
          choices: {},
          onChoose: () => {},
          error: "Connection accounts could not be checked.",
          onRefresh: retry,
        }}
      />,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry accounts")!
      .click(),
  );
  expect(retry).toHaveBeenCalledTimes(1);
});

test("account labels use readable metadata and never fall back to a raw connection ID", () => {
  for (const metadata of [
    { email: "Label" },
    { displayName: "Label" },
    { accountName: "Label" },
    { teamName: "Label" },
    { workspaceName: "Label" },
    { team: { name: "Label" } },
    { workspace: { name: "Label" } },
  ]) {
    expect(connectionAccountLabel({ ...accounts[0]!, metadata }, "Mail account 1")).toBe("Label");
  }
  expect(connectionAccountLabel({ ...accounts[0]!, metadata: {} }, "Mail account 1")).toBe(
    "Mail account 1",
  );
});

test("last account off disables only its connector; reenable restores accounts and ordinary off/on preserves narrowing", async () => {
  let current!: SessionToolSelection;
  let chosen!: ConnectionAccountChoices;
  function Preview() {
    const [selection, setSelection] = useState<SessionToolSelection>({
      mcpServerIds: new Set(["mail", "files", "hidden"]),
      firstPartyToolIds: new Set(["session_get"]),
    });
    const [choices, setChoices] = useState<ConnectionAccountChoices>({});
    const [customizing, setCustomizing] = useState(false);
    current = selection;
    chosen = choices;
    return (
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[{ id: "mail", name: "Mail", connectionStatus: "ready" }]}
        firstPartyTools={[]}
        selection={selection}
        onChange={setSelection}
        customizing={customizing}
        onCustomizingChange={setCustomizing}
        accountControls={{
          groups: [{ serverId: "mail", name: "Mail", accounts }],
          choices,
          onChoose: (id, ids) => setChoices((previous) => ({ ...previous, [id]: ids })),
        }}
      />
    );
  }
  const click = async (label: string) =>
    act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  await act(async () => root.render(<Preview />));
  await click("Mail account settings");
  await click("alex@example.com, Only me");
  await click("Support team, This workspace");
  expect(current.mcpServerIds).toEqual(new Set(["files", "hidden"]));
  expect(current.firstPartyToolIds).toEqual(new Set(["session_get"]));
  expect(chosen.mail).toEqual([]);
  await click("Back to connectors");
  const settings = container.querySelector('[aria-label="Mail account settings"]')!;
  const toggle = container.querySelector('[aria-label="Mail"]')!;
  expect(settings.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await click("Mail");
  expect(current.mcpServerIds.has("mail")).toBe(true);
  expect(chosen.mail).toEqual(accounts.map((account) => account.id));
  await click("Mail account settings");
  await click("alex@example.com, Only me");
  await click("Back to connectors");
  await click("Mail");
  expect(container.querySelector('[aria-label="Mail account settings"]')).not.toBeNull();
  await click("Mail");
  expect(chosen.mail).toEqual(["workspace-id"]);
});

test("settings remains reachable to remove the last disconnected account", async () => {
  const change = mock();
  const choose = mock();
  await act(async () =>
    root.render(
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[{ id: "mail", name: "Mail", connectionStatus: "connect" }]}
        firstPartyTools={[]}
        selection={{ mcpServerIds: new Set(["mail"]), firstPartyToolIds: new Set() }}
        onChange={change}
        accountControls={{
          groups: [{ serverId: "mail", name: "Mail", accounts: [] }],
          choices: { mail: ["gone"] },
          onChoose: choose,
        }}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Mail account settings"]')!.click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Remove disconnected account")!
      .click(),
  );
  expect(choose).toHaveBeenCalledWith("mail", []);
  expect(change.mock.calls[0]![0].mcpServerIds.size).toBe(0);
});

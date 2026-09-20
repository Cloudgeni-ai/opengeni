import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionConnectorsMenuBody } from "./session-connectors-menu-body";
import { useState } from "react";
import type { ConnectionMetadata } from "@opengeni/sdk";
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
  expect(setup.textContent).toContain("Connect your account");
  expect(setup.textContent).not.toContain("Reconnect required");
  expect(setup.hasAttribute("aria-checked")).toBe(false);
  expect(container.querySelector('button[aria-label="Reconnect Mail"]')?.textContent).toContain(
    "Reconnect required",
  );
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
  function Preview() {
    const [choices, setChoices] = useState<ConnectionAccountChoices>({});
    return (
      <SessionConnectorsMenuBody
        presentation="dialog"
        servers={[{ id: "mail", name: "Mail" }]}
        firstPartyTools={[]}
        selection={{ mcpServerIds: new Set(["mail"]), firstPartyToolIds: new Set() }}
        onChange={() => {}}
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
  expect(container.textContent).toContain("Attach an account or turn off this connector.");
  await act(async () => personal.click());
  expect(personal.getAttribute("aria-checked")).toBe("true");
  expect(workspace.getAttribute("aria-checked")).toBe("false");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Back to connectors"]')!.click(),
  );
  expect(container.textContent).not.toContain("alex@example.com");
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

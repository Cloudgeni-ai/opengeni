import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionConnectorsMenuBody } from "./session-connectors-menu-body";

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
  expect(container.textContent).toContain("Personal connections use your account.");
  await act(async () => setup.click());
  expect(recover).toHaveBeenCalledWith("personal");
  expect(change).not.toHaveBeenCalled();
});

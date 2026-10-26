import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import {
  ConnectController,
  ConnectPopupClosedError,
  type ConnectAttempt,
  type ConnectTransport,
} from "@opengeni/connect";
import { ConnectSetup } from "../src/connect";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  const current = mounted;
  mounted = null;
  await current?.unmount();
});

test("closing the sign-in window says so and offers to sign in again, not a failure", async () => {
  const attempt: ConnectAttempt = {
    id: "attempt",
    workspaceId: "workspace",
    providerId: "provider",
    ownership: "personal",
    revision: 1,
    state: "requires_user_action",
    nextAction: { type: "authorize", url: "https://provider.example/authorize" },
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const transport: ConnectTransport = {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => attempt,
    get: async () => attempt,
    advance: async () => attempt,
    cancel: async () => attempt,
    disconnect: async () => {},
  };
  const controller = new ConnectController(transport, "workspace");
  await controller.recover("attempt");
  mounted = await renderComponent(
    <ConnectSetup
      controller={controller}
      authorizeLabel="Sign in"
      onAuthorize={() => Promise.reject(new ConnectPopupClosedError())}
    />,
  );
  const buttons = () => [...mounted!.container.querySelectorAll("button")];
  await act(async () => {
    buttons()
      .find((button) => button.textContent?.includes("Sign in"))!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const text = mounted.container.textContent ?? "";
  expect(text).toContain("Sign-in window closed. You can try connecting again.");
  expect(text).not.toContain("could not continue");
  expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
  expect(buttons().some((button) => button.textContent?.includes("Try signing in again"))).toBe(
    true,
  );
  controller.dispose();
});

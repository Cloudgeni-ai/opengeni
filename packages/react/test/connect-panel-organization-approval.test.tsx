import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import {
  ConnectController,
  type ConnectAttempt,
  type ConnectProvider,
  type ConnectTransport,
} from "@opengeni/connect";
import { ConnectChooser, ConnectPanel } from "../src/connect";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const APPROVAL_LINK =
  "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=app-1" +
  "&scope=https%3A%2F%2Fgraph.microsoft.com%2FMail.ReadWrite" +
  "&redirect_uri=https%3A%2F%2Fapi.example.com%2Fv1%2Fintegrations%2Fprovider-oauth%2Fcallback" +
  "&state=microsoft_admin_consent";
const SIGN_IN =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=app-1&state=signed";

function attemptFor(overrides: Partial<ConnectAttempt> = {}): ConnectAttempt {
  return {
    id: "attempt-1",
    workspaceId: "workspace",
    providerId: "microsoft-outlook-mail",
    ownership: "personal",
    revision: 2,
    state: "cancelled",
    nextAction: { type: "none" },
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "integration",
    expiresAt: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

// What the server stores when a person leaves Microsoft's "Need admin approval"
// page (error=access_denied, error_subcode=cancel).
const leftApprovalPage = attemptFor({
  error: {
    code: "provider_denied",
    message: `Microsoft did not grant access. If Microsoft said your organization needs an administrator to approve this app, send your administrator this approval link: ${APPROVAL_LINK} After they approve, connect again.`,
    retryable: true,
  },
});

type Begin = Parameters<ConnectTransport["begin"]>[1];

function transportFor(current: ConnectAttempt, catalog: ConnectProvider[] = []) {
  const begun: Begin[] = [];
  const fresh = attemptFor({
    id: "attempt-2",
    revision: 1,
    state: "requires_user_action",
    nextAction: { type: "authorize", url: SIGN_IN },
  });
  const transport: ConnectTransport = {
    catalog: async () => catalog,
    accounts: async () => [],
    pending: async () => [],
    begin: async (_workspace, input) => {
      begun.push(input);
      return fresh;
    },
    get: async () => current,
    advance: async () => current,
    cancel: async () => current,
    disconnect: async () => {},
  };
  return { transport, begun };
}

let mounted: RenderedComponent | null = null;
let controller: ConnectController | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  controller?.dispose();
  controller = null;
});

async function renderPanel(
  current: ConnectAttempt,
  props: { finishInPopup?: boolean; onRetry?: () => void } = {},
) {
  const { transport, begun } = transportFor(current);
  controller = new ConnectController(transport, "workspace");
  await controller.recover(current.id);
  mounted = await renderComponent(
    <ConnectPanel
      controller={controller}
      returnUrl="https://host.example/settings"
      onAuthorize={() => {}}
      {...props}
    />,
  );
  return { begun };
}

const text = () => mounted!.container.textContent ?? "";
const button = (label: string) =>
  [...mounted!.container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
const chooserShown = () =>
  mounted!.container.querySelector('[aria-label="Choose a connection"]') !== null;

describe("ConnectPanel after a sign-in an organization stopped", () => {
  test("a cancel stored with the approval link keeps the organization approval help up", async () => {
    await renderPanel(leftApprovalPage);
    expect(chooserShown()).toBe(false);
    expect(mounted!.container.querySelector('[aria-label="Connection setup"]')).not.toBeNull();
    const help = mounted!.container.querySelector(".og-connect-setup-approval");
    expect(help?.getAttribute("data-reason")).toBe("possible");
    expect(text()).toContain("Microsoft didn't give access");
    expect(text()).toContain("Copy message for IT");
    // The message for IT carries the all-services approval link.
    const message = mounted!.container.querySelector(".og-connect-setup-approval-message p");
    expect(message?.textContent).toContain(APPROVAL_LINK);
    const open = mounted!.container.querySelector<HTMLAnchorElement>(
      ".og-connect-setup-approval a",
    );
    expect(open?.href).toBe(APPROVAL_LINK);
    // Not an error line: the help is the whole step.
    expect(mounted!.container.querySelector('[role="alert"]')).toBeNull();
  });

  test("a refusal that requires an administrator shows the same help", async () => {
    await renderPanel(
      attemptFor({
        state: "failed",
        error: {
          code: "admin_consent_required",
          message: `Your organization requires a Microsoft 365 administrator to approve this app first. Send your administrator this approval link: ${APPROVAL_LINK} After they approve, connect again.`,
          retryable: true,
        },
      }),
    );
    const help = mounted!.container.querySelector(".og-connect-setup-approval");
    expect(help?.getAttribute("data-reason")).toBe("required");
    expect(chooserShown()).toBe(false);
    expect(button("Back to connections")).toBeDefined();
  });

  test("the person can put the help away and go back to the services", async () => {
    await renderPanel(leftApprovalPage);
    await act(async () => button("Back to connections")!.click());
    expect(mounted!.container.querySelector(".og-connect-setup-approval")).toBeNull();
    expect(chooserShown()).toBe(true);
  });

  test("trying again starts a fresh sign-in for the same service, in the popup when asked", async () => {
    const { begun } = await renderPanel(leftApprovalPage, { finishInPopup: true });
    await act(async () => {
      button("Try signing in again")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(begun).toHaveLength(1);
    expect(begun[0]).toMatchObject({
      providerId: "microsoft-outlook-mail",
      ownership: "personal",
      returnUrl: "https://host.example/settings",
      finishInPopup: true,
    });
    // The new attempt's sign-in step replaces the help.
    expect(mounted!.container.querySelector(".og-connect-setup-approval")).toBeNull();
    expect(text()).toContain("Authorize your account");
  });

  test("a host's own retry wins", async () => {
    let retried = 0;
    const { begun } = await renderPanel(leftApprovalPage, { onRetry: () => void retried++ });
    await act(async () => button("Try signing in again")!.click());
    expect(retried).toBe(1);
    expect(begun).toHaveLength(0);
  });

  test("a plain cancel without an approval requirement closes quietly", async () => {
    for (const plain of [
      // A provider's consent screen Cancel (Google, Slack, ...).
      attemptFor({
        providerId: "gmail",
        error: {
          code: "provider_denied",
          message: "Authorization was not completed. Start a new connection attempt.",
          retryable: false,
        },
      }),
      // Stopped from this side.
      attemptFor(),
      attemptFor({ state: "expired" }),
    ]) {
      await renderPanel(plain);
      expect(chooserShown()).toBe(true);
      expect(mounted!.container.querySelector(".og-connect-setup-approval")).toBeNull();
      expect(button("Back to connections")).toBeUndefined();
      await mounted!.unmount();
      mounted = null;
      controller!.dispose();
      controller = null;
    }
  });
});

test("a chooser for a popup sign-in asks for the closing page", async () => {
  const { transport, begun } = transportFor(leftApprovalPage, [
    {
      id: "microsoft-outlook-mail",
      label: "Outlook Mail",
      family: "microsoft",
      readiness: "available",
      ownership: ["personal"],
      setup: ["oauth"],
    } as ConnectProvider,
  ]);
  controller = new ConnectController(transport, "workspace");
  for (const finishInPopup of [true, false]) {
    mounted = await renderComponent(
      <ConnectChooser
        controller={controller}
        returnUrl="https://host.example/settings"
        initialProviderId="microsoft-outlook-mail"
        finishInPopup={finishInPopup}
      />,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {
      mounted!.container.querySelector("form")!.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await mounted.unmount();
    mounted = null;
  }
  expect(begun).toHaveLength(2);
  expect(begun[0]).toMatchObject({
    returnUrl: "https://host.example/settings",
    finishInPopup: true,
  });
  expect(begun[1]).not.toHaveProperty("finishInPopup");
});

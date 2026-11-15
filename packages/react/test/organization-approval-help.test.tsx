import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import {
  ConnectController,
  ConnectPopupClosedError,
  type ConnectAttempt,
  type ConnectTransport,
} from "@opengeni/connect";
import { ConnectSetup } from "../src/connect";
import type { ConnectAttemptHints } from "../src/connect-window-host";
import {
  forgetSignIn,
  rememberSignIn,
  signInNeverReturned,
  unreturnedSignIn,
} from "../src/connect-sign-in-memory";
import { OpenGeniMessagesProvider } from "../src/messages/runtime";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const MICROSOFT_SIGN_IN =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=app-1" +
  "&redirect_uri=https%3A%2F%2Fapi.example.com%2Fv1%2Fintegrations%2Fprovider-oauth%2Fcallback" +
  "&scope=offline_access%20User.Read%20Mail.ReadWrite&state=signed-state";

function attemptFor(overrides: Partial<ConnectAttempt> = {}): ConnectAttempt {
  return {
    id: "attempt-1",
    workspaceId: "workspace",
    providerId: "microsoft-outlook-mail",
    ownership: "personal",
    revision: 1,
    state: "requires_user_action",
    nextAction: { type: "authorize", url: MICROSOFT_SIGN_IN },
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    expiresAt: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

function memoryStore(): ConnectAttemptHints & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: (key) => values.get(key) ?? null,
    remember: (key, value) => void values.set(key, value),
    forget: (key) => void values.delete(key),
  };
}

function transportFor(
  attempts: Record<string, ConnectAttempt | { status: number }>,
  current: ConnectAttempt,
): ConnectTransport {
  return {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => current,
    get: async (_workspace, id) => {
      const found = attempts[id] ?? current;
      if ("status" in found && !("id" in found)) throw Object.assign(new Error("gone"), found);
      return found as ConnectAttempt;
    },
    advance: async () => current,
    cancel: async () => current,
    disconnect: async () => {},
  };
}

describe("sign-ins the person never came back from", () => {
  test("only sign-ins an organization can block are remembered", () => {
    const memory = memoryStore();
    rememberSignIn(
      memory,
      attemptFor({ nextAction: { type: "authorize", url: "https://provider.example/authorize" } }),
    );
    expect(memory.values.size).toBe(0);
    rememberSignIn(memory, attemptFor());
    const stored = JSON.parse([...memory.values.values()][0]!);
    expect(stored.attemptId).toBe("attempt-1");
    expect(stored.approval.appId).toBe("app-1");
    // Only public approval details: never the sign-in's signed state.
    expect([...memory.values.values()][0]).not.toContain("signed-state");
  });

  test("the remembered approval covers every service the server's link names", async () => {
    const everyService =
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=app-1" +
      "&scope=https%3A%2F%2Fgraph.microsoft.com%2FMail.ReadWrite+https%3A%2F%2Fgraph.microsoft.com%2FCalendars.ReadWrite" +
      "&redirect_uri=https%3A%2F%2Fapi.example.com%2Fv1%2Fintegrations%2Fprovider-oauth%2Fcallback" +
      "&state=microsoft_admin_consent";
    const memory = memoryStore();
    const started = attemptFor({
      nextAction: {
        type: "authorize",
        url: MICROSOFT_SIGN_IN,
        organizationApprovalUrl: everyService,
      },
    });
    rememberSignIn(memory, started);
    const expired = attemptFor({ state: "expired", nextAction: { type: "none" } });
    const approval = await unreturnedSignIn(
      memory,
      transportFor({ "attempt-1": expired }, expired),
      "workspace",
      "microsoft-outlook-mail",
    );
    expect(approval?.approvalUrl).toBe(everyService);
  });

  test("an attempt still waiting, expired or stopped from this side never came back", async () => {
    for (const state of ["requires_user_action", "expired", "cancelled"] as const) {
      const memory = memoryStore();
      rememberSignIn(memory, attemptFor());
      const earlier = attemptFor({
        state,
        ...(state === "requires_user_action" ? {} : { nextAction: { type: "none" } }),
      });
      expect(signInNeverReturned(earlier)).toBe(true);
      const approval = await unreturnedSignIn(
        memory,
        transportFor({ "attempt-1": earlier }, earlier),
        "workspace",
        "microsoft-outlook-mail",
      );
      expect(approval?.appId, state).toBe("app-1");
      expect(approval?.approvalUrl, state).toContain("/organizations/v2.0/adminconsent");
      expect(memory.values.size, state).toBe(1);
    }
  });

  test("a sign-in that came back, or is gone, is forgotten", async () => {
    const returned: ConnectAttempt[] = [
      attemptFor({ state: "complete", nextAction: { type: "none" } }),
      attemptFor({
        state: "failed",
        nextAction: { type: "none" },
        error: { code: "admin_consent_required", message: "Approve", retryable: true },
      }),
    ];
    for (const attempt of returned) {
      const memory = memoryStore();
      rememberSignIn(memory, attemptFor());
      expect(
        await unreturnedSignIn(
          memory,
          transportFor({ "attempt-1": attempt }, attempt),
          "workspace",
          "microsoft-outlook-mail",
        ),
      ).toBeNull();
      expect(memory.values.size, attempt.state).toBe(0);
    }
    for (const status of [404, 403]) {
      const memory = memoryStore();
      rememberSignIn(memory, attemptFor());
      expect(
        await unreturnedSignIn(
          memory,
          transportFor({ "attempt-1": { status } }, attemptFor()),
          "workspace",
          "microsoft-outlook-mail",
        ),
      ).toBeNull();
      expect(memory.values.size, String(status)).toBe(0);
    }
    // A passing failure keeps the memory for the next visit.
    const memory = memoryStore();
    rememberSignIn(memory, attemptFor());
    expect(
      await unreturnedSignIn(
        memory,
        transportFor({ "attempt-1": { status: 503 } }, attemptFor()),
        "workspace",
        "microsoft-outlook-mail",
      ),
    ).toBeNull();
    expect(memory.values.size).toBe(1);
    forgetSignIn(memory, attemptFor({ id: "another-attempt" }));
    expect(memory.values.size).toBe(1);
    forgetSignIn(memory, attemptFor());
    expect(memory.values.size).toBe(0);
  });

  test("a month-old sign-in no longer explains a visit", async () => {
    const memory = memoryStore();
    rememberSignIn(memory, attemptFor());
    const [key, raw] = [...memory.values.entries()][0]!;
    memory.values.set(
      key,
      JSON.stringify({ ...JSON.parse(raw), startedAt: Date.now() - 31 * 24 * 60 * 60_000 }),
    );
    const expired = attemptFor({ state: "expired", nextAction: { type: "none" } });
    expect(
      await unreturnedSignIn(
        memory,
        transportFor({ "attempt-1": expired }, expired),
        "workspace",
        "microsoft-outlook-mail",
      ),
    ).toBeNull();
    expect(memory.values.size).toBe(0);
  });
});

describe("organization approval help in Connect setup", () => {
  let mounted: RenderedComponent | null = null;
  beforeEach(() => localStorage.clear());
  afterEach(async () => {
    const current = mounted;
    mounted = null;
    await current?.unmount();
    localStorage.clear();
  });

  const text = () => mounted!.container.textContent ?? "";
  const buttons = () => [...mounted!.container.querySelectorAll("button")];
  const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

  test("closing a work sign-in offers the message for IT and the approval link", async () => {
    const attempt = attemptFor();
    const controller = new ConnectController(transportFor({}, attempt), "workspace");
    await controller.recover(attempt.id);
    mounted = await renderComponent(
      <ConnectSetup
        controller={controller}
        serviceName="Outlook Mail"
        authorizeLabel="Sign in"
        onAuthorize={() => Promise.reject(new ConnectPopupClosedError())}
      />,
    );
    expect(text()).not.toContain("Didn't get to finish signing in?");
    await act(async () => {
      buttons()
        .find((button) => button.textContent?.includes("Sign in"))!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text()).toContain("Didn't get to finish signing in?");
    // The note says it all; the plain "window closed" line would repeat it.
    expect(text()).not.toContain("Sign-in window closed");
    const message = mounted.container.querySelector(".og-connect-setup-approval-message p");
    expect(message?.textContent).toContain("connect Outlook Mail to Opengeni");
    expect(message?.textContent).toContain(
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=app-1",
    );
    expect(message?.textContent).not.toContain("signed-state");
    const labels = buttons().map((button) => button.textContent);
    expect(labels).toContain("Copy message for IT");
    expect(labels).toContain("Copy approval link");
    const open = mounted.container.querySelector<HTMLAnchorElement>(
      ".og-connect-setup-approval-note a",
    );
    expect(open?.target).toBe("_blank");
    expect(open?.rel).toContain("noopener");
    // Signing in again is still the main way forward.
    expect(labels.some((label) => label?.includes("Try signing in again"))).toBe(true);
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    controller.dispose();
  });

  test("other providers keep the plain closed-window line", async () => {
    const attempt = attemptFor({
      nextAction: { type: "authorize", url: "https://provider.example/authorize?client_id=x" },
    });
    const controller = new ConnectController(transportFor({}, attempt), "workspace");
    await controller.recover(attempt.id);
    mounted = await renderComponent(
      <ConnectSetup
        controller={controller}
        authorizeLabel="Sign in"
        onAuthorize={() => Promise.reject(new ConnectPopupClosedError())}
      />,
    );
    await act(async () => {
      buttons()
        .find((button) => button.textContent?.includes("Sign in"))!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text()).toContain("Sign-in window closed");
    expect(text()).not.toContain("Didn't get to finish signing in?");
    controller.dispose();
  });

  test("the next visit after a sign-in that never came back offers the help before signing in", async () => {
    // Last time: sent to Microsoft, then the tab was closed on its approval page.
    const earlier = attemptFor({ id: "earlier" });
    rememberSignIn(
      {
        read: (key) => localStorage.getItem(key),
        remember: (key, value) => localStorage.setItem(key, value),
        forget: (key) => localStorage.removeItem(key),
      },
      earlier,
    );
    const now = attemptFor({ id: "now" });
    const controller = new ConnectController(
      transportFor(
        { earlier: { ...earlier, state: "expired", nextAction: { type: "none" } } },
        now,
      ),
      "workspace",
    );
    await controller.recover(now.id);
    mounted = await renderComponent(
      <ConnectSetup
        controller={controller}
        serviceName="Outlook Mail"
        authorizeLabel="Sign in"
        onAuthorize={async () => {}}
      />,
    );
    await settle();
    expect(text()).toContain("Didn't get to finish signing in?");
    expect(buttons().map((button) => button.textContent)).toContain("Copy message for IT");
    // The sign-in itself stays available.
    expect(buttons().some((button) => button.textContent?.includes("Sign in"))).toBe(true);
    controller.dispose();
  });

  test("a consent error asks IT in the host's own words", async () => {
    const link =
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=app-1&state=microsoft_admin_consent";
    const attempt = attemptFor({
      state: "failed",
      nextAction: { type: "none" },
      error: {
        code: "admin_consent_required",
        message: `Your organization requires a Microsoft 365 administrator to approve this app first. Send your administrator this approval link: ${link} After they approve, connect again.`,
        retryable: true,
      },
    });
    const controller = new ConnectController(transportFor({}, attempt), "workspace");
    await controller.recover(attempt.id);
    mounted = await renderComponent(
      <OpenGeniMessagesProvider
        productName="Acme"
        messages={{
          "connectSetup.organizationApprovalRequiredTitle": "IT må godkjenne {product} først",
          "connectSetup.copyMessageForIt": "Kopier melding til IT",
          "connectSetup.itMessageWithLink":
            "Hei! Kan du godkjenne {product} for {service}? Lenke: {link}",
        }}
      >
        <ConnectSetup
          controller={controller}
          serviceName="Outlook Mail"
          authorizeLabel="Sign in"
          onAuthorize={async () => {}}
        />
      </OpenGeniMessagesProvider>,
    );
    expect(text()).toContain("IT må godkjenne Acme først");
    expect(buttons().map((button) => button.textContent)).toContain("Kopier melding til IT");
    expect(
      mounted.container.querySelector(".og-connect-setup-approval-message p")?.textContent,
    ).toBe(`Hei! Kan du godkjenne Acme for Outlook Mail? Lenke: ${link}`);
    // Keys the host left alone stay in English.
    expect(buttons().map((button) => button.textContent)).toContain("Copy approval link");
    controller.dispose();
  });
});

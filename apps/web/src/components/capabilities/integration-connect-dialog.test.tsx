import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { IntegrationConnectRequest } from "./integration-connect-dialog";
import type { IntegrationDefinitionSummary } from "@/types";

let IntegrationConnectDialog: typeof import("./integration-connect-dialog").IntegrationConnectDialog;
let integrationConnectFocusTarget: typeof import("./integration-connect-dialog").integrationConnectFocusTarget;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ IntegrationConnectDialog, integrationConnectFocusTarget } =
    await import("./integration-connect-dialog"));
});

afterAll(() => GlobalRegistrator.unregister());

describe("integration connection dialog", () => {
  test("uses an accessible stepped review and keeps OAuth scopes progressive", async () => {
    const requests: IntegrationConnectRequest[] = [];
    const rendered = await render(
      <IntegrationConnectDialog
        open
        definition={gmailDefinition()}
        initialAccountLabel="Gmail — Account 2"
        canConnectPersonal
        canConnectWorkspace
        onOpenChange={() => {}}
        onConnect={async (request) => {
          requests.push(request);
        }}
      />,
    );
    try {
      const dialog = requiredElement<HTMLElement>('[role="dialog"]');
      expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
      expect(dialog.textContent).toContain("Name the account and choose who can use it");
      expect(requiredElement<HTMLInputElement>('input[value="personal"]').checked).toBe(true);
      expect(requiredElement<HTMLElement>('[aria-current="step"]').textContent).toContain(
        "Account",
      );

      await clickButton("Continue");
      expect(dialog.textContent).toContain("Find and understand mail");
      expect(dialog.textContent).toContain("Work with your Gmail mailbox");
      const details = requiredElement<HTMLDetailsElement>("details");
      expect(details.open).toBe(false);
      expect(details.textContent).toContain("https://mail.google.com/");

      await clickButton("Continue");
      expect(dialog.textContent).toContain("Review the connection");
      expect(dialog.textContent).toContain("Gmail — Account 2");
      expect(dialog.textContent).toContain("Personal — usable only through your delegated");
      await clickButton("Back");
      expect(dialog.textContent).toContain("What agents can do");
      await act(async () => {
        requiredElement<HTMLButtonElement>("ol button").click();
        await Promise.resolve();
      });
      expect(dialog.textContent).toContain("Name the account and choose who can use it");
      expect(requests).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("shows administrator remediation when both ownership choices are unavailable", async () => {
    const rendered = await render(
      <IntegrationConnectDialog
        open
        definition={gmailDefinition()}
        initialAccountLabel="Gmail"
        canConnectPersonal={false}
        canConnectWorkspace={false}
        onOpenChange={() => {}}
        onConnect={async () => {}}
      />,
    );
    try {
      expect(document.body.textContent).toContain("Administrator setup is required");
      expect(document.body.textContent).toContain("close this guide without changing anything");
      expect(requiredElement<HTMLInputElement>('input[value="personal"]').disabled).toBe(true);
      expect(requiredElement<HTMLInputElement>('input[value="workspace"]').disabled).toBe(true);
      expect(button("Continue").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("retries a failed start with the same reviewed request and a safe error", async () => {
    const requests: IntegrationConnectRequest[] = [];
    let attempt = 0;
    const rendered = await render(
      <IntegrationConnectDialog
        open
        definition={gmailDefinition()}
        initialAccountLabel="Gmail — Finance"
        canConnectPersonal
        canConnectWorkspace
        onOpenChange={() => {}}
        onConnect={async (request) => {
          requests.push(request);
          attempt += 1;
          if (attempt === 1) throw new Error("provider body containing credential-shaped data");
        }}
      />,
    );
    try {
      await clickButton("Continue");
      await clickButton("Continue");
      await clickButton("Continue to Google");
      const alert = requiredElement<HTMLElement>('[role="alert"]');
      expect(alert.textContent).toContain("Check your network and try again");
      expect(alert.textContent).not.toContain("provider body");
      expect(button("Try again").disabled).toBe(false);

      await clickButton("Try again");
      expect(document.body.textContent).toContain("Opening Google");
      expect(requests).toEqual([
        { accountLabel: "Gmail — Finance", ownership: "personal" },
        { accountLabel: "Gmail — Finance", ownership: "personal" },
      ]);
    } finally {
      await rendered.unmount();
    }
  });

  test("prefers the exact opening trigger and falls back only when it is gone", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    document.body.append(trigger, fallback);
    expect(integrationConnectFocusTarget(trigger, fallback)).toBe(trigger);
    trigger.remove();
    expect(integrationConnectFocusTarget(trigger, fallback)).toBe(fallback);
    fallback.remove();
    expect(integrationConnectFocusTarget(trigger, fallback)).toBeNull();
  });
});

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return {
    unmount: async () => {
      await act(async () => root.unmount());
      document.body.replaceChildren();
    },
  };
}

async function clickButton(name: string) {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return match;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as T;
}

function gmailDefinition(): IntegrationDefinitionSummary {
  return {
    id: "google-gmail",
    name: "Gmail",
    summary: "Gmail messages, labels, drafts, and delivery.",
    protocol: "openapi",
    provider: { id: "google", domain: "gmail.googleapis.com" },
    authentication: {
      kind: "oauth2",
      scopes: ["openid", "email", "profile", "https://mail.google.com/"],
    },
    // Mirrors the reviewed copy the definitions endpoint serves for
    // google-gmail (INTEGRATION_DEFINITION_PRESENTATIONS in
    // @opengeni/capabilities); the dialog itself has no hardcoded copy.
    presentation: {
      providerName: "Google",
      icon: "mail",
      introduction: "Let agents work with the Gmail account you choose.",
      capabilities: [
        {
          title: "Find and understand mail",
          description: "Search messages and threads, then use them as context for your work.",
        },
        {
          title: "Draft and send messages",
          description: "Prepare replies and send mail through the reviewed Gmail tools.",
        },
      ],
      permissionSummary:
        "Google grants broad mailbox access. OpenGeni still exposes only the reviewed tools configured for this integration.",
      scopeLabels: {
        "https://mail.google.com/": {
          label: "Work with your Gmail mailbox",
          description: "Read, organize, draft, and send mail for the account you approve.",
        },
      },
    },
    facets: [],
  };
}

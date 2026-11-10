import { expect, test } from "bun:test";
import type { OpenGeniClient } from "@opengeni/sdk";
import {
  ConnectController,
  type ConnectAttempt,
  type ConnectProvider,
  type ConnectTransport,
} from "@opengeni/connect";
import { ConnectAccountIdentity } from "../src/connect-account-identity";
import { ConnectPanel } from "../src/connect-panel";
import { connectionServicePresentation } from "../src/connection-service-presentation";
import {
  createOpenGeniText,
  OpenGeniMessagesProvider,
  type OpenGeniMessages,
} from "../src/messages/runtime";
import { actRun, registerDom, renderComponent } from "./render-hook";

registerDom();

// One host override, in the host's own language.
const NORWEGIAN: OpenGeniMessages = {
  "connectService.microsoft-outlook-calendar.name": "Outlook-kalender",
  "connectService.microsoft-outlook-calendar.description":
    "Kan se kalenderen din og legge inn avtaler",
};

const outlookCalendar: ConnectProvider = {
  id: "microsoft-outlook-calendar",
  label: "Outlook Calendar",
  family: "microsoft",
  readiness: "available",
  ownership: ["personal"],
  setup: ["oauth"],
};

const APPROVAL =
  "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=app-1&scope=offline_access";

function attempt(overrides: Partial<ConnectAttempt>): ConnectAttempt {
  return {
    id: "attempt-1",
    workspaceId: "workspace",
    providerId: "microsoft-outlook-calendar",
    ownership: "personal",
    revision: 1,
    state: "requires_user_action",
    nextAction: { type: "authorize", url: "https://provider.example/authorize" },
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    expiresAt: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

async function renderPanel(begin: ConnectAttempt) {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected call");
  };
  const transport: ConnectTransport = {
    catalog: async () => [outlookCalendar],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => begin,
    get: async () => begin,
    advance: unexpected,
    cancel: unexpected,
    disconnect: unexpected,
  };
  const controller = new ConnectController(transport, "workspace");
  const client = {
    listCapabilities: async () => ({ items: [] }),
    listConnections: async () => [],
  } as unknown as OpenGeniClient;
  const view = await renderComponent(
    <OpenGeniMessagesProvider messages={NORWEGIAN}>
      <ConnectPanel
        client={client}
        controller={controller}
        returnUrl="https://host.example/connections"
        presentation="catalog"
        showProviderConnections
        showCustomConnections={false}
        onAuthorize={() => {}}
      />
    </OpenGeniMessagesProvider>,
  );
  return {
    view,
    async startSetup() {
      const row = [...view.container.querySelectorAll("button")].find((node) =>
        node.textContent?.includes("Outlook-kalender"),
      )!;
      expect(row).toBeTruthy();
      await actRun(() => row.click());
      await actRun(() =>
        view.container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    },
    async dispose() {
      await view.unmount();
      controller.dispose();
    },
  };
}

test("the host's service name and description show in discovery and the sign-in step", async () => {
  const panel = await renderPanel(attempt({}));
  try {
    const results = panel.view.container.querySelector(".og-connection-discovery-results")!;
    expect(results.textContent).toContain("Outlook-kalender");
    expect(results.textContent).toContain("Kan se kalenderen din og legge inn avtaler");
    expect(results.textContent).not.toContain("Outlook Calendar");
    await panel.startSetup();
    const continueButton = [...panel.view.container.querySelectorAll("button")].find(
      (node) => node.textContent === "Continue to Outlook-kalender",
    );
    expect(continueButton).toBeTruthy();
    expect(panel.view.container.textContent).not.toContain("Outlook Calendar");
  } finally {
    await panel.dispose();
  }
});

test("the host's service name is the one IT is asked to approve", async () => {
  const panel = await renderPanel(
    attempt({
      state: "failed",
      nextAction: { type: "none" },
      error: {
        code: "admin_consent_required",
        retryable: true,
        message: `An administrator must approve this app: ${APPROVAL}`,
      },
    }),
  );
  try {
    await panel.startSetup();
    const text = panel.view.container.textContent ?? "";
    expect(text).toContain("connect Outlook-kalender to Opengeni");
    expect(text).toContain(APPROVAL);
    expect(text).not.toContain("Outlook Calendar");
  } finally {
    await panel.dispose();
  }
});

test("a connected account and the chat card use the same host name", async () => {
  const view = await renderComponent(
    <OpenGeniMessagesProvider messages={NORWEGIAN}>
      <ConnectAccountIdentity
        account={{
          id: "credential",
          providerId: "microsoft-outlook-calendar",
          label: "person@example.test",
          ownership: "personal",
          status: "connected",
        }}
        capabilities={[]}
      />
    </OpenGeniMessagesProvider>,
  );
  try {
    expect(view.container.querySelector("strong")?.textContent).toBe("Outlook-kalender");
    expect(view.container.textContent).toContain("person@example.test");
  } finally {
    await view.unmount();
  }
  // The chat setup card reads its name from this presentation.
  const t = createOpenGeniText({ messages: NORWEGIAN });
  expect(connectionServicePresentation(outlookCalendar, t)).toMatchObject({
    name: "Outlook-kalender",
    description: "Kan se kalenderen din og legge inn avtaler",
  });
});

test("without host wording a service keeps its built-in name and no description", () => {
  expect(connectionServicePresentation(outlookCalendar, createOpenGeniText())).toMatchObject({
    name: "Outlook Calendar",
    description: null,
  });
  expect(
    connectionServicePresentation(
      { id: "fiken-oauth", label: "Fiken (OAuth)" },
      createOpenGeniText(),
    ).name,
  ).toBe("Fiken (OAuth)");
});

import { expect, test } from "bun:test";
import type { OpenGeniClient, CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { AdminStepUpHandler, AdminStepUpRequest } from "../src/admin-step-up";
import type { AppHost } from "../src/app/lib/app-host";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
registerDom();
const { McpConnectionCard } = await import("../src/components/session-mcp-capability-card");
const { AppHostProvider } = await import("../src/app/lib/app-host");

const MCP_URL = "https://service.example/mcp";

const off = {
  id: "custom-service",
  kind: "mcp",
  authKind: "oauth2",
  name: "Team tools",
  enabled: false,
  mcpUrl: MCP_URL,
  providerDomain: "service.example",
  connectionRef: null,
} as unknown as CapabilityCatalogItem;
const on = {
  ...off,
  enabled: true,
  connectionRef: { providerDomain: "service.example", kind: "oauth2", subjectScope: "subject" },
} as unknown as CapabilityCatalogItem;
const account = {
  id: "own-account",
  accountId: "organization",
  workspaceId: "workspace",
  providerDomain: "service.example",
  kind: "oauth2",
  status: "active",
  subjectId: "user:own",
  metadata: { mcpUrl: MCP_URL },
  version: 1,
} as unknown as ConnectionMetadata;

/** A card whose turning on is refused until a passkey step-up, then allowed. */
function stepUpClient(passkeyRegistered: boolean) {
  let committed = false;
  let enabled = false;
  const enables: string[] = [];
  const refuseUntil = { stepUp: true };
  const attempt = {
    id: "own-attempt",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "credentials", fields: [] },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const client = {
    listCapabilities: async () => ({ items: [enabled ? on : off] }),
    listConnections: async () => (committed ? [account] : []),
    listOwnConnectionAccounts: async () => (committed ? [account] : []),
    enableCapability: async (_workspace: string, capabilityId: string) => {
      enables.push(capabilityId);
      if (refuseUntil.stepUp)
        throw new OpenGeniApiError(
          403,
          JSON.stringify({
            error: {
              message: "Confirm it's you to change who has access.",
              details: { code: "ADMIN_PASSKEY_STEP_UP_REQUIRED", passkeyRegistered },
            },
          }),
          { mutation: true },
        );
      enabled = true;
      return on;
    },
    connectTransport: () => ({
      begin: async () => attempt,
      advance: async () => {
        committed = true;
        return {
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
          account: {
            id: account.id,
            providerId: "mcp-oauth",
            ownership: "personal",
            status: "connected",
            label: "Team tools",
            version: 1,
          },
        };
      },
    }),
  } as unknown as OpenGeniClient;
  return { client, enables, refuseUntil };
}

function host(parts: { adminStepUp?: AdminStepUpHandler; opened?: string[] }): AppHost {
  return {
    ...(parts.adminStepUp ? { adminStepUp: parts.adminStepUp } : {}),
    navigation: {
      page: { open: (url: string) => parts.opened?.push(url) },
    },
  } as unknown as AppHost;
}

function buttonNamed(label: string) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
}

async function connectUntilRefused(client: OpenGeniClient, appHost: AppHost) {
  sessionStorage.clear();
  const previousOpen = window.open;
  window.open = (() => ({
    opener: null,
    closed: false,
    location: { replace() {} },
    close() {},
  })) as unknown as typeof window.open;
  const view = await renderComponent(
    <AppHostProvider host={appHost}>
      <McpConnectionCard
        client={client}
        workspaceId="workspace"
        capabilityId={off.id}
        name="Team tools"
        returnUrl="https://host.example/"
        dialogOnly
        personalOnly
      />
    </AppHostProvider>,
  );
  await flush();
  await actRun(() => buttonNamed("Continue to Team tools")!.click());
  await flush();
  return {
    unmount: async () => {
      await view.unmount();
      window.open = previousOpen;
    },
  };
}

test("the host's step-up is the card's next action, and turning on resumes once confirmed", async () => {
  const { client, enables, refuseUntil } = stepUpClient(true);
  const asked: AdminStepUpRequest[] = [];
  const view = await connectUntilRefused(
    client,
    host({
      adminStepUp: async (request) => {
        asked.push(request);
        refuseUntil.stepUp = false;
        return true;
      },
    }),
  );
  try {
    expect(document.body.textContent).toContain(
      "Confirm it's you with your passkey to turn on Team tools.",
    );
    // No "connect again": the account is connected; confirming is the step.
    expect(document.body.textContent).not.toContain("then connect again");
    expect(buttonNamed("Continue to Team tools")).toBeUndefined();
    await actRun(() => buttonNamed("Confirm it's you")!.click());
    await flush();
    expect(asked).toEqual([{ passkeyRegistered: true }]);
    expect(enables).toEqual([off.id, off.id]);
    expect(document.body.textContent).not.toContain("to turn on Team tools");
    expect(buttonNamed("Confirm it's you")).toBeUndefined();
  } finally {
    await view.unmount();
  }
});

test("a host step-up that was cancelled keeps the step and offers Try again", async () => {
  const { client, enables, refuseUntil } = stepUpClient(true);
  let calls = 0;
  const view = await connectUntilRefused(
    client,
    host({
      adminStepUp: async () => {
        calls += 1;
        return false;
      },
    }),
  );
  try {
    await actRun(() => buttonNamed("Confirm it's you")!.click());
    await flush();
    expect(calls).toBe(1);
    expect(enables).toHaveLength(1);
    // Confirmed elsewhere meanwhile: Try again turns it on without asking again.
    refuseUntil.stepUp = false;
    await actRun(() => buttonNamed("Try again")!.click());
    await flush();
    expect(calls).toBe(1);
    expect(enables).toHaveLength(2);
    expect(document.body.textContent).not.toContain("to turn on Team tools");
  } finally {
    await view.unmount();
  }
});

test("by default an embedded card opens the Opengeni app's page for the step-up", async () => {
  for (const [registered, path, label] of [
    [false, "/settings/security", "Add a passkey"],
    [true, "/confirm-passkey", "Confirm it's you"],
  ] as const) {
    const { client, enables, refuseUntil } = stepUpClient(registered);
    const opened: string[] = [];
    const view = await connectUntilRefused(client, host({ opened }));
    try {
      expect(document.body.textContent).toContain(
        registered
          ? "Confirm it's you with your passkey to turn on Team tools."
          : "Add a passkey to your account to turn on Team tools.",
      );
      await actRun(() => buttonNamed(label)!.click());
      await flush();
      expect(opened).toEqual([path]);
      expect(enables).toHaveLength(1);
      refuseUntil.stepUp = false;
      await actRun(() => buttonNamed("Try again")!.click());
      await flush();
      expect(opened).toHaveLength(1);
      expect(enables).toHaveLength(2);
      expect(document.body.textContent).not.toContain("to turn on Team tools");
    } finally {
      await view.unmount();
    }
  }
});

test("a step-up that didn't reach this session falls back to the plain message, not a loop", async () => {
  const { client, enables } = stepUpClient(true);
  const opened: string[] = [];
  const view = await connectUntilRefused(client, host({ opened }));
  try {
    await actRun(() => buttonNamed("Confirm it's you")!.click());
    await flush();
    expect(opened).toEqual(["/confirm-passkey"]);
    // Still refused after the page: the card doesn't offer the page again.
    await actRun(() => buttonNamed("Try again")!.click());
    await flush();
    expect(enables).toHaveLength(2);
    expect(buttonNamed("Confirm it's you")).toBeUndefined();
    expect(document.body.textContent).toContain(
      "Confirm it's you with your passkey to turn on Team tools, then connect again.",
    );
    expect(buttonNamed("Try again")).toBeDefined();
    await actRun(() => buttonNamed("Try again")!.click());
    await flush();
    expect(opened).toHaveLength(1);
    expect(enables).toHaveLength(3);
  } finally {
    await view.unmount();
  }
});

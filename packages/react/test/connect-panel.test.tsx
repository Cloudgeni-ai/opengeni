import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectController, type ConnectAttempt, type ConnectTransport } from "@opengeni/connect";
import { ConnectPanel } from "../src/connect-panel";

async function render(state: ConnectAttempt["state"], title?: string | null) {
  const attempt: ConnectAttempt = {
    id: "attempt",
    workspaceId: "workspace",
    providerId: "provider",
    ownership: "personal",
    revision: 1,
    state,
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    expiresAt: "2030-01-01T00:00:00Z",
    nextAction: { type: "authorize", url: "https://provider.example/authorize" },
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
  await controller.recover(attempt.id);
  try {
    return renderToStaticMarkup(
      <ConnectPanel
        controller={controller}
        returnUrl="https://host.example/settings"
        onAuthorize={() => {}}
        {...(title === undefined ? {} : { title })}
      />,
    );
  } finally {
    controller.dispose();
  }
}

test("active and uncertain setup keep recovery visible without competing new-setup forms", async () => {
  for (const state of ["requires_user_action", "provider_wait", "uncertain", "failed"] as const) {
    const html = await render(state);
    expect(html).toContain('aria-label="Connection setup"');
    expect(html).not.toContain('aria-label="Choose a connection"');
    expect(html).not.toContain("Reload accounts");
  }
});

test("terminal setup restores acquisition and account management", async () => {
  for (const state of ["complete", "cancelled", "expired"] as const) {
    const html = await render(state);
    expect(html).toContain('aria-label="Choose a connection"');
    expect(html).toContain("Reload accounts");
  }
});

test("host may explicitly omit the panel heading", async () => {
  expect(await render("requires_user_action", null)).not.toContain("<h2>");
  expect(await render("requires_user_action", "Linked accounts")).toContain(
    "<h2>Linked accounts</h2>",
  );
});

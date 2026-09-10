import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectController, type ConnectAttempt, type ConnectTransport } from "@opengeni/connect";
import { ConnectSetup } from "../src/connect";

async function render(
  nextAction: ConnectAttempt["nextAction"],
  state: ConnectAttempt["state"] = "requires_user_action",
) {
  const attempt: ConnectAttempt = {
    id: "attempt",
    workspaceId: "workspace",
    providerId: "provider",
    ownership: "personal",
    revision: 1,
    state,
    nextAction,
    credentialsCommitted: state === "complete",
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
  try {
    return renderToStaticMarkup(<ConnectSetup controller={controller} onAuthorize={() => {}} />);
  } finally {
    controller.dispose();
  }
}

test("device verification has an isolated HTTPS link and retains the provider code", async () => {
  const html = await render(
    {
      type: "wait",
      pollAfterMs: 1000,
      userCode: "ABCD-EFGH",
      verificationUrl: "https://provider.example/verify?flow=device",
    },
    "provider_wait",
  );
  expect(html).toContain("ABCD-EFGH");
  expect(html).toContain('href="https://provider.example/verify?flow=device"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("Check status");
});

test("device verification does not render unsafe or credential-bearing destinations", async () => {
  for (const verificationUrl of [
    "javascript:alert(1)",
    "http://provider.example/verify",
    "https://user:secret@provider.example/verify",
    "invalid",
  ]) {
    const html = await render(
      { type: "wait", pollAfterMs: 1000, verificationUrl },
      "provider_wait",
    );
    expect(html).not.toContain("href=");
    expect(html).not.toContain(verificationUrl);
  }
});

test("credential fields use labels, required validation and password inputs without secret values", async () => {
  const html = await render({
    type: "credentials",
    fields: [{ name: "api_key", label: "API key", required: true, secret: true }],
  });
  expect(html).toContain("Ownership: Personal");
  expect(html).toContain('type="password"');
  expect(html).toContain("required");
  expect(html).toContain("API key");
  expect(html).not.toContain('value="');
});
test("duplicate account labels retain explicit identities and disabled accounts cannot be selected", async () => {
  const html = await render({
    type: "select_account",
    accounts: [
      {
        id: "first",
        providerId: "provider",
        label: "Same name",
        ownership: "personal",
        status: "connected",
      },
      {
        id: "second",
        providerId: "provider",
        label: "Same name",
        ownership: "workspace",
        status: "disabled",
      },
    ],
  });
  expect(html).toContain("Same name — first (personal)");
  expect(html).toContain("Same name — second (workspace)");
  expect(html).toContain('value="second" disabled');
  expect(html).toContain("Choose an account");
});
test("completed setup has no authorization, cancel or install controls", async () => {
  const html = await render({ type: "none" }, "complete");
  expect(html).toContain("Connection ready");
  expect(html).not.toContain("<button");
});
test("preview does not silently preselect operations", async () => {
  const html = await render(
    {
      type: "preview",
      previewId: "preview",
      contentHash: "hash",
      operations: [{ id: "write", label: "Write records", kind: "mutation" }],
    },
    "preview",
  );
  expect(html).toContain("Install selected operations");
  expect(html).toContain("Write records");
  expect(html).not.toContain("checked");
});

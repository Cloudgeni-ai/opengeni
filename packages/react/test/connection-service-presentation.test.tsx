import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";
import { ConnectController, type ConnectProvider, type ConnectTransport } from "@opengeni/connect";
import { ConnectAccountIdentity } from "../src/connect-account-identity";
import { ConnectPanel } from "../src/connect-panel";
import { actRun, registerDom, renderComponent } from "./render-hook";
registerDom();
const gmail = {
  id: "gmail-catalog",
  name: "Gmail",
  kind: "mcp",
  authKind: "oauth2",
  mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
} as CapabilityCatalogItem;
const account = {
  id: "personal-credential",
  providerId: "gmail",
  label: "gmailmcp.googleapis.com",
  ownership: "personal",
  status: "connected",
} as const;

test("personal Gmail keeps service name and brand without an installation binding", () => {
  const html = renderToStaticMarkup(
    <ConnectAccountIdentity account={account} capabilities={[gmail]} />,
  );
  expect(html).toContain("<strong>Gmail</strong>");
  expect(html).toContain("gmail.ico");
  expect(html).toContain("Only you");
});
test("known service branding survives missing catalog metadata", () => {
  const html = renderToStaticMarkup(
    <ConnectAccountIdentity
      account={{ ...account, providerId: "microsoft-outlook-mail", label: "person@example.test" }}
      capabilities={[]}
    />,
  );
  expect(html).toContain("<strong>Outlook Mail</strong>");
  expect(html).toContain("outlook.ico");
  expect(html).toContain("person@example.test");
});

test("one search includes Outlook and deduplicates Gmail; selecting Outlook preserves ownership choice", async () => {
  const providers: ConnectProvider[] = [
    {
      id: "gmail",
      label: "Gmail",
      family: "google",
      readiness: "available",
      ownership: ["workspace", "personal"],
      setup: ["oauth"],
    },
    {
      id: "microsoft-outlook-mail",
      label: "Outlook Mail",
      family: "microsoft",
      readiness: "available",
      ownership: ["workspace", "personal"],
      setup: ["oauth"],
    },
  ];
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected mutation");
  };
  const transport: ConnectTransport = {
    catalog: async () => providers,
    accounts: async () => [account],
    pending: async () => [],
    begin: unexpected,
    advance: unexpected,
    get: unexpected,
    cancel: unexpected,
    disconnect: unexpected,
  };
  const controller = new ConnectController(transport, "workspace");
  const client = {
    listCapabilities: async () => ({ items: [gmail] }),
    listConnections: async () => [],
  } as unknown as OpenGeniClient;
  const view = await renderComponent(
    <ConnectPanel
      client={client}
      controller={controller}
      returnUrl="https://host.example/connections"
      presentation="catalog"
      showProviderConnections
      showCustomConnections={false}
      onAuthorize={() => {}}
    />,
  );
  try {
    const results = view.container.querySelector(".og-connection-discovery-results")!;
    expect([...results.querySelectorAll("strong")].map((node) => node.textContent)).toEqual([
      "Outlook Mail",
      "Gmail",
    ]);
    const search = view.container.querySelector("input")!;
    await actRun(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(search, "Outlook");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(results.textContent).toContain("Outlook Mail");
    const row = [...results.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Outlook Mail"),
    )!;
    expect(row).toBeTruthy();
    await actRun(() => row.click());
    expect(view.container.textContent).toContain("Who can use this connection?");
    expect(view.container.textContent).not.toContain("Start setup");
    expect(
      view.container.querySelector("select:not([hidden])") ||
        view.container.querySelector("select"),
    ).toBeTruthy();
  } finally {
    await view.unmount();
    controller.dispose();
  }
});

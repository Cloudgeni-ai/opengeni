import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { analyticsClickEvent } from "@/components/analytics-consent";
import {
  ProviderConnectPage,
  ReplaceKeyDialog,
  type ProviderConnection,
} from "@/components/ai-gateway-connection";
import { SuperGrokConnectPage, type SuperGrokPlaces } from "./supergrok-models";

// Radix reads DOM availability before this isolated test installs Happy DOM.
// Keep replacement dialog content inspectable without exercising its portal.
mock.module("@/components/ui/form-dialog", () => ({
  FormDialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

// The click observer reads `data-analytics-action` only from a clickable
// control, so a provider connect label must sit on the Connect button itself.
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

const submitButton = () =>
  [...container.querySelectorAll("button")].find((button) => button.type === "submit")!;
const clickedAction = (element: Element) =>
  analyticsClickEvent(element, window.location.origin)?.properties.action;

test("the API-key provider Connect button carries the provider's connect label", async () => {
  for (const action of ["connect_ai_gateway", "connect_openrouter"] as const) {
    const state = {
      config: {
        title: "Provider",
        summary: "Use models through your provider account.",
        keyHelp: "Create one in the provider console.",
        keyAriaLabel: "Provider key",
        analyticsAction: action,
      },
      canManageConnection: true,
      saveKey: async () => true,
    } as unknown as ProviderConnection;
    await act(async () =>
      root.render(
        <ProviderConnectPage state={state} onClose={() => undefined} onConnected={() => {}} />,
      ),
    );
    expect(clickedAction(submitButton())).toBe(action);
    // A label on the key field would never be reported.
    expect(container.querySelector("input[data-analytics-action]")).toBeNull();
  }
});

test("the SuperGrok Connect button carries connect_supergrok until sign-in starts", async () => {
  const places: SuperGrokPlaces = {
    scopeName: "Local",
    organizationName: "Organization",
    openAccount: () => undefined,
    openConnect: () => undefined,
    openAccess: () => undefined,
    backToList: () => undefined,
  };
  const grok = (pending: { userCode: string; verificationUri: string } | null) =>
    ({
      organizationId: null,
      pending,
      canManage: true,
      busy: false,
      connect: async () => undefined,
    }) as unknown as Parameters<typeof SuperGrokConnectPage>[0]["grok"];

  await act(async () =>
    root.render(<SuperGrokConnectPage grok={grok(null)} places={places} onClose={() => {}} />),
  );
  expect(clickedAction(submitButton())).toBe("connect_supergrok");

  // "Open xAI again" reopens the same sign-in; it is not another connect.
  await act(async () =>
    root.render(
      <SuperGrokConnectPage
        grok={grok({ userCode: "CODE", verificationUri: "https://example.com/device" })}
        places={places}
        onClose={() => {}}
      />,
    ),
  );
  expect(submitButton().hasAttribute("data-analytics-action")).toBe(false);
});

test("Claude credentials use distinct accessible forms and explain subscription expiry", async () => {
  const { ORGANIZATION_PROVIDER_META } = await import("../organization-model-provider-connection");
  for (const kind of ["anthropic", "claude_subscription"] as const) {
    const config = ORGANIZATION_PROVIDER_META[kind];
    const state = {
      config,
      canManageConnection: true,
      saveKey: async () => true,
    } as unknown as ProviderConnection;
    await act(async () =>
      root.render(
        <ProviderConnectPage key={kind} state={state} onClose={() => {}} onConnected={() => {}} />,
      ),
    );
    const input = container.querySelector("input")!;
    expect(input.getAttribute("aria-label")).toBe(config.keyAriaLabel);
    expect(input.type).toBe("password");
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain(config.title);
    if (kind === "claude_subscription") {
      expect(container.textContent).toContain("claude setup-token");
      expect(container.textContent).toContain("does not refresh");
    }
  }
});

test("subscription replacement identifies the credential as a token", async () => {
  const { ORGANIZATION_PROVIDER_META } = await import("../organization-model-provider-connection");
  const state = {
    config: ORGANIZATION_PROVIDER_META.claude_subscription,
    saveKey: async () => true,
  } as unknown as ProviderConnection;
  await act(async () =>
    root.render(<ReplaceKeyDialog state={state} open onOpenChange={() => {}} />),
  );
  expect(document.body.textContent).toContain("Replace the Claude subscription token");
  expect(document.body.textContent).not.toContain("Replace the Claude subscription key");
  expect(
    document
      .querySelector('input[aria-label="Claude subscription setup token"]')
      ?.getAttribute("type"),
  ).toBe("password");
});

test("failed subscription rotation never treats another administrator's version as its receipt", async () => {
  const { useOrganizationProviderConnection } =
    await import("../organization-model-provider-connection");
  let version = 1;
  const sent: Array<{
    operationId: string;
    claudeIdentity?: { accountUuid: string; deviceId: string };
  }> = [];
  const client = {
    getOrganizationModelProviderConnection: async () => ({ status: "active", version }),
    listOrganizationProviderCustomModels: async () => ({ models: [] }),
    upsertOrganizationModelProviderConnection: async (
      _org: string,
      _kind: string,
      payload: (typeof sent)[number],
    ) => {
      sent.push(payload);
      version = 2;
      throw new Error("Connection changed concurrently");
    },
  } as unknown as Parameters<typeof useOrganizationProviderConnection>[0]["client"];
  let state!: ReturnType<typeof useOrganizationProviderConnection>;
  function Harness() {
    state = useOrganizationProviderConnection({
      client,
      organizationId: "org",
      providerKind: "claude_subscription",
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  let saved: boolean | undefined;
  const identity = {
    accountUuid: "10000000-0000-4000-8000-000000000001",
    deviceId: "a".repeat(64),
  };
  await act(async () => {
    saved = await state.saveKey("sk-ant-oat01-fixture", identity);
  });
  expect(saved).toBe(false);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.operationId).toBe(sent[1]!.operationId);
  expect(sent[0]!.claudeIdentity).toEqual(identity);
});

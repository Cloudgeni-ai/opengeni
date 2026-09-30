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
    const input = container.querySelector<HTMLInputElement>(
      `input[aria-label="${config.keyAriaLabel}"]`,
    )!;
    expect(input.getAttribute("aria-label")).toBe(config.keyAriaLabel);
    expect(input.type).toBe("password");
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain(config.title);
    if (kind === "claude_subscription") {
      expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.hidden).toBe(true);
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Create a Claude setup token"]')
          ?.value,
      ).toBe("claude setup-token");
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

test("Claude settings import extracts identifiers only and fails closed", async () => {
  const { parseClaudeSettings } = await import("./claude-setup");
  const identity = {
    accountUuid: "10000000-0000-4000-8000-000000000001",
    deviceId: "a".repeat(64),
  };
  expect(
    parseClaudeSettings(
      JSON.stringify({
        oauthAccount: {
          accountUuid: identity.accountUuid,
          emailAddress: "not-submitted@example.com",
        },
        userID: identity.deviceId,
        projects: { private: "never-submit" },
      }),
    ),
  ).toEqual(identity);
  for (const input of [
    "invalid",
    "null",
    "{}",
    JSON.stringify({ oauthAccount: { accountUuid: identity.accountUuid }, userID: "invalid" }),
  ])
    expect(() => parseClaudeSettings(input)).toThrow();
});

test("Claude import ignores a stale file and invalid replacement clears readiness", async () => {
  const { useClaudeIdentityFields } = await import("./claude-setup");
  let current: ReturnType<typeof useClaudeIdentityFields>;
  function Harness() {
    current = useClaudeIdentityFields(true);
    return <>{current.fields}</>;
  }
  await act(async () => root.render(<Harness />));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const importButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Import Claude account details"]',
  )!;
  expect(importButton.id).not.toBe("");
  expect(
    [...container.querySelectorAll("label")].find((label) => label.htmlFor === importButton.id)
      ?.textContent,
  ).toBe("Claude account details");
  expect(
    document.getElementById(importButton.getAttribute("aria-describedby")!)?.textContent,
  ).toContain("Only the two account identifiers are read");
  const text = JSON.stringify({
    oauthAccount: { accountUuid: "10000000-0000-4000-8000-000000000001" },
    userID: "a".repeat(64),
  });
  let finish!: (value: string) => void;
  const slow = new Promise<string>((resolve) => {
    finish = resolve;
  });
  async function select(read: () => Promise<string>) {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ size: 100, text: read }],
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }
  await select(() => slow);
  await select(async () => "{}");
  await act(async () => finish(text));
  expect(current!.valid).toBe(false);
  expect(container.textContent).toContain("Account details are missing");
  expect(importButton.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(importButton.getAttribute("aria-describedby")!)?.textContent,
  ).toContain("Account details are missing");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Account details are missing",
  );
  await select(async () => text);
  expect(current!.valid).toBe(true);
  expect(container.textContent).toContain("Account details ready");
  expect(importButton.hasAttribute("aria-invalid")).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await select(async () => "bad json");
  expect(current!.valid).toBe(false);
  expect(current!.identity?.accountUuid).toBe("");
});

test("named Claude model additions persist a friendly picker label", async () => {
  const { useOrganizationProviderConnection } =
    await import("../organization-model-provider-connection");
  let current: ReturnType<typeof useOrganizationProviderConnection>;
  const create = mock(async (_org: string, _kind: string, request: any) => ({
    id: "model-one",
    version: 1,
    ...request,
  }));
  const client = {
    getOrganizationModelProviderConnection: async () => null,
    listOrganizationProviderCustomModels: async () => ({ models: [] }),
    createOrganizationProviderCustomModel: create,
  };
  function Harness() {
    current = useOrganizationProviderConnection({
      organizationId: "org-test",
      providerKind: "claude_subscription",
      client: client as any,
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => current!.addCustomModel("claude-opus-5-5"));
  expect(create.mock.calls[0]?.[2]).toMatchObject({
    upstreamModelId: "claude-opus-5-5",
    label: "Claude Opus 5.5",
  });
});

test("Claude subscription row has its logo and plan, never API-key billing", async () => {
  const { ProviderConnectionRow } = await import("../ai-gateway-connection");
  const { ORGANIZATION_PROVIDER_META } = await import("../organization-model-provider-connection");
  const state = {
    config: ORGANIZATION_PROVIDER_META.claude_subscription,
    settled: true,
    connected: true,
    customModels: [],
    error: null,
  } as unknown as ProviderConnection;
  await act(async () => root.render(<ProviderConnectionRow state={state} onOpen={() => {}} />));
  expect(container.textContent).toContain("Claude plan");
  expect(container.textContent).toContain("Choose models");
  expect(container.textContent).not.toContain("API key");
  expect(container.textContent).not.toContain("Pay per token");
  expect(container.querySelector("svg path")).not.toBeNull();
});

test("workspace connect offers workspace Claude setup only when permitted", async () => {
  const { PROVIDER_CONNECTION_CONFIGS } = await import("../ai-gateway-connection");
  const gateways = {
    claude_subscription: {
      config: PROVIDER_CONNECTION_CONFIGS.claude_subscription,
      canManageConnection: true,
      connected: false,
    },
  } as unknown as Partial<Record<"claude_subscription", ProviderConnection>>;
  const { ConnectPickerPage } = await import("./workspace-models-page");
  const pick = mock(() => {});
  await act(async () =>
    root.render(
      <ConnectPickerPage
        codexAvailable={false}
        grok="hidden"
        gateways={gateways}
        scopeName="Workspace"
        onClose={() => {}}
        onPick={pick}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Shared through your organization");
  const claude = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Claude subscription",
  )!;
  await act(async () => claude.click());
  expect(pick).toHaveBeenCalledWith("claude_subscription");
  await act(async () =>
    root.render(
      <ConnectPickerPage
        codexAvailable={false}
        grok="hidden"
        scopeName="Workspace"
        onClose={() => {}}
        onPick={pick}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Claude subscription");
});

test("workspace Claude saves identity only inside the credential and stays off without network activity", async () => {
  const { useProviderConnection, PROVIDER_CONNECTION_CONFIGS } =
    await import("../ai-gateway-connection");
  const listConnections = mock(async () => []);
  const listModels = mock(async () => ({ models: [] }));
  const createConnection = mock(async (_workspaceId: string, request: Record<string, unknown>) => ({
    id: "fixture",
    subjectId: null,
    status: "active",
    version: 1,
    ...request,
  }));
  const createModel = mock(
    async (
      _workspaceId: string,
      _kind: string,
      request: { upstreamModelId: string; label?: string; operationId: string },
    ) => ({ id: "model", version: 1, ...request }),
  );
  const client = {
    listConnections,
    listWorkspaceClaudeCustomModels: listModels,
    createWorkspaceClaudeCustomModel: createModel,
    createConnection,
  } as unknown as Parameters<typeof useProviderConnection>[0]["client"];
  let state!: ReturnType<typeof useProviderConnection>;
  function Harness({ enabled }: { enabled: boolean }) {
    state = useProviderConnection({
      client,
      config: PROVIDER_CONNECTION_CONFIGS.claude_subscription,
      workspaceId: "workspace",
      canManageConnection: true,
      canManageCustomModels: true,
      enabled,
    });
    return null;
  }
  await act(async () => root.render(<Harness enabled={false} />));
  expect(listConnections).not.toHaveBeenCalled();
  expect(listModels).not.toHaveBeenCalled();
  expect(state.hidden).toBe(true);
  expect(state.canManageConnection).toBe(false);
  const identity = {
    accountUuid: "10000000-0000-4000-8000-000000000001",
    deviceId: "a".repeat(64),
  };
  expect(await state.saveKey("sk-ant-oat01-fixture", identity)).toBe(false);
  expect(createConnection).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness enabled />));
  expect(listModels).toHaveBeenCalledWith("workspace", "claude_subscription");
  await act(async () => {
    expect(await state.saveKey("sk-ant-oat01-fixture", identity)).toBe(true);
  });
  const payload = createConnection.mock.calls[0]![1] as {
    credential: { apiKey: string };
    metadata: unknown;
    subjectId: unknown;
  };
  expect(JSON.parse(payload.credential.apiKey)).toEqual({
    version: 1,
    token: "sk-ant-oat01-fixture",
    identity,
  });
  expect(JSON.stringify(payload.metadata)).not.toContain(identity.accountUuid);
  expect(payload.subjectId).toBeNull();
  expect(state.accessTarget.kind).toBe("claude_subscription");
  expect(state.scopeLabel).toBe("Workspace");
  expect(state.config.customModelsDescription).toContain("this workspace");
  await act(async () => {
    await state.addCustomModel("claude-opus-5-5");
  });
  expect(createModel.mock.calls[0]?.slice(0, 2)).toEqual(["workspace", "claude_subscription"]);
  expect(createModel.mock.calls[0]?.[2]).toMatchObject({
    upstreamModelId: "claude-opus-5-5",
    label: "Claude Opus 5.5",
  });
});

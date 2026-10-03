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
import { modelsScopeLabels } from "./models-ui";
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

test("subscription pools reuse workspace model controls without reading or mutating legacy credentials", async () => {
  const { useProviderConnection, PROVIDER_CONNECTION_CONFIGS, ProviderCustomModels } =
    await import("../ai-gateway-connection");
  const secrets = mock(async () => {
    throw new Error("Legacy credentials must not be consulted");
  });
  const create = mock(async (_workspace: string, _kind: string, input: any) => ({
    id: "model-fixture",
    version: 1,
    ...input,
  }));
  const client = {
    listConnections: secrets,
    getWorkspaceModelCatalog: secrets,
    createConnection: secrets,
    listWorkspaceClaudeCustomModels: async () => ({ models: [] }),
    createWorkspaceClaudeCustomModel: create,
  };
  let state!: ReturnType<typeof useProviderConnection>;
  function Harness() {
    state = useProviderConnection({
      client: client as any,
      config: PROVIDER_CONNECTION_CONFIGS.claude_subscription,
      workspaceId: "workspace-fixture",
      canManageConnection: true,
      canManageCustomModels: true,
      catalogConnection: { connected: true, loaded: true, error: null },
    });
    return <ProviderCustomModels state={state} />;
  }
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain("Claude models");
  await act(async () => state.addCustomModel("claude-opus-5-5"));
  expect(create.mock.calls[0]?.[2]).toMatchObject({
    upstreamModelId: "claude-opus-5-5",
    label: "Claude Opus 5.5",
  });
  expect(await state.saveKey("sk-ant-oat01-fixture")).toBe(false);
  expect(await state.disconnect()).toBe(false);
  expect(state.canManageConnection).toBe(false);
  expect(state.hidden).toBe(true);
  expect(secrets).toHaveBeenCalledTimes(0);
});

test("organization subscription model controls keep pool and legacy credentials separate", async () => {
  const { useOrganizationProviderConnection } =
    await import("../organization-model-provider-connection");
  const secrets = mock(async () => {
    throw new Error("Legacy credentials must not be consulted");
  });
  const create = mock(async (_org: string, _kind: string, input: any) => ({
    id: "model-fixture",
    version: 1,
    ...input,
  }));
  const client = {
    getOrganizationModelProviderConnection: secrets,
    upsertOrganizationModelProviderConnection: secrets,
    listOrganizationProviderCustomModels: async () => ({ models: [] }),
    createOrganizationProviderCustomModel: create,
  };
  let state!: ReturnType<typeof useOrganizationProviderConnection>;
  function Harness() {
    state = useOrganizationProviderConnection({
      client: client as any,
      providerKind: "claude_subscription",
      organizationId: "organization-fixture",
      catalogConnection: { connected: true, loaded: true, error: null },
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => state.addCustomModel("claude-opus-5-5"));
  expect(create.mock.calls[0]?.[2]).toMatchObject({
    upstreamModelId: "claude-opus-5-5",
    label: "Claude Opus 5.5",
  });
  expect(await state.saveKey("sk-ant-oat01-fixture")).toBe(false);
  expect(await state.disconnect()).toBe(false);
  expect(secrets).toHaveBeenCalledTimes(0);
});

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
    scope: modelsScopeLabels("Organization", false),
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

  // While the code waits, the step holds its own actions: no second connect
  // button that could be counted again.
  await act(async () =>
    root.render(
      <SuperGrokConnectPage
        grok={grok({ userCode: "CODE", verificationUri: "https://example.com/device" })}
        places={places}
        onClose={() => {}}
      />,
    ),
  );
  expect(container.querySelector('button[type="submit"]')).toBeNull();
  expect(container.querySelector("[data-analytics-action]")).toBeNull();
});

test("Claude credentials use distinct accessible forms and explain subscription expiry", async () => {
  const { ORGANIZATION_PROVIDER_META } = await import("../organization-model-provider-connection");
  for (const kind of ["anthropic", "claude_subscription"] as const) {
    const config = ORGANIZATION_PROVIDER_META[kind];
    const state = {
      config,
      canManageConnection: true,
      accessTarget: {
        client: {},
        workspaceId: "22222222-2222-4222-8222-222222222222",
      },
      saveKey: async () => true,
    } as unknown as ProviderConnection;
    await act(async () =>
      root.render(
        <ProviderConnectPage key={kind} state={state} onClose={() => {}} onConnected={() => {}} />,
      ),
    );
    if (kind === "claude_subscription") {
      expect(submitButton().textContent).toContain("Sign in to Claude");
      expect(submitButton().disabled).toBe(false);
      expect(
        container
          .querySelector('input[aria-label="Claude subscription setup token"]')
          ?.closest('[data-state="closed"]') !== null,
      ).toBe(true);
      const setup = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Use a setup token"),
      )!;
      await act(async () => setup.click());
    }
    const input = container.querySelector<HTMLInputElement>(
      `input[aria-label="${config.keyAriaLabel}"]`,
    )!;
    expect(input.getAttribute("aria-label")).toBe(config.keyAriaLabel);
    expect(input.type).toBe("password");
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain(config.title);
    if (kind === "claude_subscription") {
      expect(container.querySelector('input[type="file"]')).toBeNull();
      expect(container.textContent).not.toContain("Account UUID");
      expect(container.textContent).not.toContain("Device ID");
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Create a Claude setup token"]')
          ?.value,
      ).toBe("claude setup-token");
      expect(container.textContent).toContain("cannot check current usage");
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
  expect(document.body.textContent).toContain("Replace Claude setup token");
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
  await act(async () => {
    saved = await state.saveKey("sk-ant-oat01-fixture");
  });
  expect(saved).toBe(false);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.operationId).toBe(sent[1]!.operationId);
  expect(sent[0]!.claudeIdentity).toBeUndefined();
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
        claude="available"
        gateways={gateways}
        target="workspace"
        title="Connect account"
        subtitle="Choose what pays for models in Workspace."
        onClose={() => {}}
        onPick={pick}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Shared through your organization");
  const claude = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Claude subscription"),
  )!;
  await act(async () => claude.click());
  expect(pick).toHaveBeenCalledWith("claude_subscription");
  await act(async () =>
    root.render(
      <ConnectPickerPage
        codexAvailable={false}
        grok="hidden"
        target="workspace"
        title="Connect account"
        subtitle="Choose what pays for models in Workspace."
        onClose={() => {}}
        onPick={pick}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Claude subscription");
});

test("workspace Claude submits only a setup token and stays off without network activity", async () => {
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
  expect(await state.saveKey("sk-ant-oat01-fixture")).toBe(false);
  expect(createConnection).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness enabled />));
  expect(listModels).toHaveBeenCalledWith("workspace", "claude_subscription");
  await act(async () => {
    expect(await state.saveKey("sk-ant-oat01-fixture")).toBe(true);
  });
  const payload = createConnection.mock.calls[0]![1] as {
    credential: { apiKey: string };
    metadata: unknown;
    subjectId: unknown;
  };
  expect(payload.credential.apiKey).toBe("sk-ant-oat01-fixture");
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

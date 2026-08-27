import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectionMetadata, WorkspaceGatewayCustomModel } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const listConnections = mock(async (_workspaceId: string): Promise<ConnectionMetadata[]> => []);
const listWorkspaceGatewayCustomModels = mock(
  async (_workspaceId: string): Promise<{ models: WorkspaceGatewayCustomModel[] }> => ({
    models: [],
  }),
);
const createWorkspaceGatewayCustomModel = mock(
  async (
    _workspaceId: string,
    request: { upstreamModelId: string },
  ): Promise<WorkspaceGatewayCustomModel> => customModel(request.upstreamModelId),
);
const deleteWorkspaceGatewayCustomModel = mock(
  async (_workspaceId: string, _customModelId: string): Promise<void> => {},
);
const toastSuccess = mock((_message: string) => {});
const toastError = mock((_message: string) => {});

const context = {
  client: {
    listConnections,
    listWorkspaceGatewayCustomModels,
    createWorkspaceGatewayCustomModel,
    deleteWorkspaceGatewayCustomModel,
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

mock.module("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

const { AiGatewayConnectionCard } = await import("./ai-gateway-connection");

function customModel(upstreamModelId: string): WorkspaceGatewayCustomModel {
  return {
    id: crypto.randomUUID(),
    upstreamModelId,
    label: null,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
}

function gatewayConnection(): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: null,
    providerDomain: "ai-gateway.vercel.sh",
    kind: "api_key",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { credentialRole: "vercel_ai_gateway" },
    createdBySubjectId: null,
    updatedBySubjectId: null,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderCard(canManage = true, onConnectionChange = mock(() => {})) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AiGatewayConnectionCard
        workspaceId="workspace-a"
        canManage={canManage}
        onConnectionChange={onConnectionChange}
      />,
    );
    await flush();
  });
  return { container, onConnectionChange, root };
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onChange = (
      input as unknown as Record<
        string,
        { onChange?: (event: { target: HTMLInputElement }) => void }
      >
    )[reactPropsKey!]!.onChange;
    onChange!({ target: input });
  });
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  listConnections.mockClear();
  listWorkspaceGatewayCustomModels.mockClear();
  createWorkspaceGatewayCustomModel.mockClear();
  deleteWorkspaceGatewayCustomModel.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  listConnections.mockImplementation(async () => []);
  listWorkspaceGatewayCustomModels.mockImplementation(async () => ({ models: [] }));
  createWorkspaceGatewayCustomModel.mockImplementation(async (_workspaceId, request) =>
    customModel(request.upstreamModelId),
  );
  deleteWorkspaceGatewayCustomModel.mockImplementation(async () => {});
});

describe("AiGatewayConnectionCard custom models", () => {
  test("lets an admin preconfigure one exact Gateway slug before connecting", async () => {
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      expect(container.textContent).toContain("Off");
      expect(container.textContent).toContain("No custom model slugs yet");
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      );
      const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Add model"),
      );
      expect(input).not.toBeNull();
      expect(add?.disabled).toBe(true);

      await setInputValue(input!, "anthropic/claude-sonnet-4.6");
      expect(add?.disabled).toBe(false);
      await act(async () => {
        add!.click();
        await flush();
      });

      expect(createWorkspaceGatewayCustomModel).toHaveBeenCalledWith("workspace-a", {
        upstreamModelId: "anthropic/claude-sonnet-4.6",
      });
      expect(container.textContent).toContain("anthropic/claude-sonnet-4.6");
      expect(container.textContent).toContain("Waiting for a Gateway connection");
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Gateway model added", expect.any(Object));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("blocks duplicate or whitespace-bearing slugs before the API call", async () => {
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: [customModel("anthropic/claude-sonnet-4.6")],
    }));
    const { container, root } = await renderCard();

    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Add model"),
      )!;

      await setInputValue(input, "anthropic/claude sonnet");
      expect(add.disabled).toBe(true);
      expect(container.textContent).toContain("exact printable slug with no spaces");

      await setInputValue(input, "anthropic/claude-sonnet-4.6");
      expect(add.disabled).toBe(true);
      expect(container.textContent).toContain("already configured for this workspace");
      expect(createWorkspaceGatewayCustomModel).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("shows connected models read-only to non-admin workspace members", async () => {
    listConnections.mockImplementation(async () => [gatewayConnection()]);
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: [customModel("deepseek/deepseek-v3.2")],
    }));
    const { container, root } = await renderCard(false);

    try {
      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("deepseek/deepseek-v3.2");
      expect(container.textContent).toContain("Ready through Your Gateway");
      expect(container.querySelector("input")).toBeNull();
      expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("removes a custom slug by its stable row id", async () => {
    const model = customModel("xai/grok-4.1-fast");
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({ models: [model] }));
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      const remove = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove xai/grok-4.1-fast"]',
      );
      expect(remove).not.toBeNull();
      await act(async () => {
        remove!.click();
        await flush();
      });

      expect(deleteWorkspaceGatewayCustomModel).toHaveBeenCalledWith("workspace-a", model.id);
      expect(container.textContent).not.toContain("xai/grok-4.1-fast");
      expect(container.textContent).toContain("No custom model slugs yet");
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

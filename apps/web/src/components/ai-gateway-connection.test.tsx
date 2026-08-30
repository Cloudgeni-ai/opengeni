import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  ConnectionMetadata,
  CreateConnectionRequest,
  CreateWorkspaceGatewayCustomModelRequest,
  DeleteWorkspaceGatewayCustomModelRequest,
  UpdateConnectionRequest,
  WorkspaceGatewayCustomModel,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";
import { VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY } from "@opengeni/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";

const listConnections = mock(async (_workspaceId: string): Promise<ConnectionMetadata[]> => []);
const listWorkspaceGatewayCustomModels = mock(
  async (_workspaceId: string): Promise<{ models: WorkspaceGatewayCustomModel[] }> => ({
    models: [],
  }),
);
const getWorkspaceModelCatalog = mock(
  async (_workspaceId: string): Promise<{ models: WorkspaceModelCatalogModel[] }> => ({
    models: [],
  }),
);
const createConnection = mock(
  async (_workspaceId: string, _request: CreateConnectionRequest): Promise<ConnectionMetadata> =>
    gatewayConnection(),
);
const updateConnection = mock(
  async (
    _workspaceId: string,
    _connectionId: string,
    _request: UpdateConnectionRequest,
  ): Promise<ConnectionMetadata> => gatewayConnection(),
);
const deleteConnection = mock(
  async (_workspaceId: string, _connectionId: string): Promise<ConnectionMetadata> =>
    gatewayConnection("revoked"),
);
const createWorkspaceGatewayCustomModel = mock(
  async (
    _workspaceId: string,
    request: CreateWorkspaceGatewayCustomModelRequest,
  ): Promise<WorkspaceGatewayCustomModel> => customModel(request.upstreamModelId),
);
const deleteWorkspaceGatewayCustomModel = mock(
  async (
    _workspaceId: string,
    _customModelId: string,
    _request: DeleteWorkspaceGatewayCustomModelRequest,
  ): Promise<void> => {},
);
const toastSuccess = mock((_message: string) => {});
const toastError = mock((_message: string) => {});

const context = {
  client: {
    listConnections,
    getWorkspaceModelCatalog,
    createConnection,
    updateConnection,
    deleteConnection,
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

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    confirmLabel: string;
    onConfirm: () => Promise<void | boolean>;
  }) =>
    open ? (
      <button type="button" onClick={() => void onConfirm()}>
        {confirmLabel}
      </button>
    ) : null,
}));

const { AiGatewayConnectionCard } = await import("./ai-gateway-connection");

function customModel(upstreamModelId: string): WorkspaceGatewayCustomModel {
  return {
    id: crypto.randomUUID(),
    upstreamModelId,
    label: null,
    version: 1,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
}

function gatewayConnection(
  status: ConnectionMetadata["status"] = "active",
  overrides: Partial<ConnectionMetadata> = {},
): ConnectionMetadata {
  const connection: ConnectionMetadata = {
    id: "33333333-3333-4333-8333-333333333333",
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-a",
    subjectId: null,
    providerDomain: "ai-gateway.vercel.sh",
    kind: "api_key",
    status,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: status === "active" ? 1 : 2,
    metadata: {
      credentialRole: "vercel_ai_gateway",
      credentialLabel: "Vercel AI Gateway",
    },
    createdBySubjectId: "user:fixture-admin",
    updatedBySubjectId: "user:fixture-admin",
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
  return {
    ...connection,
    ...overrides,
    metadata: { ...connection.metadata, ...overrides.metadata },
  };
}

function gatewayCatalogModel(): WorkspaceModelCatalogModel {
  return {
    id: "workspace-gateway/deepseek/deepseek-v3.2",
    label: "DeepSeek V3.2",
    provider: "workspace-gateway",
    providerLabel: "Your Gateway",
    api: "responses",
    source: "workspace_gateway",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "connection",
      checkedAt: null,
    },
    availability: {
      status: "available",
      selectable: true,
      reason: null,
      checkedAt: null,
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderCard(
  canManageConnection = true,
  onConnectionChange = mock(() => {}),
  canManageCustomModels = canManageConnection,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AiGatewayConnectionCard
        workspaceId="workspace-a"
        canManageConnection={canManageConnection}
        canManageCustomModels={canManageCustomModels}
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

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onKeyDown = (
      input as unknown as Record<
        string,
        {
          onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
        }
      >
    )[reactPropsKey!]!.onKeyDown;
    onKeyDown!({ key: "Enter", preventDefault: () => {} });
    await flush();
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
  getWorkspaceModelCatalog.mockClear();
  createConnection.mockClear();
  updateConnection.mockClear();
  deleteConnection.mockClear();
  listWorkspaceGatewayCustomModels.mockClear();
  createWorkspaceGatewayCustomModel.mockClear();
  deleteWorkspaceGatewayCustomModel.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  listConnections.mockImplementation(async () => []);
  getWorkspaceModelCatalog.mockImplementation(async () => ({ models: [] }));
  createConnection.mockImplementation(async () => gatewayConnection());
  updateConnection.mockImplementation(async () => gatewayConnection());
  deleteConnection.mockImplementation(async () => gatewayConnection("revoked"));
  listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
    models: [],
  }));
  createWorkspaceGatewayCustomModel.mockImplementation(async (_workspaceId, request) =>
    customModel(request.upstreamModelId),
  );
  deleteWorkspaceGatewayCustomModel.mockImplementation(async () => {});
});

describe("AiGatewayConnectionCard custom models", () => {
  test("lets an admin preconfigure one exact Gateway slug before connecting", async () => {
    const created = customModel("anthropic/claude-sonnet-4.6");
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: createWorkspaceGatewayCustomModel.mock.calls.length > 0 ? [created] : [],
    }));
    createWorkspaceGatewayCustomModel.mockImplementation(async () => created);
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
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
        upstreamModelId: "anthropic/claude-sonnet-4.6",
      });
      expect(add?.className).toContain("min-h-11");
      expect(container.textContent).toContain("anthropic/claude-sonnet-4.6");
      expect(container.textContent).toContain("Waiting for a Gateway connection");
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Gateway model added", expect.any(Object));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("blocks duplicate, whitespace-bearing, or field-separator slugs before the API call", async () => {
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

      await setInputValue(input, "anthropic|claude");
      expect(add.disabled).toBe(true);
      expect(container.textContent).toContain("no spaces or |");

      await setInputValue(input, " anthropic/claude-sonnet-4.6");
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

  test("ignores a slower response from the previous workspace", async () => {
    let resolveWorkspaceA: ((value: { models: WorkspaceGatewayCustomModel[] }) => void) | undefined;
    listWorkspaceGatewayCustomModels.mockImplementation(async (workspaceId) => {
      if (workspaceId === "workspace-a") {
        return await new Promise<{ models: WorkspaceGatewayCustomModel[] }>((resolve) => {
          resolveWorkspaceA = resolve;
        });
      }
      return { models: [customModel("workspace-b/model")] };
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AiGatewayConnectionCard
            workspaceId="workspace-a"
            canManageConnection
            canManageCustomModels
          />,
        );
        await flush();
      });
      await act(async () => {
        root.render(
          <AiGatewayConnectionCard
            workspaceId="workspace-b"
            canManageConnection
            canManageCustomModels
          />,
        );
        await flush();
      });
      expect(container.textContent).toContain("workspace-b/model");

      await act(async () => {
        resolveWorkspaceA?.({ models: [customModel("workspace-a/model")] });
        await flush();
      });
      expect(container.textContent).toContain("workspace-b/model");
      expect(container.textContent).not.toContain("workspace-a/model");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not let a delayed startup snapshot overwrite a successful connection", async () => {
    let resolveInitialModels:
      | ((value: { models: WorkspaceGatewayCustomModel[] }) => void)
      | undefined;
    listConnections.mockImplementation(async () => []);
    listWorkspaceGatewayCustomModels.mockImplementation(
      async () =>
        await new Promise<{ models: WorkspaceGatewayCustomModel[] }>((resolve) => {
          resolveInitialModels = resolve;
        }),
    );
    const { container, root } = await renderCard();

    try {
      const keyInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway key"]',
      )!;
      await setInputValue(keyInput, "fixture-key");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Connect"))
          ?.click();
        await flush();
      });
      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("Disconnect");

      await act(async () => {
        resolveInitialModels?.({ models: [] });
        await flush();
      });
      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("Disconnect");
      expect(createConnection).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("reconciles an outcome-unknown create before enabling another retry", async () => {
    let resolveInitialModels:
      | ((value: { models: WorkspaceGatewayCustomModel[] }) => void)
      | undefined;
    let connectionCommitted = false;
    let committedOperationId: string | null = null;
    let modelReadCount = 0;
    listConnections.mockImplementation(async () =>
      connectionCommitted
        ? [
            gatewayConnection("active", {
              metadata: {
                [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY]: committedOperationId,
              },
            }),
          ]
        : [],
    );
    listWorkspaceGatewayCustomModels.mockImplementation(async () => {
      modelReadCount += 1;
      if (modelReadCount > 1) return { models: [] };
      return await new Promise<{ models: WorkspaceGatewayCustomModel[] }>((resolve) => {
        resolveInitialModels = resolve;
      });
    });
    createConnection.mockImplementation(async (_workspaceId, request) => {
      committedOperationId = request.operationId ?? null;
      connectionCommitted = true;
      throw new Error("response lost after commit");
    });
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      const keyInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway key"]',
      )!;
      await setInputValue(keyInput, "fixture-key");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Connect"))
          ?.click();
        await flush();
      });
      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("Disconnect");
      expect(keyInput.value).toBe("");
      expect(createConnection).toHaveBeenCalledTimes(1);
      expect(createConnection.mock.calls[0]?.[1].operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(modelReadCount).toBe(1);
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Vercel AI Gateway connected");
      expect(toastError).not.toHaveBeenCalled();

      await act(async () => {
        resolveInitialModels?.({ models: [] });
        await flush();
      });
      expect(container.textContent).toContain("Connected");
      expect(createConnection).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("reconciles an outcome-unknown key replacement from its operation receipt", async () => {
    let connectionVersion = 1;
    let committedOperationId: string | null = null;
    listConnections.mockImplementation(async () => [
      gatewayConnection("active", {
        version: connectionVersion,
        metadata: {
          ...(committedOperationId
            ? {
                [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY]: committedOperationId,
              }
            : {}),
        },
      }),
    ]);
    updateConnection.mockImplementation(async (_workspaceId, _connectionId, request) => {
      committedOperationId = request.operationId ?? null;
      connectionVersion = 2;
      throw new Error("response lost after replacement commit");
    });
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      const keyInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway key"]',
      )!;
      await setInputValue(keyInput, "replacement-key");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Replace"))
          ?.click();
        await flush();
      });

      expect(container.textContent).toContain("Connected");
      expect(keyInput.value).toBe("");
      expect(updateConnection).toHaveBeenCalledTimes(1);
      expect(updateConnection.mock.calls[0]?.[2]).toMatchObject({
        expectedVersion: 1,
        operationId: committedOperationId,
      });
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Vercel AI Gateway connected");
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not attribute another administrator's replacement to a failed save", async () => {
    const unrelatedOperationId = crypto.randomUUID();
    let replacementObserved = false;
    listConnections.mockImplementation(async () => [
      gatewayConnection("active", {
        version: replacementObserved ? 2 : 1,
        metadata: replacementObserved
          ? {
              [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY]: unrelatedOperationId,
            }
          : {},
      }),
    ]);
    updateConnection.mockImplementation(async () => {
      replacementObserved = true;
      throw new Error("request failed before commit");
    });
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      const keyInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway key"]',
      )!;
      await setInputValue(keyInput, "replacement-key");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Replace"))
          ?.click();
        await flush();
      });

      expect(container.textContent).toContain("Connected");
      expect(keyInput.value).toBe("replacement-key");
      expect(updateConnection).toHaveBeenCalledTimes(1);
      expect(updateConnection.mock.calls[0]?.[2].operationId).not.toBe(unrelatedOperationId);
      expect(onConnectionChange).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't save Vercel AI Gateway key",
        expect.any(Object),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("removes every local active Gateway duplicate after a successful disconnect", async () => {
    const selected = gatewayConnection("active");
    const duplicate = gatewayConnection("active", {
      id: "44444444-4444-4444-8444-444444444444",
      version: 3,
    });
    let disconnected = false;
    listConnections.mockImplementation(async () =>
      disconnected
        ? [
            gatewayConnection("revoked", { id: selected.id, version: 2 }),
            gatewayConnection("revoked", { id: duplicate.id, version: 4 }),
          ]
        : [selected, duplicate],
    );
    deleteConnection.mockImplementation(async () => {
      disconnected = true;
      return gatewayConnection("revoked", { id: selected.id, version: 2 });
    });
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Disconnect"))
          ?.click();
        await flush();
      });

      expect(deleteConnection).toHaveBeenCalledWith("workspace-a", selected.id);
      expect(container.textContent).toContain("Off");
      expect(container.textContent).not.toContain("Disconnect");
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Vercel AI Gateway disconnected");
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps a newer Gateway generation connected after replaying an older disconnect", async () => {
    const selected = gatewayConnection("active");
    const replacement = gatewayConnection("active", {
      id: "44444444-4444-4444-8444-444444444444",
      version: 1,
    });
    let deleteReturned = false;
    listConnections.mockImplementation(async () =>
      deleteReturned
        ? [gatewayConnection("revoked", { id: selected.id, version: 2 }), replacement]
        : [selected],
    );
    deleteConnection.mockImplementation(async () => {
      deleteReturned = true;
      return gatewayConnection("revoked", { id: selected.id, version: 2 });
    });
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Disconnect"))
          ?.click();
        await flush();
      });

      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("Disconnect");
      expect(onConnectionChange).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't confirm Vercel AI Gateway disconnect",
        expect.any(Object),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("reconciles an outcome-unknown disconnect when no active Gateway row remains", async () => {
    const selected = gatewayConnection("active");
    const duplicate = gatewayConnection("active", {
      id: "44444444-4444-4444-8444-444444444444",
      version: 3,
    });
    let disconnected = false;
    listConnections.mockImplementation(async () =>
      disconnected
        ? [
            gatewayConnection("revoked", { id: selected.id, version: 2 }),
            gatewayConnection("revoked", { id: duplicate.id, version: 4 }),
          ]
        : [selected, duplicate],
    );
    deleteConnection.mockImplementation(async () => {
      disconnected = true;
      throw new Error("response lost after disconnect commit");
    });
    const onConnectionChange = mock(() => {});
    const { container, root } = await renderCard(true, onConnectionChange);

    try {
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Disconnect"))
          ?.click();
        await flush();
      });

      expect(container.textContent).toContain("Off");
      expect(container.textContent).not.toContain("Disconnect");
      expect(deleteConnection).toHaveBeenCalledTimes(1);
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Vercel AI Gateway disconnected");
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("suppresses a completed mutation after switching workspaces", async () => {
    let resolveWorkspaceACreate: ((value: WorkspaceGatewayCustomModel) => void) | undefined;
    createWorkspaceGatewayCustomModel.mockImplementation(async (workspaceId, request) => {
      if (workspaceId === "workspace-a") {
        return await new Promise<WorkspaceGatewayCustomModel>((resolve) => {
          resolveWorkspaceACreate = resolve;
        });
      }
      return customModel(request.upstreamModelId);
    });
    const onConnectionChange = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AiGatewayConnectionCard
            workspaceId="workspace-a"
            canManageConnection
            canManageCustomModels
            onConnectionChange={onConnectionChange}
          />,
        );
        await flush();
      });
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      await setInputValue(input, "workspace-a/pending-model");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Add model"))
          ?.click();
        await flush();
      });

      await act(async () => {
        root.render(
          <AiGatewayConnectionCard
            workspaceId="workspace-b"
            canManageConnection
            canManageCustomModels
            onConnectionChange={onConnectionChange}
          />,
        );
        await flush();
      });
      await act(async () => {
        resolveWorkspaceACreate?.(customModel("workspace-a/pending-model"));
        await flush();
      });

      expect(container.textContent).not.toContain("workspace-a/pending-model");
      expect(onConnectionChange).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("shows connected models read-only to non-admin workspace members", async () => {
    getWorkspaceModelCatalog.mockImplementation(async () => ({
      models: [gatewayCatalogModel()],
    }));
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
      expect(listConnections).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not expose a transient read-only summary before empty loads settle", async () => {
    let resolveCatalog: ((value: { models: WorkspaceModelCatalogModel[] }) => void) | undefined;
    let resolveCustomModels:
      | ((value: { models: WorkspaceGatewayCustomModel[] }) => void)
      | undefined;
    getWorkspaceModelCatalog.mockImplementation(
      async () =>
        await new Promise<{ models: WorkspaceModelCatalogModel[] }>((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    listWorkspaceGatewayCustomModels.mockImplementation(
      async () =>
        await new Promise<{ models: WorkspaceGatewayCustomModel[] }>((resolve) => {
          resolveCustomModels = resolve;
        }),
    );
    const { container, root } = await renderCard(false);

    try {
      expect(container.querySelector("summary")).toBeNull();
      await act(async () => {
        resolveCatalog?.({ models: [] });
        resolveCustomModels?.({ models: [] });
        await flush();
      });
      expect(container.querySelector("summary")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps connection controls separate from workspace-admin model controls", async () => {
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: [customModel("deepseek/deepseek-v3.2")],
    }));
    const { container, root } = await renderCard(
      true,
      mock(() => {}),
      false,
    );

    try {
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
      expect(
        container.querySelector('input[aria-label="Vercel AI Gateway model slug"]'),
      ).toBeNull();
      expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();
      expect(listConnections).toHaveBeenCalledWith("workspace-a");
      expect(getWorkspaceModelCatalog).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("lets workspace admins curate models without connection-write authority", async () => {
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: [customModel("deepseek/deepseek-v3.2")],
    }));
    const { container, root } = await renderCard(
      false,
      mock(() => {}),
      true,
    );

    try {
      expect(container.querySelector('input[type="password"]')).toBeNull();
      expect(
        container.querySelector('input[aria-label="Vercel AI Gateway model slug"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('button[aria-label="Remove deepseek/deepseek-v3.2"]'),
      ).not.toBeNull();
      expect(getWorkspaceModelCatalog).toHaveBeenCalledWith("workspace-a");
      expect(listConnections).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("shows an unavailable state when a member cannot read Gateway readiness", async () => {
    getWorkspaceModelCatalog.mockImplementation(async () => {
      throw new Error("readiness unavailable");
    });
    const { container, root } = await renderCard(false);

    try {
      expect(container.textContent).toContain("Bring your own Vercel AI Gateway");
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).toContain("readiness unavailable");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not mislabel custom models as disconnected when readiness is unavailable", async () => {
    getWorkspaceModelCatalog.mockImplementation(async () => {
      throw new Error("readiness unavailable");
    });
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: [customModel("deepseek/deepseek-v3.2")],
    }));
    const { container, root } = await renderCard(false);

    try {
      expect(container.textContent).toContain("Gateway connection status unavailable");
      expect(container.textContent).not.toContain("Waiting for a Gateway connection");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("removes a custom slug by its stable row id", async () => {
    const model = customModel("xai/grok-4.1-fast");
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: deleteWorkspaceGatewayCustomModel.mock.calls.length > 0 ? [] : [model],
    }));
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
      expect(deleteWorkspaceGatewayCustomModel).not.toHaveBeenCalled();
      const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Remove model",
      );
      expect(confirm).not.toBeUndefined();
      await act(async () => {
        confirm!.click();
        await flush();
      });

      expect(deleteWorkspaceGatewayCustomModel).toHaveBeenCalledWith("workspace-a", model.id, {
        expectedVersion: model.version,
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      });
      expect(container.textContent).not.toContain("xai/grok-4.1-fast");
      expect(container.textContent).toContain("No custom model slugs yet");
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(
        container.querySelector('input[aria-label="Vercel AI Gateway model slug"]'),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("retries a lost delete response with the same operation id", async () => {
    const model = customModel("xai/grok-4.1-fast");
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: [model],
    }));
    const operationIds: string[] = [];
    deleteWorkspaceGatewayCustomModel.mockImplementation(
      async (_workspaceId, _customModelId, request) => {
        operationIds.push(request.operationId);
        if (operationIds.length === 1) {
          throw new Error("response lost after delete commit");
        }
      },
    );
    const { container, root } = await renderCard();

    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="Remove ${model.upstreamModelId}"]`)!
          .click();
        await flush();
      });
      const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Remove model",
      )!;
      await act(async () => {
        confirm.click();
        await flush();
      });

      expect(deleteWorkspaceGatewayCustomModel).toHaveBeenCalledTimes(2);
      expect(operationIds[0]).toBe(operationIds[1]);
      expect(container.textContent).not.toContain(model.upstreamModelId);
      expect(toastSuccess).toHaveBeenCalledWith("Gateway model removed");
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not present a failed custom-model read as empty and offers an in-page retry", async () => {
    const recovered = customModel("recovered/provider-model");
    let reads = 0;
    listWorkspaceGatewayCustomModels.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) throw new Error("catalog unavailable");
      return { models: [recovered] };
    });
    const { container, root } = await renderCard();

    try {
      expect(container.textContent).toContain("catalog unavailable");
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).not.toContain("No custom model slugs yet");
      const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).not.toBeUndefined();
      await act(async () => {
        retry!.click();
        await flush();
      });
      expect(listWorkspaceGatewayCustomModels).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain(recovered.upstreamModelId);
      expect(container.textContent).not.toContain("catalog unavailable");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("recovers an unavailable initial state from the successful create response", async () => {
    const created = customModel("anthropic/claude-sonnet-4.6");
    listWorkspaceGatewayCustomModels.mockImplementation(async () => {
      throw new Error("catalog unavailable");
    });
    createWorkspaceGatewayCustomModel.mockImplementation(async () => created);
    const { container, root } = await renderCard();

    try {
      expect(container.textContent).toContain("catalog unavailable");
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      await setInputValue(input, created.upstreamModelId);
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Add model"))
          ?.click();
        await flush();
      });

      expect(container.textContent).toContain(created.upstreamModelId);
      expect(container.textContent).toContain("1 model");
      expect(container.textContent).not.toContain("catalog unavailable");
      expect(listWorkspaceGatewayCustomModels).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("ignores an older custom-model read after a successful add", async () => {
    const created = customModel("anthropic/claude-sonnet-4.6");
    let resolveInitialRead:
      | ((value: { models: WorkspaceGatewayCustomModel[] }) => void)
      | undefined;
    listWorkspaceGatewayCustomModels.mockImplementation(async () => {
      return await new Promise<{ models: WorkspaceGatewayCustomModel[] }>((resolve) => {
        resolveInitialRead = resolve;
      });
    });
    createWorkspaceGatewayCustomModel.mockImplementation(async () => created);
    const { container, root } = await renderCard();

    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      await setInputValue(input, created.upstreamModelId);
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Add model"))
          ?.click();
        await flush();
      });
      expect(container.textContent).toContain(created.upstreamModelId);

      await act(async () => {
        resolveInitialRead?.({ models: [] });
        await flush();
      });
      expect(container.textContent).toContain(created.upstreamModelId);
      expect(container.textContent).toContain("1 model");
      expect(container.textContent).not.toContain("No custom model slugs yet");
      expect(listWorkspaceGatewayCustomModels).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("retries a lost create response with the same operation id", async () => {
    const created = customModel("anthropic/claude-sonnet-4.6");
    const operationIds: string[] = [];
    createWorkspaceGatewayCustomModel.mockImplementation(async (_workspaceId, request) => {
      operationIds.push(request.operationId);
      if (operationIds.length === 1) throw new Error("response lost after create commit");
      return created;
    });
    const { container, root } = await renderCard();

    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      await setInputValue(input, created.upstreamModelId);
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Add model"))
          ?.click();
        await flush();
      });

      expect(createWorkspaceGatewayCustomModel).toHaveBeenCalledTimes(2);
      expect(operationIds[0]).toBe(operationIds[1]);
      expect(container.textContent).toContain(created.upstreamModelId);
      expect(input.value).toBe("");
      expect(toastSuccess).toHaveBeenCalledWith("Gateway model added", expect.any(Object));
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("blocks Enter and disables the slug input while an add is pending", async () => {
    const created = customModel("anthropic/claude-sonnet-4.6");
    let resolveCreate: ((model: WorkspaceGatewayCustomModel) => void) | undefined;
    createWorkspaceGatewayCustomModel.mockImplementation(
      async () =>
        await new Promise<WorkspaceGatewayCustomModel>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: createWorkspaceGatewayCustomModel.mock.calls.length > 0 ? [created] : [],
    }));
    const { container, root } = await renderCard();

    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      await setInputValue(input, created.upstreamModelId);
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Add model"))
          ?.click();
        await flush();
      });
      expect(input.disabled).toBe(true);
      await pressEnter(input);
      expect(createWorkspaceGatewayCustomModel).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveCreate?.(created);
        await flush();
      });
      expect(input.disabled).toBe(false);
      expect(input.value).toBe("");
      expect(document.activeElement).toBe(input);
      expect(input.className).toContain("text-base");
      expect(input.className).toContain("md:text-base");
      expect(input.className).not.toContain("lg:text-xs");
      expect(input.className).not.toContain("pointer-fine:text-xs");
      expect(input.className).not.toContain("lg:pointer-coarse:text-base");
      expect(input.className).not.toContain("sm:text-xs");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("preserves the slug and restores input focus when an add fails", async () => {
    createWorkspaceGatewayCustomModel.mockImplementation(async () => {
      throw new Error("fixture create failed");
    });
    const { container, root } = await renderCard();

    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Vercel AI Gateway model slug"]',
      )!;
      await setInputValue(input, "anthropic/claude-sonnet-4.6");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Add model"))
          ?.click();
        await flush();
      });

      expect(input.disabled).toBe(false);
      expect(input.value).toBe("anthropic/claude-sonnet-4.6");
      expect(document.activeElement).toBe(input);
      expect(createWorkspaceGatewayCustomModel).toHaveBeenCalledTimes(2);
      expect(createWorkspaceGatewayCustomModel.mock.calls[0]?.[1].operationId).toBe(
        createWorkspaceGatewayCustomModel.mock.calls[1]?.[1].operationId,
      );
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't confirm Gateway model add",
        expect.any(Object),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("restores removal focus to the next stable model action", async () => {
    const first = customModel("anthropic/claude-sonnet-4.6");
    const second = customModel("xai/grok-4.1-fast");
    listWorkspaceGatewayCustomModels.mockImplementation(async () => ({
      models: deleteWorkspaceGatewayCustomModel.mock.calls.length > 0 ? [second] : [first, second],
    }));
    const { container, root } = await renderCard();

    try {
      const removeFirst = container.querySelector<HTMLButtonElement>(
        `button[aria-label="Remove ${first.upstreamModelId}"]`,
      )!;
      expect(removeFirst.className).toContain("size-11");
      await act(async () => {
        removeFirst.click();
        await flush();
      });
      const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Remove model",
      )!;
      await act(async () => {
        confirm.click();
        await flush();
      });

      expect(document.activeElement).toBe(
        container.querySelector(`button[aria-label="Remove ${second.upstreamModelId}"]`),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

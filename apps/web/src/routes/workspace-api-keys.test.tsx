import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ApiKey } from "@/types";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "44444444-4444-4444-8444-444444444444";

function key(overrides: Partial<ApiKey>): ApiKey {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accountId,
    workspaceId,
    name: "CI pipeline",
    description: null,
    prefix: "ogk_b76d4e32",
    permissions: ["workspace:read", "sessions:read"],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:00:00.000Z",
    ...overrides,
  } as ApiKey;
}

const activeKey = key({});
const expiredKey = key({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Staging smoke tests",
  prefix: "ogk_1c0e77b9",
  expiresAt: "2020-09-20T10:00:00.000Z",
});
const revokedKey = key({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Old deploy key",
  prefix: "ogk_9a41d2e0",
  revokedAt: "2026-08-12T10:00:00.000Z",
});

const listApiKeys = mock(async (): Promise<ApiKey[]> => [activeKey, expiredKey, revokedKey]);
const createApiKey = mock(async (_workspaceId: string, request: Record<string, unknown>) => ({
  apiKey: key({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    name: String(request.name),
    permissions: request.permissions as ApiKey["permissions"],
    expiresAt: (request.expiresAt as string | undefined) ?? null,
  }),
  token: "ogk_dddddddd_shown-once",
}));
const deleteApiKey = mock(async () => ({ ...activeKey, revokedAt: new Date().toISOString() }));
const navigate = mock((_options: unknown) => undefined);
let permissions = ["workspace:admin", "workspace:read"];

const context = {
  client: { listApiKeys, createApiKey, deleteApiKey },
  get accessContext() {
    return {
      workspaceGrants: [{ workspaceId, accountId, permissions }],
      accountGrants: [],
    };
  },
  workspaces: [{ id: workspaceId, name: "Design preview", accountId }],
  captureWorkspaceInvocation: () => ({ workspaceId }),
  ownsWorkspaceInvocation: () => true,
};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { WorkspaceApiKeysPage } = await import("./workspace-api-keys");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  listApiKeys.mockClear();
  createApiKey.mockClear();
  deleteApiKey.mockClear();
  navigate.mockClear();
  permissions = ["workspace:admin", "workspace:read"];
});

async function render(keyParam: string | undefined) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<WorkspaceApiKeysPage workspaceId={workspaceId} keyParam={keyParam} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (each) => each.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

describe("workspace API keys", () => {
  test("lists live keys and collapses revoked and expired ones", async () => {
    const view = await render(undefined);
    expect(listApiKeys).toHaveBeenCalledWith(workspaceId);
    const text = view.container.textContent ?? "";
    expect(text).toContain("CI pipeline");
    expect(text).toContain("Revoked and expired (2)");
    // An expired key is never called active.
    expect(text).not.toContain("Staging smoke testsActive");
    await view.unmount();
  });

  test("a key past its expiry shows Expired on its page", async () => {
    const view = await render(expiredKey.id);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Staging smoke tests");
    expect(text).toContain("Expired");
    expect(text).toContain("Create a replacement");
    expect(text).not.toContain("Revoke key");
    await view.unmount();
  });

  test("members without api_keys:manage see who manages keys and load nothing", async () => {
    permissions = ["workspace:read"];
    const view = await render(undefined);
    expect(listApiKeys).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("API keys are managed by workspace admins");
    await view.unmount();
  });

  test("a Personal workspace says keys aren't available there, not who manages them", async () => {
    permissions = ["workspace:read"];
    const workspace = context.workspaces[0]! as { kind?: string };
    workspace.kind = "personal";
    try {
      const view = await render(undefined);
      expect(listApiKeys).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain(
        "API keys aren't available in Personal workspaces",
      );
      expect(view.container.textContent).not.toContain("workspace admins can");
      expect(view.container.textContent).not.toContain("managed by workspace admins");
      await view.unmount();
    } finally {
      delete workspace.kind;
    }
  });

  test("creates a key with a 90-day expiry and shows the token once on the same page", async () => {
    const view = await render("new");
    const input = view.container.querySelector<HTMLInputElement>(
      "input[placeholder='e.g. CI pipeline']",
    );
    expect(input).not.toBeNull();
    expect(input!.value).toBe("");
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(
        input,
        "Nightly export",
      );
      const propsKey = Object.keys(input!).find((each) => each.startsWith("__reactProps$"));
      const props = propsKey
        ? (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[propsKey]
        : undefined;
      props?.onChange?.({ target: input, currentTarget: input });
    });
    await act(async () => {
      button(view.container, "Create API key").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(createApiKey).toHaveBeenCalledTimes(1);
    const request = createApiKey.mock.calls[0]![1] as {
      name: string;
      permissions: string[];
      expiresAt?: string;
    };
    expect(request.name).toBe("Nightly export");
    expect(request.permissions).toContain("sessions:create");
    expect(request.permissions.some((each) => each.startsWith("account:"))).toBe(false);
    const days = (new Date(request.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    const text = view.container.textContent ?? "";
    expect(text).toContain("API key created");
    expect(text).toContain("ogk_dddddddd_shown-once");
    await view.unmount();
  });
});

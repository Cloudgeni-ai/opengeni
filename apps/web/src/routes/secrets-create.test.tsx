import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const reactApi = await import("@opengeni/react");
const router = await import("@tanstack/react-router");
const sonner = await import("sonner");
const { buildMockState } = await import("@/dev/secrets-mock/fixtures");
const state = buildMockState("create-test");
const vault = state.vaults.find((each) => each.source === "protonpass")!;
const created = { ...state.items[0]!, id: "new-item", name: "Example", vaultId: vault.id };
const createItem = mock(async () => created);
const refresh = mock(async (): Promise<void> => undefined);
const refreshItems = mock(async () => undefined);
const navigate = mock(() => undefined);
const warning = mock(() => 1);
const success = mock(() => 1);
const api = { createItem, getVaultProviderCatalog: async () => ({ connections: [] }) };
const context = {
  accessContext: {
    subjectId: "human",
    workspaceGrants: [{ workspaceId: state.workspaceId, permissions: ["workspace:admin"] }],
    accountGrants: [],
  },
  workspaces: [],
};

mock.module("@opengeni/react", () => ({
  ...reactApi,
  useVaults: () => ({ api, vaults: [vault], refresh, loading: false, error: null }),
  useVault: () => ({ vault: null, refresh, loading: false, error: null }),
  useVaultItems: () => ({ items: [], refresh: refreshItems, loading: false, error: null }),
}));
mock.module("@tanstack/react-router", () => ({ ...router, useNavigate: () => navigate }));
mock.module("sonner", () => ({ ...sonner, toast: { ...sonner.toast, warning, success } }));
mock.module("@/context", () => ({ useAppContext: () => context }));
const { SecretsRoute } = await import("./secrets");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  createItem.mockReset().mockImplementation(async () => created);
  refresh.mockReset().mockImplementation(async () => undefined);
  refreshItems.mockClear();
  navigate.mockClear();
  warning.mockClear();
  success.mockClear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function failure(code: string, details: Record<string, unknown> = {}) {
  return new OpenGeniApiError(
    503,
    JSON.stringify({ error: code, message: "Provider result", details }),
    { mutation: true },
  );
}

async function renderEditor() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <SecretsRoute
        workspaceId={state.workspaceId}
        vaultId={vault.id}
        view="new-item"
        type="note"
      />,
    ),
  );
  const name = host.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;
  const note = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "Example",
    );
    name.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      note,
      "Synthetic note",
    );
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = host.querySelector("form")!;
  return async () =>
    act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

for (const sync of ["failed", "ok"]) {
  test(`confirmed create not listed (sync ${sync}) leaves the editor and never resubmits`, async () => {
    createItem.mockImplementation(async () => {
      throw failure("provider_inventory_incomplete", {
        saved: true,
        vaultId: vault.id,
        itemName: "Example",
        sync,
      });
    });
    const submit = await renderEditor();
    await submit();
    // Keep the actual editor mounted until navigation commits: neither a click
    // nor a keyboard form submit may issue another create during that interval.
    await submit();
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(host.textContent).not.toContain("Try again in a moment");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      to: "/workspaces/$workspaceId/secrets/$vaultId",
      params: { workspaceId: state.workspaceId, vaultId: vault.id },
      search: {},
    });
    expect(warning).toHaveBeenCalledWith(
      "Saved Example",
      expect.objectContaining({
        description: `It will appear in ${vault.name} after the next successful sync. Don't save it again.`,
        duration: Infinity,
        closeButton: true,
      }),
    );
    expect(success).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<SecretsRoute workspaceId={state.workspaceId} vaultId={vault.id} />),
    );
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe(vault.name);
    expect(refreshItems).toHaveBeenCalled();
  });
}

test("confirmed save leaves even while the vault refresh has not finished", async () => {
  let finishRefresh!: () => void;
  refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  createItem.mockImplementation(async () => {
    throw failure("provider_inventory_incomplete", { saved: true });
  });
  const submit = await renderEditor();
  await submit();
  await submit();
  expect(createItem).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledTimes(1);
  await act(async () => finishRefresh());
});

for (const code of [
  "provider_inventory_incomplete",
  "provider_unavailable",
  "provider_outcome_unknown",
]) {
  test(`${code} without confirmed save keeps its guidance and can be retried`, async () => {
    createItem.mockImplementation(async () => {
      throw failure(code, { saved: false });
    });
    const submit = await renderEditor();
    await submit();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    if (code === "provider_outcome_unknown") {
      expect(host.textContent).toContain(
        "Check there before you try again, so nothing is saved twice.",
      );
    } else {
      expect(host.textContent).toContain("Try again in a moment.");
    }
    await submit();
    expect(createItem).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });
}

test("an ordinary created item still opens its detail and cannot be submitted twice", async () => {
  const submit = await renderEditor();
  await submit();
  await submit();
  expect(createItem).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith({
    to: "/workspaces/$workspaceId/secrets/$vaultId/$itemId",
    params: { workspaceId: state.workspaceId, vaultId: vault.id, itemId: created.id },
    search: {},
  });
  expect(success).toHaveBeenCalledWith("Saved Example");
  expect(warning).not.toHaveBeenCalled();
});

test("two submits in the same render dispatch only one in-flight create", async () => {
  let finishCreate!: (value: typeof created) => void;
  createItem.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
  );
  const submit = await renderEditor();
  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(createItem).toHaveBeenCalledTimes(1);
  await act(async () => finishCreate(created));
  await submit();
  expect(createItem).toHaveBeenCalledTimes(1);
});

test("an ordinary failure can be corrected and saved", async () => {
  createItem.mockRejectedValueOnce(failure("provider_unavailable"));
  const submit = await renderEditor();
  await submit();
  await submit();
  expect(createItem).toHaveBeenCalledTimes(2);
  expect(success).toHaveBeenCalledWith("Saved Example");
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});

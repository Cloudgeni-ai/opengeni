import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  OrganizationModelProviderConnection,
  OrganizationProviderCustomModel,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useOrganizationProviderConnection } from "./organization-model-provider-connection";
import {
  clearSharedQueries,
  invalidateSharedQueries,
  peekSharedQuery,
  retainSharedQueries,
  sharedQueryWriter,
} from "@/lib/shared-query";

let root: Root, container: HTMLDivElement;
let state: ReturnType<typeof useOrganizationProviderConnection>;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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

const connection = (version = 1) =>
  ({ status: "active", version }) as OrganizationModelProviderConnection;
const model = (id: string) =>
  ({ id, upstreamModelId: id, version: 1 }) as OrganizationProviderCustomModel;
const connectionKey = [
  "model-settings",
  "organization-provider",
  "org",
  "openrouter",
  "connection",
] as const;
const modelsKey = [
  "model-settings",
  "organization-provider",
  "org",
  "openrouter",
  "models",
] as const;
function Harness({
  client,
  organizationId = "org",
  enabled = true,
}: {
  client: OpenGeniBrowserClient;
  organizationId?: string;
  enabled?: boolean;
}) {
  state = useOrganizationProviderConnection({
    client,
    organizationId,
    providerKind: "openrouter",
    enabled,
  });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("organization reads deduplicate across readers and stay fresh for five minutes", async () => {
  let connections = 0,
    models = 0,
    now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const client = {
    getOrganizationModelProviderConnection: async () => {
      connections++;
      return connection();
    },
    listOrganizationProviderCustomModels: async () => {
      models++;
      return { models: [model("first")] };
    },
  } as unknown as OpenGeniBrowserClient;
  const retain = retainSharedQueries(client);
  try {
    await act(async () =>
      root.render(
        <>
          <Harness client={client} />
          <Harness client={client} />
        </>,
      ),
    );
    expect([connections, models]).toEqual([1, 1]);
    await act(async () => root.render(<></>));
    now += 5 * 60_000 - 1;
    await act(async () => root.render(<Harness client={client} />));
    expect(state.settled).toBe(true);
    expect(state.customModels[0]?.id).toBe("first");
    expect([connections, models]).toEqual([1, 1]);
    await act(async () => root.render(<></>));
    now++;
    await act(async () => root.render(<Harness client={client} />));
    expect([connections, models]).toEqual([2, 2]);
    await act(async () => state.refreshConnection());
    await act(async () => state.refreshCustomModels());
    expect([connections, models]).toEqual([3, 3]);
    await act(async () => invalidateSharedQueries(client, ["model-settings"]));
    expect([connections, models]).toEqual([4, 4]);
  } finally {
    clock.mockRestore();
    retain();
  }
});

test("disabled reads, clients and organization identities do not share data", async () => {
  let reads = 0;
  const first = {
    getOrganizationModelProviderConnection: async () => {
      reads++;
      return connection();
    },
    listOrganizationProviderCustomModels: async (org: string) => ({ models: [model(org)] }),
  } as unknown as OpenGeniBrowserClient;
  const pending = deferred<OrganizationModelProviderConnection>();
  const second = {
    getOrganizationModelProviderConnection: () => pending.promise,
    listOrganizationProviderCustomModels: async () => ({ models: [model("second-client")] }),
  } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={first} enabled={false} />));
  expect(reads).toBe(0);
  await act(async () => root.render(<Harness client={first} />));
  expect(state.connected).toBe(true);
  await act(async () => root.render(<Harness client={first} organizationId="other" />));
  expect(state.customModels[0]?.id).toBe("other");
  await act(async () => root.render(<Harness client={second} />));
  expect(state.connected).toBe(false);
  expect(state.customModels[0]?.id).toBe("second-client");
  await act(async () => pending.resolve(connection(2)));
  expect(state.connected).toBe(true);
});

test("connection and custom-model mutations update readers and invalidate retained Models reads", async () => {
  let current: OrganizationModelProviderConnection | null = null;
  let models: OrganizationProviderCustomModel[] = [];
  const client = {
    getOrganizationModelProviderConnection: async () => current,
    listOrganizationProviderCustomModels: async () => ({ models }),
    upsertOrganizationModelProviderConnection: async () => (current = connection()),
    revokeOrganizationModelProviderConnection: async () =>
      (current = { ...connection(2), status: "revoked" }),
    createOrganizationProviderCustomModel: async (
      _org: string,
      _kind: string,
      input: { upstreamModelId: string },
    ) => {
      const saved = model(input.upstreamModelId);
      models = [...models, saved];
      return saved;
    },
    deleteOrganizationProviderCustomModel: async (_org: string, _kind: string, id: string) => {
      models = models.filter((item) => item.id !== id);
    },
  } as unknown as OpenGeniBrowserClient;
  const retain = retainSharedQueries(client);
  try {
    await act(async () => root.render(<Harness client={client} />));
    sharedQueryWriter(client)(["model-settings", "other-scope"], ["old"]);
    await act(async () => {
      expect(await state.saveKey("fixture-key")).toBe(true);
    });
    expect(state.connected).toBe(true);
    expect(peekSharedQuery(client, ["model-settings", "other-scope"])).toBeNull();
    await act(async () => state.addCustomModel("new-model"));
    expect(state.customModels.map((item) => item.id)).toEqual(["new-model"]);
    await act(async () => {
      expect(await state.removeCustomModel(state.customModels[0]!)).toBe(true);
    });
    expect(state.customModels).toEqual([]);
    await act(async () => {
      expect(await state.disconnect()).toBe(true);
    });
    expect(state.connected).toBe(false);
  } finally {
    retain();
  }
});

test("a pre-clear mutation writer cannot restore an old connection or model", async () => {
  const saved = deferred<OrganizationModelProviderConnection>();
  const added = deferred<OrganizationProviderCustomModel>();
  const never = deferred<OrganizationModelProviderConnection | null>();
  const noModels = deferred<{ models: OrganizationProviderCustomModel[] }>();
  let cleared = false;
  const client = {
    getOrganizationModelProviderConnection: async () => (cleared ? never.promise : connection()),
    listOrganizationProviderCustomModels: async () => (cleared ? noModels.promise : { models: [] }),
    upsertOrganizationModelProviderConnection: () => saved.promise,
    createOrganizationProviderCustomModel: () => added.promise,
  } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={client} />));
  let saving!: Promise<boolean>, adding!: Promise<void>;
  await act(async () => {
    saving = state.saveKey("fixture-key");
    adding = state.addCustomModel("late-model");
  });
  cleared = true;
  await act(async () => clearSharedQueries(client));
  await act(async () => {
    saved.resolve(connection(2));
    added.resolve(model("late-model"));
    await Promise.all([saving, adding]);
  });
  expect(peekSharedQuery(client, connectionKey)?.data).toBeNull();
  expect(peekSharedQuery(client, modelsKey)?.data).toBeNull();
  expect(state.connected).toBe(false);
  expect(state.customModels).toEqual([]);
  await act(async () => {
    never.resolve(null);
    noModels.resolve({ models: [] });
  });
});

test("a refused re-read drops cached connection and custom models", async () => {
  let refused = false;
  const read = () => {
    if (refused) throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  const client = {
    getOrganizationModelProviderConnection: async () => {
      read();
      return connection();
    },
    listOrganizationProviderCustomModels: async () => {
      read();
      return { models: [model("private")] };
    },
  } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={client} />));
  refused = true;
  await act(async () => invalidateSharedQueries(client, ["model-settings"]));
  expect(state.connected).toBe(false);
  expect(state.customModels).toEqual([]);
  expect(state.error?.message).toBe("Forbidden");
  expect(state.customModelsError?.message).toBe("Forbidden");
});

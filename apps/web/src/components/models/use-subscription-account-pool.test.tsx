import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type {
  SubscriptionAccountPoolData,
  SubscriptionAccountPoolOperations,
  SubscriptionPoolAccount,
} from "./use-subscription-account-pool";
import { peekSharedQuery, retainSharedQueries } from "@/lib/shared-query";

let createRoot: typeof import("react-dom/client").createRoot;
let usePool: typeof import("./use-subscription-account-pool").useSubscriptionAccountPool;
let root: Root, container: HTMLElement, result: ReturnType<typeof usePool>;
// Account lists are retained per client between mounts; every test gets its own.
let client: object = {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const poolAccount = (id: string): SubscriptionPoolAccount => ({
  id,
  subject: id,
  email: "person@example.test",
  label: null,
  scope: "workspace",
  allocatorVersion: 1,
});
const data = (id: string): SubscriptionAccountPoolData<SubscriptionPoolAccount> => ({
  accounts: [poolAccount(id)],
  activeAccountId: id,
  source: "workspace",
  settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: id },
});
function operations(
  load: () => Promise<SubscriptionAccountPoolData<SubscriptionPoolAccount>>,
  rename = async () => {},
): SubscriptionAccountPoolOperations<SubscriptionPoolAccount> {
  return {
    load,
    rotation: async () => {},
    activate: async () => {},
    allocator: async () => {},
    rename,
    disconnect: async () => {},
  };
}
function Harness({
  identity,
  ops,
  canManage = true,
}: {
  identity: string;
  ops: SubscriptionAccountPoolOperations<SubscriptionPoolAccount>;
  canManage?: boolean;
}) {
  result = usePool({
    client,
    identity,
    operations: ops,
    providerName: "Subscription",
    workspaceId: identity,
    canManage,
  });
  return createElement(
    "output",
    null,
    JSON.stringify({
      accounts: result.accounts,
      working: result.working,
      busy: result.busy,
      loading: result.loading,
      error: result.loadError,
    }),
  );
}
const render = (
  identity: string,
  ops: SubscriptionAccountPoolOperations<SubscriptionPoolAccount>,
  canManage = true,
) =>
  act(async () => {
    root.render(createElement(Harness, { identity, ops, canManage }));
  });
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost" });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  ({ useSubscriptionAccountPool: usePool } = await import("./use-subscription-account-pool"));
});
beforeEach(() => {
  client = {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

test("a late account list never appears in the newly selected scope", async () => {
  const old = deferred<SubscriptionAccountPoolData<SubscriptionPoolAccount>>();
  await render(
    "scope-a",
    operations(() => old.promise),
  );
  await render(
    "scope-b",
    operations(async () => data("account-b")),
  );
  expect(result.accounts.map((account) => account.id)).toEqual(["account-b"]);
  await act(async () => {
    old.resolve(data("account-a"));
    await old.promise;
  });
  expect(result.accounts.map((account) => account.id)).toEqual(["account-b"]);
  expect(result.loading).toBe(false);
});

test("a late failed read cannot clear the next scope's account list", async () => {
  const old = deferred<SubscriptionAccountPoolData<SubscriptionPoolAccount>>();
  await render(
    "scope-a",
    operations(() => old.promise),
  );
  await render(
    "scope-b",
    operations(async () => data("account-b")),
  );
  await act(async () => {
    old.reject(new Error("fixture outage"));
    await old.promise.catch(() => {});
  });
  expect(result.accounts.map((account) => account.id)).toEqual(["account-b"]);
  expect(result.loadError).toBeNull();
});

test("an old mutation cannot mark the next scope as busy or show the old scope's rows", async () => {
  const rename = deferred<void>();
  let oldReads = 0,
    newReads = 0;
  const old = operations(
    async () => {
      oldReads++;
      return data("account-a");
    },
    () => rename.promise,
  );
  await render("scope-a", old);
  let mutation!: Promise<void>;
  await act(async () => {
    mutation = result.rename(result.accounts[0]!, "Name");
  });
  expect(result.busy).toBe(true);
  await render(
    "scope-b",
    operations(async () => {
      newReads++;
      return data("account-b");
    }),
  );
  expect(result.busy).toBe(false);
  await act(async () => {
    rename.resolve();
    await mutation;
  });
  expect(result.accounts.map((account) => account.id)).toEqual(["account-b"]);
  expect(result.busy).toBe(false);
  // The old scope's loader never runs again for the new scope ...
  expect(oldReads).toBe(1);
  // ... but the completed change still invalidates this provider's lists (an
  // organization change can change what a workspace inherits), so the mounted
  // list re-reads once in the background with its own loader.
  expect(newReads).toBe(2);
});

test("inherited accounts cannot be mutated through the workspace pool", async () => {
  let mutations = 0;
  const ops = operations(
    async () => ({ ...data("account-a"), source: "organization" }),
    async () => {
      mutations++;
    },
  );
  await render("scope-a", ops);
  expect(result.canManageAccounts).toBe(false);
  await act(async () => {
    await expect(result.rename(result.accounts[0]!, "Name")).rejects.toThrow("owning scope");
  });
  expect(mutations).toBe(0);
});

test("a revisit renders retained accounts at once and an account change evicts other scopes", async () => {
  // The console keeps reads across navigation for its live client.
  const retained = retainSharedQueries(client);
  let reads = 0;
  let label = "Before";
  const ops = operations(async () => {
    reads++;
    return { ...data("account-a"), accounts: [{ ...poolAccount("account-a"), label }] };
  });
  await render("scope-a", ops);
  expect(result.accounts[0]?.label).toBe("Before");
  // Navigate to another scope's page and back.
  await render(
    "scope-b",
    operations(async () => data("account-b")),
  );
  const rendered: { loading: boolean; ids: string[] }[] = [];
  await render("scope-a", ops);
  rendered.push({ loading: result.loading, ids: result.accounts.map((account) => account.id) });
  expect(rendered[0]).toEqual({ loading: false, ids: ["account-a"] });
  expect(reads).toBe(1);

  // Renaming from scope A's page evicts scope B's retained list too: an
  // organization change can change what a workspace inherits.
  label = "After";
  await act(async () => {
    await result.rename(result.accounts[0]!, "After");
  });
  expect(result.accounts[0]?.label).toBe("After");
  expect(reads).toBe(2);
  expect(
    peekSharedQuery(client, ["subscription-pool", "Subscription", "workspace", "scope-b"]),
  ).toBeNull();
  retained();
});

test("an account change that settles after the page is left still invalidates retained lists", async () => {
  const retained = retainSharedQueries(client);
  let reads = 0;
  let label = "Before";
  const renamed = deferred<void>();
  const ops = operations(
    async () => {
      reads++;
      return { ...data("account-a"), accounts: [{ ...poolAccount("account-a"), label }] };
    },
    () => renamed.promise,
  );
  await render("scope-a", ops);
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.rename(result.accounts[0]!, "After").catch(() => undefined);
  });
  // Leave Settings while the rename is still being saved.
  await act(async () => root.render(createElement("div")));
  label = "After";
  await act(async () => {
    renamed.resolve();
    await pending;
  });
  expect(
    peekSharedQuery(client, ["subscription-pool", "Subscription", "workspace", "scope-a"]),
  ).toBeNull();
  // Coming back never shows the pre-rename row, even for one frame.
  const labels: (string | null | undefined)[] = [];
  function Probe() {
    const pool = usePool({
      client,
      identity: "scope-a",
      operations: ops,
      providerName: "Subscription",
      workspaceId: "scope-a",
      canManage: true,
    });
    labels.push(pool.accounts[0]?.label);
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  expect(labels).not.toContain("Before");
  expect(labels.at(-1)).toBe("After");
  expect(reads).toBe(2);
  retained();
});

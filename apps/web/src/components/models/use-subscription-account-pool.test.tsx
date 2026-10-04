import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type {
  SubscriptionAccountPoolData,
  SubscriptionAccountPoolOperations,
  SubscriptionPoolAccount,
} from "./use-subscription-account-pool";
let createRoot: typeof import("react-dom/client").createRoot;
let usePool: typeof import("./use-subscription-account-pool").useSubscriptionAccountPool;
let root: Root, container: HTMLElement, result: ReturnType<typeof usePool>;
const client = {};
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

test("an old mutation cannot refresh or mark the next scope as busy", async () => {
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
  expect(oldReads).toBe(1);
  expect(newReads).toBe(1);
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

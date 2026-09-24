import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useConnectionAccounts } from "./use-connection-accounts";

let container: HTMLDivElement;
let root: Root;
let state: ReturnType<typeof useConnectionAccounts>;
const selectedMailIds = ["mail"];
const catalog = [
  {
    enabled: true,
    name: "Mail",
    runtime: { mcpServerId: "mail" },
    connectionRef: { providerDomain: "example.com", subjectScope: "subject" },
  },
] as CapabilityCatalogItem[];
const accounts = ["one", "two"].map((id) => ({
  id,
  subjectId: "me",
  authorityId: "authority",
  status: "active",
  providerDomain: "example.com",
})) as ConnectionMetadata[];
function Harness({
  client,
  id = "session",
  workspaceId = "workspace",
  selectedIds = selectedMailIds,
  canReadConnections = true,
}: {
  client: OpenGeniBrowserClient;
  id?: string;
  workspaceId?: string;
  selectedIds?: string[];
  canReadConnections?: boolean | null;
}) {
  state = useConnectionAccounts(
    client,
    { id, workspaceId, selectedIds },
    catalog,
    canReadConnections,
  );
  return null;
}
function clientFor(load: () => Promise<ConnectionMetadata[]>) {
  return { listOwnConnectionAccounts: load } as unknown as OpenGeniBrowserClient;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
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

test("defaults attach all accounts; explicit narrowing survives inventory refresh and connector toggles", async () => {
  let inventory = accounts;
  const client = clientFor(async () => inventory);
  await act(async () => root.render(<Harness client={client} />));
  expect(state.selections).toHaveLength(2);
  await act(async () => state.selectAccount("mail", ["two"]));
  inventory = [...accounts].reverse();
  await act(async () => state.refresh());
  expect(state.selections).toEqual([{ serverId: "mail", connectionId: "two" }]);
  await act(async () => root.render(<Harness client={client} selectedIds={[]} />));
  expect(state.selections).toEqual([]);
  expect(state.accountGroups).toEqual([]);
  expect(state.availableAccountGroups).toHaveLength(1);
  await act(async () => root.render(<Harness client={client} />));
  expect(state.selections).toEqual([{ serverId: "mail", connectionId: "two" }]);
  inventory = [accounts[0]!];
  await act(async () => state.refresh());
  expect(state.requiresAccountChoice).toBe(true);
  expect(state.accountChoiceMessage).toContain("Review accounts for Mail");
  expect(state.selections).toEqual([]);
});

test("a default connector with no eligible accounts does not block; an explicit stale choice still does", async () => {
  let inventory: ConnectionMetadata[] = [];
  const client = clientFor(async () => inventory);
  await act(async () => root.render(<Harness client={client} />));
  expect(state.loading).toBe(false);
  expect(state.error).toBeNull();
  expect(state.requiresAccountChoice).toBe(false);
  expect(state.accountChoiceMessage).toBeNull();
  expect(state.selections).toEqual([]);
  inventory = accounts;
  await act(async () => state.refresh());
  await act(async () => state.selectAccount("mail", ["two"]));
  inventory = [];
  await act(async () => state.refresh());
  expect(state.requiresAccountChoice).toBe(true);
  expect(state.accountChoiceMessage).toContain("+ → Connectors");
  expect(state.selections).toEqual([]);
});

test("caller, session and workspace changes reset choices and fence stale inventory", async () => {
  const first = clientFor(async () => accounts);
  await act(async () => root.render(<Harness client={first} />));
  await act(async () => state.selectAccount("mail", ["two"]));
  let resolve!: (accounts: ConnectionMetadata[]) => void;
  const second = clientFor(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<Harness client={second} />));
  expect(state.loading).toBe(true);
  expect(state.accountChoices).toEqual({});
  expect(state.selections).toEqual([]);
  const third = clientFor(async () => [accounts[0]!]);
  await act(async () => root.render(<Harness client={third} />));
  await act(async () => resolve(accounts));
  expect(state.selections).toEqual([{ serverId: "mail", connectionId: "one" }]);
  await act(async () => state.selectAccount("mail", []));
  await act(async () => root.render(<Harness client={third} id="another-session" />));
  expect(state.accountChoices).toEqual({});
  await act(async () => state.selectAccount("mail", []));
  await act(async () =>
    root.render(<Harness client={third} id="another-session" workspaceId="other-workspace" />),
  );
  expect(state.accountChoices).toEqual({});
});

test("failed inventory blocks sending and retry recovers without forgetting exclusions", async () => {
  let fail = false;
  const client = clientFor(async () => {
    if (fail) throw new Error("Cannot load accounts");
    return accounts;
  });
  await act(async () => root.render(<Harness client={client} />));
  await act(async () => state.selectAccount("mail", ["two"]));
  fail = true;
  await act(async () => state.refresh());
  expect(state.error).toBe("Cannot load accounts");
  expect(state.selections).toEqual([]);
  fail = false;
  await act(async () => state.refresh());
  expect(state.error).toBeNull();
  expect(state.selections).toEqual([{ serverId: "mail", connectionId: "two" }]);
  expect(state.accessDenied).toBe(false);
});

test("403 refresh hides prior accounts and gives scoped permission guidance until access returns", async () => {
  let denied = false;
  const client = clientFor(async () => {
    if (denied) throw { status: 403 };
    return accounts;
  });
  await act(async () => root.render(<Harness client={client} />));
  expect(state.selections).toHaveLength(2);
  denied = true;
  await act(async () => state.refresh());
  expect(state.availableAccountGroups).toEqual([]);
  expect(state.selections).toEqual([]);
  expect(state.error).toContain("Ask a workspace admin for connection access");
  expect(state.accessDenied).toBe(true);

  denied = false;
  await act(async () => state.refresh());
  expect(state.error).toBeNull();
  expect(state.accessDenied).toBe(false);
  expect(state.selections).toHaveLength(2);
});

test("a member without selected native connectors retains the normal Send gate after a 403", async () => {
  const client = clientFor(async () => {
    throw { status: 403 };
  });
  await act(async () => root.render(<Harness client={client} selectedIds={[]} />));
  expect(state.loading).toBe(false);
  expect(state.error).toBeNull();
  expect(state.accessDenied).toBe(false);
  expect(state.requiresAccountChoice).toBe(false);
  expect(state.selections).toEqual([]);
});

test("same-client live grant loss masks cached labels and choices before effects; restoration fences old responses", async () => {
  for (const outcome of ["success", "403", "503"] as const) {
    const stale = deferred<ConnectionMetadata[]>();
    const restored = deferred<ConnectionMetadata[]>();
    let reads = 0;
    const client = clientFor(() => {
      reads++;
      return reads === 1
        ? Promise.resolve(accounts)
        : reads === 2
          ? stale.promise
          : restored.promise;
    });
    await act(async () => root.render(<Harness client={client} />));
    expect(state.selections).toHaveLength(2);
    await act(async () => state.selectAccount("mail", ["two"]));
    const oldSelect = state.selectAccount;
    const oldReset = state.resetEmptyChoices;
    const oldRefresh = state.refresh;
    // The hook refresh is explicit; start a second inventory read before revocation.
    await act(async () => {
      void state.refresh();
    });
    expect(reads).toBe(2);

    await act(async () => root.render(<Harness client={client} canReadConnections={false} />));
    expect(state.availableAccountGroups).toEqual([]);
    expect(state.accountGroups).toEqual([]);
    expect(state.accountChoices).toEqual({});
    expect(state.selections).toEqual([]);
    expect(state.accessDenied).toBe(true);
    expect(state.error).toContain("Ask a workspace admin");
    await act(async () => {
      oldSelect("mail", ["one"]);
      oldReset();
      await oldRefresh();
    });
    expect(reads).toBe(2);

    await act(async () => root.render(<Harness client={client} canReadConnections />));
    expect(reads).toBe(3);
    expect(state.loading).toBe(true);
    expect(state.accountChoices).toEqual({});
    expect(state.availableAccountGroups).toEqual([]);
    await act(async () => {
      oldSelect("mail", ["two"]);
      oldReset();
      await oldRefresh();
    });
    expect(reads).toBe(3);
    await act(async () => {
      if (outcome === "success") stale.resolve(accounts);
      else stale.reject({ status: Number(outcome) });
      await Bun.sleep(0);
    });
    expect(state.selections).toEqual([]);
    expect(state.availableAccountGroups).toEqual([]);
    await act(async () => {
      restored.resolve([accounts[0]!]);
      await Bun.sleep(0);
    });
    expect(state.error).toBeNull();
    expect(state.selections).toEqual([{ serverId: "mail", connectionId: "one" }]);
    expect(state.accountChoices).toEqual({});
    // Between cases use a new identity, not a stale result or an in-flight hook.
    await act(async () => root.render(<Harness client={client} id={`done-${outcome}`} />));
  }
});

test("bootstrapping never reads accounts and a missing grant does not block Send without a native connector", async () => {
  let reads = 0;
  const client = clientFor(async () => {
    reads++;
    return accounts;
  });
  await act(async () => root.render(<Harness client={client} canReadConnections={null} />));
  expect(reads).toBe(0);
  expect(state.selections).toEqual([]);
  await act(async () =>
    root.render(<Harness client={client} canReadConnections={false} selectedIds={[]} />),
  );
  expect(state.loading).toBe(false);
  expect(state.error).toBeNull();
  expect(state.requiresAccountChoice).toBe(false);
  await act(async () => root.render(<Harness client={client} canReadConnections />));
  expect(reads).toBe(1);
});

test("returning to connector defaults restores emptied accounts but preserves nonempty narrowing", async () => {
  const client = clientFor(async () => accounts);
  await act(async () => root.render(<Harness client={client} />));
  await act(async () => state.selectAccount("mail", []));
  await act(async () => root.render(<Harness client={client} selectedIds={[]} />));
  expect(state.requiresAccountChoice).toBe(false);
  await act(async () => {
    state.resetEmptyChoices();
    root.render(<Harness client={client} />);
  });
  expect(state.requiresAccountChoice).toBe(false);
  expect(state.selections).toHaveLength(2);
  await act(async () => state.selectAccount("mail", ["two"]));
  await act(async () => state.resetEmptyChoices());
  expect(state.selections).toEqual([{ serverId: "mail", connectionId: "two" }]);
});

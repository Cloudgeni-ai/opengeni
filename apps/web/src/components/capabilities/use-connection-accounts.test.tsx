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
}: {
  client: OpenGeniBrowserClient;
  id?: string;
  workspaceId?: string;
  selectedIds?: string[];
}) {
  state = useConnectionAccounts(client, { id, workspaceId, selectedIds }, catalog);
  return null;
}
function clientFor(load: () => Promise<ConnectionMetadata[]>) {
  return { listOwnConnectionAccounts: load } as unknown as OpenGeniBrowserClient;
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
  await act(async () => root.render(<Harness client={client} />));
  expect(state.selections).toEqual([{ serverId: "mail", connectionId: "two" }]);
  inventory = [accounts[0]!];
  await act(async () => state.refresh());
  expect(state.requiresAccountChoice).toBe(true);
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
});

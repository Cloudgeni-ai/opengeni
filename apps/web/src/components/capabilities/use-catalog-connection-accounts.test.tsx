import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectionMetadata } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCatalogConnectionAccounts } from "./use-catalog-connection-accounts";

let root: Root;
let container: HTMLDivElement;
let result: ReturnType<typeof useCatalogConnectionAccounts>;
const accounts = [
  { id: "own-account", workspaceId: "other-workspace", status: "needs_reauth" },
] as ConnectionMetadata[];
function Harness({
  client,
  authority = "owner",
  canRead = true,
}: {
  client: OpenGeniBrowserClient;
  authority?: string;
  canRead?: boolean | null;
}) {
  result = useCatalogConnectionAccounts(client, "workspace", authority, canRead, true, 0);
  return null;
}
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("settings request own organization-wide inventory including accounts needing repair", async () => {
  const load = mock(async () => accounts);
  const client = { listOwnConnectionAccounts: load } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={client} />));
  expect(load).toHaveBeenCalledWith("workspace", { includeInactive: true });
  expect(result.connections).toEqual(accounts);
});

test("identity changes clear accounts immediately and fence outstanding reads", async () => {
  let finish!: (rows: ConnectionMetadata[]) => void;
  const client = {
    listOwnConnectionAccounts: () =>
      new Promise<ConnectionMetadata[]>((resolve) => {
        finish = resolve;
      }),
  } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={client} />));
  const oldFinish = finish;
  await act(async () => root.render(<Harness client={client} authority="another-owner" />));
  expect(result.connections).toBeNull();
  await act(async () => oldFinish(accounts));
  expect(result.connections).toBeNull();
  await act(async () => finish([]));
  expect(result.connections).toEqual([]);
  await act(async () => root.render(<Harness client={client} canRead={false} />));
  expect(result.connections).toBeNull();
  expect(result.accessDenied).toBe(true);
});

test("failures are retryable and denied responses never retain stale personal rows", async () => {
  let failure: { status: number } | null = null;
  const client = {
    listOwnConnectionAccounts: async () => {
      if (failure) throw failure;
      return accounts;
    },
  } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={client} />));
  failure = { status: 500 };
  await act(async () => result.onRetry());
  expect(result.connections).toBeNull();
  expect(result.loadFailed).toBe(true);
  failure = null;
  await act(async () => result.onRetry());
  expect(result.connections).toEqual(accounts);
  failure = { status: 403 };
  await act(async () => result.onRetry());
  expect(result.connections).toBeNull();
  expect(result.accessDenied).toBe(true);
});

test("an earlier refresh denial clears cached rows while a newer request is pending", async () => {
  const pending: Array<{
    resolve: (rows: ConnectionMetadata[]) => void;
    reject: (error: unknown) => void;
  }> = [];
  let initial = true;
  const client = {
    listOwnConnectionAccounts: async () => {
      if (initial) {
        initial = false;
        return accounts;
      }
      return await new Promise<ConnectionMetadata[]>((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
  } as unknown as OpenGeniBrowserClient;
  await act(async () => root.render(<Harness client={client} />));
  await act(async () => {
    result.onRetry();
    result.onRetry();
  });
  expect(result.connections).toEqual(accounts);
  await act(async () => pending[0]!.reject({ status: 403 }));
  expect(result.connections).toBeNull();
  expect(result.accessDenied).toBe(true);
  await act(async () => pending[1]!.resolve(accounts));
  expect(result.connections).toEqual(accounts);
  expect(result.accessDenied).toBe(false);
});

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const {
  invalidateSubscriptionAccountQueries,
  MODEL_CONNECTIONS_CHANGED,
  peekSharedQuery,
  retainSharedQueries,
  sharedQueryWriter,
  useConsoleSharedQueries,
  useSharedQuery,
} = await import("./shared-query");
type SharedQueryKey = import("./shared-query").SharedQueryKey;

test("an access change drops every retained subscription account list, and only those", async () => {
  const client = {};
  const release = retainSharedQueries(client);
  try {
    const lists: SharedQueryKey[] = [
      ["codex-accounts", "workspace-a"],
      ["codex-accounts", "workspace-a", "session", "session-1"],
      ["codex-accounts", "organization", "organization-a"],
      ["subscription-pool", "Claude", "workspaces", "workspace-a"],
      ["supergrok-accounts", "workspace-a"],
    ];
    // Live usage readings are per account, not which accounts a workspace sees.
    const kept: SharedQueryKey = ["codex-live-usage", "workspace-a"];
    const write = sharedQueryWriter(client);
    for (const key of [...lists, kept]) expect(write(key, { rows: [] })).toBe(true);

    await invalidateSubscriptionAccountQueries(client);

    for (const key of lists) expect(peekSharedQuery(client, key)).toBeNull();
    expect(peekSharedQuery(client, kept)?.data).toEqual({ rows: [] });
  } finally {
    release();
  }
});

describe("the console's cache wiring", () => {
  const listKey: SharedQueryKey = ["codex-accounts", "workspace-a"];

  /** One signed-in identity's client and what its list reads return. */
  function identity(person: string) {
    const client = { person };
    const reads = { count: 0 };
    const load = async () => {
      reads.count += 1;
      return `${person}-rows-${reads.count}`;
    };
    return { client, reads, load };
  }

  function AccountList({ client, load }: { client: object; load: () => Promise<string> }) {
    const { data, loading } = useSharedQuery(client, listKey, load);
    return <span>{data ?? (loading ? "loading" : "none")}</span>;
  }

  /** The root that owns the client (context.tsx), with an optional page below it. */
  function Console({ client, children }: { client: object; children?: ReactNode }) {
    useConsoleSharedQueries(client);
    return <>{children}</>;
  }

  async function settle(ms = 0) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  test("keeps reads across navigation, drops them on an identity change, and re-reads on access changes", async () => {
    const alice = identity("alice");
    const bob = identity("bob");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const page = (who: ReturnType<typeof identity>, onModels: boolean) => (
      <Console client={who.client}>
        {onModels ? <AccountList client={who.client} load={who.load} /> : null}
      </Console>
    );
    try {
      await act(async () => root.render(page(alice, true)));
      await settle();
      expect(container.textContent).toBe("alice-rows-1");

      // Leave Models and come back: the root retained the read.
      await act(async () => root.render(page(alice, false)));
      await settle();
      await act(async () => root.render(page(alice, true)));
      expect(container.textContent).toBe("alice-rows-1");
      expect(alice.reads.count).toBe(1);

      // An "Available in" save elsewhere re-reads the mounted list.
      await act(async () => {
        window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED));
      });
      await settle();
      expect(alice.reads.count).toBe(2);
      expect(container.textContent).toBe("alice-rows-2");

      // Sign-in as someone else: the console creates a new client. Nothing
      // Alice read is shown or kept.
      await act(async () => root.render(page(bob, true)));
      await settle();
      expect(container.textContent).toBe("bob-rows-1");
      expect(peekSharedQuery(alice.client, listKey)).toBeNull();
      // Alice's client no longer listens for access changes.
      await act(async () => {
        window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED));
      });
      await settle();
      expect(alice.reads.count).toBe(2);
      expect(bob.reads.count).toBe(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("context.tsx wires it to the client it replaces on every identity change", async () => {
    const source = await Bun.file(`${import.meta.dir}/../context.tsx`).text();
    const memo = source.indexOf("const client = useMemo(() => {");
    expect(memo).toBeGreaterThanOrEqual(0);
    const wiring = source.indexOf("useConsoleSharedQueries(client);", memo);
    expect(wiring).toBeGreaterThan(memo);
    // The client is recreated per access-key version (the identity fence).
    expect(source.slice(memo, wiring)).toContain(
      "[accessKeyVersion, sessionChannelProjectionAuthority]",
    );
  });
});

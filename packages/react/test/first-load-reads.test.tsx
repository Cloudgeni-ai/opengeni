// The app's first load reads each startup resource once. The rail, the home
// page, the composer and the chat's credit notices mount moments apart and each
// need the inbox, the channels, the billing summary, the capability catalog,
// the connection accounts and the client config; they share one read per
// resource instead of sending their own. Refreshes and polls still read anew.
import type { AccessContext } from "@opengeni/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";

import { AppContext, type AppContextValue } from "../src/app/app-context";
import { useCreditBalance } from "../src/app/components/credits/use-credit-balance";
import { inboxStoreFor, useInbox } from "../src/app/lib/inbox";
import {
  loadConnectionHealthAccounts,
  loadWorkspaceCapabilities,
} from "../src/app/lib/capabilities";
import { fetchSharedQuery, retainSharedQueries } from "../src/hooks/shared-query";
import { useChannels } from "../src/hooks/use-channels";
import {
  cachedClientConfigRead,
  joinClientConfigRead,
  noteClientCreated,
  rememberClientConfigRead,
} from "../src/lib/client-config-read";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ACCOUNT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Endpoint =
  | "GET /v1/inbox"
  | "GET /v1/workspaces/:id/channels"
  | "GET /v1/billing"
  | "GET /v1/workspaces/:id/capabilities"
  | "GET /v1/workspaces/:id/connections/accounts"
  | "GET /v1/config/client";

function countingClient() {
  const requests = new Map<Endpoint, number>([
    ["GET /v1/config/client", 0],
    ["GET /v1/inbox", 0],
    ["GET /v1/workspaces/:id/channels", 0],
    ["GET /v1/billing", 0],
    ["GET /v1/workspaces/:id/capabilities", 0],
    ["GET /v1/workspaces/:id/connections/accounts", 0],
  ]);
  const hit = (endpoint: Endpoint) => requests.set(endpoint, (requests.get(endpoint) ?? 0) + 1);
  const client = fakeClient({
    listInbox: async () => {
      hit("GET /v1/inbox");
      return { items: [], needsYouCount: 0, unreadCount: 0 };
    },
    listChannels: async () => {
      hit("GET /v1/workspaces/:id/channels");
      return [];
    },
    getBilling: async () => {
      hit("GET /v1/billing");
      return { mode: "stripe", balance: { balanceMicros: 5_000_000, currency: "usd" } };
    },
    listCapabilities: async () => {
      hit("GET /v1/workspaces/:id/capabilities");
      return { items: [] };
    },
    listOwnConnectionAccounts: async () => {
      hit("GET /v1/workspaces/:id/connections/accounts");
      return [];
    },
    getClientConfig: async () => {
      hit("GET /v1/config/client");
      return { apiContractRevision: "contract" };
    },
  } as never) as never as Parameters<typeof useCreditBalance>[0] & {
    listCapabilities: (workspaceId: string) => Promise<{ items: unknown[] }>;
    listOwnConnectionAccounts: (
      workspaceId: string,
      options: { includeInactive: boolean },
    ) => Promise<never[]>;
    getClientConfig: () => Promise<{ apiContractRevision: string }>;
  };
  return { client, requests };
}

function appContext(client: object): AppContextValue {
  const accessContext = {
    mode: "managed",
    subjectId: "user:one",
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
    workspaceGrants: [],
    accountGrants: [
      {
        accountId: ACCOUNT_ID,
        subjectId: "user:one",
        role: "owner",
        permissions: ["billing:read"],
      },
    ],
  } as unknown as AccessContext;
  return {
    client,
    accessContext,
    accessKeyVersion: 0,
    authSession: null,
    workspaces: [{ id: WORKSPACE_ID, accountId: ACCOUNT_ID }],
  } as unknown as AppContextValue;
}

// One startup consumer: the inbox, the channels and the billing summary.
function Consumer({ client }: { client: Parameters<typeof useCreditBalance>[0] }) {
  useInbox({ workspaceId: WORKSPACE_ID });
  useChannels({ client: client as never, workspaceId: WORKSPACE_ID });
  useCreditBalance(client, ACCOUNT_ID, true);
  return null;
}

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

describe("first load", () => {
  test("reads each startup resource once, and refreshes still read anew", async () => {
    const { client, requests } = countingClient();
    // The console keeps reads across mounts for its client.
    release = retainSharedQueries(client);
    const context = appContext(client);
    const tree = (children: ReactNode) => (
      <AppContext.Provider value={context}>{children}</AppContext.Provider>
    );

    // The bootstrap reads the config itself; the API client's first contract
    // check and the capability flags follow a moment later.
    const startedAt = Date.now();
    noteClientCreated(client, startedAt);
    rememberClientConfigRead(
      client,
      { apiContractRevision: "contract" },
      { startedAt, readAt: Date.now() },
    );
    await joinClientConfigRead(client, undefined, { settledWithinMs: 10_000 });
    await cachedClientConfigRead(client);

    // The rail mounts first and its reads settle.
    const view = await renderComponent(tree(<Consumer key="rail" client={client} />));
    await flush();
    // The workspace tool list reads the catalog; the composer's connector list
    // and account picker read the catalog and the accounts.
    await loadWorkspaceCapabilities(client, WORKSPACE_ID, { reuseRecent: true });
    await loadConnectionHealthAccounts(client, WORKSPACE_ID, { reuseRecent: true });

    // Then the home page and the composer's credit prompt mount.
    await view.rerender(
      tree(
        <>
          <Consumer key="rail" client={client} />
          <Consumer key="page" client={client} />
        </>,
      ),
    );
    await flush();
    await Promise.all([
      loadWorkspaceCapabilities(client, WORKSPACE_ID, { reuseRecent: true }),
      loadConnectionHealthAccounts(client, WORKSPACE_ID, { reuseRecent: true }),
      loadConnectionHealthAccounts(client, WORKSPACE_ID, { reuseRecent: true }),
    ]);

    expect(Object.fromEntries(requests)).toEqual({
      "GET /v1/config/client": 0,
      "GET /v1/inbox": 1,
      "GET /v1/workspaces/:id/channels": 1,
      "GET /v1/billing": 1,
      "GET /v1/workspaces/:id/capabilities": 1,
      "GET /v1/workspaces/:id/connections/accounts": 1,
    } satisfies Record<Endpoint, number>);

    // A change re-reads: a tools refresh, an account reload, an inbox action
    // and the next contract check after the startup window.
    await actRun(async () => {
      await loadWorkspaceCapabilities(client, WORKSPACE_ID);
      await loadConnectionHealthAccounts(client, WORKSPACE_ID);
      await inboxStoreFor(context).refresh();
      await joinClientConfigRead(client);
    });
    expect(requests.get("GET /v1/workspaces/:id/capabilities")).toBe(2);
    expect(requests.get("GET /v1/workspaces/:id/connections/accounts")).toBe(2);
    expect(requests.get("GET /v1/inbox")).toBe(2);
    expect(requests.get("GET /v1/config/client")).toBe(1);
    await view.unmount();
  });

  test("a startup config read before the client existed, or an old one, is not taken", async () => {
    const config = { apiContractRevision: "contract" };
    // Read before this client was created (before sign-in, or another identity's).
    const early = countingClient();
    const readStarted = Date.now() - 1;
    noteClientCreated(early.client, Date.now());
    rememberClientConfigRead(early.client, config, { startedAt: readStarted, readAt: Date.now() });
    await cachedClientConfigRead(early.client);
    expect(early.requests.get("GET /v1/config/client")).toBe(1);

    // Read by this client's host, but past the startup window.
    const late = countingClient();
    const created = Date.now() - 60_000;
    noteClientCreated(late.client, created);
    rememberClientConfigRead(late.client, config, { startedAt: created, readAt: created + 1 });
    await joinClientConfigRead(late.client, undefined, { settledWithinMs: 10_000 });
    expect(late.requests.get("GET /v1/config/client")).toBe(1);

    // A client the host never noted takes nothing.
    const unknown = countingClient();
    rememberClientConfigRead(unknown.client, config, { startedAt: Date.now(), readAt: Date.now() });
    await cachedClientConfigRead(unknown.client);
    expect(unknown.requests.get("GET /v1/config/client")).toBe(1);
  });

  test("a read reusing recent data joins a fresh read in flight", async () => {
    const scope = {};
    const stop = retainSharedQueries(scope);
    try {
      let version = "old";
      let finish!: () => void;
      const load = async () => {
        if (version === "new") await new Promise<void>((resolve) => (finish = resolve));
        return version;
      };
      expect(await fetchSharedQuery(scope, ["accounts"], load)).toBe("old");
      // A connect finishes: the next read is fresh, and still in flight.
      version = "new";
      const fresh = fetchSharedQuery(scope, ["accounts"], load, { fresh: true });
      const reuse = fetchSharedQuery(scope, ["accounts"], load);
      finish();
      expect(await fresh).toBe("new");
      expect(await reuse).toBe("new");
    } finally {
      stop();
    }
  });
});

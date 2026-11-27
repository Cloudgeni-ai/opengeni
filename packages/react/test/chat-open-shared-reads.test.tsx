// Opening a chat reads its lineage and the inbox once. The chat page, the
// session rail and the mobile header each read the chat's lineage; the rail
// and the header learn the open chat moments after the page's read settled.
// A deep link's rail reads the inbox moments before the chat marks its replies
// read. Each takes the read from moments ago; refreshes, polls and leaving the
// chat still read anew.
import type { AccessContext, InboxItem, ListInboxResponse } from "@opengeni/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";

import { AppContext, type AppContextValue } from "../src/app/app-context";
import { inboxStoreFor, useReadSessionInbox } from "../src/app/lib/inbox";
import { useSessionLineage } from "../src/hooks/use-session-lineage";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function lineageClient(options: { stamped: boolean }) {
  let reads = 0;
  let clock = 40;
  const client = fakeClient({
    getSessionLineage: async (_workspaceId, sessionId, read) => {
      reads += 1;
      // The app's client stamps each shared read with its causal clock.
      read?.onRequestStart?.(options.stamped ? ++clock : undefined);
      return {
        ancestors: [],
        children: [{ id: `child-of-${sessionId}-${reads}` }],
        truncated: false,
      } as never;
    },
  });
  return { client, reads: () => reads };
}

function personContext(client: object): AppContextValue {
  return {
    client,
    accessContext: { mode: "managed", subjectId: "user:one" } as unknown as AccessContext,
    accessKeyVersion: 0,
    authSession: null,
    workspaces: [],
  } as unknown as AppContextValue;
}

type Readers = { rail: string | null; header: string | null };

async function renderReaders(client: ReturnType<typeof lineageClient>["client"]) {
  // The rail's own clock, used only for a read the client does not stamp.
  const railClock = () => 0;
  const hook = await renderHook(
    ({ rail, header }: Readers) => ({
      page: useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      rail: useSessionLineage(rail, { client, workspaceId: WORKSPACE_ID, beginRead: railClock }),
      header: useSessionLineage(header, { client, workspaceId: WORKSPACE_ID }),
    }),
    { rail: null, header: null } as Readers,
  );
  cleanup = hook.unmount;
  return hook;
}

describe("opening a chat", () => {
  test("the rail and the header take the page's lineage read; refreshes read anew", async () => {
    const { client, reads } = lineageClient({ stamped: true });
    const hook = await renderReaders(client);
    await flush();
    expect(reads()).toBe(1);

    // The rail and the header learn the open chat after the page's read settled.
    await hook.rerender({ rail: SESSION_ID, header: SESSION_ID });
    await flush();
    expect(reads()).toBe(1);
    const { page, rail, header } = hook.result.current;
    expect(rail.lineage).toEqual(page.lineage);
    expect(header.lineage).toEqual(page.lineage);
    // Ordered exactly as the page's read: the same causal stamp.
    expect(rail.readGeneration).toBe(page.readGeneration);
    expect(header.readGeneration).toBe(page.readGeneration);

    await actRun(() => hook.result.current.rail.refresh());
    expect(reads()).toBe(2);

    // Another chat is not this one's read.
    await hook.rerender({ rail: "33333333-3333-4333-8333-333333333333", header: SESSION_ID });
    await flush();
    expect(reads()).toBe(3);
  });

  test("a read without the client's shared clock is not taken", async () => {
    const { client, reads } = lineageClient({ stamped: false });
    const hook = await renderReaders(client);
    await flush();
    await hook.rerender({ rail: SESSION_ID, header: null });
    await flush();
    expect(reads()).toBe(2);
  });

  test("marks the chat's replies read from the rail's inbox list, and reads anew on leaving", async () => {
    const reply = (id: string, unread: boolean) =>
      ({ id, sessionId: SESSION_ID, kind: "reply", unread }) as unknown as InboxItem;
    let inbox: ListInboxResponse = {
      items: [reply("first", true)],
      needsYouCount: 0,
      unreadCount: 1,
    };
    let listed = 0;
    const seen: string[] = [];
    const client = fakeClient({
      listInbox: async () => {
        listed += 1;
        return inbox;
      },
      updateInboxItem: async (id: string) => {
        seen.push(id);
        return {};
      },
    } as never);
    const context = personContext(client);
    // The rail's first read.
    await inboxStoreFor(context).refresh();
    expect(listed).toBe(1);

    const tree = (children: ReactNode) => (
      <AppContext.Provider value={context}>{children}</AppContext.Provider>
    );
    const hook = await renderHook(() => useReadSessionInbox(SESSION_ID), undefined, {
      wrapper: ({ children }: { children: ReactNode }) => tree(children),
    });
    await flush();
    expect(listed).toBe(1);
    expect(seen).toEqual(["first"]);
    expect(inboxStoreFor(context).snapshot.data?.items).toEqual([reply("first", false)]);

    // A reply that arrived while the chat was open is read on leaving.
    inbox = { items: [reply("second", true)], needsYouCount: 0, unreadCount: 1 };
    await hook.unmount();
    await flush();
    expect(listed).toBe(2);
    expect(seen).toEqual(["first", "second"]);
  });
});

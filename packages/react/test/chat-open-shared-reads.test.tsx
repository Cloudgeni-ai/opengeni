// Opening a chat reads its lineage and the inbox once. The chat page, the
// session rail and the mobile header each read the chat's lineage; the rail
// and the header learn the open chat moments after the page's read started.
// While they are mounted together, a reader's first read takes the latest read
// another started (joining it in flight); nothing outlives its readers or
// crosses viewers. A deep link's rail reads the inbox as the chat marks its
// replies read: one request. Refreshes, polls, reopening and leaving the chat
// still read anew.
import type { AccessContext, InboxItem, ListInboxResponse } from "@opengeni/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";

import { AppContext, type AppContextValue } from "../src/app/app-context";
import { inboxStoreFor, useInbox, useReadSessionInbox } from "../src/app/lib/inbox";
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
  // While held, reads wait until `release()`.
  let held: Array<() => void> | null = null;
  const client = fakeClient({
    getSessionLineage: async (_workspaceId, sessionId, read) => {
      reads += 1;
      const version = reads;
      // The app's client stamps each shared read with its causal clock.
      read?.onRequestStart?.(options.stamped ? ++clock : undefined);
      if (held) await new Promise<void>((resolve) => held?.push(resolve));
      return {
        ancestors: [],
        children: [{ id: `child-of-${sessionId}-${version}` }],
        truncated: false,
      } as never;
    },
  });
  return {
    client,
    reads: () => reads,
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const resolve of waiting) resolve();
    },
  };
}

const VIEWER = "viewer-one";

// The fake lineage's children are bare ids.
function firstChildId(lineage: { children: readonly unknown[] } | null | undefined) {
  return (lineage?.children[0] as { id?: string } | undefined)?.id;
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
      page: useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, viewer: VIEWER }),
      rail: useSessionLineage(rail, {
        client,
        workspaceId: WORKSPACE_ID,
        beginRead: railClock,
        viewer: VIEWER,
      }),
      header: useSessionLineage(header, { client, workspaceId: WORKSPACE_ID, viewer: VIEWER }),
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

  test("a reader mounting during a newer read joins it and ends fresh", async () => {
    const lineage = lineageClient({ stamped: true });
    const hook = await renderReaders(lineage.client);
    await flush();
    expect(lineage.reads()).toBe(1);

    // The page refreshes; the rail and the header mount while it is in flight.
    lineage.hold();
    // Started outside act, so the readers' mount effects run while it is held.
    const refreshed = hook.result.current.page.refresh();
    await hook.rerender({ rail: SESSION_ID, header: SESSION_ID });
    await flush();
    expect(lineage.reads()).toBe(2);
    lineage.release();
    await actRun(() => refreshed);
    await flush();
    expect(lineage.reads()).toBe(2);
    const { page, rail, header } = hook.result.current;
    expect(firstChildId(page.lineage)).toBe(`child-of-${SESSION_ID}-2`);
    expect(rail.lineage).toEqual(page.lineage);
    expect(header.lineage).toEqual(page.lineage);
    expect(rail.readGeneration).toBe(page.readGeneration);
  });

  test("leaving the chat and returning within moments reads again", async () => {
    const { client, reads } = lineageClient({ stamped: true });
    const first = await renderHook(
      () => useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, viewer: VIEWER }),
      undefined,
    );
    await flush();
    expect(reads()).toBe(1);
    await first.unmount();

    const again = await renderHook(
      () => useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, viewer: VIEWER }),
      undefined,
    );
    cleanup = again.unmount;
    await flush();
    expect(reads()).toBe(2);
    expect(firstChildId(again.result.current.lineage)).toBe(`child-of-${SESSION_ID}-2`);
  });

  test("another viewer on the same client never takes the read", async () => {
    const { client, reads } = lineageClient({ stamped: true });
    const hook = await renderHook(
      ({ other }: { other: string | null }) => ({
        page: useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, viewer: VIEWER }),
        other: useSessionLineage(other, {
          client,
          workspaceId: WORKSPACE_ID,
          viewer: "viewer-two",
        }),
      }),
      { other: null } as { other: string | null },
    );
    cleanup = hook.unmount;
    await flush();
    expect(reads()).toBe(1);
    await hook.rerender({ other: SESSION_ID });
    await flush();
    expect(reads()).toBe(2);
    expect(firstChildId(hook.result.current.other.lineage)).toBe(`child-of-${SESSION_ID}-2`);
  });

  test("a reader without a viewer reads its own", async () => {
    const { client, reads } = lineageClient({ stamped: true });
    const hook = await renderHook(
      ({ other }: { other: string | null }) => ({
        page: useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        other: useSessionLineage(other, { client, workspaceId: WORKSPACE_ID }),
      }),
      { other: null } as { other: string | null },
    );
    cleanup = hook.unmount;
    await flush();
    await hook.rerender({ other: SESSION_ID });
    await flush();
    expect(reads()).toBe(2);
  });

  test("a deep link's rail inbox read and the chat's read are one request", async () => {
    const inbox = inboxClient();
    const context = personContext(inbox.client);
    // The rail's first read is in flight as the chat opens.
    const railRead = inboxStoreFor(context).refresh();
    const hook = await renderHook(() => useReadSessionInbox(SESSION_ID), undefined, {
      wrapper: wrapperFor(context),
    });
    cleanup = hook.unmount;
    await railRead;
    await flush();
    expect(inbox.listed()).toBe(1);
    expect(inbox.seen).toEqual(["first"]);
    expect(inboxStoreFor(context).snapshot.data?.items).toEqual([inbox.reply("first", false)]);
  });

  test("the chat opening before the rail mounts is one request too", async () => {
    const inbox = inboxClient();
    const context = personContext(inbox.client);
    const hook = await renderHook(
      () => {
        useReadSessionInbox(SESSION_ID);
        return useInbox();
      },
      undefined,
      { wrapper: wrapperFor(context) },
    );
    cleanup = hook.unmount;
    await flush();
    expect(inbox.listed()).toBe(1);
    expect(inbox.seen).toEqual(["first"]);
  });

  test("leaving reads anew, and reopening moments later reads anew too", async () => {
    const inbox = inboxClient();
    const context = personContext(inbox.client);
    await inboxStoreFor(context).refresh();
    const opened = await renderHook(() => useReadSessionInbox(SESSION_ID), undefined, {
      wrapper: wrapperFor(context),
    });
    await flush();
    expect(inbox.seen).toEqual(["first"]);

    // A reply that arrived while the chat was open is read on leaving.
    inbox.set([inbox.reply("second", true)]);
    await opened.unmount();
    await flush();
    expect(inbox.seen).toEqual(["first", "second"]);

    // A reply arriving after leaving is read when the chat is opened again.
    inbox.set([inbox.reply("third", true)]);
    const listedBefore = inbox.listed();
    const reopened = await renderHook(() => useReadSessionInbox(SESSION_ID), undefined, {
      wrapper: wrapperFor(context),
    });
    cleanup = reopened.unmount;
    await flush();
    expect(inbox.listed()).toBe(listedBefore + 1);
    expect(inbox.seen).toEqual(["first", "second", "third"]);
  });
});

function inboxClient() {
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
  return {
    client,
    reply,
    seen,
    listed: () => listed,
    set: (items: InboxItem[]) => {
      inbox = { items, needsYouCount: 0, unreadCount: items.length };
    },
  };
}

function wrapperFor(context: AppContextValue) {
  return ({ children }: { children: ReactNode }) => (
    <AppContext.Provider value={context}>{children}</AppContext.Provider>
  );
}

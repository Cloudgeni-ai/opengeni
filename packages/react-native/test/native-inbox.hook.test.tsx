import { expect, mock, test } from "bun:test";
import { act } from "react";
import { registerDom, renderHook } from "../../react/test/render-hook";

registerDom();

mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

const { useNativeInbox } = await import("../src/timeline/inbox-state");

function inboxClient(title: string, pending?: Promise<void>) {
  return {
    listInbox: async () => {
      await pending;
      return {
        items: [
          {
            id: title,
            kind: "question",
            title,
            sessionId: "s1",
            workspaceId: "w1",
            createdAt: "2026-11-17T10:00:00.000Z",
          },
        ],
      };
    },
  } as unknown as Parameters<typeof useNativeInbox>[0];
}

test("another account's client starts empty instead of showing the last account's rows", async () => {
  const first = inboxClient("from-a");
  let release!: () => void;
  const second = inboxClient("from-b", new Promise<void>((resolve) => (release = resolve)));
  const hook = await renderHook((client) => useNativeInbox(client), first);
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.result.current.data?.items.map((item) => item.id)).toEqual(["from-a"]);

  await hook.rerender(second);
  // B's first read has not landed: nothing from A may show meanwhile.
  expect(hook.result.current.data).toBeNull();
  expect(hook.result.current.loading).toBe(true);

  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(hook.result.current.data?.items.map((item) => item.id)).toEqual(["from-b"]);
  await hook.unmount();
});

test("a late answer for the last account never shows for the new one", async () => {
  let releaseA!: () => void;
  const first = inboxClient("from-a", new Promise<void>((resolve) => (releaseA = resolve)));
  let releaseB!: () => void;
  const second = inboxClient("from-b", new Promise<void>((resolve) => (releaseB = resolve)));
  const hook = await renderHook((client) => useNativeInbox(client), first);
  await hook.rerender(second);
  await act(async () => {
    releaseA();
    await Promise.resolve();
  });
  expect(hook.result.current.data).toBeNull();
  await act(async () => {
    releaseB();
    await Promise.resolve();
  });
  expect(hook.result.current.data?.items.map((item) => item.id)).toEqual(["from-b"]);
  await hook.unmount();
});

test("disabled (signed out): nothing is read", async () => {
  let reads = 0;
  const client = {
    listInbox: async () => {
      reads += 1;
      return { items: [] };
    },
  } as unknown as Parameters<typeof useNativeInbox>[0];
  const hook = await renderHook(() => useNativeInbox(client, { enabled: false }), undefined);
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(reads).toBe(0);
  expect(hook.result.current.data).toBeNull();
  await hook.unmount();
});

import { describe, expect, test } from "bun:test";
import type { Channel } from "@opengeni/sdk";
import { act } from "react";

import { createChannelCacheStore } from "../src/hooks/channel-cache";
import { useChannels } from "../src/hooks/use-channels";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

const ACCOUNT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function channel(id: string, name: string, sortOrder = 0): Channel {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name,
    description: null,
    pinned: false,
    sortOrder,
    createdBy: "user:test",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("channel cache ordering", () => {
  test("a load already in flight cannot erase a newly committed project", () => {
    const store = createChannelCacheStore();
    const created = channel("11111111-1111-4111-8111-111111111111", "Incident response");
    const staleLoad = store.beginLoad();

    store.publishCreated(created);
    store.acceptLoad(staleLoad, []);

    expect(store.getSnapshot().channels).toEqual([created]);

    const confirmingLoad = store.beginLoad();
    store.acceptLoad(confirmingLoad, [created]);
    expect(store.getSnapshot().channels).toEqual([created]);
  });
});

describe("useChannels shared cache", () => {
  test("publishes a created project to the sidebar before post-create refresh settles", async () => {
    const created = channel("33333333-3333-4333-8333-333333333333", "Launch");
    const refreshResult = deferred<Channel[]>();
    let listCalls = 0;
    const client = fakeClient({
      listChannels: async () => {
        listCalls += 1;
        return listCalls <= 2 ? [] : await refreshResult.promise;
      },
      createChannel: async () => created,
    });
    const sidebar = await renderHook(
      () => useChannels({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    const composer = await renderHook(
      () => useChannels({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(sidebar.result.current.channels).toEqual([]);
    expect(composer.result.current.channels).toEqual([]);

    let createPromise!: Promise<Channel | null>;
    await act(async () => {
      createPromise = composer.result.current.create({ name: created.name });
      await Promise.resolve();
      await Promise.resolve();
    });

    // create() still awaits its post-write reconciliation, but the rail and
    // composer already share the returned canonical project.
    expect(sidebar.result.current.channels).toEqual([created]);
    expect(composer.result.current.channels).toEqual([created]);

    refreshResult.resolve([created]);
    await act(async () => {
      expect(await createPromise).toEqual(created);
    });
    await sidebar.unmount();
    await composer.unmount();
  });

  test("a failed project create leaves no phantom project in any consumer", async () => {
    const original = channel("22222222-2222-4222-8222-222222222222", "Existing");
    const client = fakeClient({
      listChannels: async () => [original],
      createChannel: async () => {
        throw new Error("name conflict");
      },
    });
    const sidebar = await renderHook(
      () => useChannels({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    const composer = await renderHook(
      () => useChannels({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();

    await act(async () => {
      expect(await composer.result.current.create({ name: "Existing" })).toBeNull();
    });
    expect(sidebar.result.current.channels).toEqual([original]);
    expect(composer.result.current.channels).toEqual([original]);
    expect(composer.result.current.mutationError?.message).toBe("name conflict");
    await sidebar.unmount();
    await composer.unmount();
  });
});

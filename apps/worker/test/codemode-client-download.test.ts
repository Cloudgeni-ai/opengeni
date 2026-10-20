import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  loadManagedCodemodeClient,
  managedCodemodeClientBytes,
  managedCodemodeClientDigest,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import {
  managedCodemodeClientDownload,
  managedCodemodeClientObjectKey,
  resetManagedCodemodeClientPublicationForTest,
} from "../src/activities/agent-turn/codemode-client-download";

const settings = { objectStorageBackend: "azure-blob" } as unknown as Settings;

function storage(options: { present?: boolean; failPut?: boolean } = {}) {
  const puts: { key: string; body: Uint8Array }[] = [];
  const heads: string[] = [];
  const signed: { key: string; expiresInSeconds?: number }[] = [];
  let present = options.present ?? false;
  const value = {
    bucket: "bucket",
    headObject: async (key: string) => {
      heads.push(key);
      return present ? ({ sizeBytes: 1 } as never) : null;
    },
    putObject: async (args: { key: string; body: Uint8Array }) => {
      if (options.failPut) throw new Error("storage unavailable");
      puts.push(args);
      present = true;
    },
    createGetUrl: async (args: { key: string; expiresInSeconds?: number }) => {
      signed.push(args);
      return { url: `https://storage.example/${args.key}?sig=x`, expiresAt: new Date() };
    },
  } as unknown as ObjectStorage;
  return { value, puts, heads, signed };
}

afterEach(() => resetManagedCodemodeClientPublicationForTest());

describe("managed Codemode client download", () => {
  test("publishes the exact release bytes once under their digest and signs per call", async () => {
    const client = await loadManagedCodemodeClient();
    const digest = managedCodemodeClientDigest(client);
    const store = storage();
    const first = await managedCodemodeClientDownload({
      settings,
      objectStorage: store.value,
      activeSandboxBackend: "modal",
    });
    const second = await managedCodemodeClientDownload({
      settings,
      objectStorage: store.value,
      activeSandboxBackend: "modal",
    });
    const key = managedCodemodeClientObjectKey(digest);
    expect(first?.url).toContain(key);
    expect(second?.url).toContain(key);
    expect(store.heads).toEqual([key]);
    expect(store.puts).toHaveLength(1);
    expect(new TextDecoder().decode(store.puts[0]!.body)).toBe(managedCodemodeClientBytes(client));
    expect(store.signed).toHaveLength(2);
    expect(store.signed[0]!.expiresInSeconds).toBeGreaterThan(0);
  });

  test("an existing object is not uploaded again", async () => {
    const store = storage({ present: true });
    const download = await managedCodemodeClientDownload({
      settings,
      objectStorage: store.value,
      activeSandboxBackend: "modal",
    });
    expect(download).toBeDefined();
    expect(store.puts).toHaveLength(0);
  });

  test("storage failure returns no URL and is retried on the next turn", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = storage({ failPut: true });
      expect(
        await managedCodemodeClientDownload({
          settings,
          objectStorage: failing.value,
          activeSandboxBackend: "modal",
        }),
      ).toBeUndefined();
      expect(
        await managedCodemodeClientDownload({
          settings,
          objectStorage: failing.value,
          activeSandboxBackend: "modal",
        }),
      ).toBeUndefined();
      expect(failing.heads).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("Connected Machines and missing storage get no URL", async () => {
    const store = storage();
    expect(
      await managedCodemodeClientDownload({
        settings,
        objectStorage: store.value,
        activeSandboxBackend: "selfhosted",
      }),
    ).toBeUndefined();
    expect(
      await managedCodemodeClientDownload({
        settings,
        objectStorage: null,
        activeSandboxBackend: "modal",
      }),
    ).toBeUndefined();
    expect(store.heads).toHaveLength(0);
  });
});

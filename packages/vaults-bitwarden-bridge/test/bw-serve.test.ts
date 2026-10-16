import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BitwardenPrivatePathError,
  BitwardenServeClient,
  BitwardenServeError,
  assertPrivateDirectory,
  bitwardenServeCommand,
  createUnixSocketBitwardenTransport,
} from "../src/index";
import { COLLECTION_ID, login, startFakeBwServe } from "./fake-bw-serve";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fake(items = [login()]) {
  const bw = await startFakeBwServe({ items });
  cleanups.push(() => bw.close());
  const client = new BitwardenServeClient({
    transport: createUnixSocketBitwardenTransport({ socketPath: bw.socketPath }),
    timeoutMs: 2_000,
  });
  return { bw, client };
}

function privateDir() {
  const directory = mkdtempSync(join(tmpdir(), "bw-path-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("private paths", () => {
  test("accepts only a 0700 real directory owned by this user", () => {
    const directory = privateDir();
    expect(() => assertPrivateDirectory(directory)).not.toThrow();
    chmodSync(directory, 0o750);
    expect(() => assertPrivateDirectory(directory)).toThrow(BitwardenPrivatePathError);
    chmodSync(directory, 0o700);
    const link = join(privateDir(), "link");
    symlinkSync(directory, link);
    expect(() => assertPrivateDirectory(link)).toThrow(/not a link/);
    expect(() => assertPrivateDirectory(join(directory, "missing"))).toThrow(/does not exist/);
  });

  test("refuses a socket in a shared directory, a missing socket and a regular file", async () => {
    const { bw } = await fake();
    expect(() => createUnixSocketBitwardenTransport({ socketPath: bw.socketPath })).not.toThrow();
    chmodSync(bw.directory, 0o755);
    expect(() => createUnixSocketBitwardenTransport({ socketPath: bw.socketPath })).toThrow(/0700/);
    chmodSync(bw.directory, 0o700);
    expect(() =>
      createUnixSocketBitwardenTransport({ socketPath: join(bw.directory, "nope.sock") }),
    ).toThrow(/bw serve running/);
    expect(() =>
      createUnixSocketBitwardenTransport({ socketPath: join(privateDir(), ".") }),
    ).toThrow();
  });

  test("rechecks the socket directory before every request", async () => {
    const { bw, client } = await fake();
    await client.status();
    chmodSync(bw.directory, 0o777);
    await expect(client.status()).rejects.toBeInstanceOf(BitwardenPrivatePathError);
    chmodSync(bw.directory, 0o700);
  });

  test("serve command uses a unix socket and private app data, never TCP", () => {
    const appData = privateDir();
    const socketDir = join(privateDir(), "sock");
    mkdirSync(socketDir, { mode: 0o700 });
    const command = bitwardenServeCommand({
      socketPath: join(socketDir, "bw.sock"),
      appDataDir: appData,
    });
    expect(command.argv).toEqual([
      "bw",
      "serve",
      "--hostname",
      `unix://${join(socketDir, "bw.sock")}`,
    ]);
    expect(command.argv).not.toContain("--port");
    expect(command.env).toEqual({ BITWARDENCLI_APPDATA_DIR: appData, BW_NOINTERACTION: "true" });
    chmodSync(appData, 0o755);
    expect(() =>
      bitwardenServeCommand({ socketPath: join(socketDir, "bw.sock"), appDataDir: appData }),
    ).toThrow();
  });
});

describe("BitwardenServeClient", () => {
  test("sends the localhost Host header and no Origin", async () => {
    const { bw, client } = await fake();
    const status = await client.status();
    expect(status).toMatchObject({ status: "unlocked", userEmail: "ops@example.com" });
    expect(bw.state.requests.every((request) => request.host === "localhost:8087")).toBe(true);
  });

  test("a wrong origin-protection port is a definite refusal", async () => {
    const { bw } = await fake();
    const client = new BitwardenServeClient({
      transport: createUnixSocketBitwardenTransport({ socketPath: bw.socketPath, port: 9999 }),
    });
    const error = await client.status().catch((e) => e);
    expect(error).toBeInstanceOf(BitwardenServeError);
    expect(error.failure).toBe("permission_denied");
  });

  test("classifies locked, logged out and not found definitively", async () => {
    const { bw, client } = await fake();
    bw.state.status = "locked";
    expect((await client.listItems({ personal: true }).catch((e) => e)).failure).toBe("locked");
    bw.state.status = "unauthenticated";
    expect((await client.sync().catch((e) => e)).failure).toBe("unauthenticated");
    bw.state.status = "unlocked";
    const missing = await client.getItem("9affffff-0000-4000-8000-000000000000").catch((e) => e);
    expect(missing).toMatchObject({ failure: "not_found", definite: true });
  });

  test("never sends non-GUID ids, which bw would treat as a search", async () => {
    const { bw, client } = await fake();
    const before = bw.state.requests.length;
    expect((await client.getItem("github").catch((e) => e)).failure).toBe("not_found");
    expect((await client.editItem("../status", {}).catch((e) => e)).failure).toBe("not_found");
    expect((await client.trashItem("github").catch((e) => e)).failure).toBe("not_found");
    expect(bw.state.requests.length).toBe(before);
  });

  test("trash is a soft delete and never permanent", async () => {
    const item = login();
    const { bw, client } = await fake([item]);
    await client.trashItem(item.id);
    expect(bw.state.items).toHaveLength(1);
    expect(bw.state.items[0]!.deletedDate).not.toBeNull();
    expect(bw.state.requests.some((request) => request.path.includes("permanent"))).toBe(false);
    expect(await client.listItems({ personal: true })).toHaveLength(0);
  });

  test("an unknown mutation failure is not definite; a known refusal is", async () => {
    const item = login();
    const { bw, client } = await fake([item]);
    bw.state.failNext = "Something unexpected happened.";
    expect(await client.editItem(item.id, item).catch((e) => e)).toMatchObject({
      failure: "rejected",
      definite: false,
    });
    bw.state.readOnly.add(item.id);
    expect(await client.editItem(item.id, item).catch((e) => e)).toMatchObject({
      failure: "permission_denied",
      definite: true,
    });
    bw.state.readOnly.clear();
    expect(
      await client
        .editItem(item.id, { ...item, revisionDate: "2020-01-01T00:00:00.000Z" })
        .catch((e) => e),
    ).toMatchObject({
      failure: "conflict",
      definite: true,
    });
  });

  test("a dropped connection after a write is an uncertain transport failure", async () => {
    const item = login();
    const { bw, client } = await fake([item]);
    bw.state.dropAfterCommit = true;
    const error = await client.editItem(item.id, { ...item, name: "changed" }).catch((e) => e);
    expect(error).toMatchObject({ failure: "transport", definite: false });
    expect(bw.state.items[0]!.name).toBe("changed");
  });

  test("bounds response sizes", async () => {
    const big = login({ notes: "x".repeat(200_000) });
    const { bw } = await fake([big]);
    const client = new BitwardenServeClient({
      transport: createUnixSocketBitwardenTransport({ socketPath: bw.socketPath }),
      maxListBytes: 10_000,
    });
    expect((await client.listItems({ personal: true }).catch((e) => e)).failure).toBe("transport");
  });

  test("collection listing filters by collection id", async () => {
    const shared = login({
      organizationId: "1c7e8b63-a2b5-4a6f-9a8d-3f9a62c2d002",
      collectionIds: [COLLECTION_ID],
    });
    const { client } = await fake([login(), shared]);
    const items = await client.listItems({ collectionId: COLLECTION_ID });
    expect(items.map((item) => item.id)).toEqual([shared.id]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFetchRemoteVaultTransport,
  createProviderCallBudget,
  createRemoteVaultProvider,
} from "@opengeni/vaults";
import {
  BitwardenServeClient,
  createBitwardenBridge,
  createFileExternalVaultReceiverStore,
  createUnixSocketBitwardenTransport,
  loadBitwardenBridgeConfigFile,
  serveBitwardenBridge,
} from "../src/index";
import { login, startFakeBwServe } from "./fake-bw-serve";

const SECRET = "e".repeat(48);
const CONNECTION = "5c3f2a11-8d4e-4f60-9bac-1d2e3f4a5b6c";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function privateDir() {
  const directory = mkdtempSync(join(tmpdir(), "bw-bridge-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("file receiver store", () => {
  const claim = {
    connectionId: CONNECTION,
    idempotencyKey: "k1",
    digest: "d1",
    expiresAt: new Date(Date.now() + 60_000),
  };

  test("replay and mutation state survive a restart", async () => {
    const directory = join(privateDir(), "state");
    const store = createFileExternalVaultReceiverStore({ directory });
    const request = {
      connectionId: CONNECTION,
      requestId: "r1",
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await store.rememberRequest(request)).toBe(true);
    expect(await store.claimMutation(claim)).toEqual({ state: "claimed" });
    const reopened = createFileExternalVaultReceiverStore({ directory });
    expect(await reopened.rememberRequest(request)).toBe(false);
    expect(await reopened.claimMutation(claim)).toEqual({ state: "pending" });
    expect(await reopened.claimMutation({ ...claim, digest: "other" })).toEqual({
      state: "mismatch",
    });
    await reopened.completeMutation({ ...claim, result: { archived: true } });
    const third = createFileExternalVaultReceiverStore({ directory });
    expect(await third.claimMutation(claim)).toEqual({
      state: "completed",
      result: { archived: true },
    });
  });

  test("a released claim can be claimed again; expired entries are pruned", async () => {
    let now = Date.now();
    const store = createFileExternalVaultReceiverStore({
      directory: join(privateDir(), "s"),
      now: () => now,
    });
    await store.claimMutation(claim);
    await store.releaseMutation(claim);
    expect(await store.claimMutation(claim)).toEqual({ state: "claimed" });
    now += 120_000;
    expect(
      await store.claimMutation({ ...claim, digest: "new", expiresAt: new Date(now + 60_000) }),
    ).toEqual({
      state: "claimed",
    });
  });

  test("refuses a shared directory and a corrupt state file", () => {
    const shared = privateDir();
    chmodSync(shared, 0o755);
    expect(() => createFileExternalVaultReceiverStore({ directory: shared })).toThrow(/0700/);
    const corrupt = privateDir();
    writeFileSync(join(corrupt, "receiver-state.json"), "{not json");
    expect(() => createFileExternalVaultReceiverStore({ directory: corrupt })).toThrow(
      /cannot read/,
    );
  });
});

describe("config file", () => {
  function write(dir: string, value: unknown) {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  const base = (dir: string) => ({
    connectionId: CONNECTION,
    opengeni: { accountId: "acct", connectionWorkspaceId: "ws" },
    vaults: [{ kind: "personal", mode: "read_only" }],
    bwSocketPath: join(dir, "bw", "bw.sock"),
    stateDir: join(dir, "state"),
  });

  test("reads the signing secret from a 0600 file or the environment, never the JSON", () => {
    const dir = privateDir();
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
    const loaded = loadBitwardenBridgeConfigFile(
      write(dir, { ...base(dir), signingSecretFile: secretFile }),
      {},
    );
    expect(loaded.bridge.signingSecrets).toEqual([SECRET]);
    expect(loaded.listen).toEqual({ host: "127.0.0.1", port: 8788 });
    expect(
      loadBitwardenBridgeConfigFile(write(dir, base(dir)), {
        OPENGENI_VAULT_SIGNING_SECRET: SECRET,
      }).bridge.signingSecrets,
    ).toEqual([SECRET]);
    expect(() =>
      loadBitwardenBridgeConfigFile(write(dir, { ...base(dir), signingSecrets: [SECRET] }), {}),
    ).toThrow(/signingSecretFile/);
    chmodSync(secretFile, 0o644);
    expect(() =>
      loadBitwardenBridgeConfigFile(
        write(dir, { ...base(dir), signingSecretFile: secretFile }),
        {},
      ),
    ).toThrow(/0600/);
    expect(() =>
      loadBitwardenBridgeConfigFile(write(dir, { ...base(dir), stateDir: "relative" }), {}),
    ).toThrow(/absolute/);
  });
});

describe("HTTP listener", () => {
  async function running() {
    const item = login();
    const bw = await startFakeBwServe({ items: [item] });
    cleanups.push(() => bw.close());
    const bridge = createBitwardenBridge({
      config: {
        connectionId: CONNECTION,
        signingSecrets: [SECRET],
        opengeni: { accountId: "acct", connectionWorkspaceId: "ws" },
        vaults: [{ kind: "personal", mode: "read_write" }],
      },
      client: new BitwardenServeClient({
        transport: createUnixSocketBitwardenTransport({ socketPath: bw.socketPath }),
      }),
      store: createFileExternalVaultReceiverStore({ directory: join(privateDir(), "state") }),
    });
    const server = await serveBitwardenBridge({ bridge, listen: { port: 0 } });
    cleanups.push(() => server.close());
    return { item, bw, bridge, server };
  }

  test("end to end: signed adapter over HTTP to the bridge and the bw socket", async () => {
    const { item, server } = await running();
    const provider = createRemoteVaultProvider({
      provider: "bitwarden",
      endpoint: `${server.address}/opengeni/vault`,
      signingSecret: SECRET,
      connectionId: CONNECTION,
      allowInsecureHttp: true,
      transport: createFetchRemoteVaultTransport((url, init) => fetch(url, init)),
    });
    const ctx = {
      connectionId: CONNECTION,
      budget: createProviderCallBudget(20),
      authority: {
        accountId: "acct",
        workspaceId: "ws",
        subjectId: "u",
        connectionWorkspaceId: "ws",
      },
    };
    expect((await provider.validate(ctx)).accountId).toMatch(/^bitwarden:/);
    const items = await provider.listItems(ctx, "personal");
    expect(items.map((i) => i.externalItemId)).toEqual([item.id]);
    const [value] = await provider.readFields(ctx, "personal", item.id, ["login.username"]);
    expect(value?.externalFieldId).toBe("login.username");
    await provider.archiveItem(ctx, "personal", item.id);
  });

  test("only POST on the configured path; oversized bodies are refused; loopback by default", async () => {
    const { server } = await running();
    expect((await fetch(`${server.address}/opengeni/vault`)).status).toBe(405);
    expect((await fetch(`${server.address}/status`, { method: "POST", body: "{}" })).status).toBe(
      404,
    );
    const unsigned = await fetch(`${server.address}/opengeni/vault`, {
      method: "POST",
      body: "{}",
    });
    expect(unsigned.status).toBe(401);
    const big = await fetch(`${server.address}/opengeni/vault`, {
      method: "POST",
      body: "x".repeat(5 * 1024 * 1024),
    }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
    await expect(
      serveBitwardenBridge({
        bridge: (await running()).bridge,
        listen: { host: "0.0.0.0", port: 0 },
      }),
    ).rejects.toThrow(/loopback/);
  });

  test("can listen on a Unix socket for the reverse proxy", async () => {
    const { bridge } = await running();
    const dir = privateDir();
    mkdirSync(join(dir, "run"), { mode: 0o700 });
    const server = await serveBitwardenBridge({
      bridge,
      listen: { path: join(dir, "run", "bridge.sock") },
    });
    cleanups.push(() => server.close());
    expect(server.address).toBe(`unix:${join(dir, "run", "bridge.sock")}`);
  });
});

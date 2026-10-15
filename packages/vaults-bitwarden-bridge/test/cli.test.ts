import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createFetchRemoteVaultTransport,
  createProviderCallBudget,
  createRemoteVaultProvider,
} from "@opengeni/vaults";
import { login, startFakeBwServe } from "./fake-bw-serve";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startCli(configPath: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../src/cli.ts"),
      "--config",
      configPath,
    ],
    {
      env: { ...process.env, OPENGENI_VAULT_SIGNING_SECRET: undefined },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  cleanups.push(stop);
  let diagnostics = "";
  let ready!: (address: string) => void;
  const readiness = new Promise<string>((resolveReady) => {
    ready = resolveReady;
  });
  const output = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        diagnostics += decoder.decode(chunk.value, { stream: true });
        const match = /bridge listening on (unix:\S+)/.exec(diagnostics);
        if (match) ready(match[1]!);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = await Promise.race([
      readiness,
      child.exited.then(async (status) => {
        await output;
        throw new Error(`bridge exited before ready (${status}): ${diagnostics}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("bridge startup timed out")), 10_000);
      }),
    ]);
    return { address, stop, diagnostics: () => diagnostics };
  } finally {
    clearTimeout(timer);
  }
}

test("documented CLI uses the private socket and preserves the account pin after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bw-cli-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const item = login();
  const bw = await startFakeBwServe({ items: [item] });
  cleanups.push(() => bw.close());
  const signingSecret = "cli-fixture-signing-secret-".repeat(3);
  const connectionId = "baf9b9e0-6e3f-4f55-8c90-45c87cf351bc";
  const secretFile = join(directory, "signing-key");
  writeFileSync(secretFile, signingSecret, { mode: 0o600 });
  const configPath = join(directory, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      connectionId,
      signingSecretFile: secretFile,
      opengeni: { accountId: "acct", connectionWorkspaceId: "ws" },
      vaults: [{ kind: "personal", mode: "read_write" }],
      bwSocketPath: bw.socketPath,
      stateDir: join(directory, "state"),
      listen: { path: join(directory, "bridge.sock") },
    }),
    { mode: 0o600 },
  );
  function provider(address: string) {
    return createRemoteVaultProvider({
      provider: "bitwarden",
      endpoint: "http://bridge.local/opengeni/vault",
      signingSecret,
      connectionId,
      allowInsecureHttp: true,
      transport: createFetchRemoteVaultTransport((url, init) =>
        fetch(url, { ...init, unix: address.slice("unix:".length) }),
      ),
    });
  }
  const ctx = {
    connectionId,
    budget: createProviderCallBudget(30),
    authority: {
      accountId: "acct",
      workspaceId: "ws",
      subjectId: "user",
      connectionWorkspaceId: "ws",
    },
  };
  const first = await startCli(configPath);
  const remote = provider(first.address);
  expect((await remote.validate(ctx)).accountId).toMatch(/^bitwarden:/);
  expect((await remote.listItems(ctx, "personal")).map((value) => value.externalItemId)).toEqual([
    item.id,
  ]);
  const [value] = await remote.readFields(ctx, "personal", item.id, ["login.username"]);
  expect(value?.material).toEqual({ type: "text", value: "octo" });
  await first.stop();

  // A locked vault still starts the listener and reports the actual condition.
  bw.state.status = "locked";
  const second = await startCli(configPath);
  const reopened = provider(second.address);
  await expect(reopened.validate(ctx)).rejects.toMatchObject({ code: "provider_locked" });
  bw.state.status = "unlocked";
  expect((await reopened.validate(ctx)).accountId).toMatch(/^bitwarden:/);

  // The first process's durable account pin survives, not merely its memory.
  bw.state.userId = "3b16d09a-1dd6-4c2e-9a4c-786db60e1b5c";
  await expect(reopened.listItems(ctx, "personal")).rejects.toMatchObject({
    code: "provider_auth_invalid",
  });
  for (const log of [first.diagnostics(), second.diagnostics()]) {
    expect(log).not.toContain(signingSecret);
    expect(log).not.toContain("hunter2");
  }
}, 30_000);

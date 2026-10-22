#!/usr/bin/env bun
/**
 * Run the fake-login suite as a long-lived process.
 *
 *   bun packages/testing/src/fake-login/cli.ts [--slot N] [--port P] [--iframe-port Q]
 *
 * Ports: --port/--iframe-port, else FAKE_LOGIN_PORT/FAKE_LOGIN_IFRAME_PORT, else the
 * f598 localstack slot block (slot base + 20 and + 21; slot 3 → 47220/47221).
 * Accounts: FAKE_LOGIN_ACCOUNTS_JSON (JSON array of {username,password,email?,totpSecret?})
 * replaces the defaults; FAKE_LOGIN_EXTRA_ACCOUNTS_JSON adds to them. Live 1Password mode
 * passes real test credentials this way, in this process's environment only.
 */
import { DEFAULT_FAKE_LOGIN_ACCOUNTS, startFakeLoginServer, type FakeLoginAccount } from "./server";

const SLOT_BASES: Record<string, number> = { "0": 47100, "1": 47130, "2": 47160, "3": 47200 };

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function accountsFromEnv(): FakeLoginAccount[] {
  const replace = process.env.FAKE_LOGIN_ACCOUNTS_JSON;
  const extra = process.env.FAKE_LOGIN_EXTRA_ACCOUNTS_JSON;
  const base = replace ? (JSON.parse(replace) as FakeLoginAccount[]) : DEFAULT_FAKE_LOGIN_ACCOUNTS;
  return extra ? [...base, ...(JSON.parse(extra) as FakeLoginAccount[])] : base;
}

const slot = flag("--slot") ?? process.env.FAKE_LOGIN_SLOT;
const slotBase = slot === undefined ? undefined : SLOT_BASES[slot];
if (slot !== undefined && slotBase === undefined) throw new Error(`unknown slot ${slot}`);
const port = Number(
  flag("--port") ?? process.env.FAKE_LOGIN_PORT ?? (slotBase ? slotBase + 20 : 0),
);
const iframePort = Number(
  flag("--iframe-port") ?? process.env.FAKE_LOGIN_IFRAME_PORT ?? (slotBase ? slotBase + 21 : 0),
);

const server = await startFakeLoginServer({ port, iframePort, accounts: accountsFromEnv() });
console.log(
  JSON.stringify({
    ready: true,
    url: server.url,
    crossOriginUrl: server.crossOriginUrl,
    mcpUrl: server.mcpUrl,
    mailApiUrl: server.mailApiUrl,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}

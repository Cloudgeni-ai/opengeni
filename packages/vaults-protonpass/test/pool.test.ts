import { afterEach, describe, expect, test } from "bun:test";
import { createProviderCallBudget, providerOperations, VaultProviderError } from "@opengeni/vaults";
import { createProtonPassProviderPool } from "../src/pool";
import { VALID_TOKEN, makeFakeCli, type FakeCli } from "./fixture";

const ctx = () => ({ connectionId: "conn-pool", budget: createProviderCallBudget(50) });
const OTHER_TOKEN = "pst_fedcba9876543210::b3RoZXIta2V5LW5vdC1yZWFs";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

function world(options: { maxSessions?: number; poolIdleMs?: number } = {}) {
  const fake = makeFakeCli();
  let clock = 1_000_000;
  const pool = createProtonPassProviderPool({
    binaryPath: fake.binaryPath,
    stateRoot: fake.stateRoot,
    hostEnv: { PATH: "/usr/bin:/bin" },
    now: () => clock,
    ...options,
  });
  cleanup.push(
    () => pool.close(),
    () => fake.cleanup(),
  );
  return { fake, pool, advance: (ms: number) => (clock += ms) };
}

function logins(fake: FakeCli) {
  return fake.log().filter((entry) => entry.argv[0] === "login");
}
function logouts(fake: FakeCli) {
  return fake.log().filter((entry) => entry.argv[0] === "logout");
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultProviderError);
  return (error as VaultProviderError).code;
}

describe("Proton Pass provider pool", () => {
  test("one token logs in once, however many connections use it", async () => {
    const { fake, pool } = world();
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    expect(logins(fake)).toHaveLength(1);
    expect(pool.size()).toBe(1);
  });

  test("different tokens never share a session or state directory", async () => {
    const { fake, pool } = world();
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    // The fake knows only VALID_TOKEN, so the other token's own login is refused.
    expect(await code(pool.provider(OTHER_TOKEN).listVaults(ctx()))).toBe("provider_auth_invalid");
    expect(pool.size()).toBe(2);
    const homes = new Set(logins(fake).map((entry) => entry.home));
    expect(homes.size).toBe(2);
    expect(await pool.provider(VALID_TOKEN).listVaults(ctx())).toHaveLength(3);
  });

  test("idle sessions are logged out and forgotten", async () => {
    const { fake, pool, advance } = world({ poolIdleMs: 60_000 });
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    advance(61_000);
    expect(pool.provider(OTHER_TOKEN).id).toBe("protonpass");
    expect(pool.size()).toBe(1);
    await Bun.sleep(50);
    await waitFor(() => logouts(fake).length === 1);
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    expect(logins(fake)).toHaveLength(2);
  });

  test("the least recently used session makes room at the limit", async () => {
    const { fake, pool } = world({ maxSessions: 1 });
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    pool.provider(OTHER_TOKEN);
    expect(pool.size()).toBe(1);
    await waitFor(() => logouts(fake).length === 1);
  });

  test("providers are narrowed to the verified operations without running the CLI", async () => {
    const { fake, pool } = world();
    const readOnly = pool.provider(
      VALID_TOKEN,
      providerOperations({
        write: false,
        createVault: false,
        totp: false,
        files: false,
        groupGrants: false,
        passkeys: false,
      }),
    );
    expect(readOnly.capabilities().write).toBe(false);
    expect(await code(readOnly.archiveItem(ctx(), "rwShare==", "loginItem1"))).toBe(
      "provider_permission_denied",
    );
    expect(await code(readOnly.readFields(ctx(), "rwShare==", "loginItem1", ["@file:abc"]))).toBe(
      "provider_permission_denied",
    );
    expect(fake.log()).toHaveLength(0);
  });

  test("close logs every session out", async () => {
    const { fake, pool } = world();
    await pool.provider(VALID_TOKEN).listVaults(ctx());
    await pool.close();
    expect(pool.size()).toBe(0);
    expect(logouts(fake)).toHaveLength(1);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(20);
  }
}

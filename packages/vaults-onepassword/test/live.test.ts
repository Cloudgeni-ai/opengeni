import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAttemptProviderBudget } from "../src/budget";
import { type VaultProviderContext, VaultProviderError, totpCode } from "../src/contract";
import { type OnePasswordVaultProvider, createOnePasswordVaultProvider } from "../src/provider";
import { type OnePasswordSdk, OnePasswordClientCache, loadOnePasswordSdk } from "../src/sdk";
import { onePasswordTokenFingerprint } from "../src/token";
import { defineVaultProviderContract } from "./contract-suite";

/**
 * Live 1Password run (dossier §16.5, OP-1..OP-3). Never runs in CI:
 *
 *   (set -a; . keys/op.env; set +a; OPENGENI_ONEPASSWORD_LIVE=1 \
 *     bun test ./packages/vaults-onepassword/test/live.test.ts)
 *
 * The fixture is a FAMILY account (about 1,000 requests/day shared), so the
 * run counts every SDK call and every HTTP request the WASM core makes and fails
 * above 60 SDK calls. Only operation names, paths and counts are recorded.
 */
const LIVE = process.env.OPENGENI_ONEPASSWORD_LIVE === "1";
const token = process.env.ONEPASSWORD_TEST_SERVICE_ACCOUNT_TOKEN ?? "";
const RW = process.env.ONEPASSWORD_TEST_RW_VAULT_ID ?? "dfictlxpjayo7rjac24euezsk4";
const RO = process.env.ONEPASSWORD_TEST_RO_VAULT_ID ?? "dhvjy5lcnvojzbqumrr5awihg4";
const PREFIX = "ogtest-";
/** dossier OP-1: at most 60 calls per run (counted as HTTP requests, the stricter unit). */
const MAX_CALLS_PER_RUN = 60;
const evidenceDir = process.env.OPENGENI_ONEPASSWORD_EVIDENCE_DIR ?? null;

type HttpEntry = { op: string; method: string; host: string; path: string; status: number | null; ms: number };
type SdkEntry = { op: string; ms: number; outcome: string };
const http: HttpEntry[] = [];
const sdkCalls: SdkEntry[] = [];
const findings: Record<string, unknown> = {};
let currentOp = "sign-in";

function instrumentFetch() {
  const original = globalThis.fetch;
  const counted = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const started = performance.now();
    const entry: HttpEntry = { op: currentOp, method, host: url.host, path: url.pathname, status: null, ms: 0 };
    http.push(entry);
    try {
      const response = await original(input, init);
      entry.status = response.status;
      return response;
    } finally {
      entry.ms = Math.round(performance.now() - started);
    }
  };
  globalThis.fetch = Object.assign(counted, original) as typeof fetch;
}

/** Times the sign-in; returns the SDK's own Client object untouched. */
function timedSdk(real: OnePasswordSdk): OnePasswordSdk {
  return {
    ...real,
    async createClient(config) {
      currentOp = "sign-in";
      const started = performance.now();
      const client = await real.createClient(config);
      findings.signInMs = Math.round(performance.now() - started);
      findings.signInHttpRequests = http.filter((entry) => entry.op === "sign-in").length;
      currentOp = "between-calls";
      return client;
    },
  };
}

const PROVIDER_METHODS = [
  "validate",
  "listVaults",
  "listItems",
  "readFields",
  "writeItem",
  "archiveItem",
  "createVault",
  "deleteVault",
  "deleteItem",
] as const;

/** Counts and times every provider call; HTTP requests are attributed to it. */
function countedProvider(base: OnePasswordVaultProvider): OnePasswordVaultProvider {
  const counted: Record<string, unknown> = { ...base };
  for (const method of PROVIDER_METHODS) {
    const original = base[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (!original) continue;
    counted[method] = async (...args: unknown[]) => {
      currentOp = method;
      const started = performance.now();
      const entry: SdkEntry = { op: method, ms: 0, outcome: "ok" };
      sdkCalls.push(entry);
      try {
        return await original(...args);
      } catch (error) {
        entry.outcome =
          error instanceof VaultProviderError ? `error: ${error.code}` : "error: unexpected";
        throw error;
      } finally {
        entry.ms = Math.round(performance.now() - started);
        currentOp = "between-calls";
      }
    };
  }
  return counted as unknown as OnePasswordVaultProvider;
}

/**
 * Records whether the SDK's own client finalizer fires during the run (it must
 * not: the provider's client cache holds the Client). wasm-bindgen registries
 * hold other values and are ignored.
 */
function watchClientFinalizer() {
  const Native = globalThis.FinalizationRegistry;
  const released: number[] = [];
  findings.sdkClientReleases = released;
  globalThis.FinalizationRegistry = class<T> extends Native<T> {
    constructor(callback: (held: T) => void) {
      super((held: T) => {
        const id = (held as { id?: unknown } | null)?.id;
        if (typeof id === "number") released.push(id);
        callback(held);
      });
    }
  } as typeof FinalizationRegistry;
}

function writeEvidence() {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  const byOp: Record<string, { sdkCalls: number; httpRequests: number; avgMs: number }> = {};
  for (const call of sdkCalls) {
    const row = (byOp[call.op] ??= { sdkCalls: 0, httpRequests: 0, avgMs: 0 });
    row.avgMs = Math.round((row.avgMs * row.sdkCalls + call.ms) / (row.sdkCalls + 1));
    row.sdkCalls += 1;
  }
  for (const entry of http) {
    (byOp[entry.op] ??= { sdkCalls: 0, httpRequests: 0, avgMs: 0 }).httpRequests += 1;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    join(evidenceDir, `live-run-${stamp}.json`),
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        sdkVersion: "0.5.0",
        bun: Bun.version,
        totals: { sdkCalls: sdkCalls.length, httpRequests: http.length },
        byOp,
        findings,
        sdkCalls,
        http,
      },
      null,
      2,
    )}\n`,
  );
}

if (!(LIVE && token)) {
  test.skip("live 1Password (set OPENGENI_ONEPASSWORD_LIVE=1 and load keys/op.env)", () => {});
} else {
describe("live 1Password (FAMILY fixture)", () => {
  instrumentFetch();
  watchClientFinalizer();
  const clientCache = new OnePasswordClientCache();
  const connectionId = crypto.randomUUID();
  const createdItems = new Set<string>();
  let provider: OnePasswordVaultProvider;
  let sdk: OnePasswordSdk;
  const context = (): VaultProviderContext => ({ connectionId, budget: createAttemptProviderBudget() });

  const ready = (async () => {
    sdk = timedSdk(await loadOnePasswordSdk());
    const base = countedProvider(createOnePasswordVaultProvider({ token, planTier: "family", sdk, clientCache }));
    provider = {
      ...base,
      async writeItem(ctx, vaultId, item) {
        const meta = await base.writeItem(ctx, vaultId, item);
        createdItems.add(`${vaultId}/${meta.externalItemId}`);
        return meta;
      },
    };
    // Leftover sweep (§16.5): delete ogtest-* items from earlier interrupted runs.
    const client = await clientCache.get(`${connectionId}:${await onePasswordTokenFingerprint(token)}`, () =>
      sdk.createClient({ auth: token, integrationName: "OpenGeni", integrationVersion: "live-test" }),
    );
    currentOp = "sweep";
    const overviews = await client.items.list(RW, { type: "ByState", content: { active: true, archived: true } });
    const leftovers = overviews.filter((item) => item.title.startsWith(PREFIX));
    for (const item of leftovers) await client.items.delete(RW, item.id);
    sdkCalls.push({ op: "sweep(items.list+delete)", ms: 0, outcome: `ok: ${leftovers.length} deleted` });
    findings.sweptLeftovers = leftovers.length;
  })();

  afterAll(() => {
    writeEvidence();
  });

  defineVaultProviderContract("live 1Password", async () => {
    await ready;
    return {
      provider,
      context,
      readWriteVaultId: RW,
      readOnlyVaultId: RO,
      fixtureItemName: "Test Login",
      namePrefix: PREFIX,
      async cleanup() {
        const deleted: string[] = [];
        for (const ref of createdItems) {
          const [vaultId, itemId] = ref.split("/") as [string, string];
          try {
            await provider.deleteItem(context(), vaultId, itemId);
            deleted.push(ref);
          } catch (error) {
            if (!(error instanceof VaultProviderError && error.code === "provider_not_found")) throw error;
          }
        }
        findings.cleanupDeletedItems = deleted.length;
      },
    };
  });

  test("vault names decrypt and both fixture vaults are reachable", async () => {
    await ready;
    const vaults = await provider.listVaults(context());
    findings.vaults = vaults.map((vault) => ({ id: vault.externalVaultId, name: vault.name, itemCount: vault.itemCount }));
    expect(vaults.find((vault) => vault.externalVaultId === RW)?.name).toBe("OpenGeni Test RW");
    expect(vaults.find((vault) => vault.externalVaultId === RO)?.name).toBe("OpenGeni Test RO");
  });

  test("read-only vault: TOTP resolves; a write is refused by 1Password", async () => {
    await ready;
    const items = await provider.listItems(context(), RO);
    const login = items.find((item) => item.name === "Test Login");
    expect(login).toBeDefined();
    const otp = login!.fields.find((field) => field.kind === "totp")!;
    const [value] = await provider.readFields(context(), RO, login!.externalItemId, [otp.externalFieldId]);
    expect(value!.material.type).toBe("totp");
    if (value!.material.type === "totp") {
      const code = await totpCode(value!.material.params, Date.now());
      findings.roTotp = { resolved: /^\d{6,8}$/.test(code), digits: code.length, periodSeconds: value!.material.params.periodSeconds };
    }
    const refused = await provider
      .writeItem(context(), RO, {
        externalItemId: login!.externalItemId,
        name: login!.name,
        type: "login",
        websites: login!.websites,
        // No field changes: even if 1Password accepted the put, the fixture is unchanged.
        fields: [],
      })
      .catch((error) => error);
    expect(refused).toBeInstanceOf(VaultProviderError);
    findings.roUpdateError = { code: refused.code, message: refused.message };
    expect(refused.code).toBe("provider_permission_denied");
  });

  test("managed vault: create, then delete the temporary vault", async () => {
    await ready;
    const vault = await provider.createVault!(context(), {
      name: `${PREFIX}managed-${crypto.randomUUID().slice(0, 8)}`,
      allowAdminsAccess: true,
    });
    findings.managedVault = { created: true, itemCount: vault.itemCount };
    await provider.deleteVault(context(), vault.externalVaultId);
    findings.managedVault = { created: true, deleted: true };
  });

  test(`stays within ${MAX_CALLS_PER_RUN} requests and never releases the SDK client`, async () => {
    await ready;
    findings.totals = { sdkCalls: sdkCalls.length, httpRequests: http.length };
    expect(http.length).toBeLessThanOrEqual(MAX_CALLS_PER_RUN);
    expect(findings.sdkClientReleases).toEqual([]);
  });
});
}

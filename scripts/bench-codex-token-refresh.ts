#!/usr/bin/env bun
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  bootstrapWorkspace,
  buildCodexTokenResolver,
  createDb,
  encryptEnvironmentValue,
  loadCodexCredentialForRun,
  recordCodexTokenRefresh,
  setCodexCredentialStatus,
  type CodexAuthDeps,
  upsertCodexSubscriptionCredential,
  withCodexCredentialRefreshLock,
} from "@opengeni/db";
import { startTestServices, testSettings } from "@opengeni/testing";
import { CodexRefreshTransient, CodexReloginRequired } from "../packages/codex/src/refresh";

const ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 73).toString("base64");

if (process.argv.includes("--child")) {
  await runChild();
  process.exit(0);
}

const services = await startTestServices({ temporal: false });
let client: ReturnType<typeof createDb> | undefined;

try {
  await migrateQuietly();
  client = createDb(services.databaseUrl, { max: 10 });
  const settings = testSettings({
    databaseUrl: services.databaseUrl,
    environmentsEncryptionKey: ENCRYPTION_KEY_BASE64,
    codexSubscriptionEnabled: true,
  });
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) throw new Error("synthetic encryption key was not parsed");

  const suffix = crypto.randomUUID();
  const context = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:codex-token-refresh",
    accountExternalId: `account:${suffix}`,
    accountName: "Codex token refresh benchmark",
    workspaceExternalSource: "bench:codex-token-refresh",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "Codex token refresh benchmark",
    subjectId: `user:${suffix}`,
  });
  const grant = context.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");

  let credentialSequence = 0;
  const createExpiredCredential = async (label: string): Promise<string> => {
    credentialSequence += 1;
    const result = await upsertCodexSubscriptionCredential(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({
          access_token: `expired-access-${suffix}-${credentialSequence}`,
          refresh_token: `refresh-${suffix}-${credentialSequence}`,
          id_token: `id-${suffix}-${credentialSequence}`,
        }),
      ),
      chatgptAccountId: `synthetic:${label}:${credentialSequence}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() - 60_000),
      lastRefreshAt: new Date(Date.now() - 60_000),
      connectedBySubjectId: grant.subjectId,
    });
    if (result.kind !== "upserted") throw new Error("credential upsert remained unresolved");
    return result.id;
  };

  const providerDelayReceipts = [];
  for (const delayMs of [0, 20, 100, 500, 2_000]) {
    const credentialId = await createExpiredCredential(`delay-${delayMs}`);
    const samples = delayMs >= 2_000 ? 3 : 7;
    let refreshCalls = 0;
    const deps = realDeps(async () => {
      refreshCalls += 1;
      await sleep(delayMs);
      return { accessToken: `access-after-${delayMs}-${refreshCalls}` };
    });
    const elapsed: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const resolver = buildCodexTokenResolver(
        client.db,
        settings,
        grant.workspaceId,
        credentialId,
        deps,
      );
      const startedAt = performance.now();
      await resolver.refresh();
      elapsed.push(performance.now() - startedAt);
    }
    providerDelayReceipts.push({
      injectedProviderDelayMs: delayMs,
      refreshCalls,
      elapsedMs: distribution(elapsed),
      estimatedHostOverheadMs: distribution(elapsed.map((value) => value - delayMs)),
    });
  }

  const sameCredentialId = await createExpiredCredential("same-process-single-flight");
  let sameProcessRefreshCalls = 0;
  const sameProcessDeps = realDeps(async () => {
    sameProcessRefreshCalls += 1;
    await sleep(500);
    return { accessToken: "same-process-refreshed" };
  });
  const sameProcessStartedAt = performance.now();
  const sameProcessTokens = await Promise.all(
    Array.from({ length: 32 }, () =>
      buildCodexTokenResolver(
        client!.db,
        settings,
        grant.workspaceId,
        sameCredentialId,
        sameProcessDeps,
      ).getToken(),
    ),
  );
  const sameProcessElapsedMs = performance.now() - sameProcessStartedAt;

  const distinctCredentialIds = await Promise.all(
    Array.from({ length: 32 }, (_, index) => createExpiredCredential(`distinct-${index}`)),
  );
  let distinctRefreshCalls = 0;
  const distinctDeps = realDeps(async () => {
    distinctRefreshCalls += 1;
    await sleep(100);
    return { accessToken: `distinct-refreshed-${distinctRefreshCalls}` };
  });
  const distinctStartedAt = performance.now();
  await Promise.all(
    distinctCredentialIds.map((credentialId) =>
      buildCodexTokenResolver(
        client!.db,
        settings,
        grant.workspaceId,
        credentialId,
        distinctDeps,
      ).getToken(),
    ),
  );
  const distinctElapsedMs = performance.now() - distinctStartedAt;

  const crossProcessCredentialId = await createExpiredCredential("cross-process-lock");
  const crossProcessStartedAt = performance.now();
  const children = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, import.meta.path, "--child"], {
      env: {
        ...process.env,
        OPENGENI_BENCH_REFRESH_DATABASE_URL: services.databaseUrl,
        OPENGENI_BENCH_REFRESH_WORKSPACE_ID: grant.workspaceId,
        OPENGENI_BENCH_REFRESH_CREDENTIAL_ID: crossProcessCredentialId,
        OPENGENI_BENCH_REFRESH_ENCRYPTION_KEY: ENCRYPTION_KEY_BASE64,
        OPENGENI_BENCH_REFRESH_DELAY_MS: "500",
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const childReceipts = await Promise.all(
    children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`refresh child failed (${exitCode}): ${stderr.trim()}`);
      return JSON.parse(stdout) as { elapsedMs: number; refreshCalls: number };
    }),
  );
  const crossProcessElapsedMs = performance.now() - crossProcessStartedAt;

  const permanentCredentialId = await createExpiredCredential("permanent-failure");
  const permanentStartedAt = performance.now();
  let permanentError = "none";
  try {
    await buildCodexTokenResolver(
      client.db,
      settings,
      grant.workspaceId,
      permanentCredentialId,
      realDeps(async () => {
        throw new CodexReloginRequired("synthetic expired refresh token");
      }),
    ).getToken();
  } catch (error) {
    permanentError = error instanceof Error ? error.name : String(error);
  }
  const permanentElapsedMs = performance.now() - permanentStartedAt;
  const permanentRow = await loadCodexCredentialForRun(
    client.db,
    settings,
    grant.workspaceId,
    permanentCredentialId,
  );

  const transientCredentialId = await createExpiredCredential("transient-failure");
  const transientStartedAt = performance.now();
  let transientError = "none";
  try {
    await buildCodexTokenResolver(
      client.db,
      settings,
      grant.workspaceId,
      transientCredentialId,
      realDeps(async () => {
        await sleep(100);
        throw new CodexRefreshTransient("synthetic provider unavailable");
      }),
    ).getToken();
  } catch (error) {
    transientError = error instanceof Error ? error.name : String(error);
  }
  const transientElapsedMs = performance.now() - transientStartedAt;
  const transientRow = await loadCodexCredentialForRun(
    client.db,
    settings,
    grant.workspaceId,
    transientCredentialId,
  );

  const timeoutCredentialId = await createExpiredCredential("timeout");
  const timeoutStartedAt = performance.now();
  let timeoutError = "none";
  try {
    await buildCodexTokenResolver(
      client.db,
      settings,
      grant.workspaceId,
      timeoutCredentialId,
      realDeps(async () => {
        await sleep(6_500);
        return { accessToken: "too-late" };
      }),
    ).getToken();
  } catch (error) {
    timeoutError = error instanceof Error ? error.message : String(error);
  }
  const timeoutElapsedMs = performance.now() - timeoutStartedAt;
  const timeoutRow = await loadCodexCredentialForRun(
    client.db,
    settings,
    grant.workspaceId,
    timeoutCredentialId,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        configuration: {
          databasePoolSize: 10,
          providerRefreshDeadlineMs: 6_000,
          crossProcessCallers: childReceipts.length,
          sameProcessCallers: sameProcessTokens.length,
          distinctCredentialCallers: distinctCredentialIds.length,
        },
        providerDelayReceipts,
        sameCredentialSameProcess: {
          callers: sameProcessTokens.length,
          injectedProviderDelayMs: 500,
          elapsedMs: sameProcessElapsedMs,
          providerRefreshCalls: sameProcessRefreshCalls,
          allCallersReceivedRefreshedToken: sameProcessTokens.every(
            (token) => token.accessToken === "same-process-refreshed",
          ),
        },
        sameCredentialCrossProcess: {
          callers: childReceipts.length,
          injectedProviderDelayMs: 500,
          wallElapsedMs: crossProcessElapsedMs,
          childElapsedMs: distribution(childReceipts.map((receipt) => receipt.elapsedMs)),
          providerRefreshCalls: childReceipts.reduce(
            (total, receipt) => total + receipt.refreshCalls,
            0,
          ),
        },
        distinctCredentials: {
          callers: distinctCredentialIds.length,
          injectedProviderDelayMs: 100,
          databasePoolSize: 10,
          elapsedMs: distinctElapsedMs,
          providerRefreshCalls: distinctRefreshCalls,
        },
        failures: {
          permanent: {
            elapsedMs: permanentElapsedMs,
            error: permanentError,
            storedStatus: permanentRow?.status ?? null,
          },
          transient: {
            elapsedMs: transientElapsedMs,
            error: transientError,
            storedStatus: transientRow?.status ?? null,
          },
          timeout: {
            elapsedMs: timeoutElapsedMs,
            error: timeoutError,
            storedStatus: timeoutRow?.status ?? null,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client?.close();
  await services.down();
}

// The DB test harness owns internal, unref'd compose bookkeeping that has no
// aggregate close hook. All external resources are drained above; exit only
// after the complete benchmark receipt and cleanup have settled.
process.exit(0);

function realDeps(refresh: CodexAuthDeps["refresh"]): CodexAuthDeps {
  return {
    loadCredential: loadCodexCredentialForRun,
    recordRefresh: recordCodexTokenRefresh,
    setStatus: setCodexCredentialStatus,
    refresh,
    encrypt: encryptEnvironmentValue,
    keyBytes: environmentsEncryptionKeyBytes,
    withRefreshLock: withCodexCredentialRefreshLock,
  };
}

async function runChild(): Promise<void> {
  const databaseUrl = requiredEnv("OPENGENI_BENCH_REFRESH_DATABASE_URL");
  const workspaceId = requiredEnv("OPENGENI_BENCH_REFRESH_WORKSPACE_ID");
  const credentialId = requiredEnv("OPENGENI_BENCH_REFRESH_CREDENTIAL_ID");
  const encryptionKey = requiredEnv("OPENGENI_BENCH_REFRESH_ENCRYPTION_KEY");
  const delayMs = Number(requiredEnv("OPENGENI_BENCH_REFRESH_DELAY_MS"));
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("invalid child refresh delay");
  const childClient = createDb(databaseUrl, { max: 2 });
  try {
    const settings = testSettings({
      databaseUrl,
      environmentsEncryptionKey: encryptionKey,
      codexSubscriptionEnabled: true,
    });
    let refreshCalls = 0;
    const startedAt = performance.now();
    await buildCodexTokenResolver(
      childClient.db,
      settings,
      workspaceId,
      credentialId,
      realDeps(async () => {
        refreshCalls += 1;
        await sleep(delayMs);
        return { accessToken: "cross-process-refreshed" };
      }),
    ).getToken();
    process.stdout.write(
      JSON.stringify({ elapsedMs: performance.now() - startedAt, refreshCalls }),
    );
  } finally {
    await childClient.close();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function migrateQuietly(): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await services.migrate();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function distribution(values: readonly number[]) {
  if (values.length === 0) throw new Error("cannot summarize an empty distribution");
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

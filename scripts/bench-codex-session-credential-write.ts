#!/usr/bin/env bun
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  recordSessionActiveCodexCredential,
  upsertCodexSubscriptionCredential,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import postgres from "postgres";

const samples = integerArgument("--samples", 50);
const parallelSessions = integerArgument("--parallel-sessions", 32);
if (samples < 5 || samples > 1_000) throw new Error("--samples must be between 5 and 1000");
if (parallelSessions < 1 || parallelSessions > 200) {
  throw new Error("--parallel-sessions must be between 1 and 200");
}

const services = await startTestServices({ temporal: false });
let client: ReturnType<typeof createDb> | null = null;
let raw: ReturnType<typeof postgres> | null = null;
try {
  await services.migrate();
  client = createDb(services.databaseUrl);
  raw = postgres(services.databaseUrl, { max: Math.min(64, parallelSessions + 4) });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "codex-credential-write-benchmark",
    accountExternalId: `account-${suffix}`,
    accountName: "Codex credential write benchmark",
    workspaceExternalSource: "codex-credential-write-benchmark",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Codex credential write benchmark",
    subjectId: `benchmark:${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("Benchmark workspace bootstrap failed");

  const firstCredential = await createCredential("first");
  const secondCredential = await createCredential("second");
  const sessions = await Promise.all(
    Array.from({ length: parallelSessions }, (_, index) =>
      createSession(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: `credential write benchmark ${index}`,
        resources: [],
        metadata: {},
        model: "gpt-5.6",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: grant.subjectId },
        createdByContext: {},
      }),
    ),
  );
  await Promise.all(
    sessions.map((session) =>
      recordSessionActiveCodexCredential(
        client!.db,
        grant.workspaceId,
        session.id,
        firstCredential,
      ),
    ),
  );

  const primarySession = sessions[0]!;
  const revisionBeforeNoops = await activityRevision();
  const noOpSamples = await measure(samples, async () => {
    await recordSessionActiveCodexCredential(
      client!.db,
      grant.workspaceId,
      primarySession.id,
      firstCredential,
    );
  });
  const revisionAfterNoops = await activityRevision();

  let workerGuardDatabaseCalls = 0;
  const recordIfChanged = async (priorCredentialId: string, effectiveCredentialId: string) => {
    if (priorCredentialId === effectiveCredentialId) return;
    workerGuardDatabaseCalls += 1;
    await recordSessionActiveCodexCredential(
      client!.db,
      grant.workspaceId,
      primarySession.id,
      effectiveCredentialId,
    );
  };
  const workerGuardedSamples = await measure(samples, async () => {
    await recordIfChanged(firstCredential, firstCredential);
  });

  const parallelRevisionBefore = await activityRevision();
  const parallelStartedAt = performance.now();
  await Promise.all(
    sessions.map((session) =>
      recordSessionActiveCodexCredential(
        client!.db,
        grant.workspaceId,
        session.id,
        firstCredential,
      ),
    ),
  );
  const parallelElapsedMs = performance.now() - parallelStartedAt;
  const parallelRevisionAfter = await activityRevision();

  const changedStartedAt = performance.now();
  await recordSessionActiveCodexCredential(
    client.db,
    grant.workspaceId,
    primarySession.id,
    secondCredential,
  );
  const changedElapsedMs = performance.now() - changedStartedAt;
  const [sessionRow] = await raw<
    Array<{
      activity_revision: string;
      codex_last_credential_id: string;
      updated_at: Date;
    }>
  >`
    select activity_revision::text, codex_last_credential_id, updated_at
    from sessions
    where workspace_id = ${grant.workspaceId}::uuid and id = ${primarySession.id}::uuid
  `;

  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration: { samples, parallelSessions },
    directIdempotentAccessor: {
      elapsedMs: distribution(noOpSamples),
      workspaceActivityRevisionDelta: revisionAfterNoops - revisionBeforeNoops,
      expectedSemanticChanges: 0,
    },
    workerKnownUnchangedCredential: {
      elapsedMs: distribution(workerGuardedSamples),
      databaseCalls: workerGuardDatabaseCalls,
      expectedSemanticChanges: 0,
    },
    parallelUnchangedCredentials: {
      elapsedMs: parallelElapsedMs,
      sessions: sessions.length,
      workspaceActivityRevisionDelta: parallelRevisionAfter - parallelRevisionBefore,
      expectedSemanticChanges: 0,
    },
    changedCredential: {
      elapsedMs: changedElapsedMs,
      storedCredentialId: sessionRow?.codex_last_credential_id ?? null,
      expectedCredentialId: secondCredential,
      sessionActivityRevision: sessionRow?.activity_revision ?? null,
      sessionUpdatedAt: sessionRow?.updated_at.toISOString() ?? null,
    },
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

  async function createCredential(label: string): Promise<string> {
    const result = await upsertCodexSubscriptionCredential(client!.db, {
      accountId: grant!.accountId,
      workspaceId: grant!.workspaceId,
      credentialEncrypted: `benchmark-not-a-secret:${label}:${suffix}`,
      chatgptAccountId: `benchmark-${label}-${suffix}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: null,
      lastRefreshAt: null,
    });
    if (result.kind !== "upserted") throw new Error("Credential benchmark upsert was unresolved");
    return result.id;
  }

  async function activityRevision(): Promise<number> {
    const [row] = await raw!<Array<{ revision: string }>>`
      select revision::text
      from workspace_session_activity_revisions
      where workspace_id = ${grant!.workspaceId}::uuid
    `;
    if (!row) throw new Error("Workspace activity revision row is missing");
    return Number(row.revision);
  }
} finally {
  await raw?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await services.down();
}

async function measure(count: number, run: () => Promise<void>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await run();
    values.push(performance.now() - startedAt);
  }
  return values;
}

function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ordered.at(-1)!,
  };
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

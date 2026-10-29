// The secret history scrub over HTTP through the composed API, against
// PostgreSQL (docs/secrets.md, "Removing secrets from stored history"): a
// workspace admin scrubs a vault value from a session's stored history; a
// member without admin is refused; and the value never appears in the
// response, the audit event or anything the process logs. Values are fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  formatSecretReference,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
  type SecretRedactionResponse,
} from "@opengeni/contracts";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  encryptEnvironmentValue,
  ensureDefaultVault,
  upsertVaultItem,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { secretRedactionReferenceAllowed } from "../src/routes/secret-redactions";

const KEY = new Uint8Array(32).fill(7);
const FAKE_TOKEN = `ghp_${"F4KE".repeat(9)}`;
const delegationSecret = randomBytes(32).toString("hex");

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-secret-redactions");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret,
    environmentsEncryptionKey: Buffer.from(KEY).toString("base64"),
    publicBaseUrl: "https://app.example.test",
  }) as Settings;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const MEMBER_PERMISSIONS: Permission[] = [
  "sessions:read",
  "sessions:control",
  "secrets:list",
  "secrets:use",
];

async function world() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scrub-api-account-${suffix}`,
    accountName: "Secret scrub API",
    workspaceExternalSource: "test",
    workspaceExternalId: `scrub-api-workspace-${suffix}`,
    workspaceName: "Secret scrub API",
    subjectId: `user:owner-${suffix}`,
  });
  const owner = access.workspaceGrants[0]! as AccessGrant;
  const memberSubject = `user:member-${suffix}`;
  const [personal] = await shared!.admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${owner.accountId}::uuid, 'Personal')
    returning id::text as id`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
    values (${owner.accountId}::uuid, ${memberSubject}, 'active', 'member', ${personal!.id}::uuid)
    on conflict do nothing`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
    values (${owner.accountId}::uuid, ${owner.workspaceId}::uuid, ${memberSubject},
      ${JSON.stringify(MEMBER_PERMISSIONS)}::text::jsonb)
    on conflict do nothing`;
  const context = {
    kind: "subject" as const,
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
  };
  const vault = await ensureDefaultVault(client.db, context, {
    workspaceId: owner.workspaceId,
    ownerKind: "workspace",
  });
  await upsertVaultItem(client.db, context, {
    vaultId: vault.id,
    name: "Deploy token",
    type: "api_key",
    primaryFieldName: "value",
    fields: [
      {
        name: "value",
        kind: "concealed",
        valueEncrypted: encryptEnvironmentValue(KEY, FAKE_TOKEN),
        valueSize: FAKE_TOKEN.length,
      },
    ],
  });
  const session = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    initialMessage: `Push with ${FAKE_TOKEN} and report back`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: owner.subjectId },
  } as Parameters<typeof createSession>[1]);
  await appendSessionEvents(client.db, owner.workspaceId, session.id, [
    { type: "user.message", payload: { text: `token: ${FAKE_TOKEN}` } },
  ]);
  await upsertVaultItem(client.db, context, {
    vaultId: vault.id,
    name: "Short value",
    type: "api_key",
    primaryFieldName: "value",
    fields: [
      {
        name: "value",
        kind: "concealed",
        valueEncrypted: encryptEnvironmentValue(KEY, "abc12"),
        valueSize: 5,
      },
    ],
  });
  const bare = `${vault.name}/Deploy token/value`;
  return {
    owner,
    memberSubject,
    sessionId: session.id,
    bare,
    short: `${vault.name}/Short value/value`,
    braced: formatSecretReference({ vault: vault.name, item: "Deploy token", field: "value" }),
  };
}

function app() {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

async function scrub(
  target: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
  body: unknown,
) {
  const token = await signDelegatedAccessToken(delegationSecret, {
    accountId: target.accountId,
    workspaceId: target.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return await app().request(`/v1/workspaces/${target.workspaceId}/secret-redactions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Everything written to the console while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    };
  }
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function storedCopies(workspaceId: string): Promise<number> {
  const [row] = await shared!.admin<Array<{ n: number }>>`
    select (
      (select count(*) from sessions s where s.workspace_id = ${workspaceId}::uuid
        and strpos(row_to_json(s)::text, ${FAKE_TOKEN}) > 0)
      + (select count(*) from session_events e where e.workspace_id = ${workspaceId}::uuid
        and strpos(e.payload::text, ${FAKE_TOKEN}) > 0)
      + (select count(*) from session_message_search_texts t where t.workspace_id = ${workspaceId}::uuid
        and strpos(t.text, ${FAKE_TOKEN}) > 0)
    )::int as n`;
  return Number(row!.n);
}

describe("POST /v1/workspaces/:workspaceId/secret-redactions", () => {
  test("an admin scrubs a vault value; the value appears in no response, audit or log", async () => {
    if (!shared) return;
    const w = await world();
    const initial = await storedCopies(w.owner.workspaceId);
    expect(initial).toBeGreaterThan(1);
    const admin: Permission[] = ["workspace:admin"];

    const { result, logs } = await captureLogs(async () => {
      const dry = await scrub(w.owner, w.owner.subjectId, admin, {
        sessionIds: [w.sessionId],
        match: { reference: w.bare },
        dryRun: true,
      });
      const dryText = await dry.text();
      const before = await storedCopies(w.owner.workspaceId);
      const run = await scrub(w.owner, w.owner.subjectId, admin, {
        sessionIds: [w.sessionId],
        match: { reference: w.braced },
      });
      const runText = await run.text();
      const again = await scrub(w.owner, w.owner.subjectId, admin, {
        sessionIds: [w.sessionId],
        match: { reference: w.bare },
      });
      const againText = await again.text();
      return { dry, dryText, before, run, runText, again, againText };
    });

    expect(result.dry.status).toBe(200);
    const dry = JSON.parse(result.dryText) as SecretRedactionResponse;
    expect(dry.dryRun).toBe(true);
    expect(dry.tables.sessions!.rowsMatched).toBe(1);
    expect(dry.tables.session_events!.rowsMatched).toBeGreaterThan(0);
    // A dry run changes nothing.
    expect(result.before).toBe(initial);

    expect(result.run.status).toBe(200);
    const run = JSON.parse(result.runText) as SecretRedactionResponse;
    expect(run.match).toEqual({
      kind: "reference",
      label: expect.stringContaining("Deploy token"),
    });
    expect(run.failures).toEqual([]);
    expect(run.tables.sessions!.rowsChanged).toBe(1);
    expect(await storedCopies(w.owner.workspaceId)).toBe(0);
    const [session] = await shared!.admin<Array<{ initial_message: string }>>`
      select initial_message from sessions where id = ${w.sessionId}::uuid`;
    expect(session!.initial_message).toMatch(
      /^Push with \[redacted: secret:.*Deploy token\/value\] and report back$/u,
    );

    // A second run finds nothing.
    const again = JSON.parse(result.againText) as SecretRedactionResponse;
    expect(Object.values(again.tables).every((counts) => counts.rowsMatched === 0)).toBe(true);

    const audits = await shared!.admin<Array<{ action: string; metadata: unknown }>>`
      select action, metadata from audit_events
      where workspace_id = ${w.owner.workspaceId}::uuid and action like 'session.secret_history.%'
      order by occurred_at`;
    expect(audits.map((row) => row.action)).toEqual([
      "session.secret_history.counted",
      "session.secret_history.redacted",
      "session.secret_history.redacted",
    ]);
    const everything = [
      result.dryText,
      result.runText,
      result.againText,
      JSON.stringify(audits),
      logs,
    ];
    for (const text of everything) expect(text).not.toContain(FAKE_TOKEN);
    const [allAudit] = await shared!.admin<Array<{ text: string }>>`
      select coalesce(string_agg(row_to_json(a)::text, ''), '') as text from audit_events a
      where workspace_id = ${w.owner.workspaceId}::uuid`;
    expect(allAudit!.text).not.toContain(FAKE_TOKEN);
  }, 120_000);

  test("a member without workspace admin is refused and nothing changes", async () => {
    if (!shared) return;
    const w = await world();
    const before = await storedCopies(w.owner.workspaceId);
    const response = await scrub(w.owner, w.memberSubject, MEMBER_PERMISSIONS, {
      sessionIds: [w.sessionId],
      match: { reference: w.bare },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(FAKE_TOKEN);
    expect(await storedCopies(w.owner.workspaceId)).toBe(before);
  }, 120_000);

  test("a URL password limited to one host is scrubbed while other hosts are untouched", async () => {
    if (!shared) return;
    const w = await world();
    const password = "fakeDbPa55-word";
    const kept = `postgres://app:${password}@db-two.example.test:5432/app`;
    await appendSessionEvents(client.db, w.owner.workspaceId, w.sessionId, [
      {
        type: "user.message",
        payload: {
          text: `A=postgres://app:${password}@db-one.example.test:5432/app?sslmode=require\nB=${kept}`,
        },
      },
    ]);
    const body = {
      sessionIds: [w.sessionId],
      match: { patterns: [{ kind: "url_password", hosts: ["DB-ONE.example.test"] }] },
    };
    const admin: Permission[] = ["workspace:admin"];
    const run = await scrub(w.owner, w.owner.subjectId, admin, body);
    expect(run.status).toBe(200);
    const report = (await run.json()) as SecretRedactionResponse;
    expect(report.match).toEqual({ kind: "patterns", label: "url_password" });
    expect(report.tables.session_events!.rowsChanged).toBe(1);
    const [row] = await shared!.admin<Array<{ text: string }>>`
      select string_agg(payload::text, '') as text from session_events
      where session_id = ${w.sessionId}::uuid`;
    expect(row!.text).toContain("postgres://app:[redacted: url_password]@db-one.example.test");
    expect(row!.text).toContain(kept);
    // The GitHub token in the same session was not asked for and stays.
    expect(await storedCopies(w.owner.workspaceId)).toBeGreaterThan(0);
    const again = (await (
      await scrub(w.owner, w.owner.subjectId, admin, body)
    ).json()) as SecretRedactionResponse;
    expect(Object.values(again.tables).every((counts) => counts.rowsChanged === 0)).toBe(true);
  }, 120_000);

  test("an unknown session is not found and invalid input is never echoed", async () => {
    if (!shared) return;
    const w = await world();
    const admin: Permission[] = ["workspace:admin"];
    const missing = await scrub(w.owner, w.owner.subjectId, admin, {
      sessionIds: [crypto.randomUUID()],
      match: { patterns: [{ kind: "github_token" }] },
    });
    expect(missing.status).toBe(404);
    const invalid = await scrub(w.owner, w.owner.subjectId, admin, {
      sessionIds: [w.sessionId],
      match: { reference: `${FAKE_TOKEN}}}` },
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).not.toContain(FAKE_TOKEN);
  }, 120_000);

  test("a value too short to search safely is refused before anything runs", async () => {
    if (!shared) return;
    const w = await world();
    const before = await storedCopies(w.owner.workspaceId);
    const response = await scrub(w.owner, w.owner.subjectId, ["workspace:admin"], {
      sessionIds: [w.sessionId],
      match: { reference: w.short },
    });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("abc12");
    expect(await storedCopies(w.owner.workspaceId)).toBe(before);
  }, 120_000);

  test("a reference needs secrets:use; admin implies it only outside explicit grants", () => {
    expect(secretRedactionReferenceAllowed({ permissions: ["workspace:admin"] })).toBe(true);
    expect(
      secretRedactionReferenceAllowed({
        permissions: ["workspace:admin"],
        permissionMode: "explicit",
      }),
    ).toBe(false);
    expect(
      secretRedactionReferenceAllowed({
        permissions: ["workspace:admin", "secrets:use"],
        permissionMode: "explicit",
      }),
    ).toBe(true);
  });
});

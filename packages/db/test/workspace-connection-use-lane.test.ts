// Migration 0279: workspace-owned connections resolve through
// resolve_accepted_connection_use like every other lane - canonical lifecycle
// fences, live workspace-row validation, and idempotent audit facts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { testSettings } from "@opengeni/testing";
import {
  buildConnectionTokenResolver,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  resolveAcceptedConnectionUse,
  type Database,
  type DbClient,
} from "../src";
import type { ConnectionBrokerDeps } from "../src/connection-token-resolver";

const migrationUrl = new URL("../drizzle/0279_workspace_connection_use_lane.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-connection-use-lane");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Fixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

async function claimedTurnFixture(): Promise<Fixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('workspace-connection-lane') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'connection-lane-workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "use the workspace connection",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspace!.id, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `connection-lane-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
}

async function insertWorkspaceConnection(
  fixture: Pick<Fixture, "accountId" | "workspaceId">,
  overrides: { workspaceId?: string; status?: string } = {},
): Promise<{ id: string; generation: number }> {
  const workspaceId = overrides.workspaceId ?? fixture.workspaceId;
  const [row] = await admin<{ id: string; generation: number }[]>`
    insert into connections (
      account_id, workspace_id, origin_workspace_id, provider_domain, kind,
      credential_encrypted, status
    ) values (
      ${fixture.accountId}, ${workspaceId}, ${workspaceId}, 'linear.app',
      'oauth2', 'ciphertext-never-read-by-authority', ${overrides.status ?? "active"}
    ) returning id, authority_generation::int as generation`;
  return row!;
}

function useInput(fixture: Fixture, connectionId: string) {
  return {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    turnId: fixture.turnId,
    attemptId: fixture.attemptId,
    executionGeneration: fixture.executionGeneration,
    physicalRequestId: crypto.randomUUID(),
    usePhase: "credential_resolution" as const,
    serverId: "linear",
    connectionId,
    providerDomain: "linear.app",
    connectionKind: "oauth2" as const,
    subjectScope: "workspace" as const,
  };
}

describe("workspace connection use lane (migration 0279)", () => {
  test("declares one rolling redefinition with the workspace lane and re-pinned posture", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE OR REPLACE FUNCTION resolve_accepted_connection_use(");
    expect(source).toContain("ELSIF p_subject_scope = 'workspace' THEN");
    expect(source).toContain("connection_row.authority_scope IS DISTINCT FROM 'workspace'");
    expect(source).toContain("SET search_path = pg_catalog, %I, public, pg_temp");
    expect(source).toContain("REVOKE ALL ON FUNCTION");
    expect(source).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')");
    expect(source).not.toMatch(/\bALTER TABLE\b/u);
    expect(source).not.toMatch(/\bDROP TABLE\b/u);
  });

  test("authorizes the live workspace-owned connection inside the lifecycle fences", async () => {
    if (!available) return;
    const fixture = await claimedTurnFixture();
    const connection = await insertWorkspaceConnection(fixture);
    const input = useInput(fixture, connection.id);
    const resolution = await resolveAcceptedConnectionUse(db, input);
    expect(resolution.status).toBe("authorized");
    if (resolution.status !== "authorized") throw new Error("unreachable");
    expect(resolution.originWorkspaceId).toBe(fixture.workspaceId);
    expect(resolution.connectionKind).toBe("oauth2");
    expect(resolution.attribution).toMatchObject({
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      scope: "workspace",
      ownerSubjectId: null,
      authorityId: null,
      grantId: null,
    });
    const [audit] = await admin<
      Array<{ outcome: string; authority_scope: string; owner_subject_id: string | null }>
    >`
      select outcome, authority_scope, owner_subject_id
      from connection_use_audit_facts
      where physical_request_id = ${input.physicalRequestId}`;
    expect(audit).toEqual({
      outcome: "authorized",
      authority_scope: "workspace",
      owner_subject_id: null,
    });
    // Idempotent replay of the exact physical request returns the same result.
    const replay = await resolveAcceptedConnectionUse(db, input);
    expect(replay.status).toBe("authorized");
  });

  test("denies another workspace's connection, an inactive row, and a personal row", async () => {
    if (!available) return;
    const fixture = await claimedTurnFixture();
    const [foreignWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fixture.accountId}, 'foreign-connection-workspace') returning id`;
    const foreign = await insertWorkspaceConnection(fixture, {
      workspaceId: foreignWorkspace!.id,
    });
    const inactive = await insertWorkspaceConnection(fixture, { status: "revoked" });
    const personal = await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${fixture.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', ${"user:owner"}, true)`;
      const [row] = await tx<{ id: string }[]>`
        insert into connections (
          account_id, workspace_id, subject_id, provider_domain, kind,
          credential_encrypted
        ) values (
          ${fixture.accountId}, ${fixture.workspaceId}, ${"user:owner"},
          'linear.app', 'oauth2', 'ciphertext-never-read-by-authority'
        ) returning id`;
      return row!;
    });

    const denials: Array<[string, string]> = [];
    for (const [label, connectionId] of [
      ["foreign", foreign.id],
      ["inactive", inactive.id],
      ["personal", personal.id],
    ] as const) {
      const resolution = await resolveAcceptedConnectionUse(db, useInput(fixture, connectionId));
      if (resolution.status !== "denied") throw new Error(`${label} was not denied`);
      denials.push([label, resolution.reason]);
    }
    expect(denials).toEqual([
      ["foreign", "connection_identity_changed"],
      ["inactive", "connection_status_inactive"],
      ["personal", "connection_identity_changed"],
    ]);
    // A denied use leaves the same audit evidence as an authorized one.
    const [deniedCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from connection_use_audit_facts
      where workspace_id = ${fixture.workspaceId} and outcome = 'denied'`;
    expect(deniedCount!.count).toBe(3);
  });

  test("a settled attempt fences the workspace lane like every other lane", async () => {
    if (!available) return;
    const fixture = await claimedTurnFixture();
    const connection = await insertWorkspaceConnection(fixture);
    await admin`
      update session_turn_attempts
      set state = 'closed', outcome = 'completed', closed_at = now()
      where id = ${fixture.attemptId}`;
    const resolution = await resolveAcceptedConnectionUse(db, useInput(fixture, connection.id));
    expect(resolution).toEqual({ status: "denied", reason: "session_identity_changed" });
  });

  test("the standalone resolver never forwards an owner binding for a workspace ref", async () => {
    // Interactive turns stamp the initiating human's subjectId on every
    // credential request regardless of ref scope. The non-host resolver must
    // not turn that into a personal owner binding, or the 0279 workspace lane
    // denies the ambient shared row for every interactive turn.
    const captured: Array<Record<string, unknown>> = [];
    const never = () => {
      throw new Error("must not be reached after a denied authorization");
    };
    const deps = {
      loadCredential: never,
      recordRefresh: never,
      setStatus: never,
      recordUsed: never,
      refresh: never,
      encrypt: never,
      keyBytes: never,
      now: () => new Date(),
      authorizeAcceptedUse: async (_db: unknown, input: Record<string, unknown>) => {
        captured.push(input);
        return { status: "denied" as const, reason: "connection_status_inactive" as const };
      },
    } as unknown as ConnectionBrokerDeps;
    const resolver = buildConnectionTokenResolver({} as Database, testSettings(), deps);
    const result = await resolver({
      workspaceId: "workspace-1",
      subjectId: "user:human-initiator",
      serverId: "linear",
      destinationUrl: "https://mcp.linear.app/mcp",
      connectionRef: {
        providerDomain: "linear.app",
        connectionId: crypto.randomUUID(),
        kind: "oauth2",
        subjectScope: "workspace",
      },
      connectionUseContext: {
        accountId: crypto.randomUUID(),
        workspaceId: "workspace-1",
        sessionId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
        physicalRequestId: crypto.randomUUID(),
        usePhase: "credential_resolution",
      },
    });
    expect(result.status).toBe("auth_needed");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ subjectScope: "workspace" });
    expect("ownerSubjectId" in captured[0]!).toBe(false);
    // The subject lane keeps its owner binding.
    await resolver({
      workspaceId: "workspace-1",
      subjectId: "user:human-initiator",
      serverId: "linear",
      destinationUrl: "https://mcp.linear.app/mcp",
      connectionRef: {
        providerDomain: "linear.app",
        connectionId: crypto.randomUUID(),
        kind: "oauth2",
        subjectScope: "subject",
      },
      connectionUseContext: {
        accountId: crypto.randomUUID(),
        workspaceId: "workspace-1",
        sessionId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
        physicalRequestId: crypto.randomUUID(),
        usePhase: "credential_resolution",
      },
    });
    expect(captured[1]).toMatchObject({
      subjectScope: "subject",
      ownerSubjectId: "user:human-initiator",
    });
  });

  test("a frozen snapshot for the turn+server denies a workspace-scope request live", async () => {
    if (!available) return;
    const fixture = await claimedTurnFixture();
    const connection = await insertWorkspaceConnection(fixture);
    // Freeze an explicit-workspace snapshot for this exact turn + server. The
    // snapshot lane runs first and honors only personal ('user') snapshots,
    // so any frozen row for the pair refuses the ambient workspace borrow.
    await admin`
      insert into turn_connection_authority_snapshots (
        account_id, workspace_id, session_id, turn_id, server_id, connection_id,
        connection_generation, origin_workspace_id, provider_domain,
        connection_kind, authority_scope, authority_source,
        session_visibility, session_authority_epoch, canonical_snapshot,
        snapshot_digest
      )
      select ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId},
        ${fixture.turnId}, 'linear', ${connection.id}, ${connection.generation},
        ${fixture.workspaceId}, 'linear.app', 'oauth2', 'workspace',
        'explicit_workspace', 'workspace_shared', 1, snapshot.value,
        digest(convert_to(snapshot.value::text, 'UTF8'), 'sha256')
      from (select '{"kind":"frozen-workspace"}'::jsonb as value) snapshot`;
    const resolution = await resolveAcceptedConnectionUse(db, useInput(fixture, connection.id));
    expect(resolution).toEqual({ status: "denied", reason: "connection_identity_changed" });
  });

  test("the snapshot lane keeps precedence over the workspace lane in the function source", async () => {
    // A frozen per-turn personal snapshot for the same server takes the
    // snapshot lane (checked first), whose scope check denies a
    // workspace-scope request outright instead of borrowing the workspace
    // row. Asserted structurally: the workspace lane is reachable only when
    // no snapshot row was found for the turn + server.
    const source = await readFile(migrationUrl, "utf8");
    const snapshotLane = source.indexOf("FROM turn_connection_authority_snapshots");
    const workspaceLane = source.indexOf("ELSIF p_subject_scope = 'workspace' THEN");
    const legacyLane = source.indexOf("IS DISTINCT FROM 'legacy_user'");
    expect(snapshotLane).toBeGreaterThan(0);
    expect(workspaceLane).toBeGreaterThan(snapshotLane);
    expect(legacyLane).toBeGreaterThan(workspaceLane);
    expect(source).toContain("OR p_subject_scope IS DISTINCT FROM 'subject'");
  });
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  resolveAcceptedConnectionUse,
  sendAgentMessageInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("inherited-inactive-personal-connection");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("real PostgreSQL is required for inherited connection proof");
  }
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

// An agent's follow-up work inherits the personal accounts its human accepted.
// When one of those accounts later needs re-authorization or is revoked, the
// inherited turn must still run, exactly like a lapsed shared workspace
// account: the accepted selection stays on the turn, but it carries no
// authority, so every use of that account is denied and it is never revived.
test.each(["needs_reauth", "revoked"] as const)(
  "an agent turn whose inherited personal account became %s runs and is denied that account",
  async (status) => {
    if (!shared || !client) return;
    const sql = shared.admin;
    const [account] =
      await sql`insert into managed_accounts (name) values ('inherited inactive account') returning id`;
    const [origin] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'origin') returning id`;
    const [target] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
    const [personal] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'personal') returning id`;
    const human = `user:${crypto.randomUUID()}`;
    await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${account!.id}, ${human}, 'active', ${personal!.id})`;
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${target!.id}, ${human})`;
    const connectionIds = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${account!.id}, true), set_config('opengeni.workspace_id', ${origin!.id}, true), set_config('opengeni.subject_id', ${human}, true)`;
      const ids: string[] = [];
      for (const domain of ["mail.example.test", "chat.example.test"]) {
        const [connection] =
          await tx`insert into connections (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
          values (${account!.id}, ${origin!.id}, ${human}, ${domain}, 'oauth2', 'fixture-ciphertext') returning id`;
        ids.push(connection!.id as string);
      }
      return ids;
    });
    const scope = { accountId: account!.id as string, workspaceId: target!.id as string };
    await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
    const base = {
      ...scope,
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "low" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    };
    const source = await createSession(client.db, {
      ...base,
      subjectId: human,
      createdBy: { kind: "subject", subjectId: human },
      initialMessage: "",
    });
    const [stale, kept] = [
      {
        serverId: "mail",
        connectionId: connectionIds[0]!,
        originWorkspaceId: origin!.id as string,
        ownerSubjectId: human,
        providerDomain: "mail.example.test",
        kind: "oauth2" as const,
      },
      {
        serverId: "chat",
        connectionId: connectionIds[1]!,
        originWorkspaceId: origin!.id as string,
        ownerSubjectId: human,
        providerDomain: "chat.example.test",
        kind: "oauth2" as const,
      },
    ];
    await withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, human, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...scope,
        sessionId: source.id,
        subjectId: human,
        actor: { type: "human", subjectId: human },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Use my accounts",
        resources: [],
        model: "test-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
        personalConnectionDelegations: [stale!, kept!],
      }),
    );
    const sourceAttempt = crypto.randomUUID();
    const claimedSource = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: source.id,
      workflowId: `session-${source.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: sourceAttempt,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimedSource.action !== "claimed") throw new Error("Source turn was not claimed");
    const child = await createSession(client.db, {
      ...base,
      parentSessionId: source.id,
      initialMessage: "",
    });
    // The account lapses after the human accepted it but before agent work
    // inherits it, exactly like an expired OAuth refresh token.
    await sql`update connections set status = ${status} where id = ${stale!.connectionId}`;
    await withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, human, (tx) =>
      sendAgentMessageInTransaction(tx, {
        ...scope,
        targetSessionId: child.id,
        operationKey: crypto.randomUUID(),
        text: "Continue with my accounts",
        actor: {
          type: "agent_attempt",
          sessionId: source.id,
          turnId: claimedSource.turn.id,
          attemptId: sourceAttempt,
          executionGeneration: claimedSource.turn.executionGeneration,
        },
      }),
    );
    const childAttempt = crypto.randomUUID();
    const claimedChild = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: child.id,
      workflowId: `session-${child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttempt,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimedChild.action !== "claimed") {
      throw new Error(`Agent message was not claimed: ${claimedChild.action}`);
    }
    const [turn] = await sql`select initiating_human_subject_id, personal_connection_delegations
      from session_turns where id = ${claimedChild.turn.id}`;
    expect(turn).toMatchObject({
      initiating_human_subject_id: human,
      personal_connection_delegations: [stale, kept],
    });
    const snapshots = await sql`select connection_id from turn_connection_authority_snapshots
      where turn_id = ${claimedChild.turn.id}`;
    expect(snapshots.map((row) => row.connection_id)).toEqual([kept!.connectionId]);
    const use = (selection: typeof kept) =>
      resolveAcceptedConnectionUse(client!.db, {
        ...scope,
        sessionId: child.id,
        turnId: claimedChild.turn.id,
        attemptId: childAttempt,
        executionGeneration: claimedChild.turn.executionGeneration,
        physicalRequestId: crypto.randomUUID(),
        usePhase: "credential_resolution",
        serverId: selection!.serverId,
        connectionId: selection!.connectionId,
        providerDomain: selection!.providerDomain,
        connectionKind: "oauth2",
        subjectScope: "subject",
        ownerSubjectId: human,
      });
    expect(await use(kept)).toMatchObject({ status: "authorized" });
    expect(await use(stale)).toMatchObject({ status: "denied" });
  },
  180_000,
);

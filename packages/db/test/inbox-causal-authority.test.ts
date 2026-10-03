import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { HostMcpAcceptedAuthority } from "@opengeni/contracts/host-mcp-bindings";
import type { ExternalLinkWorkSnapshot } from "@opengeni/contracts/external-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import {
  beginExternalIdentityLink,
  confirmExternalIdentityLink,
  revokeExternalIdentityLink,
} from "../src/external-identity-links";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("inbox-causal-authority");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type UpdateKind = "child_paused" | "child_terminal_result" | "agent_message";

async function fixture(
  kinds: UpdateKind[] = ["child_paused", "child_paused"],
  secondHuman?: string | null,
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Inbox authority",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Inbox authority",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const human = `user:${crypto.randomUUID()}`;
  const personal = await createWorkspace(client.db, { accountId: scope.accountId, name: "Owner" });
  const [membership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id, authorization_revision)
    values (${scope.accountId}, ${human}, 'member', 'active', ${personal.id}, 1) returning id`;
  await grantWorkspaceAccess(client.db, {
    ...scope,
    subjectId: human,
    permissions: ["sessions:read", "sessions:create", "sessions:control"],
  });
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "Inbox authority",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: human },
  });
  const turns: string[] = [];
  const turnSessions: string[] = [];
  for (let position = 0; position < 2; position++) {
    const originHuman = position === 1 && secondHuman !== undefined ? secondHuman : human;
    const origin =
      kinds[position] === "agent_message"
        ? await createSession(client.db, {
            ...scope,
            parentSessionId: session.id,
            initialMessage: "Delegated work",
            resources: [],
            metadata: {},
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            createdBy: { kind: "subject", subjectId: human },
          })
        : session;
    const [turn] = await shared.admin<{ id: string }[]>`
      insert into session_turns
        (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
         status, position, prompt, model, reasoning_effort, sandbox_backend,
         initiator_kind, initiator_subject_id, initiating_human_subject_id)
      values (${scope.accountId}, ${scope.workspaceId}, ${origin.id}, gen_random_uuid(),
        ${`session-${origin.id}`}, 'completed', ${position}, 'Origin', 'scripted-model',
        'medium', 'none', ${originHuman ? "subject" : "service"},
        ${originHuman ?? "test-service"}, ${originHuman}) returning id`;
    turns.push(turn!.id);
    turnSessions.push(origin.id);
  }
  const host = HostMcpAcceptedAuthority.parse({
    version: 1,
    ...scope,
    targetSessionId: session.id,
    targetSessionVisibility: "workspace_shared",
    targetSessionAuthorityEpoch: 1,
    acceptedWork: { kind: "turn", turnId: turns[0]! },
    bindingId: crypto.randomUUID(),
    bindingGeneration: 1,
    definition: {
      serverId: "host",
      destinationUrl: "https://tools.example/mcp",
      connectionRef: {
        authoritySource: "host",
        connectionId: "opaque-account",
        providerDomain: "tools.example",
      },
    },
    ownerSubjectId: human,
    ownerOrganizationMembershipId: membership!.id,
    ownerMembershipAuthorizationRevision: 1,
    delegationId: crypto.randomUUID(),
    delegationGeneration: 1,
    source: { kind: "direct" },
  });
  const identity = await ensureExternalIdentity(client.db, {
    accountId: scope.accountId,
    externalId: suffix,
  });
  const pending = await beginExternalIdentityLink(client.db, identity, {
    permissions: ["sessions:read", "sessions:create"],
  });
  const link = await confirmExternalIdentityLink(client.db, {
    accountId: scope.accountId,
    linkId: pending.link.id,
    nativeSubjectId: human,
    request: {
      challenge: pending.challenge,
      expectedRevision: 1,
      permissions: ["sessions:read", "sessions:create"],
    },
  });
  const external: ExternalLinkWorkSnapshot = {
    identity: { source: identity.source, externalId: identity.externalId },
    actor: {
      accountId: scope.accountId,
      authenticatingApiKeyId: crypto.randomUUID(),
      externalIdentityId: identity.id,
      externalSubjectId: identity.subjectId,
      externalAuthorizationRevision: identity.authorizationRevision,
      effectiveSubjectId: human,
      actingMode: "linked_native",
      linkId: link.id,
      linkRevision: link.revision,
    },
    permissions: ["sessions:read", "sessions:create"],
  };
  return { ...scope, sessionId: session.id, human, turns, turnSessions, kinds, host, external };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Authority = { host?: HostMcpAcceptedAuthority; external?: ExternalLinkWorkSnapshot };

async function arrange(f: Fixture, authorities: Authority[]) {
  // Synthetic immutable acceptance records isolate batching from admission and
  // credential liveness. Only this admin fixture transaction bypasses triggers;
  // the claim below runs with ordinary app permissions and all RLS enabled.
  // Host bindings are deliberately absent: these tests do not assert MCP use.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const [index, authority] of authorities.entries()) {
      const turnId = f.turns[index]!;
      if (authority.host) {
        const snapshot = HostMcpAcceptedAuthority.parse({
          ...authority.host,
          targetSessionId: f.turnSessions[index],
          acceptedWork: { kind: "turn", turnId },
          source:
            index === 0
              ? { kind: "direct" }
              : { kind: "inherited_turn", sessionId: f.sessionId, turnId: f.turns[0]! },
        });
        await tx`insert into host_mcp_turn_authorities
          (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id,
           binding_id, delegation_id, canonical_snapshot)
          values (${turnId}, ${snapshot.definition.serverId}, ${f.accountId}, ${f.workspaceId},
            ${f.turnSessions[index]!}, ${f.human}, ${snapshot.bindingId}, ${snapshot.delegationId}, ${tx.json(snapshot)})`;
      }
      if (authority.external) {
        const snapshot = authority.external;
        if (!snapshot.actor.linkId || snapshot.actor.linkRevision === undefined) {
          throw new Error("Fixture requires an explicit linked authority");
        }
        await tx`insert into external_link_turn_authorities
          (turn_id, account_id, workspace_id, session_id, link_id, link_revision, canonical_snapshot, source_kind)
          values (${turnId}, ${f.accountId}, ${f.workspaceId}, ${f.turnSessions[index]!},
            ${snapshot.actor.linkId}, ${snapshot.actor.linkRevision}, ${tx.json(snapshot)}, 'direct')`;
      }
    }
  });
  const updates = [];
  for (const [index, turnId] of f.turns.entries()) {
    const sourceId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const lineage =
      f.kinds[index] === "agent_message"
        ? {
            callerSessionId: f.turnSessions[index]!,
            callerTurnId: turnId,
            callerAttemptId: crypto.randomUUID(),
            callerExecutionGeneration: 1,
          }
        : {
            parentTurnId: turnId,
            parentSessionId: f.sessionId,
            childSessionId,
            connectionAuthoritySubjectId: f.human,
          };
    await addSessionSystemUpdate(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      classification: "info",
      sourceId,
      dedupeKey: sourceId,
      summary: "Child paused",
      lineage,
      ...(f.kinds[index] === "agent_message"
        ? ({
            kind: "agent_message",
            payload: {
              type: "agent_message",
              text: "Delegated result",
              operationId: crypto.randomUUID(),
            },
          } as const)
        : f.kinds[index] === "child_terminal_result"
          ? ({
              kind: "child_terminal_result",
              payload: {
                type: "child_terminal_result",
                childSessionId,
                status: "idle",
              },
            } as const)
          : ({
              kind: "child_paused",
              payload: {
                type: "child_paused",
                childSessionId,
                operationId: crypto.randomUUID(),
                actorKind: "agent",
                reason: "Awaited input",
              },
            } as const)),
    });
    updates.push({ sourceId, lineage });
  }
  return updates;
}

async function verify(
  f: Fixture,
  authorities: Authority[],
  coalesces: boolean,
  beforeClaim?: () => Promise<unknown>,
) {
  const updates = await arrange(f, authorities);
  await beforeClaim?.();
  // Prove the accepted host snapshots are visible to the causal owner under
  // actual RLS; an unscoped worker read must not silently treat these as empty.
  const visible = await withWorkspaceSubjectRls(client.db, f.workspaceId, f.human, (tx) =>
    tx.execute(
      sql`select turn_id from host_mcp_turn_authorities where turn_id in (${f.turns[0]}::uuid, ${f.turns[1]}::uuid)`,
    ),
  );
  expect(Array.from(visible)).toHaveLength(authorities.filter((a) => a.host).length);
  const claim = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claim.action).toBe("claimed");
  if (claim.action !== "claimed") throw new Error(`Expected claim, got ${claim.action}`);
  expect(claim.turn.initiatingHumanSubjectId).toBe(f.human);
  const rows = await shared.admin`
    select source_id, state, lineage, delivered_turn_id, delivered_history_item_id
    from session_system_updates where session_id = ${f.sessionId}`;
  expect(rows).toHaveLength(2);
  for (const [index, update] of updates.entries()) {
    const row = rows.find((r) => r.source_id === update.sourceId)!;
    expect(row.lineage).toEqual(update.lineage);
    const delivered = index === 0 || coalesces;
    expect(row.state).toBe(delivered ? "delivered" : "pending");
    expect(row.delivered_turn_id).toBe(delivered ? claim.turn.id : null);
    if (delivered) expect(row.delivered_history_item_id).not.toBeNull();
    else expect(row.delivered_history_item_id).toBeNull();
  }
  if (coalesces)
    expect(rows[0]!.delivered_history_item_id).toBe(rows[1]!.delivered_history_item_id);
  const inherited = await shared.admin`
    select canonical_snapshot, source_kind, source_turn_id
    from external_link_turn_authorities where turn_id = ${claim.turn.id}`;
  const causalIndex = f.kinds.findIndex(
    (kind, index) => kind !== "agent_message" && (index === 0 || coalesces),
  );
  if (causalIndex >= 0 && authorities[causalIndex]!.external) {
    expect(inherited).toMatchObject([
      {
        canonical_snapshot: authorities[causalIndex]!.external,
        source_kind: "causal",
        source_turn_id: f.turns[causalIndex],
      },
    ]);
  } else {
    expect(inherited).toHaveLength(0);
  }
  return claim.turn.id;
}

describe("same-human cross-origin inbox authority under app RLS", () => {
  test.each([
    ["agent_message", "agent_message"],
    ["agent_message", "child_terminal_result"],
    ["child_terminal_result", "agent_message"],
  ] as UpdateKind[][])(
    "compatible %s and %s share one delivery with retained lineage",
    async (first, second) => {
      const f = await fixture([first, second]);
      await verify(f, [{}, {}], true);
    },
  );

  test("different message senders cannot borrow each other's human", async () => {
    const f = await fixture(["agent_message", "agent_message"], `user:${crypto.randomUUID()}`);
    await verify(f, [{}, {}], false);
  });

  test("a service-only message does not join a human result", async () => {
    const f = await fixture(["child_paused", "agent_message"], null);
    await verify(f, [{}, {}], false);
  });

  test("message batching resolves external and host authority on the sender session", async () => {
    for (const kind of ["external", "host"] as const) {
      const f = await fixture(["agent_message", "agent_message"]);
      await verify(f, [{}, { [kind]: f[kind] }], false);
    }
  });

  test("equivalent external authority lets a message and result share delivery", async () => {
    const f = await fixture(["agent_message", "child_paused"]);
    await verify(f, [{ external: f.external }, { external: f.external }], true);
  });

  test("a message naming the wrong source session keeps its own delivery", async () => {
    const f = await fixture(["child_paused", "agent_message"]);
    f.turnSessions[1] = f.sessionId;
    await verify(f, [{}, {}], false);
  });

  test.each([false, true])(
    "revoked linked origin cannot combine with native authority (reverse=%s)",
    async (reverse) => {
      const f = await fixture();
      const authorities: Authority[] = [{ external: f.external }, {}];
      await verify(f, reverse ? authorities.reverse() : authorities, false, () =>
        revokeExternalIdentityLink(client.db, {
          accountId: f.accountId,
          linkId: f.external.actor.linkId!,
          subjectId: f.human,
          expectedRevision: f.external.actor.linkRevision!,
        }),
      );
    },
  );

  test("equivalent historical host selections coalesce without creating new host authority", async () => {
    const f = await fixture();
    const receivingTurnId = await verify(f, [{ host: f.host }, { host: f.host }], true);
    const rows = await withWorkspaceSubjectRls(client.db, f.workspaceId, f.human, (tx) =>
      tx.execute(
        sql`select canonical_snapshot from host_mcp_turn_authorities where turn_id=${receivingTurnId}::uuid`,
      ),
    );
    expect(Array.from(rows)).toEqual([]);
  });

  test("candidate authority reads restore the incoming subject before delivery", async () => {
    const f = await fixture();
    await arrange(f, [{}, {}]);
    const otherHuman = `user:${crypto.randomUUID()}`;
    await grantWorkspaceAccess(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: otherHuman,
      permissions: ["sessions:read", "sessions:create", "sessions:control"],
    });
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update session_turns set initiator_subject_id=${otherHuman}, initiating_human_subject_id=${otherHuman} where id=${f.turns[1]!}`;
    });
    await shared.admin.unsafe(`
      create function assert_inbox_subject_read_scope() returns trigger language plpgsql as $body$
      begin
        if new.state = 'delivered' and old.state = 'pending'
          and nullif(current_setting('opengeni.test_expected_subject', true), '') is not null
          and current_setting('opengeni.subject_id', true) is distinct from current_setting('opengeni.test_expected_subject', true)
        then raise exception 'candidate subject leaked into inbox delivery'; end if;
        return new;
      end $body$;
      create trigger assert_inbox_subject_read_scope before update on session_system_updates
        for each row execute function assert_inbox_subject_read_scope();
    `);
    try {
      const claimed = await withWorkspaceSubjectSessionActivityRls(
        client.db,
        f.workspaceId,
        f.human,
        async (tx) => {
          await tx.execute(
            sql`select set_config('opengeni.test_expected_subject', ${f.human}, true)`,
          );
          return claimSessionWorkForAttempt(tx, f.workspaceId, {
            sessionId: f.sessionId,
            workflowId: `session-${f.sessionId}`,
            workflowRunId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
            dispatchId: crypto.randomUUID(),
            trigger: { kind: "next" },
          });
        },
      );
      expect(claimed.action).toBe("claimed");
      if (claimed.action !== "claimed") throw new Error("first origin was not claimed");
      expect(claimed.turn.initiatingHumanSubjectId).toBe(f.human);
      const rows =
        await shared.admin`select state from session_system_updates where session_id=${f.sessionId} order by created_at,id`;
      expect([...rows]).toEqual([{ state: "delivered" }, { state: "pending" }]);
    } finally {
      await shared.admin.unsafe(
        `drop trigger assert_inbox_subject_read_scope on session_system_updates; drop function assert_inbox_subject_read_scope()`,
      );
    }
  });

  test("claims run without superuser or BYPASSRLS", async () => {
    const rows = await client.db.execute(sql`select rolsuper, rolbypassrls,
      current_setting('row_security') as row_security from pg_roles where rolname = current_user`);
    expect(Array.from(rows)).toMatchObject([
      { rolsuper: false, rolbypassrls: false, row_security: "on" },
    ]);
    const tables = await shared.admin`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('host_mcp_turn_authorities', 'external_link_turn_authorities', 'session_system_updates')`;
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }
  });

  const differences: Array<[string, (f: Fixture) => [Authority, Authority]]> = [
    ["empty versus present host authority", (f) => [{}, { host: f.host }]],
    [
      "host binding generation",
      (f) => [{ host: f.host }, { host: { ...f.host, bindingGeneration: 2 } }],
    ],
    [
      "host delegation generation",
      (f) => [{ host: f.host }, { host: { ...f.host, delegationGeneration: 2 } }],
    ],
    [
      "host canonical definition",
      (f) => [
        { host: f.host },
        {
          host: {
            ...f.host,
            definition: { ...f.host.definition, destinationUrl: "https://other.example/mcp" },
          },
        },
      ],
    ],
    ["native versus external-linked", (f) => [{}, { external: f.external }]],
    [
      "external permission ceiling",
      (f) => [
        { external: f.external },
        { external: { ...f.external, permissions: ["sessions:read"] } },
      ],
    ],
    [
      "external authenticating key snapshot",
      (f) => [
        { external: f.external },
        {
          external: {
            ...f.external,
            actor: { ...f.external.actor, authenticatingApiKeyId: crypto.randomUUID() },
          },
        },
      ],
    ],
  ];
  for (const [name, pair] of differences) {
    for (const reverse of [false, true]) {
      test(`${name} stays separate (${reverse ? "reverse" : "forward"})`, async () => {
        const f = await fixture();
        const authorities = pair(f);
        await verify(f, reverse ? authorities.reverse() : authorities, false);
      }, 60_000);
    }
  }

  test("equivalent full snapshots coalesce despite distinct acceptedWork/source and retain both lineages", async () => {
    const f = await fixture();
    await verify(
      f,
      [
        { host: f.host, external: f.external },
        { host: structuredClone(f.host), external: structuredClone(f.external) },
      ],
      true,
    );
  }, 60_000);

  test("equivalent empty native authority coalesces across origin turns", async () => {
    const f = await fixture();
    await verify(f, [{}, {}], true);
  }, 60_000);
});

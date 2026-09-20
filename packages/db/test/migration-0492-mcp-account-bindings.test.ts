import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { McpConnectionAccountBindings } from "@opengeni/contracts";
import { personalDelegationsForAccountBindings } from "../../core/src/domain/mcp-account-bindings";

// Optional isolated WASM PostgreSQL for sandboxes without Docker. No deployed
// database URL is read; otherwise use the repository's disposable DB harness.
type Fixture = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
  close(): Promise<void>;
};
let db: Fixture;
let blank: BlankTestDatabase | null = null;
const migration = await readFile(
  new URL("../drizzle/0492_mcp_account_bindings.sql", import.meta.url),
  "utf8",
);
const sender = await readFile(
  new URL("../drizzle/0478_sender_owned_connections.sql", import.meta.url),
  "utf8",
);
const xai = await readFile(
  new URL("../drizzle/0234_xai_subscription_authority.sql", import.meta.url),
  "utf8",
);
const visibilityCleanup = await readFile(
  new URL("../drizzle/0481_personal_connection_visibility_cleanup.sql", import.meta.url),
  "utf8",
);
const account = "10000000-0000-4000-8000-000000000001";
const workspace = "10000000-0000-4000-8000-000000000002";
const session = "10000000-0000-4000-8000-000000000003";
const turn = "10000000-0000-4000-8000-000000000004";
const attempt = "10000000-0000-4000-8000-000000000005";
const connection = "10000000-0000-4000-8000-000000000006";
const otherConnection = "10000000-0000-4000-8000-000000000007";
const route = `account-${"a".repeat(64)}`;
const binding = {
  serverId: route,
  canonicalServerId: "mail",
  connectionId: connection,
  originWorkspaceId: workspace,
  subjectScope: "workspace",
  ownerSubjectId: null,
  accountLabel: "Team mail",
  providerDomain: "mail.test",
  kind: "oauth2",
  connectionRef: {
    connectionId: connection,
    subjectScope: "workspace",
    providerDomain: "mail.test",
    kind: "oauth2",
  },
  connectionAuthorityGeneration: 1,
};

beforeAll(async () => {
  const modulePath = process.env.OPENGENI_MCP_BINDINGS_PGLITE_MODULE;
  if (modulePath) {
    const { PGlite } = await import(modulePath);
    db = new PGlite();
  } else {
    blank = await acquireBlankTestDatabase("migration-0492-exact-mcp");
    if (!blank)
      throw new Error("0492 requires disposable PostgreSQL or OPENGENI_MCP_BINDINGS_PGLITE_MODULE");
    const sql = postgres(blank.databaseUrl, { max: 1 });
    db = {
      exec: (text) => sql.unsafe(text),
      query: async (text, args = []) => ({ rows: await sql.unsafe(text, args as never[]) }),
      close: () => sql.end(),
    };
  }
  // Minimal, local-only prerequisites. Install the real 0478 resolver and
  // sender read helper; this tests the migration's actual patched SQL body.
  await db.exec(`
    CREATE SCHEMA opengeni_private;
    CREATE FUNCTION digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS 'SELECT sha256($1)';
    CREATE TABLE connections (id uuid PRIMARY KEY, account_id uuid, workspace_id uuid,
      origin_workspace_id uuid, subject_id text, authority_scope text, status text,
      provider_domain text, kind text, authority_generation bigint, owner_organization_membership_id uuid);
    CREATE TABLE sessions (id uuid PRIMARY KEY, account_id uuid, workspace_id uuid, active_turn_id uuid,
      status text, visibility text, authority_epoch integer, owner_organization_membership_id uuid,
      initial_personal_connection_delegations jsonb DEFAULT '[]', owner_subject_id text, parent_turn_id uuid);
    CREATE TABLE session_visibility_write_capabilities (backend_pid integer,transaction_id xid8,capability_id uuid);
    CREATE TABLE session_turns (id uuid PRIMARY KEY, account_id uuid, workspace_id uuid, session_id uuid,
      active_attempt_id uuid, execution_generation integer, status text, initiator_kind text,
      initiator_subject_id text, initiating_human_subject_id text, scheduled_task_run_id uuid,
      personal_connection_delegations jsonb DEFAULT '[]', source text);
    CREATE TABLE session_system_updates (id uuid DEFAULT gen_random_uuid(), account_id uuid, workspace_id uuid,
      personal_connection_delegations jsonb DEFAULT '[]', session_id uuid, kind text,
      lineage jsonb DEFAULT '{}', state text DEFAULT 'pending', delivered_turn_id uuid);
    CREATE TABLE session_system_update_outbox (id uuid DEFAULT gen_random_uuid(), account_id uuid, workspace_id uuid,
      source_session_id uuid, target_session_id uuid, dedupe_key text, kind text, classification text,
      source_id text, summary text, summary_codec_version integer, payload jsonb, payload_codec_version integer,
      lineage jsonb, personal_connection_delegations jsonb DEFAULT '[]', codex_provider_account_authority_snapshot jsonb,
      xai_provider_account_authority_snapshot jsonb, status text DEFAULT 'pending', created_at timestamptz DEFAULT now(),
      updated_at timestamptz, attempts integer DEFAULT 0);
    CREATE TABLE scheduled_task_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, workspace_id uuid,
      accepted_execution_snapshot jsonb);
    CREATE TABLE workspace_inference_controls (account_id uuid,workspace_id uuid);
    CREATE TABLE workspaces (id uuid,account_id uuid);
    CREATE TABLE session_turn_attempts (id uuid,account_id uuid,workspace_id uuid,session_id uuid,turn_id uuid,
      execution_generation integer,state text,closed_at timestamptz,quiesced_at timestamptz,
      authority_visibility text,authority_epoch integer,authority_owner_organization_membership_id uuid);
    CREATE TABLE session_attempt_interruptions (account_id uuid,workspace_id uuid,session_id uuid,attempt_id uuid,state text);
    CREATE TABLE turn_connection_authority_snapshots (turn_id uuid,server_id text,account_id uuid,workspace_id uuid,
      session_id uuid,canonical_snapshot jsonb,snapshot_digest bytea,origin_workspace_id uuid,connection_id uuid,
      owner_subject_id text,authority_source text,authority_scope text,provider_domain text,connection_kind text,
      owner_organization_membership_id uuid,connection_generation bigint,session_visibility text,session_authority_epoch integer,
      membership_authorization_revision bigint,authority_id uuid,authority_generation bigint,grant_id uuid);
    CREATE TABLE organization_memberships (id uuid,account_id uuid,subject_id text,status text,revoked_at timestamptz,
      authorization_revision bigint,personal_workspace_id uuid);
    CREATE TABLE workspace_memberships (account_id uuid,workspace_id uuid,subject_id text);
    CREATE TABLE organization_user_resource_authorities (id uuid,account_id uuid,organization_membership_id uuid,
      resource_kind text,resource_id uuid,origin_workspace_id uuid,generation bigint,status text,revoked_at timestamptz);
    CREATE TABLE connection_use_audit_facts (physical_request_id uuid UNIQUE,use_phase text,request_digest bytea,
      account_id uuid,workspace_id uuid,session_id uuid,turn_id uuid,attempt_id uuid,execution_generation integer,
      server_id text,connection_id uuid,connection_generation bigint,authority_scope text,owner_subject_id text,
      authority_id uuid,grant_id uuid,outcome text,denial_reason text,initiator_kind text,initiator_subject_id text,
      initiating_human_subject_id text,authority_epoch integer,authority_visibility text,authority_owner_organization_membership_id uuid);
  `);
  const helper = sender.match(
    /CREATE FUNCTION opengeni_private\.read_sender_connection\([\s\S]*?\$body\$;/,
  )![0];
  const resolver = sender.match(
    /CREATE OR REPLACE FUNCTION resolve_accepted_connection_use\([\s\S]*?\$body\$;/,
  )![0];
  const claim = xai.match(
    /CREATE FUNCTION opengeni_private\.claim_session_system_update_outbox\([\s\S]*?END\n      \$function\$/,
  )![0];
  await db.exec(helper + resolver + claim + ";");
  await db.exec(visibilityCleanup);
  await db.exec(`CREATE TRIGGER personal_connection_guard BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();`);
  await expect(db.exec("BEGIN;" + migration)).rejects.toThrow("requires stopped application roles");
  await db.exec("ROLLBACK;");
  await db.exec(
    "BEGIN; SET LOCAL opengeni.migration_application_roles = '[\"fixture_stopped_app\"]';" +
      migration +
      "COMMIT;",
  );
  await db.query(
    "SELECT set_config('opengeni.account_id',$1,false),set_config('opengeni.workspace_id',$2,false)",
    [account, workspace],
  );
  await db.exec(`
    INSERT INTO workspaces VALUES ('${workspace}','${account}');
    INSERT INTO workspace_inference_controls VALUES ('${account}','${workspace}');
    INSERT INTO connections VALUES ('${connection}','${account}','${workspace}','${workspace}',NULL,'workspace','active','mail.test','oauth2',1,NULL),
      ('${otherConnection}','${account}','${workspace}','${workspace}',NULL,'workspace','active','mail.test','oauth2',1,NULL);
    INSERT INTO sessions (id,account_id,workspace_id,active_turn_id,status,visibility,authority_epoch)
      VALUES ('${session}','${account}','${workspace}','${turn}','running','shared',1);
    INSERT INTO session_turn_attempts VALUES ('${attempt}','${account}','${workspace}','${session}','${turn}',1,'running',NULL,NULL,'shared',1,NULL);
  `);
  await db.query(
    `INSERT INTO session_turns (id,account_id,workspace_id,session_id,active_attempt_id,execution_generation,status,
    initiator_kind,initiator_subject_id,mcp_account_bindings) VALUES ($1,$2,$3,$4,$5,1,'running','subject','sender',$6::jsonb)`,
    [turn, account, workspace, session, attempt, JSON.stringify([binding])],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
  await blank?.release();
});

async function validate(values: unknown, delegations: unknown = []) {
  return db.query("SELECT opengeni_private.validate_mcp_account_bindings($1::jsonb,$2::jsonb)", [
    JSON.stringify(values),
    JSON.stringify(delegations),
  ]);
}
async function use(
  options: {
    connectionId?: string;
    serverId?: string;
    scope?: string;
    owner?: string | null;
    requestId?: string;
    phase?: string;
    sessionId?: string;
    turnId?: string;
    attemptId?: string;
    providerDomain?: string;
  } = {},
) {
  return (
    await db.query(
      `SELECT * FROM resolve_accepted_connection_use($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$12,'oauth2',$10,$11)`,
      [
        account,
        workspace,
        options.sessionId ?? session,
        options.turnId ?? turn,
        options.attemptId ?? attempt,
        options.requestId ?? crypto.randomUUID(),
        options.phase ?? "credential_resolution",
        options.serverId ?? route,
        options.connectionId ?? connection,
        options.scope ?? "workspace",
        options.owner ?? null,
        options.providerDomain ?? "mail.test",
      ],
    )
  ).rows[0]!;
}

test("migration declares maintenance; exact columns/defaults and private ACLs", async () => {
  expect(migration.split("\n")[0]).toBe("-- deployment-mode: maintenance");
  const columns = await db.query(
    "SELECT table_name,column_default,is_nullable FROM information_schema.columns WHERE column_name IN ('initial_mcp_account_bindings','mcp_account_bindings') ORDER BY table_name",
  );
  expect(columns.rows).toHaveLength(4);
  for (const column of columns.rows) {
    expect(column.is_nullable).toBe("YES");
    expect(column.column_default).toBeNull();
  }
  const acl = await db.query(
    "SELECT count(*)::integer n FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.proname IN ('validate_mcp_account_bindings','fence_mcp_account_bindings','claim_session_system_update_outbox') AND a.grantee=0",
  );
  expect(acl.rows[0]!.n).toBe(0);
});

test("shape rejects malformed, duplicate, foreign-owner and host bindings", async () => {
  await validate([binding]);
  for (const invalid of [
    null,
    {},
    [{}],
    [binding, binding],
    [{ ...binding, ownerSubjectId: "sender" }],
    [{ ...binding, connectionAuthorityGeneration: 0 }],
    [{ ...binding, unknown: true }],
    [{ ...binding, connectionRef: { ...binding.connectionRef, authoritySource: "host" } }],
    [binding, { ...binding, serverId: "another-route" }],
  ]) {
    await expect(validate(invalid)).rejects.toThrow();
  }
});

test("personal selection requires exact sender delegation, never fabricated workspace owner", async () => {
  const personal = {
    ...binding,
    subjectScope: "subject",
    ownerSubjectId: "sender",
    connectionRef: { ...binding.connectionRef, subjectScope: "subject" },
  };
  // Exercise the actual admission producer, not a hand-built SQL-only shape.
  const [delegation] = personalDelegationsForAccountBindings(
    McpConnectionAccountBindings.parse([personal]),
  );
  expect(delegation?.connectionType).toBe("mcp");
  await validate([personal], [delegation]);
  for (const delta of [
    { connectionId: otherConnection },
    { ownerSubjectId: "someone-else" },
    { serverId: "mail" },
    { connectionType: "social" },
    { connectionType: "connection" },
  ]) {
    await expect(validate([personal], [{ ...delegation, ...delta }])).rejects.toThrow(
      "exact sender delegation",
    );
  }
  await expect(validate([personal])).rejects.toThrow("exact sender delegation");
});

test("selected workspace account cannot substitute another same-provider account or scope", async () => {
  expect((await use()).authorization_status).toBe("authorized");
  expect((await use({ connectionId: otherConnection })).denial_reason).toBe(
    "accepted_account_binding_changed",
  );
  expect((await use({ scope: "subject", owner: "sender" })).denial_reason).toBe(
    "accepted_account_binding_changed",
  );
  expect((await use({ serverId: `account-${"b".repeat(64)}` })).denial_reason).toBe(
    "accepted_account_binding_required",
  );
  expect((await use({ serverId: "mail" })).denial_reason).toBe("accepted_account_binding_required");
  expect((await use({ serverId: "legacy-workspace" })).denial_reason).toBe(
    "accepted_account_binding_required",
  );
});

test("SQL NULL retains legacy canonical fallback; explicit [] denies every credential-use route", async () => {
  await db.query("SELECT opengeni_private.validate_mcp_account_bindings(NULL,'[]')");
  for (const receipt of [null, []]) {
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await db.query(
      `INSERT INTO sessions(id,account_id,workspace_id,active_turn_id,status,visibility,authority_epoch)
      VALUES ($1,$2,$3,$4,'running','shared',1)`,
      [sessionId, account, workspace, turnId],
    );
    await db.query(
      `INSERT INTO session_turns(id,account_id,workspace_id,session_id,active_attempt_id,execution_generation,status,mcp_account_bindings)
      VALUES ($1,$2,$3,$4,$5,1,'running',$6::jsonb)`,
      [
        turnId,
        account,
        workspace,
        sessionId,
        attemptId,
        receipt === null ? null : JSON.stringify(receipt),
      ],
    );
    await db.query(
      `INSERT INTO session_turn_attempts VALUES ($1,$2,$3,$4,$5,1,'running',NULL,NULL,'shared',1,NULL)`,
      [attemptId, account, workspace, sessionId, turnId],
    );
    for (const phase of ["credential_resolution", "provider_request"]) {
      const selected = { sessionId, turnId, attemptId, phase };
      expect((await use({ ...selected, serverId: "mail" })).authorization_status).toBe(
        receipt === null ? "authorized" : "denied",
      );
      expect((await use({ ...selected, serverId: route })).denial_reason).toBe(
        "accepted_account_binding_required",
      );
    }
  }
});

test("generation/status revocation and physical-request replay remain live", async () => {
  const requestId = crypto.randomUUID();
  expect((await use({ requestId })).authorization_status).toBe("authorized");
  await db.query("UPDATE connections SET authority_generation=2 WHERE id=$1", [connection]);
  try {
    expect((await use({ requestId })).denial_reason).toBe("connection_generation_changed");
    expect((await use({ phase: "provider_request" })).denial_reason).toBe(
      "connection_generation_changed",
    );
  } finally {
    await db.query("UPDATE connections SET authority_generation=1 WHERE id=$1", [connection]);
  }
  await db.query("UPDATE connections SET status='revoked' WHERE id=$1", [connection]);
  try {
    expect((await use()).denial_reason).toBe("connection_status_inactive");
  } finally {
    await db.query("UPDATE connections SET status='active' WHERE id=$1", [connection]);
  }
  await expect(use({ requestId, connectionId: otherConnection })).rejects.toThrow(
    "reused for different work",
  );
});

test("all accepted surfaces reject replacement; outbox claim carries original binding", async () => {
  for (const table of [
    "sessions",
    "session_turns",
    "session_system_updates",
    "session_system_update_outbox",
  ]) {
    const column = table === "sessions" ? "initial_mcp_account_bindings" : "mcp_account_bindings";
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO ${table}(id,account_id,workspace_id,${column}) VALUES ($1,$2,$3,$4::jsonb)`,
      [id, account, workspace, JSON.stringify([binding])],
    );
    await expect(db.query(`UPDATE ${table} SET ${column}='[]' WHERE id=$1`, [id])).rejects.toThrow(
      "immutable",
    );
  }
  const claimed = await db.query(
    "SELECT * FROM opengeni_private.claim_session_system_update_outbox(10)",
  );
  expect(claimed.rows[0]!.mcp_account_bindings).toEqual([binding]);
});

test("acceptance refuses missing generation, foreign workspace and inactive account", async () => {
  for (const selected of [
    { ...binding, connectionAuthorityGeneration: undefined },
    { ...binding, connectionAuthorityGeneration: 2 },
    { ...binding, originWorkspaceId: crypto.randomUUID() },
  ]) {
    await expect(
      db.query(
        "INSERT INTO session_turns(id,account_id,workspace_id,mcp_account_bindings) VALUES (gen_random_uuid(),$1,$2,$3::jsonb)",
        [account, workspace, JSON.stringify([selected])],
      ),
    ).rejects.toThrow("identity changed");
  }
});

test("revoked causal accounts still travel through immutable update/outbox carriers but cannot execute", async () => {
  await db.query("UPDATE connections SET status='revoked',authority_generation=2 WHERE id=$1", [
    connection,
  ]);
  try {
    for (const table of ["session_system_updates", "session_system_update_outbox"]) {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO ${table}(id,account_id,workspace_id,mcp_account_bindings) VALUES ($1,$2,$3,$4::jsonb)`,
        [id, account, workspace, JSON.stringify([binding])],
      );
      expect(
        (await db.query(`SELECT mcp_account_bindings FROM ${table} WHERE id=$1`, [id])).rows[0]!
          .mcp_account_bindings,
      ).toEqual([binding]);
      await expect(
        db.query(`UPDATE ${table} SET mcp_account_bindings='[]' WHERE id=$1`, [id]),
      ).rejects.toThrow("immutable");
      if (table === "session_system_update_outbox") {
        const claimed = (
          await db.query("SELECT * FROM opengeni_private.claim_session_system_update_outbox(100)")
        ).rows;
        expect(claimed.find((row) => row.id === id)!.mcp_account_bindings).toEqual([binding]);
      }
    }
    for (const phase of ["credential_resolution", "provider_request"]) {
      expect((await use({ phase })).denial_reason).toBe("connection_status_inactive");
    }
    for (const table of ["sessions", "session_turns", "scheduled_task_runs"]) {
      const column =
        table === "sessions"
          ? "initial_mcp_account_bindings"
          : table === "scheduled_task_runs"
            ? "accepted_execution_snapshot"
            : "mcp_account_bindings";
      const receipt =
        table === "scheduled_task_runs" ? { mcpAccountBindings: [binding] } : [binding];
      await expect(
        db.query(
          `INSERT INTO ${table}(id,account_id,workspace_id,${column}) VALUES ($1,$2,$3,$4::jsonb)`,
          [crypto.randomUUID(), account, workspace, JSON.stringify(receipt)],
        ),
      ).rejects.toThrow("identity changed");
    }
  } finally {
    await db.query("UPDATE connections SET status='active',authority_generation=1 WHERE id=$1", [
      connection,
    ]);
  }
});

test("scheduled run bindings are immutable and copied exactly to scheduled turns", async () => {
  const runId = crypto.randomUUID();
  await db.query(
    "INSERT INTO scheduled_task_runs(id,account_id,workspace_id,accepted_execution_snapshot) VALUES ($1,$2,$3,$4::jsonb)",
    [runId, account, workspace, JSON.stringify({ mcpAccountBindings: [binding] })],
  );
  await expect(
    db.query("UPDATE scheduled_task_runs SET accepted_execution_snapshot='{}' WHERE id=$1", [
      runId,
    ]),
  ).rejects.toThrow("immutable");
  await expect(
    db.query(
      "INSERT INTO session_turns(id,account_id,workspace_id,scheduled_task_run_id) VALUES ($1,$2,$3,$4)",
      [crypto.randomUUID(), account, workspace, runId],
    ),
  ).rejects.toThrow("differs from accepted MCP");
  await db.query(
    "INSERT INTO session_turns(id,account_id,workspace_id,scheduled_task_run_id,mcp_account_bindings) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [crypto.randomUUID(), account, workspace, runId, JSON.stringify([binding])],
  );
});

for (const consumer of ["Git broker", "GitHub REST MCP"]) {
  test(`${consumer} retains specialized sender authority with empty and nonempty generic bindings`, async () => {
    for (const genericBindings of [[], [binding]]) {
      const personalId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const authorityId = crypto.randomUUID();
      const specialized = {
        serverId: "github:personal",
        connectionId: personalId,
        originWorkspaceId: workspace,
        ownerSubjectId: "sender",
        providerDomain: "github.com",
        kind: "oauth2",
        connectionType: "github_personal",
      };
      await db.query(
        "INSERT INTO connections VALUES ($1,$2,$3,$3,'sender','user','active','github.com','oauth2',1,$4)",
        [personalId, account, workspace, memberId],
      );
      await db.query(
        `INSERT INTO sessions (id,account_id,workspace_id,active_turn_id,status,visibility,authority_epoch)
        VALUES ($1,$2,$3,$4,'running','shared',1)`,
        [sessionId, account, workspace, turnId],
      );
      await db.query(
        `INSERT INTO session_turns (id,account_id,workspace_id,session_id,active_attempt_id,execution_generation,status,
        initiator_kind,initiator_subject_id,initiating_human_subject_id,mcp_account_bindings,personal_connection_delegations)
        VALUES ($1,$2,$3,$4,$5,1,'running','subject','sender','sender',$6::jsonb,$7::jsonb)`,
        [
          turnId,
          account,
          workspace,
          sessionId,
          attemptId,
          JSON.stringify(genericBindings),
          JSON.stringify([specialized]),
        ],
      );
      await db.query(
        "INSERT INTO session_turn_attempts VALUES ($1,$2,$3,$4,$5,1,'running',NULL,NULL,'shared',1,NULL)",
        [attemptId, account, workspace, sessionId, turnId],
      );
      const request = {
        sessionId,
        turnId,
        attemptId,
        connectionId: personalId,
        serverId: "github:personal",
        providerDomain: "github.com",
        scope: "subject",
        owner: "sender",
      };
      // Neither a delegation alone nor a generic inventory enables this route.
      expect((await use(request)).denial_reason).toBe("accepted_account_binding_required");
      await db.query(
        "INSERT INTO organization_memberships VALUES ($1,$2,'sender','active',NULL,1,$3)",
        [memberId, account, workspace],
      );
      await db.query(
        "INSERT INTO organization_user_resource_authorities VALUES ($1,$2,$3,'connection',$4,$5,1,'active',NULL)",
        [authorityId, account, memberId, personalId, workspace],
      );
      await db.query(
        `INSERT INTO turn_connection_authority_snapshots VALUES ($1,'github:personal',$2,$3,$4,'{}',digest(convert_to('{}','UTF8'),'sha256'),
        $3,$5,'sender','sender','user','github.com','oauth2',$6,1,'shared',1,1,$7,1,NULL)`,
        [turnId, account, workspace, sessionId, personalId, memberId, authorityId],
      );
      for (const phase of ["credential_resolution", "provider_request"]) {
        expect((await use({ ...request, phase })).authorization_status).toBe("authorized");
        for (const changed of [
          { scope: "workspace", owner: null },
          { owner: "teammate" },
          { connectionId: otherConnection },
          { serverId: "github:unbound" },
        ]) {
          expect((await use({ ...request, ...changed, phase })).authorization_status).toBe(
            "denied",
          );
        }
      }
      await db.query("UPDATE connections SET status='revoked' WHERE id=$1", [personalId]);
      expect((await use(request)).denial_reason).toBe("connection_status_inactive");
      await db.query("UPDATE connections SET status='active' WHERE id=$1", [personalId]);
      await db.query("UPDATE organization_memberships SET status='revoked' WHERE id=$1", [
        memberId,
      ]);
      expect((await use(request)).denial_reason).toBe("owner_membership_inactive");
    }
  });
}

test("delivered causal carriers can be claimed after workspace revocation without regaining credential authority", async () => {
  const scheduledRun = crypto.randomUUID();
  await db.query(
    "INSERT INTO scheduled_task_runs(id,account_id,workspace_id,accepted_execution_snapshot) VALUES ($1,$2,$3,$4::jsonb)",
    [scheduledRun, account, workspace, JSON.stringify({ mcpAccountBindings: [binding] })],
  );
  for (const revision of [
    { status: "revoked", generation: 1 },
    { status: "active", generation: 2 },
  ]) {
    await db.query("UPDATE connections SET status=$2,authority_generation=$3 WHERE id=$1", [
      connection,
      revision.status,
      revision.generation,
    ]);
    try {
      for (const [kind, scheduledTaskRunId] of [
        ["child_terminal_result", null],
        ["background_command_result", null],
        ["goal_continuation", null],
        ["goal_continuation", scheduledRun],
        ["agent_message", null],
      ]) {
        const successor = crypto.randomUUID();
        const successorAttempt = crypto.randomUUID();
        const updateId = crypto.randomUUID();
        const lineage =
          kind === "agent_message"
            ? { callerTurnId: turn, callerSessionId: session }
            : kind === "child_terminal_result"
              ? { parentTurnId: turn }
              : { causalTurnId: turn };
        // The receipt travels through an outbox and pending update unchanged.
        const outboxId = crypto.randomUUID();
        await db.query(
          `INSERT INTO session_system_update_outbox(id,account_id,workspace_id,source_session_id,target_session_id,kind,lineage,mcp_account_bindings)
          VALUES ($1,$2,$3,$4,$4,$5,$6::jsonb,$7::jsonb)`,
          [
            outboxId,
            account,
            workspace,
            session,
            kind,
            JSON.stringify(lineage),
            JSON.stringify([binding]),
          ],
        );
        const carrier = (
          await db.query(
            "SELECT mcp_account_bindings FROM session_system_update_outbox WHERE id=$1",
            [outboxId],
          )
        ).rows[0]!;
        await db.query(
          `INSERT INTO session_system_updates(id,account_id,workspace_id,session_id,kind,lineage,mcp_account_bindings)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
          [
            updateId,
            account,
            workspace,
            session,
            kind,
            JSON.stringify(lineage),
            JSON.stringify(carrier.mcp_account_bindings),
          ],
        );
        const insertTurn = () =>
          db.query(
            `INSERT INTO session_turns(id,account_id,workspace_id,session_id,active_attempt_id,execution_generation,status,
          source,initiator_kind,initiator_subject_id,initiating_human_subject_id,mcp_account_bindings,scheduled_task_run_id)
          VALUES ($1,$2,$3,$4,$5,1,'running',$6,'service','internal-update',$9,$7::jsonb,$8)`,
            [
              successor,
              account,
              workspace,
              session,
              successorAttempt,
              kind === "goal_continuation" ? "goal" : "system",
              JSON.stringify([binding]),
              scheduledTaskRunId,
              kind === "agent_message" ? null : "sender",
            ],
          );
        // Pending input alone is not a claim or inherited authority.
        await expect(insertTurn()).rejects.toThrow("identity changed");
        // Mirror claimSessionWorkForAttempt's transactional order: mark the
        // batch delivered to the exact successor, then insert its running turn.
        await db.query(
          "UPDATE session_system_updates SET state='delivered',delivered_turn_id=$2 WHERE id=$1",
          [updateId, successor],
        );
        await insertTurn();
        expect(
          (
            await db.query("SELECT mcp_account_bindings FROM session_turns WHERE id=$1", [
              successor,
            ])
          ).rows[0]!.mcp_account_bindings,
        ).toEqual([binding]);
        if (kind === "agent_message") {
          expect(
            (
              await db.query("SELECT initiating_human_subject_id FROM session_turns WHERE id=$1", [
                successor,
              ])
            ).rows[0]!.initiating_human_subject_id,
          ).toBeNull();
        }
        await db.query(
          "INSERT INTO session_turn_attempts VALUES ($1,$2,$3,$4,$5,1,'running',NULL,NULL,'shared',1,NULL)",
          [successorAttempt, account, workspace, session, successor],
        );
        await db.query("UPDATE sessions SET active_turn_id=$2 WHERE id=$1", [session, successor]);
        for (const phase of ["credential_resolution", "provider_request"]) {
          const result = await use({ turnId: successor, attemptId: successorAttempt, phase });
          expect(result.denial_reason).toBe(
            revision.status === "revoked"
              ? "connection_status_inactive"
              : "connection_generation_changed",
          );
        }
        await db.query("UPDATE sessions SET active_turn_id=$2 WHERE id=$1", [session, turn]);
      }
    } finally {
      await db.query("UPDATE connections SET status='active',authority_generation=1 WHERE id=$1", [
        connection,
      ]);
    }
  }
});

test("personal bindings retain sender proofs and live membership/resource revocation", async () => {
  const personalId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  const personal = {
    ...binding,
    connectionId: personalId,
    subjectScope: "subject",
    ownerSubjectId: "sender",
    connectionRef: { ...binding.connectionRef, connectionId: personalId, subjectScope: "subject" },
  };
  const delegation = {
    serverId: route,
    connectionId: personalId,
    originWorkspaceId: workspace,
    ownerSubjectId: "sender",
    providerDomain: "mail.test",
    kind: "oauth2",
    connectionType: "mcp",
  };
  await db.query(
    `INSERT INTO connections VALUES ($1,$2,$3,$3,'sender','user','active','mail.test','oauth2',1,$4)`,
    [personalId, account, workspace, memberId],
  );
  await db.query(
    `INSERT INTO sessions (id,account_id,workspace_id,active_turn_id,status,visibility,authority_epoch)
    VALUES ($1,$2,$3,$4,'running','shared',1)`,
    [sessionId, account, workspace, turnId],
  );
  await db.query(
    `INSERT INTO session_turns (id,account_id,workspace_id,session_id,active_attempt_id,execution_generation,status,
    initiator_kind,initiator_subject_id,initiating_human_subject_id,mcp_account_bindings,personal_connection_delegations)
    VALUES ($1,$2,$3,$4,$5,1,'running','subject','sender','sender',$6::jsonb,$7::jsonb)`,
    [
      turnId,
      account,
      workspace,
      sessionId,
      attemptId,
      JSON.stringify([personal]),
      JSON.stringify([delegation]),
    ],
  );
  await db.query(
    `INSERT INTO session_turn_attempts VALUES ($1,$2,$3,$4,$5,1,'running',NULL,NULL,'shared',1,NULL)`,
    [attemptId, account, workspace, sessionId, turnId],
  );
  const selected = {
    sessionId,
    turnId,
    attemptId,
    connectionId: personalId,
    scope: "subject",
    owner: "sender",
  };
  // A well-shaped binding plus delegation alone must not authorize a use.
  expect((await use(selected)).denial_reason).toBe("accepted_attempt_authority_required");
  await db.query(
    `INSERT INTO organization_memberships VALUES ($1,$2,'sender','active',NULL,1,$3)`,
    [memberId, account, workspace],
  );
  await db.query(
    `INSERT INTO organization_user_resource_authorities VALUES ($1,$2,$3,'connection',$4,$5,1,'active',NULL)`,
    [authorityId, account, memberId, personalId, workspace],
  );
  await db.query(
    `INSERT INTO turn_connection_authority_snapshots VALUES ($1,$2,$3,$4,$5,'{}',digest(convert_to('{}','UTF8'),'sha256'),
    $4,$6,'sender','sender','user','mail.test','oauth2',$7,1,'shared',1,1,$8,1,NULL)`,
    [turnId, route, account, workspace, sessionId, personalId, memberId, authorityId],
  );
  expect((await use(selected)).authorization_status).toBe("authorized");
  expect((await use({ ...selected, owner: "another-human" })).denial_reason).toBe(
    "accepted_account_binding_changed",
  );
  await db.query("UPDATE organization_memberships SET status='revoked' WHERE id=$1", [memberId]);
  expect((await use(selected)).denial_reason).toBe("owner_membership_inactive");
  await db.query(
    "UPDATE organization_memberships SET status='active',authorization_revision=2 WHERE id=$1",
    [memberId],
  );
  expect((await use(selected)).denial_reason).toBe("owner_membership_inactive");
  await db.query("UPDATE organization_memberships SET authorization_revision=1 WHERE id=$1", [
    memberId,
  ]);
  await db.query("UPDATE organization_user_resource_authorities SET status='revoked' WHERE id=$1", [
    authorityId,
  ]);
  expect((await use(selected)).denial_reason).toBe("authority_status_inactive");
  await db.query(
    "UPDATE organization_user_resource_authorities SET status='active',generation=2 WHERE id=$1",
    [authorityId],
  );
  expect((await use(selected)).denial_reason).toBe("authority_status_inactive");
  await db.query("UPDATE organization_user_resource_authorities SET generation=1 WHERE id=$1", [
    authorityId,
  ]);
  await db.query(
    "UPDATE turn_connection_authority_snapshots SET authority_source='grant' WHERE turn_id=$1",
    [turnId],
  );
  expect((await use(selected)).denial_reason).toBe("connection_identity_changed");
  await db.query(
    "UPDATE turn_connection_authority_snapshots SET authority_source='sender' WHERE turn_id=$1",
    [turnId],
  );
  expect((await use(selected)).authorization_status).toBe("authorized");
});

test("continuation inheritance rejects forged, mismatched and mixed receipt provenance", async () => {
  await db.query("UPDATE connections SET status='revoked',authority_generation=2 WHERE id=$1", [
    connection,
  ]);
  try {
    for (const variant of [
      "missing-origin",
      "wrong-session",
      "wrong-human",
      "wrong-target",
      "changed-receipt",
      "mixed-batch",
      "human-admission",
      "message-wrong-human",
      "message-subject-initiator",
      "message-personal-delegation",
      "message-carrier-personal-delegation",
      "message-wrong-origin",
    ]) {
      const successor = crypto.randomUUID();
      const copied =
        variant === "changed-receipt"
          ? [{ ...binding, accountLabel: "Changed after acceptance" }]
          : [binding];
      const isMessage = variant.startsWith("message-");
      const lineage =
        variant === "wrong-session" || isMessage
          ? {
              callerTurnId: variant === "message-wrong-origin" ? crypto.randomUUID() : turn,
              callerSessionId: variant === "wrong-session" ? crypto.randomUUID() : session,
            }
          : { causalTurnId: variant === "missing-origin" ? crypto.randomUUID() : turn };
      await db.query(
        `INSERT INTO session_system_updates(account_id,workspace_id,session_id,kind,lineage,state,delivered_turn_id,mcp_account_bindings)
        VALUES ($1,$2,$3,$4,$5::jsonb,'delivered',$6,$7::jsonb)`,
        [
          account,
          workspace,
          session,
          variant === "wrong-session" || isMessage ? "agent_message" : "background_command_result",
          JSON.stringify(lineage),
          variant === "wrong-target" ? crypto.randomUUID() : successor,
          JSON.stringify(copied),
        ],
      );
      if (variant === "message-carrier-personal-delegation") {
        await db.query(
          "UPDATE session_system_updates SET personal_connection_delegations=$2::jsonb WHERE delivered_turn_id=$1",
          [
            successor,
            JSON.stringify([{ connectionType: "github_personal", ownerSubjectId: "sender" }]),
          ],
        );
      }
      if (variant === "mixed-batch") {
        await db.query(
          `INSERT INTO session_system_updates(account_id,workspace_id,session_id,kind,lineage,state,delivered_turn_id,mcp_account_bindings)
          VALUES ($1,$2,$3,'background_command_result',$4::jsonb,'delivered',$5,'[]')`,
          [account, workspace, session, JSON.stringify(lineage), successor],
        );
      }
      await expect(
        db.query(
          `INSERT INTO session_turns(id,account_id,workspace_id,session_id,status,source,initiator_kind,initiator_subject_id,
        initiating_human_subject_id,mcp_account_bindings,personal_connection_delegations)
        VALUES ($1,$2,$3,$4,'running',$5,$8,'internal-update',$6,$7::jsonb,$9::jsonb)`,
          [
            successor,
            account,
            workspace,
            session,
            variant === "human-admission" ? "user" : "system",
            variant === "wrong-human" || variant === "message-wrong-human"
              ? "teammate"
              : isMessage
                ? null
                : "sender",
            JSON.stringify(copied),
            variant === "message-subject-initiator" ? "subject" : "service",
            JSON.stringify(
              variant === "message-personal-delegation"
                ? [{ connectionType: "github_personal", ownerSubjectId: "sender" }]
                : [],
            ),
          ],
        ),
      ).rejects.toThrow("identity changed");
    }
  } finally {
    await db.query("UPDATE connections SET status='active',authority_generation=1 WHERE id=$1", [
      connection,
    ]);
  }
});

test("non-owner runtime executes resolver but cannot call private validators or claim outbox before provisioning", async () => {
  await db.exec(`CREATE ROLE mcp_binding_fixture_app NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public,opengeni_private TO mcp_binding_fixture_app;
    GRANT EXECUTE ON FUNCTION resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text) TO mcp_binding_fixture_app;
    SET ROLE mcp_binding_fixture_app;`);
  try {
    expect((await use()).authorization_status).toBe("authorized");
    await expect(validate([binding])).rejects.toThrow("permission denied");
    await expect(
      db.query("SELECT * FROM opengeni_private.claim_session_system_update_outbox(10)"),
    ).rejects.toThrow("permission denied");
  } finally {
    await db.exec("RESET ROLE");
  }
});

test("resolver patch fails closed when its installed prerequisite has drifted", async () => {
  const signature =
    "resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)";
  const original = (
    await db.query("SELECT pg_get_functiondef($1::regprocedure) definition", [signature])
  ).rows[0]!.definition as string;
  const resolverPatch = migration.match(/DO \$resolver\$[\s\S]*?END \$resolver\$;/)![0];
  await db.exec(
    original.replace(
      "    SELECT authority_snapshot.* INTO snapshot",
      "    SELECT authority_snapshot.*\n    INTO snapshot",
    ),
  );
  try {
    await expect(db.exec(resolverPatch)).rejects.toThrow("prerequisite drift");
  } finally {
    await db.exec(original);
  }
});

test("NULL and empty receipts remain distinct and immutable on every persistence surface", async () => {
  for (const table of [
    "sessions",
    "session_turns",
    "session_system_updates",
    "session_system_update_outbox",
  ]) {
    const column = table === "sessions" ? "initial_mcp_account_bindings" : "mcp_account_bindings";
    for (const receipt of [null, []]) {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO ${table}(id,account_id,workspace_id,${column}) VALUES ($1,$2,$3,$4::jsonb)`,
        [id, account, workspace, receipt === null ? null : JSON.stringify(receipt)],
      );
      expect(
        (await db.query(`SELECT ${column} receipt FROM ${table} WHERE id=$1`, [id])).rows[0]!
          .receipt,
      ).toEqual(receipt);
      await expect(
        db.query(`UPDATE ${table} SET ${column}=$2::jsonb WHERE id=$1`, [
          id,
          receipt === null ? "[]" : null,
        ]),
      ).rejects.toThrow("immutable");
      if (table === "session_system_update_outbox") {
        const claimed = (
          await db.query("SELECT * FROM opengeni_private.claim_session_system_update_outbox(100)")
        ).rows;
        expect(claimed.find((row) => row.id === id)!.mcp_account_bindings).toEqual(receipt);
      }
    }
    await expect(
      db.query(
        `INSERT INTO ${table}(id,account_id,workspace_id,${column}) VALUES ($1,$2,$3,'null'::jsonb)`,
        [crypto.randomUUID(), account, workspace],
      ),
    ).rejects.toThrow("check constraint");
  }
});

test("scheduled missing/null legacy receipts differ from explicit empty occurrence selection", async () => {
  for (const snapshot of [{}, { mcpAccountBindings: null }, { mcpAccountBindings: [] }]) {
    const runId = crypto.randomUUID();
    await db.query(
      "INSERT INTO scheduled_task_runs(id,account_id,workspace_id,accepted_execution_snapshot) VALUES ($1,$2,$3,$4::jsonb)",
      [runId, account, workspace, JSON.stringify(snapshot)],
    );
    const receipt =
      "mcpAccountBindings" in snapshot && snapshot.mcpAccountBindings !== null ? "[]" : null;
    await db.query(
      "INSERT INTO session_turns(id,account_id,workspace_id,scheduled_task_run_id,mcp_account_bindings) VALUES ($1,$2,$3,$4,$5::jsonb)",
      [crypto.randomUUID(), account, workspace, runId, receipt],
    );
    await expect(
      db.query(
        "INSERT INTO session_turns(id,account_id,workspace_id,scheduled_task_run_id,mcp_account_bindings) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [crypto.randomUUID(), account, workspace, runId, receipt === null ? "[]" : null],
      ),
    ).rejects.toThrow("differs from accepted MCP");
    await expect(
      db.query("UPDATE scheduled_task_runs SET accepted_execution_snapshot=$2::jsonb WHERE id=$1", [
        runId,
        JSON.stringify({ mcpAccountBindings: receipt === null ? [] : null }),
      ]),
    ).rejects.toThrow("immutable");
  }
});

test("visibility cleanup requires the protected capability and clears initial bindings without changing accepted turns", async () => {
  const id = crypto.randomUUID();
  const personal = {
    ...binding,
    subjectScope: "subject",
    ownerSubjectId: "sender",
    connectionRef: { ...binding.connectionRef, subjectScope: "subject" },
  };
  const delegation = {
    serverId: route,
    connectionId: connection,
    originWorkspaceId: workspace,
    ownerSubjectId: "sender",
    providerDomain: "mail.test",
    kind: "oauth2",
    connectionType: "mcp",
  };
  await db.query(
    `INSERT INTO sessions(id,account_id,workspace_id,visibility,authority_epoch,owner_subject_id,
    initial_mcp_account_bindings,initial_personal_connection_delegations) VALUES ($1,$2,$3,'shared',1,'sender',$4::jsonb,$5::jsonb)`,
    [id, account, workspace, JSON.stringify([personal]), JSON.stringify([delegation])],
  );
  const transition =
    "UPDATE sessions SET visibility='user_private',authority_epoch=2,initial_personal_connection_delegations='[]' WHERE id=$1";
  await expect(db.query(transition, [id])).rejects.toThrow("visibility lifecycle capability");
  await db.query("SELECT set_config('opengeni.session_visibility_write_capability',$1,false)", [
    crypto.randomUUID(),
  ]);
  await expect(db.query(transition, [id])).rejects.toThrow("visibility lifecycle capability");
  await db.exec("BEGIN");
  try {
    const capabilityId = crypto.randomUUID();
    await db.query(
      "INSERT INTO session_visibility_write_capabilities VALUES (pg_backend_pid(),pg_current_xact_id(),$1)",
      [capabilityId],
    );
    await db.query("SELECT set_config('opengeni.session_visibility_write_capability',$1,true)", [
      capabilityId,
    ]);
    for (const changes of [
      "authority_epoch=3",
      "authority_epoch=2,owner_subject_id='another-human'",
      "authority_epoch=2,parent_turn_id=gen_random_uuid()",
      "authority_epoch=2,initial_mcp_account_bindings=NULL",
    ]) {
      await db.exec("SAVEPOINT invalid_cleanup");
      await expect(
        db.query(
          `UPDATE sessions SET visibility='user_private',${changes},initial_personal_connection_delegations='[]' WHERE id=$1`,
          [id],
        ),
      ).rejects.toThrow("invalid MCP account visibility cleanup");
      await db.exec("ROLLBACK TO SAVEPOINT invalid_cleanup; RELEASE SAVEPOINT invalid_cleanup");
    }
    await db.query(transition, [id]);
    const changed = (
      await db.query(
        "SELECT initial_mcp_account_bindings,initial_personal_connection_delegations FROM sessions WHERE id=$1",
        [id],
      )
    ).rows[0]!;
    expect(changed.initial_mcp_account_bindings).toEqual([]);
    expect(changed.initial_personal_connection_delegations).toEqual([]);
    expect(
      (await db.query("SELECT mcp_account_bindings FROM session_turns WHERE id=$1", [turn]))
        .rows[0]!.mcp_account_bindings,
    ).toEqual([binding]);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
  await expect(
    db.query("UPDATE sessions SET initial_mcp_account_bindings=NULL WHERE id=$1", [id]),
  ).rejects.toThrow("immutable");
  await expect(
    db.query(
      "UPDATE sessions SET initial_mcp_account_bindings=$2::jsonb,initial_personal_connection_delegations=$3::jsonb WHERE id=$1",
      [id, JSON.stringify([personal]), JSON.stringify([delegation])],
    ),
  ).rejects.toThrow("immutable");
});

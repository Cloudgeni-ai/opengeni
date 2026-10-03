import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { createDb, createSession, withSessionRlsActorContext } from "../src";
import { getAgentLearningSettings, saveAgentLearningSettings } from "../src/knowledge-entries";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

test("0515 preserves queued, claimed and snapshotted accepted work across the default cutover", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("autonomous-default-cutover");
  if (!owned) throw new Error("PostgreSQL required for learning default cutover");
  const owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  let client: ReturnType<typeof createDb> | undefined;
  try {
    await owner`CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await owner`INSERT INTO schema_migrations(name) VALUES('0515_autonomous_learning_defaults.sql')`;
    await migrate(owned.ownerUrl);
    await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
    const appUrl = new URL(owned.adminUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
    const accountId = crypto.randomUUID(),
      workspaceId = crypto.randomUUID(),
      subjectId = `user:${crypto.randomUUID()}`;
    const admin = owned.admin;
    await admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Learning cutover')`;
    await admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Learning cutover')`;
    await admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
    const human = {
      accountId,
      workspaceId,
      actor: {
        kind: "human" as const,
        principalKind: "human_session" as const,
        subjectId,
        settingsScopes: ["workspace" as const, "personal" as const],
        writeScopes: ["workspace" as const],
        review: true,
      },
    };
    const oldDefaults = {
      knowledge: "automatic",
      instructions: "review_first",
      skills: "review_first",
    } as const;
    const newDefaults = {
      knowledge: "automatic",
      instructions: "automatic",
      skills: "automatic",
    } as const;
    const personalDefaults = {
      knowledge: "off",
      instructions: "review_first",
      skills: "off",
    } as const;
    const savedPersonal = await saveAgentLearningSettings(client.db, human, {
      scope: "personal",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: personalDefaults,
    });
    async function turn(status: "queued" | "running", knowledgeOff = false) {
      const session = await withSessionRlsActorContext({ subjectId }, () =>
        createSession(client!.db, {
          accountId,
          workspaceId,
          initialMessage: "Test defaults",
          memoryScope: "workspace",
          resources: [],
          metadata: {},
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId },
          createdByContext: {},
        }),
      );
      if (knowledgeOff)
        await saveAgentLearningSettings(client!.db, human, {
          scope: "workspace",
          source: { kind: "chat", id: session.id },
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
          settings: { knowledge: "off" },
        });
      const id = crypto.randomUUID();
      await admin.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true),set_config('opengeni.subject_id',${subjectId},true)`;
        await tx`SELECT set_config('opengeni.session_inference_claim','1',true), set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
        await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
        status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
        initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id)
        VALUES(${id},${accountId},${workspaceId},${session.id},${crypto.randomUUID()},${`cutover-${id}`},
          ${status},'user',1,'Test defaults','test-model','medium','none',1,'subject',${subjectId},'{}',${subjectId})`;
        if (status === "running") {
          const attemptId = crypto.randomUUID();
          await tx`UPDATE sessions SET active_turn_id=${id},status='running' WHERE id=${session.id}`;
          await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${id}`;
          await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
            temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
            VALUES(${attemptId},${accountId},${workspaceId},${session.id},${id},1,'running',${`cutover-${id}`},
              ${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}')`;
        }
      });
      return id;
    }
    async function freeze(id: string) {
      return admin.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true),set_config('opengeni.subject_id',${subjectId},true)`;
        await tx`SELECT set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
        const [row] =
          await tx`SELECT knowledge_learning_for_turn(${accountId},${workspaceId},${id}) AS policy`;
        return row!.policy;
      });
    }
    const queued = await turn("queued", true),
      claimed = await turn("running"),
      frozen = await turn("running");
    const snapshot = await freeze(frozen);
    expect(snapshot.effective).toEqual(oldDefaults);
    const [unsnapshotted] =
      await admin`SELECT count(*)::integer AS count FROM agent_learning_snapshots WHERE turn_id IN (${queued},${claimed})`;
    expect(unsnapshotted!.count).toBe(0);
    const before = await admin`SELECT oid,proacl,prosecdef,proconfig FROM pg_proc WHERE oid IN
      ('knowledge_learning_resolve(uuid,uuid,text,text,timestamptz)'::regprocedure,'agent_learning_manage(uuid,uuid,jsonb,jsonb)'::regprocedure) ORDER BY oid`;
    await owner`DELETE FROM schema_migrations WHERE name='0515_autonomous_learning_defaults.sql'`;
    await migrate(owned.ownerUrl);
    const [applied] =
      await admin`SELECT pg_get_functiondef('knowledge_learning_resolve(uuid,uuid,text,text,timestamptz)'::regprocedure) AS definition`;
    await migrate(owned.ownerUrl); // A ledger replay must not recapture the cutover.
    const [replayed] =
      await admin`SELECT pg_get_functiondef('knowledge_learning_resolve(uuid,uuid,text,text,timestamptz)'::regprocedure) AS definition`;
    expect(replayed!.definition).toBe(applied!.definition);
    expect((await freeze(queued)).effective).toEqual({ ...oldDefaults, knowledge: "off" });
    expect((await freeze(claimed)).effective).toEqual(oldDefaults);
    expect(await freeze(frozen)).toEqual(snapshot);
    expect((await freeze(await turn("queued"))).effective).toEqual(newDefaults);
    expect((await getAgentLearningSettings(client.db, human, "workspace")).settings).toEqual(
      newDefaults,
    );
    const saved = { knowledge: "off", instructions: "review_first", skills: "off" } as const;
    await saveAgentLearningSettings(client.db, human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: saved,
    });
    expect((await freeze(await turn("queued"))).effective).toEqual(saved);
    expect(await getAgentLearningSettings(client.db, human, "personal")).toEqual(savedPersonal);
    const after = await admin`SELECT oid,proacl,prosecdef,proconfig FROM pg_proc WHERE oid IN
      ('knowledge_learning_resolve(uuid,uuid,text,text,timestamptz)'::regprocedure,'agent_learning_manage(uuid,uuid,jsonb,jsonb)'::regprocedure) ORDER BY oid`;
    expect(after).toEqual(before);
  } finally {
    await client?.close();
    await owner.end();
    await owned.release();
  }
}, 180_000);

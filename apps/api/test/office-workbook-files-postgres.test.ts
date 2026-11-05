import { expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  OfficeWorkbookFileError,
  XLSX_CONTENT_TYPE,
  officeRunFiles,
  publishWorkbookCopy,
  workbookCopyScope,
} from "../src/office-workbook-files";

// CI must execute the real FORCE-RLS proof; local no-Docker runs report a skip.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "an agent saves the person's workbook copy to its chat with the chat's audience, and opens chat files",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("office-workbook-files");
    if (!owned) throw new Error("Workbook file verification requires PostgreSQL");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const db = client.db;
      const accountId = crypto.randomUUID(),
        workspaceId = crypto.randomUUID(),
        personalWorkspaceId = crypto.randomUUID(),
        membershipId = crypto.randomUUID();
      const person = `user:${crypto.randomUUID()}`,
        other = `user:${crypto.randomUUID()}`;
      const permissions = '["files:read","files:upload","sessions:read","sessions:control"]';
      await owned.admin.begin(async (tx) => {
        await tx`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Workbook files')`;
        await tx`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${workspaceId},${accountId},'Shared','{}'),(${personalWorkspaceId},${accountId},'Personal','{}')`;
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id) VALUES(${membershipId},${accountId},${person},'owner','active',${personalWorkspaceId})`;
        await tx`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role,permissions) VALUES(${accountId},${workspaceId},${person},'member',${permissions}::jsonb),(${accountId},${workspaceId},${other},'member',${permissions}::jsonb)`;
        await tx`SET LOCAL session_replication_role = origin`;
        await tx`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId}),(${personalWorkspaceId},${accountId})`;
      });
      const deps = {
        db,
        settings: testSettings({ productAccessMode: "managed" }),
      } as never;

      /** A live agent turn in a new chat the person started. */
      const agentIn = async (visibility: "workspace" | "user_private"): Promise<AccessGrant> => {
        const session = await createSession(db, {
          accountId,
          workspaceId,
          initialMessage: "Send me the workbook",
          model: "test-model",
          resources: [],
          metadata: {},
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: person },
          createdByContext: {},
        });
        if (visibility === "user_private") {
          await owned.admin.begin(async (tx) => {
            await tx`SET LOCAL session_replication_role = replica`;
            await tx`UPDATE sessions SET visibility='user_private',owner_subject_id=${person},owner_organization_membership_id=${membershipId} WHERE id=${session.id}`;
          });
        }
        const started = await initializeSessionStartAtomically(db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          reasoningEffortFallback: "low",
          createdEventPayload: {},
          goal: null,
        });
        if (!started.turn) throw new Error("no initial turn");
        const attemptId = crypto.randomUUID();
        const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
          sessionId: session.id,
          workflowId: `session-${session.id}`,
          workflowRunId: crypto.randomUUID(),
          attemptId,
          dispatchId: crypto.randomUUID(),
          trigger: { kind: "next" },
        });
        if (claimed.action !== "claimed") throw new Error("turn not claimed");
        return {
          accountId,
          workspaceId,
          subjectId: "worker:office-workbook-files",
          principalKind: "agent_attempt",
          permissions: ["files:read", "files:upload", "sessions:read"],
          metadata: {
            sessionId: session.id,
            turnId: claimed.turn.id,
            attemptId,
            executionGeneration: claimed.turn.executionGeneration,
          },
        } as AccessGrant;
      };

      /** A ready upload, as the add-in's uploadFile leaves it. */
      const upload = async (input: {
        owner: string;
        scope: "personal" | "workspace";
        contentType?: string;
        createdAt?: string;
      }) => {
        const id = crypto.randomUUID();
        const privateOwners = input.scope === "personal" ? [input.owner] : null;
        await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,owner_subject_id,private_owner_subject_ids,created_at)
          VALUES(${id},${accountId},${workspaceId},'ready','Model.xlsx','Model.xlsx',${input.contentType ?? XLSX_CONTENT_TYPE},2048,${"b".repeat(64)},'fixture',${id},${input.owner},${privateOwners},${input.createdAt ?? new Date().toISOString()})`;
        return id;
      };
      const publications = async (fileId: string) =>
        (
          await owned.admin`SELECT source_session_id FROM opengeni_private.sandbox_file_publications WHERE file_id=${fileId}`
        ).map((row) => row["source_session_id"]);

      // A shared chat: the copy is for the workspace and becomes one of the chat's files.
      const shared = await agentIn("workspace");
      const sharedSession = shared.metadata!["sessionId"] as string;
      expect(await workbookCopyScope(deps, shared, sharedSession)).toBe("workspace");
      const copy = await upload({ owner: person, scope: "workspace" });
      const receipt = await publishWorkbookCopy(deps, {
        grant: shared,
        sessionId: sharedSession,
        fileId: copy,
      });
      expect(receipt).toMatchObject({
        artifactId: copy,
        filename: "Model.xlsx",
        access: { visibility: "workspace" },
        artifact: { artifactId: copy, contentType: XLSX_CONTENT_TYPE },
      });
      expect(await publications(copy)).toEqual([sharedSession]);

      // Only the person's own fresh .xlsx with the chat's audience qualifies.
      for (const fileId of [
        await upload({ owner: other, scope: "workspace" }),
        await upload({ owner: person, scope: "personal" }),
        await upload({ owner: person, scope: "workspace", contentType: "text/csv" }),
        await upload({
          owner: person,
          scope: "workspace",
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        }),
        crypto.randomUUID(),
      ]) {
        await expect(
          publishWorkbookCopy(deps, { grant: shared, sessionId: sharedSession, fileId }),
        ).rejects.toBeInstanceOf(OfficeWorkbookFileError);
        expect(await publications(fileId)).toEqual([]);
      }

      // An Only me chat: the copy stays the person's own.
      const privateChat = await agentIn("user_private");
      const privateSession = privateChat.metadata!["sessionId"] as string;
      expect(await workbookCopyScope(deps, privateChat, privateSession)).toBe("personal");
      const privateCopy = await upload({ owner: person, scope: "personal" });
      expect(
        await publishWorkbookCopy(deps, {
          grant: privateChat,
          sessionId: privateSession,
          fileId: privateCopy,
        }),
      ).toMatchObject({ artifactId: privateCopy, access: { visibility: "private" } });
      expect(await publications(privateCopy)).toEqual([privateSession]);

      // Chat files the code opens: references the add-in downloads as the person.
      const files = await officeRunFiles(deps, shared, [copy]);
      expect(files).toEqual([
        {
          name: "Model.xlsx",
          artifact: expect.objectContaining({
            artifactId: copy,
            contentType: XLSX_CONTENT_TYPE,
            originalBytes: 2048,
          }),
        },
      ]);
      // Another person's Only me file is out of reach, like a missing one.
      const othersPrivate = await upload({ owner: other, scope: "personal" });
      for (const id of [othersPrivate, crypto.randomUUID()])
        await expect(officeRunFiles(deps, shared, [id])).rejects.toBeInstanceOf(
          OfficeWorkbookFileError,
        );
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);

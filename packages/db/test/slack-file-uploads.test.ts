import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bindSlackInteractionSession,
  checkpointSlackFileUpload,
  claimSlackFileUpload,
  createConnection,
  createDb,
  createSession,
  getOrCreateSlackInteraction,
  getSlackInteractionForSession,
  grantWorkspaceAccess,
  releaseSlackFileUploadClaim,
  renewSlackFileUploadClaim,
  SlackFileUploadRefusedError,
  withRlsContext,
  withSessionRlsActorContext,
  type ClaimSlackFileUploadInput,
  type Database,
  type DbClient,
  type SlackFileUploadPhase,
} from "../src/index";

function input(): ClaimSlackFileUploadInput {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    interactionId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    fileId: crypto.randomUUID(),
    subjectId: "user:slack-upload-owner",
    operationId: crypto.randomUUID(),
    requestDigest: "a".repeat(64),
    claimHolderId: crypto.randomUUID(),
    leaseMs: 60_000,
  };
}

describe("Slack upload ingress bounds", () => {
  const noQueries = {} as Database;
  test("rejects invalid leases before querying", async () => {
    for (const leaseMs of [0, -1, 1.5, NaN, Infinity, 120_001, Number.MAX_SAFE_INTEGER]) {
      await expect(claimSlackFileUpload(noQueries, { ...input(), leaseMs })).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(
        renewSlackFileUploadClaim(noQueries, { ...input(), leaseMs }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });
  test("rejects unbounded subject/digest/identities before querying", async () => {
    for (const changed of [
      { subjectId: " " },
      { subjectId: "é".repeat(513) },
      { requestDigest: "a".repeat(65) },
      { requestDigest: "G".repeat(64) },
      { fileId: "not-a-file" },
      { claimHolderId: "not-a-holder" },
    ]) {
      await expect(
        claimSlackFileUpload(noQueries, { ...input(), ...changed }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });
  test("refuses illegal or unbounded checkpoints before querying", async () => {
    const base = input();
    for (const [expectedPhase, phase] of [
      ["pending", "completed"],
      ["uploaded", "uploading"],
      ["completing", "pending"],
      ["completing", "uploading"],
      ["outcome_unknown", "pending"],
      ["outcome_unknown", "uploading"],
      ["completed", "completed"],
    ] as [SlackFileUploadPhase, SlackFileUploadPhase][]) {
      expect(
        await checkpointSlackFileUpload(noQueries, {
          ...base,
          expectedPhase,
          phase,
          slackFileId: "F1",
        }),
      ).toBe(false);
    }
    for (const slackFileId of [undefined, "", " ", "é".repeat(65)]) {
      expect(
        await checkpointSlackFileUpload(noQueries, {
          ...base,
          expectedPhase: "pending",
          phase: "uploading",
          ...(slackFileId === undefined ? {} : { slackFileId }),
        }),
      ).toBe(false);
    }
  });

  test("a lease expiring at the SQL guard is a failed CAS, not an automatic retry", async () => {
    let calls = 0;
    const boundary = {
      transaction: async () => {
        calls++;
        throw new Error("query failed", {
          cause: { code: "23514", message: "Slack file upload claim expired" },
        });
      },
    } as unknown as Database;
    expect(
      await checkpointSlackFileUpload(boundary, {
        ...input(),
        expectedPhase: "pending",
        phase: "uploading",
        slackFileId: "FEXPIRED",
      }),
    ).toBe(false);
    expect(calls).toBe(1);
  });
});

// A skipped DB proof stays visibly skipped; static checks are not a substitute.
const postgresDescribe =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? describe
    : describe.skip;

postgresDescribe("Slack file upload ordinary-RLS durable ledger", () => {
  let shared: SharedTestDatabase;
  let client: DbClient;
  let db: Database;
  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("slack-file-uploads");
    if (!acquired) throw new Error("Slack file upload PostgreSQL fixture unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
    db = client.db;
  }, 180_000);
  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 180_000);

  async function workspace(accountId = crypto.randomUUID()) {
    const workspaceId = crypto.randomUUID();
    await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Slack upload') ON CONFLICT DO NOTHING`;
    await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Slack upload')`;
    await shared.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
    return { accountId, workspaceId };
  }

  async function fixture(privateSession = false, routed = false) {
    const scope = await workspace();
    const connectionScope = routed ? await workspace(scope.accountId) : scope;
    const subjectId = "user:slack-upload-owner";
    await grantWorkspaceAccess(db, {
      ...scope,
      subjectId,
      permissions: ["sessions:create", "sessions:read", "sessions:control"],
    });
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const connection = await createConnection(db, {
      ...connectionScope,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "fixture-ciphertext",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      verifiedInstallAt: new Date(),
      verifiedInstallVersion: 1,
      metadata: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        slackTeamId: `T${suffix}`,
        slackTeamName: "Slack uploads",
        botId: `B${suffix}`,
        botUserId: `U${suffix}`,
        botDisplayName: "OpenGeni",
        verifiedAt: new Date().toISOString(),
      },
    });
    const { interaction } = await getOrCreateSlackInteraction(db, {
      ...scope,
      connectionId: connection.id,
      slackTeamId: `T${suffix}`,
      slackChannelId: privateSession ? "DUPLOAD" : "CUPLOAD",
      slackThreadTs: "1710000000.000010",
      routeKey: `upload:${suffix}`,
      triggeringProviderEventId: `E${suffix}`,
      initiatingSlackUserId: "UOWNER",
      owningSubjectId: subjectId,
      visibility: privateSession ? "private" : "workspace",
    });
    const session = await createSession(db, {
      ...scope,
      requestedSessionId: interaction.sessionReservationId,
      initialMessage: "Upload this task file",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
    });
    await bindSlackInteractionSession(db, { ...interaction, sessionId: session.id });
    const fileId = crypto.randomUUID();
    await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
      VALUES(${fileId},${scope.accountId},${scope.workspaceId},'ready','report.pdf','report.pdf','application/pdf',12,'fixture',${`slack/${fileId}`})`;
    const claim: ClaimSlackFileUploadInput = {
      ...scope,
      sessionId: session.id,
      interactionId: interaction.id,
      connectionId: connection.id,
      fileId,
      subjectId,
      operationId: crypto.randomUUID(),
      requestDigest: "a".repeat(64),
      claimHolderId: crypto.randomUUID(),
      leaseMs: 60_000,
    };
    return { claim, interaction, session, connectionScope };
  }

  async function expire(claim: ClaimSlackFileUploadInput) {
    await shared.admin`UPDATE opengeni_private.slack_file_upload_operations
      SET claim_expires_at = clock_timestamp() - interval '1 second'
      WHERE workspace_id = ${claim.workspaceId} AND operation_id = ${claim.operationId}`;
  }

  async function advance(claim: ClaimSlackFileUploadInput, to: SlackFileUploadPhase) {
    const path: SlackFileUploadPhase[] = ["pending", "uploading", "uploaded", "completing"];
    for (let index = 1; index <= path.indexOf(to); index++) {
      expect(
        await checkpointSlackFileUpload(db, {
          ...claim,
          expectedPhase: path[index - 1]!,
          phase: path[index]!,
          ...(index === 1 ? { slackFileId: "FUPLOAD1" } : {}),
        }),
      ).toBe(true);
    }
  }

  test("finds only the exact bound session, never a root/child/reservation fallback", async () => {
    const { claim, interaction } = await fixture();
    expect(await getSlackInteractionForSession(db, claim)).toMatchObject({
      id: interaction.id,
      sessionId: claim.sessionId,
    });
    const child = await createSession(db, {
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: claim.subjectId },
      parentSessionId: claim.sessionId,
    });
    expect(await getSlackInteractionForSession(db, { ...claim, sessionId: child.id })).toBeNull();
    const reserved = await getOrCreateSlackInteraction(db, {
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      connectionId: claim.connectionId,
      slackTeamId: interaction.slackTeamId,
      slackChannelId: "CRESERVED",
      slackThreadTs: "1710000000.000020",
      routeKey: `reserved:${crypto.randomUUID()}`,
      triggeringProviderEventId: "ERESERVED",
      owningSubjectId: claim.subjectId,
      visibility: "workspace",
    });
    expect(
      await getSlackInteractionForSession(db, {
        ...claim,
        sessionId: reserved.interaction.sessionReservationId,
      }),
    ).toBeNull();
    const other = await workspace();
    expect(await getSlackInteractionForSession(db, { ...claim, ...other })).toBeNull();
  });

  test("uses source tenancy while the routed installation HOME is another workspace", async () => {
    const { claim, connectionScope } = await fixture(false, true);
    expect(claim.workspaceId).not.toBe(connectionScope.workspaceId);
    expect(await claimSlackFileUpload(db, claim)).toMatchObject({
      status: "claimed",
      operation: { workspaceId: claim.workspaceId, connectionId: claim.connectionId },
    });
    expect(await renewSlackFileUploadClaim(db, { ...claim, ...connectionScope })).toBe(false);
  });

  test("fences concurrent inserts and rejects every changed binding", async () => {
    const { claim } = await fixture();
    const contender = { ...claim, claimHolderId: crypto.randomUUID() };
    const results = await Promise.all([
      claimSlackFileUpload(db, claim),
      claimSlackFileUpload(db, contender),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["busy", "claimed"]);
    expect(results[0]!.operation.id).toBe(results[1]!.operation.id);
    for (const changed of [
      { sessionId: crypto.randomUUID() },
      { interactionId: crypto.randomUUID() },
      { connectionId: crypto.randomUUID() },
      { fileId: crypto.randomUUID() },
      { subjectId: "user:changed" },
      { requestDigest: "b".repeat(64) },
    ]) {
      expect((await claimSlackFileUpload(db, { ...claim, ...changed })).status).toBe("conflict");
    }
    const rows =
      await shared.admin`SELECT count(*)::int AS count FROM opengeni_private.slack_file_upload_operations
      WHERE workspace_id=${claim.workspaceId} AND operation_id=${claim.operationId}`;
    expect(rows[0]!.count).toBe(1);
  });

  test("validates exact interaction binding and a ready source file under ordinary RLS", async () => {
    const { claim } = await fixture();
    for (const changed of [
      { interactionId: crypto.randomUUID() },
      { sessionId: crypto.randomUUID() },
      { connectionId: crypto.randomUUID() },
    ]) {
      await expect(
        claimSlackFileUpload(db, { ...claim, ...changed, operationId: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(SlackFileUploadRefusedError);
    }
    await shared.admin`UPDATE files SET status='pending_upload' WHERE id=${claim.fileId}`;
    await expect(claimSlackFileUpload(db, claim)).rejects.toBeInstanceOf(
      SlackFileUploadRefusedError,
    );
    const privateFileId = crypto.randomUUID();
    await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key,private_owner_subject_ids)
      VALUES(${privateFileId},${claim.accountId},${claim.workspaceId},'ready','private.pdf','private.pdf','application/pdf',12,'fixture',${`slack/${privateFileId}`},ARRAY['user:someone-else'])`;
    await expect(
      withSessionRlsActorContext(
        { subjectId: claim.subjectId, privateFileOwnerSubjectId: claim.subjectId },
        () => claimSlackFileUpload(db, { ...claim, fileId: privateFileId }),
      ),
    ).rejects.toBeInstanceOf(SlackFileUploadRefusedError);
  });

  test("renewal, checkpoints and release fence both stale holders and expired leases", async () => {
    const { claim } = await fixture();
    expect((await claimSlackFileUpload(db, claim)).status).toBe("claimed");
    expect(
      await renewSlackFileUploadClaim(db, { ...claim, claimHolderId: crypto.randomUUID() }),
    ).toBe(false);
    expect(await renewSlackFileUploadClaim(db, claim)).toBe(true);
    await expire(claim);
    expect(await renewSlackFileUploadClaim(db, claim)).toBe(false);
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "pending",
        phase: "uploading",
        slackFileId: "FOLD",
      }),
    ).toBe(false);
    await releaseSlackFileUploadClaim(db, claim);
    const replacement = { ...claim, claimHolderId: crypto.randomUUID() };
    expect(await claimSlackFileUpload(db, replacement)).toMatchObject({
      status: "claimed",
      operation: { phase: "pending" },
    });
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "pending",
        phase: "uploading",
        slackFileId: "FSTALE",
      }),
    ).toBe(false);
    await releaseSlackFileUploadClaim(db, claim);
    expect(
      (await claimSlackFileUpload(db, { ...replacement, claimHolderId: crypto.randomUUID() }))
        .status,
    ).toBe("busy");
  });

  test("checks expiry after a lock-only transaction, not before waiting for its row lock", async () => {
    const { claim } = await fixture();
    for (const action of ["renew", "checkpoint", "release"] as const) {
      const current = {
        ...claim,
        operationId: crypto.randomUUID(),
        claimHolderId: crypto.randomUUID(),
        leaseMs: 150,
      };
      expect((await claimSlackFileUpload(db, current)).status).toBe("claimed");
      let pending: Promise<boolean | void> | undefined;
      await shared.admin.begin(async (locked) => {
        // No UPDATE: PostgreSQL need not re-evaluate an UPDATE predicate after
        // this lock wait. Repositories must explicitly lock before reading time.
        await locked`SELECT id FROM opengeni_private.slack_file_upload_operations
          WHERE workspace_id=${current.workspaceId} AND operation_id=${current.operationId} FOR UPDATE`;
        pending =
          action === "renew"
            ? renewSlackFileUploadClaim(db, { ...current, leaseMs: 60_000 })
            : action === "checkpoint"
              ? checkpointSlackFileUpload(db, {
                  ...current,
                  expectedPhase: "pending",
                  phase: "uploading",
                  slackFileId: "FTOOLATE",
                })
              : releaseSlackFileUploadClaim(db, current);
        await locked`SELECT pg_sleep(0.25)`;
      });
      expect(await pending).toBe(action === "release" ? undefined : false);
      const rows =
        await shared.admin`SELECT phase, claim_holder_id, claim_expires_at <= clock_timestamp() AS expired
        FROM opengeni_private.slack_file_upload_operations WHERE workspace_id=${current.workspaceId} AND operation_id=${current.operationId}`;
      expect(rows[0]).toMatchObject({
        phase: "pending",
        claim_holder_id: current.claimHolderId,
        expired: true,
      });
    }
  });

  test("stores allocation before upload, permits only unshared allocation replacement, and preserves uploaded recovery", async () => {
    const { claim } = await fixture();
    await claimSlackFileUpload(db, claim);
    await advance(claim, "uploading");
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "pending",
        phase: "uploading",
        slackFileId: "FWRONGPHASE",
      }),
    ).toBe(false);
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "uploading",
        phase: "uploading",
        slackFileId: "FREPLACED",
      }),
    ).toBe(true);
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "uploading",
        phase: "uploaded",
        slackFileId: "FOTHER",
      }),
    ).toBe(false);
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "uploading",
        phase: "uploaded",
      }),
    ).toBe(true);
    await expire(claim);
    const recovered = { ...claim, claimHolderId: crypto.randomUUID() };
    expect(await claimSlackFileUpload(db, recovered)).toMatchObject({
      status: "claimed",
      operation: { phase: "uploaded", slackFileId: "FREPLACED" },
    });
    expect(
      await checkpointSlackFileUpload(db, {
        ...recovered,
        expectedPhase: "uploaded",
        phase: "uploading",
        slackFileId: "FNEVER",
      }),
    ).toBe(false);
    expect(
      await checkpointSlackFileUpload(db, {
        ...recovered,
        expectedPhase: "uploaded",
        phase: "completing",
        slackFileId: "FOTHER",
      }),
    ).toBe(false);
    expect(
      await checkpointSlackFileUpload(db, {
        ...recovered,
        expectedPhase: "uploaded",
        phase: "completing",
      }),
    ).toBe(true);
  });

  test("expired completion stays uncertain through repeated recovery and completes only with its stable id", async () => {
    const { claim } = await fixture();
    await claimSlackFileUpload(db, claim);
    await advance(claim, "completing");
    await expire(claim);
    const recovered = { ...claim, claimHolderId: crypto.randomUUID() };
    expect(await claimSlackFileUpload(db, recovered)).toMatchObject({
      status: "claimed",
      operation: { phase: "outcome_unknown", slackFileId: "FUPLOAD1" },
    });
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "completing",
        phase: "completed",
      }),
    ).toBe(false);
    expect(
      await checkpointSlackFileUpload(db, {
        ...recovered,
        expectedPhase: "outcome_unknown",
        phase: "completed",
        slackFileId: "FOTHER",
      }),
    ).toBe(false);
    await releaseSlackFileUploadClaim(db, recovered);
    const reconciliation = { ...claim, claimHolderId: crypto.randomUUID() };
    expect(await claimSlackFileUpload(db, reconciliation)).toMatchObject({
      status: "claimed",
      operation: { phase: "outcome_unknown", slackFileId: "FUPLOAD1" },
    });
    expect(
      await checkpointSlackFileUpload(db, {
        ...reconciliation,
        expectedPhase: "outcome_unknown",
        phase: "completed",
        slackFileId: "FUPLOAD1",
      }),
    ).toBe(true);
    expect(
      await claimSlackFileUpload(db, { ...claim, claimHolderId: crypto.randomUUID() }),
    ).toMatchObject({
      status: "completed",
      operation: {
        phase: "completed",
        slackFileId: "FUPLOAD1",
        claimHolderId: null,
        claimExpiresAt: null,
      },
    });
    expect(await renewSlackFileUploadClaim(db, reconciliation)).toBe(false);
    expect(
      (await claimSlackFileUpload(db, { ...claim, requestDigest: "b".repeat(64) })).status,
    ).toBe("conflict");
  });

  test("release never rewinds any phase and successful provider completion is absorbing", async () => {
    for (const phase of ["pending", "uploading", "uploaded", "completing"] as const) {
      const { claim } = await fixture();
      await claimSlackFileUpload(db, claim);
      await advance(claim, phase);
      await releaseSlackFileUploadClaim(db, claim);
      const next = { ...claim, claimHolderId: crypto.randomUUID() };
      expect(await claimSlackFileUpload(db, next)).toMatchObject({
        status: "claimed",
        operation: { phase: phase === "completing" ? "outcome_unknown" : phase },
      });
    }
    const { claim } = await fixture();
    await claimSlackFileUpload(db, claim);
    await advance(claim, "completing");
    expect(
      await checkpointSlackFileUpload(db, {
        ...claim,
        expectedPhase: "completing",
        phase: "completed",
      }),
    ).toBe(true);
    await releaseSlackFileUploadClaim(db, claim);
    expect((await claimSlackFileUpload(db, claim)).status).toBe("completed");
  });

  test("hides private sessions and their ledger from another live workspace member", async () => {
    const { claim } = await fixture(true);
    const otherSubjectId = "user:slack-upload-other";
    await grantWorkspaceAccess(db, {
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      subjectId: otherSubjectId,
      permissions: ["sessions:read"],
    });
    await withSessionRlsActorContext({ subjectId: claim.subjectId }, async () => {
      expect(await getSlackInteractionForSession(db, claim)).not.toBeNull();
      expect((await claimSlackFileUpload(db, claim)).status).toBe("claimed");
    });
    await withSessionRlsActorContext({ subjectId: otherSubjectId }, async () => {
      expect(await getSlackInteractionForSession(db, claim)).toBeNull();
      expect(await renewSlackFileUploadClaim(db, claim)).toBe(false);
      await expect(claimSlackFileUpload(db, claim)).rejects.toBeInstanceOf(
        SlackFileUploadRefusedError,
      );
      await withRlsContext(db, claim, async (tx) => {
        const rows = await tx.execute(
          sql`SELECT id FROM opengeni_private.slack_file_upload_operations`,
        );
        expect(rows).toHaveLength(0);
      });
    });
  });

  test("enforces SQL immutability/phase/id shape and rejects tenantless reads and destructive grants", async () => {
    const { claim } = await fixture();
    await claimSlackFileUpload(db, claim);
    for (const update of [
      sql`subject_id = 'user:changed'`,
      sql`request_digest = repeat('b',64)`,
      sql`phase = 'completed', slack_file_id = 'FBYPASS', claim_holder_id = NULL, claim_expires_at = NULL`,
      sql`slack_file_id = 'FBEFOREUPLOAD'`,
    ]) {
      await expect(
        withRlsContext(db, claim, async (tx) =>
          tx.execute(sql`
        UPDATE opengeni_private.slack_file_upload_operations SET ${update} WHERE operation_id=${claim.operationId}::uuid
      `),
        ),
      ).rejects.toThrow();
    }
    const rows = await db.execute(
      sql`SELECT id FROM opengeni_private.slack_file_upload_operations`,
    );
    expect(rows).toHaveLength(0);
    const posture = await shared.admin`SELECT c.relrowsecurity, c.relforcerowsecurity,
      has_table_privilege('opengeni_app',c.oid,'SELECT') AS can_select,
      has_table_privilege('opengeni_app',c.oid,'INSERT') AS can_insert,
      has_table_privilege('opengeni_app',c.oid,'UPDATE') AS can_update,
      has_table_privilege('opengeni_app',c.oid,'DELETE') AS can_delete,
      has_table_privilege('opengeni_app',c.oid,'TRUNCATE') AS can_truncate
      FROM pg_class c WHERE c.oid='opengeni_private.slack_file_upload_operations'::regclass`;
    expect(posture[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: false,
      can_truncate: false,
    });
  });
});

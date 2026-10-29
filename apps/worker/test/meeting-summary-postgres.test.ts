import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as codex from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import { projectAgentEffectiveTools } from "@opengeni/contracts";
import {
  resolveDefaultSessionModel,
  sessionEffectiveToolProjectionInput,
  swapActiveSandbox,
  updateSessionToolPolicy,
} from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  claimRecordingTranscriptVersion,
  completeRecordingTranscriptVersion,
  createDb,
  createEventSource,
  createScheduledTask,
  createRecording,
  createSession,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  finalizeRecording,
  freezeAgentLearningPolicy,
  getSessionForSubject,
  markRecordingChunksUploaded,
  reserveRecordingChunks,
  saveRecordingNote,
  setScheduledTaskEvents,
  updateWorkspaceSettings,
  type DbClient,
  type SessionCreateInput,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { meetingSummaryModel, startMeetingSummary } from "../src/activities/meeting-summary";
import type { ControlActivityServices } from "../src/activities/types";

// The built-in meeting summary (docs/recordings.md, "Notes") against real
// PostgreSQL: one ordinary chat per ready transcript, on the model a new chat
// gets when the workspace's shared subscription accounts serve it, and none
// when the setting is off, notes exist, or no subscription account can serve.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const encryptionKey = Buffer.alloc(32, 41);
const settings = testSettings({
  productAccessMode: "managed",
  codexSubscriptionEnabled: true,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  sandboxBackend: "none",
});
const codexModels = configuredModels(withCodexCatalogProvider(settings)).filter((model) =>
  model.id.startsWith("codex/"),
);

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("meeting-summary");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (restores.length) restores.pop()!.mockRestore();
});

function serveCodex() {
  restores.push(
    spyOn(codex, "fetchCodexModels").mockResolvedValue({
      ok: true,
      status: 200,
      slugs: codexModels.map((model) => model.upstreamModelId),
    }),
  );
}

function services(overrides: Partial<typeof settings> = {}): ControlActivityServices {
  return {
    db: client.db,
    bus: new MemoryEventBus(),
    settings: { ...settings, ...overrides },
    objectStorage: null,
    wakeSessionWorkflow: null,
    signalSessionAttemptQuiesced: null,
    inspectSessionAttemptActivity: null,
  } as unknown as ControlActivityServices;
}

/** Claims the summary chat's first turn as the worker does and freezes its
 * learning policy, the first thing a run does before the model is called. */
async function freezeFirstTurnLearning(
  scope: { accountId: string; workspaceId: string },
  sessionId: string,
) {
  const [turn] = await shared!.admin<{ human: string | null; workflowId: string }[]>`
    select initiating_human_subject_id as human, temporal_workflow_id as "workflowId"
    from session_turns where session_id = ${sessionId}::uuid`;
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId,
    workflowId: turn!.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Claim failed: ${claim.reason}`);
  const policy = await freezeAgentLearningPolicy(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    actor: {
      kind: "agent",
      sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  });
  return { human: turn!.human, policy };
}

async function workspace(options: { subscription: boolean }) {
  const userId = `meeting-summary-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Ingrid Solberg', ${`${userId}@example.test`}, true)`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Ingrid Solberg",
  });
  const { accountId, workspaceId } = access.workspaceGrants.find(
    (grant) => grant.workspaceId === access.defaultWorkspaceId,
  )!;
  const owner = `user:${userId}`;
  if (options.subscription) {
    const tokens = encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
    );
    await shared!.admin`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        provider_account_id, plan_type, provider_state, expires_at, last_refresh_at, label
      ) values (
        ${accountId}::uuid, 'codex', 'subscription', ${tokens}, 'shared', 'organization',
        ${`chatgpt-${userId}`}, 'pro', ${shared!.admin.json({ isFedramp: false })}::jsonb,
        ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, now(), 'Team'
      )`;
  }
  const actor = { workspaceId, subjectId: owner };

  /** A meeting whose transcript just became ready; returns the summary input. */
  async function meeting(visibility: "private" | "workspace" = "private") {
    const recordingId = crypto.randomUUID();
    await createRecording(client.db, {
      ...actor,
      accountId,
      recordingId,
      title: "Roof planning",
      visibility,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    await reserveRecordingChunks(client.db, {
      ...actor,
      recordingId,
      trackNumber: 0,
      chunks: [
        {
          chunkNumber: 0,
          byteLength: 100,
          sha256: "a".repeat(64),
          startMilliseconds: 0,
          durationMilliseconds: 60_000,
        },
      ],
    });
    await markRecordingChunksUploaded(client.db, {
      ...actor,
      recordingId,
      trackNumber: 0,
      chunkNumbers: [0],
    });
    const versionId = crypto.randomUUID();
    await finalizeRecording(client.db, {
      ...actor,
      recordingId,
      tracks: [{ trackNumber: 0, chunkCount: 1 }],
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
      versionId,
    });
    const processingOwner = crypto.randomUUID();
    await claimRecordingTranscriptVersion(client.db, {
      ...actor,
      versionId,
      processingOwner,
      leaseSeconds: 600,
    });
    await completeRecordingTranscriptVersion(client.db, {
      ...actor,
      versionId,
      processingOwner,
      languages: ["en"],
      diarized: true,
      diarization: "provider",
      audioMilliseconds: 60_000,
      segments: [
        {
          startMilliseconds: 0,
          endMilliseconds: 4_000,
          trackNumber: 0,
          speakerLabel: "speaker_0",
          text: "Tomas will order the roof tiles by Friday.",
        },
      ],
    });
    return { accountId, workspaceId, recordingId, versionId, ownerSubjectId: owner };
  }

  /** Another person's Only me meeting in this same workspace. */
  async function someoneElsesMeeting() {
    const { recordingId } = await meeting("private");
    const copyId = crypto.randomUUID();
    await shared!.admin`
      insert into recordings select (jsonb_populate_record(null::recordings, to_jsonb(r)
        || ${shared!.admin.json({ id: copyId, owner_subject_id: `user:someone-${copyId}` })}::jsonb)).*
      from recordings r where r.id = ${recordingId}::uuid`;
    return copyId;
  }

  async function sessionsFor(recordingId: string) {
    return await shared!.admin<{ id: string }[]>`
      select id::text as id from sessions
      where workspace_id = ${workspaceId}::uuid
        and metadata ->> 'meetingSummaryRecordingId' = ${recordingId}`;
  }
  const grant = access.workspaceGrants.find((each) => each.workspaceId === workspaceId)!;
  return { accountId, workspaceId, owner, actor, grant, meeting, someoneElsesMeeting, sessionsFor };
}

describe("built-in meeting summary", () => {
  test("a ready transcript starts exactly one Only me chat for the owner, on the chat's subscription model", async () => {
    if (!realDb) return;
    serveCodex();
    const scope = await workspace({ subscription: true });
    const input = await scope.meeting("private");

    const first = await startMeetingSummary(services(), input);
    const again = await startMeetingSummary(services(), input);
    if (!first.started || !again.started) throw new Error(JSON.stringify({ first, again }));
    expect(again.sessionId).toBe(first.sessionId);
    expect(await scope.sessionsFor(input.recordingId)).toEqual([{ id: first.sessionId }]);

    // The model a new chat gets here, the one the shared Codex account serves.
    const chat = await resolveDefaultSessionModel(client.db, withCodexCatalogProvider(settings), {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      subjectId: scope.owner,
    });
    expect(chat.source).toBe("subscription");
    expect(first.model).toBe(chat.model);

    const session = await getSessionForSubject(
      client.db,
      scope.workspaceId,
      first.sessionId,
      scope.owner,
    );
    expect(session).toMatchObject({
      model: chat.model,
      tenancy: { visibility: "private", ownedByCurrentUser: true },
      sandboxBackend: "none",
      policyRole: "meeting_summary",
      createdBy: { kind: "service", subjectId: "meeting-summary" },
      firstPartyMcpTools: ["meeting_read", "meeting_notes_save"],
      resources: [],
    });
    // What the agent can call: the two meeting tools and the runtime's own
    // wait_for_input (agent-config: mechanics every agent has, reaching nothing).
    const projected = projectAgentEffectiveTools(
      sessionEffectiveToolProjectionInput(session as never, session!.tools, {
        settings,
        humanInputEnabled: true,
        hasWorkspaceSkills: true,
        objectStorageAvailable: true,
      }),
    );
    expect(projected.tools.map((tool) => tool.name).sort()).toEqual([
      "opengeni__meeting_notes_save",
      "opengeni__meeting_read",
      "opengeni__wait_for_input",
    ]);
    const [turn] = await shared!.admin<{ count: number; authority: string; codex: string }[]>`
      select count(*)::int as count, min(subscription_authority::text) as authority, min(codex_provider_account_authority_snapshot::text) as codex from session_turns where session_id = ${first.sessionId}::uuid`;
    // Its one turn is placed like any chat turn, on the shared accounts only:
    // no personal account is frozen into its subscription authority.
    expect(turn?.count).toBe(1);
    expect(JSON.parse(turn!.authority)).toEqual({ version: 2, personal: [] });
    expect(JSON.parse(turn!.codex)).toEqual({ scope: "workspace", version: 1 });
    const [row] = await shared!.admin<{ visibility: string; owner: string | null }[]>`
      select visibility, owner_subject_id as owner from sessions where id = ${first.sessionId}::uuid`;
    expect(row).toEqual({ visibility: "user_private", owner: scope.owner });

    // The service starts it, but the turn runs for the meeting's owner, like
    // their own Only me automation: the run's first step, freezing what it may
    // learn, gets their personal layer instead of refusing a human-less turn
    // in their private chat.
    const run = await freezeFirstTurnLearning(scope, first.sessionId);
    expect(run.human).toBe(scope.owner);
    expect(run.policy).toMatchObject({ defaultScope: "personal", subjectId: scope.owner });
  }, 180_000);

  test("a shared meeting gets a workspace chat", async () => {
    if (!realDb) return;
    serveCodex();
    const scope = await workspace({ subscription: true });
    const input = await scope.meeting("workspace");
    const started = await startMeetingSummary(services(), input);
    if (!started.started) throw new Error(started.reason);
    const [row] = await shared!.admin<{ visibility: string; owner: string | null }[]>`
      select visibility, owner_subject_id as owner from sessions where id = ${started.sessionId}::uuid`;
    expect(row).toEqual({ visibility: "workspace_shared", owner: null });
    // No one person's: it learns into the workspace, for no human.
    const run = await freezeFirstTurnLearning(scope, started.sessionId);
    expect(run.human).toBeNull();
    expect(run.policy).toMatchObject({ defaultScope: "workspace" });
  }, 180_000);

  test("nothing starts when the setting is off, notes exist, or the owner's own automation writes them", async () => {
    if (!realDb) return;
    serveCodex();
    const off = await workspace({ subscription: true });
    await updateWorkspaceSettings(client.db, off.workspaceId, {
      recordings: { autoSummary: false },
    });
    const offInput = await off.meeting();
    expect(await startMeetingSummary(services(), offInput)).toEqual({
      started: false,
      reason: "turned_off",
    });
    expect(await off.sessionsFor(offInput.recordingId)).toEqual([]);

    const noted = await workspace({ subscription: true });
    const notedInput = await noted.meeting();
    await saveRecordingNote(client.db, {
      ...noted.actor,
      recordingId: notedInput.recordingId,
      kind: "notes",
      body: "Already written.",
    });
    expect(await startMeetingSummary(services(), notedInput)).toEqual({
      started: false,
      reason: "has_notes",
    });
    expect(await noted.sessionsFor(notedInput.recordingId)).toEqual([]);

    // The owner's own automation for ready transcripts, such as the "Meeting
    // notes" template, writes the notes instead, while event triggers run.
    const automated = await workspace({ subscription: true });
    const space = {
      accountId: automated.accountId,
      workspaceId: automated.workspaceId,
      subjectId: automated.owner,
    };
    const { source } = await createEventSource(client.db, {
      ...space,
      createdBySubjectId: automated.owner,
      kind: "webhook",
      adapter: "standard",
      name: "This workspace",
      ownerSubjectId: automated.owner,
      visibility: "private",
      secretEncrypted: "encrypted-secret",
    });
    const task = await createScheduledTask(client.db, {
      accountId: automated.accountId,
      workspaceId: automated.workspaceId,
      ownerSubjectId: automated.owner,
      name: "Meeting notes",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `schedule-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      agentConfig: { prompt: "Write the notes", resources: [], tools: [], metadata: {} },
      metadata: {},
      createdBy: { kind: "subject", subjectId: automated.owner },
    } as Parameters<typeof createScheduledTask>[1]);
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: task.id,
      triggers: [
        {
          sourceId: source.id,
          eventTypes: ["recording.transcript.ready"],
          conditions: [],
          includeOwnEvents: false,
        },
      ],
    });
    const automatedInput = await automated.meeting();
    expect(
      await startMeetingSummary(services({ eventTriggersEnabled: true }), automatedInput),
    ).toEqual({ started: false, reason: "own_automation" });
    expect(await automated.sessionsFor(automatedInput.recordingId)).toEqual([]);
  }, 180_000);

  test("without a subscription account that can serve it, nothing starts and no credits are spent", async () => {
    if (!realDb) return;
    serveCodex();
    const scope = await workspace({ subscription: false });
    const input = await scope.meeting();
    expect(await startMeetingSummary(services(), input)).toEqual({
      started: false,
      reason: "no_subscription",
    });
    expect(await startMeetingSummary(services({ codexSubscriptionEnabled: false }), input)).toEqual(
      { started: false, reason: "no_subscription" },
    );
    expect(await scope.sessionsFor(input.recordingId)).toEqual([]);
  }, 180_000);

  test("in an EU-only workspace nothing starts on a subscription model outside the EU", async () => {
    if (!realDb) return;
    serveCodex();
    const scope = await workspace({ subscription: true });
    const input = await scope.meeting();
    await shared!.admin`insert into organization_inference_residency
        (account_id, eu_only, version, updated_by_subject_id)
      values (${scope.accountId}, true, 1, ${scope.owner})
      on conflict (account_id) do update set eu_only = true`;
    expect(await startMeetingSummary(services(), input)).toEqual({
      started: false,
      reason: "region_restricted",
    });
    expect(await scope.sessionsFor(input.recordingId)).toEqual([]);
  }, 180_000);

  test("no other session can pass as a meeting summary or widen one", async () => {
    if (!realDb) return;
    const scope = await workspace({ subscription: false });
    const own = await scope.meeting("private");
    const other = await workspace({ subscription: false });
    const theirs = await other.meeting("private");
    const someoneElses = await scope.someoneElsesMeeting();
    const exact: SessionCreateInput = {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      visibility: "user_private",
      meetingSummary: { recordingId: own.recordingId, ownerSubjectId: scope.owner },
      initialMessage: "Write the notes.",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: { meetingSummaryRecordingId: own.recordingId },
      createdBy: { kind: "service", subjectId: "meeting-summary", label: "Opengeni meeting notes" },
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      policyRole: "meeting_summary",
      firstPartyMcpTools: ["meeting_read", "meeting_notes_save"],
      createIdempotencyKey: `meeting-summary:${crypto.randomUUID()}`,
      subjectId: "meeting-summary",
    };
    const forged: Array<[string, Partial<SessionCreateInput>]> = [
      ["no proof", { meetingSummary: undefined }],
      ["a person as creator", { createdBy: { kind: "subject", subjectId: scope.owner } }],
      [
        "another tool",
        { firstPartyMcpTools: ["meeting_read", "meeting_notes_save", "sessions_list"] },
      ],
      ["a missing tool", { firstPartyMcpTools: ["meeting_read"] }],
      ["a sandbox", { sandboxBackend: "docker" }],
      [
        "a resource",
        { resources: [{ kind: "repository", url: "https://example.test/r.git" } as never] },
      ],
      [
        "another server",
        {
          tools: [
            { kind: "mcp", id: "opengeni" },
            { kind: "mcp", id: "github" },
          ],
        },
      ],
      ["another meeting", { metadata: { meetingSummaryRecordingId: theirs.recordingId } }],
      [
        "someone else's meeting",
        {
          meetingSummary: { recordingId: someoneElses, ownerSubjectId: scope.owner },
          metadata: { meetingSummaryRecordingId: someoneElses },
        },
      ],
      [
        "Only me for someone who doesn't own it",
        { meetingSummary: { recordingId: own.recordingId, ownerSubjectId: other.owner } },
      ],
      ["shared for an Only me meeting", { visibility: "workspace_shared" }],
      [
        "the role alone",
        {
          meetingSummary: undefined,
          createdBy: undefined,
          metadata: {},
          visibility: "workspace_shared",
        },
      ],
    ];
    for (const [label, change] of forged) {
      const attempt = {
        ...exact,
        ...change,
        createIdempotencyKey: `meeting-summary:${crypto.randomUUID()}`,
      };
      const outcome = await createSession(client.db, attempt).then(
        () => "created",
        (error: Error) => error.message,
      );
      if (process.env.MEETING_SUMMARY_DEBUG) console.log(label, "=>", outcome.slice(0, 160));
      expect({ label, outcome }).not.toEqual({ label, outcome: "created" });
    }
    expect(await scope.sessionsFor(own.recordingId)).toEqual([]);
    // The exact shape is accepted.
    const accepted = await createSession(client.db, exact);
    expect(await scope.sessionsFor(own.recordingId)).toHaveLength(1);

    // The database refuses the same forgeries on its own: the accepted row,
    // copied under a freshly opened private-create capability, with one change.
    const sharedMeeting = await scope.meeting("workspace");
    async function insertCopy(change: Record<string, unknown>) {
      const id = typeof change.id === "string" ? change.id : crypto.randomUUID();
      const row = {
        id,
        root_session_id: id,
        temporal_workflow_id: `session-${id}`,
        create_idempotency_key: `meeting-summary:${id}`,
        active_turn_id: null,
        execution_context_turn_id: null,
        input_wait_turn_id: null,
        ...change,
      };
      return await shared!.admin
        .begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${scope.accountId}, true),
            set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
            set_config('opengeni.subject_id', ${scope.owner}, true)`;
          const [capability] = await tx<{ capability_id: string }[]>`
            select capability_id::text from open_private_session_create_capability(
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${id}::uuid, ${scope.owner})`;
          await tx`select set_config('opengeni.private_session_create_capability',
            ${capability!.capability_id}, true)`;
          await tx`insert into sessions select (jsonb_populate_record(null::sessions,
              to_jsonb(s) || ${tx.json(row as never)}::jsonb)).*
            from sessions s where s.id = ${accepted.id}::uuid`;
        })
        .then(
          () => "created",
          (error: { code?: string; message: string }) => error.code ?? error.message,
        );
    }
    const metadata = (recordingId: string) => ({
      metadata: { meetingSummaryRecordingId: recordingId },
    });
    for (const [label, change] of [
      [
        "a third tool",
        { first_party_mcp_tools: ["meeting_read", "meeting_notes_save", "sessions_list"] },
      ],
      ["a resource", { resources: [{ kind: "repository", url: "https://example.test/r.git" }] }],
      [
        "another server",
        {
          tools: [
            { kind: "mcp", id: "opengeni" },
            { kind: "mcp", id: "github" },
          ],
        },
      ],
      ["a Skill", { skills: [{ kind: "workspace", id: crypto.randomUUID() }] }],
      ["a sandbox", { sandbox_backend: "docker" }],
      ["another role", { policy_role: "automation" }],
      ["another key", { create_idempotency_key: `scheduler:${crypto.randomUUID()}` }],
      ["someone else's meeting", metadata(someoneElses)],
      ["a shared meeting", metadata(sharedMeeting.recordingId)],
      ["another workspace's meeting", metadata(theirs.recordingId)],
    ] as const) {
      expect({ label, outcome: await insertCopy(change) }).toEqual({ label, outcome: "42501" });
    }
    expect(await insertCopy({})).toBe("created");

    // And it keeps that shape: nothing can widen it once it exists.
    await expect(
      updateSessionToolPolicy(
        { db: client.db, bus: new MemoryEventBus(), settings },
        scope.grant,
        accepted.id,
        { mode: "workspace_default" },
      ),
    ).rejects.toMatchObject({ status: 409 });
    // Nor can it be moved onto a machine, which would give it a shell.
    await expect(
      swapActiveSandbox(
        { db: client.db, settings },
        {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: accepted.id,
          sessionBackend: accepted.sandboxBackend,
          sessionGroupId: accepted.sandboxGroupId,
          subjectId: scope.owner,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    for (const [label, assignment] of [
      ["tools", `first_party_mcp_tools = first_party_mcp_tools || '["sessions_list"]'::jsonb`],
      ["tool policy", `tool_policy = '{"mode":"workspace_default"}'::jsonb`],
      [
        "resources",
        `resources = '[{"kind":"repository","url":"https://example.test/r.git"}]'::jsonb`,
      ],
      ["sandbox", `sandbox_backend = 'docker'`],
      ["machine", `active_sandbox_id = '${crypto.randomUUID()}'::uuid`],
      ["meeting", `metadata = '{"meetingSummaryRecordingId":"${someoneElses}"}'::jsonb`],
      ["role", `policy_role = null`],
    ] as const) {
      const outcome = await shared!.admin
        .unsafe(`update sessions set ${assignment} where id = $1::uuid`, [accepted.id])
        .then(
          () => "updated",
          (error: { code?: string }) => error.code,
        );
      expect({ label, outcome }).toEqual({ label, outcome: "42501" });
    }
    const server = await shared!.admin`
      insert into session_mcp_servers (account_id, workspace_id, session_id, server_id, url)
      values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${accepted.id}::uuid, 'extra', 'https://example.test/mcp')`.then(
      () => "inserted",
      (error: { code?: string; message: string }) => error.code ?? error.message,
    );
    expect(server).toBe("42501");
    // Ordinary progress still writes, such as its title.
    await shared!
      .admin`update sessions set title = 'Roof planning notes' where id = ${accepted.id}::uuid`;
    // A person's copy, as a fork makes, is their ordinary chat and stays editable.
    const forkId = crypto.randomUUID();
    expect(
      await insertCopy({
        id: forkId,
        root_session_id: forkId,
        created_by_kind: "subject",
        created_by_subject_id: scope.owner,
      }),
    ).toBe("created");
    await shared!
      .admin`update sessions set resources = '[{"kind":"repository","url":"https://x.test/r"}]'::jsonb where id = ${forkId}::uuid`;

    // Applying the migration again changes nothing.
    const guard = async () =>
      await shared!.admin<{ definition: string }[]>`
        select pg_get_functiondef('guard_session_authority_write()'::regprocedure) as definition`;
    const before = await guard();
    await shared!.admin.unsafe(
      await Bun.file(
        `${import.meta.dir}/../../../packages/db/drizzle/1005_meeting_summary_private_sessions.sql`,
      ).text(),
    );
    expect(await guard()).toEqual(before);
    expect(await insertCopy({ resources: [{ kind: "repository", url: "https://x.test/r" }] })).toBe(
      "42501",
    );
  }, 180_000);
});

describe("meetingSummaryModel", () => {
  const all = configuredModels(withCodexCatalogProvider(settings));
  const served = codexModels[0]!;
  const other = codexModels[1]!;
  const paid = all.find((model) => model.cost !== "subscription")!;
  const selection = (model: (typeof all)[number], selectable = true) =>
    ({
      model,
      policyAllowed: true,
      credentialReadiness: { status: "ready" },
      availability: { selectable },
    }) as never;
  const chat = (model: (typeof all)[number]) => ({
    model: model.id,
    reasoningEffort: "medium" as const,
    source: "workspace" as const,
  });

  test("takes the chat's default when a subscription serves it", () => {
    expect(
      meetingSummaryModel({
        settings,
        selections: [selection(served), selection(other)],
        chatDefault: chat(served),
      }),
    ).toEqual(chat(served));
  });

  test("a paid chat default gives way to a model a subscription serves", () => {
    const chosen = meetingSummaryModel({
      settings,
      selections: [selection(paid), selection(other)],
      chatDefault: chat(paid),
    });
    expect(chosen).toMatchObject({ model: other.id, source: "subscription" });
  });

  test("never a paid model or one no subscription can serve", () => {
    expect(
      meetingSummaryModel({ settings, selections: [selection(paid)], chatDefault: chat(paid) }),
    ).toBeNull();
    expect(
      meetingSummaryModel({
        settings,
        selections: [selection(paid), selection(served, false)],
        chatDefault: chat(served),
      }),
    ).toBeNull();
  });

  test("under EU-only inference only a model whose route is EU counts", () => {
    const eu = { ...settings, requiredModelGeography: "eu" as const };
    expect(
      meetingSummaryModel({
        settings: eu,
        selections: [selection(served), selection(other)],
        chatDefault: chat(served),
      }),
    ).toBeNull();
    const euResidency = {
      geography: "eu" as const,
      deploymentType: "self_hosted" as const,
      regions: [],
      evidence: {
        source: "operator_declaration" as const,
        reference: "test",
        verifiedAt: "2026-10-27",
      },
    };
    expect(
      meetingSummaryModel({
        settings: eu,
        selections: [selection({ ...served, residency: euResidency })],
        chatDefault: chat(served),
      }),
    ).toEqual(chat(served));
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  createDb,
  createRecording,
  deleteWorkspace,
  ensureManagedAccessForUser,
  getRecording,
  listRecordings,
  nameRecording,
  recordingTitleSourceOutranks,
  updateRecording,
  type DbClient,
} from "../src";

// Meetings name themselves (docs/recordings.md, "Names"): a recording
// remembers where its title came from, and only a better source replaces it.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("recording-title-source");
  if (!shared) return;
  client = createDb(shared.appUrl, { searchPath: shared.schema });
}, 180_000);

afterAll(async () => {
  if (client) {
    for (const workspaceId of workspaceIds) {
      await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
    }
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspace() {
  const userId = `title-owner-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Title owner",
  });
  workspaceIds.push(...access.workspaceGrants.map((grant) => grant.workspaceId));
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  )!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: `user:${userId}`,
  };
}

type Scope = Awaited<ReturnType<typeof workspace>>;

async function meeting(
  scope: Scope,
  naming: { title?: string; titleSource?: "person" | "calendar" | "app"; dictation?: boolean } = {},
) {
  const { recording } = await createRecording(client!.db, {
    ...scope,
    recordingId: crypto.randomUUID(),
    ...(naming.dictation ? { purpose: "dictation" as const } : {}),
    ...(naming.title === undefined ? {} : { title: naming.title }),
    ...(naming.titleSource === undefined ? {} : { titleSource: naming.titleSource }),
    startedAt: new Date("2026-10-30T13:51:00Z"),
    tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
  });
  return recording;
}

async function name(
  scope: Scope,
  recordingId: string,
  title: string,
  source: "calendar" | "conversation" | "app",
) {
  return await nameRecording(client!.db, { ...scope, recordingId, title, source });
}

describe("recording title sources", () => {
  test("ranks a person over the calendar over the conversation over the app over the default", () => {
    const order = ["default", "app", "conversation", "calendar", "person"] as const;
    for (const [i, weaker] of order.entries()) {
      for (const stronger of order.slice(i + 1)) {
        expect(recordingTitleSourceOutranks(stronger, weaker)).toBe(true);
        expect(recordingTitleSourceOutranks(weaker, stronger)).toBe(false);
      }
      expect(recordingTitleSourceOutranks(weaker, weaker)).toBe(false);
    }
  });

  test("a new recording says where its title came from", async () => {
    if (!client) return;
    const scope = await workspace();
    const untitled = await meeting(scope);
    expect(untitled.title).toBe("Recording 2026-10-30 13:51 UTC");
    expect(untitled.titleSource).toBe("default");
    expect((await meeting(scope, { title: "Board prep" })).titleSource).toBe("person");
    expect((await meeting(scope, { title: "Zoom meeting", titleSource: "app" })).titleSource).toBe(
      "app",
    );
    expect(
      (await meeting(scope, { title: "Quarterly review", titleSource: "calendar" })).titleSource,
    ).toBe("calendar");
    const listed = await listRecordings(client.db, scope);
    expect(listed.recordings.find((item) => item.id === untitled.id)?.titleSource).toBe("default");
  });

  test("the conversation names an unnamed or app-named meeting, once", async () => {
    if (!client) return;
    const scope = await workspace();
    for (const naming of [{}, { title: "Teams meeting", titleSource: "app" as const }]) {
      const recording = await meeting(scope, naming);
      const named = await name(scope, recording.id, "  Hiring plan\n for Q1 ", "conversation");
      expect(named.renamed).toBe(true);
      expect(named.recording.title).toBe("Hiring plan for Q1");
      expect(named.recording.titleSource).toBe("conversation");
      const again = await name(scope, recording.id, "Something else", "conversation");
      expect(again.renamed).toBe(false);
      expect(again.recording.title).toBe("Hiring plan for Q1");
    }
  });

  test("nothing names over a person's or the calendar's title", async () => {
    if (!client) return;
    const scope = await workspace();
    const typed = await meeting(scope, { title: "Board prep" });
    const fromCalendar = await meeting(scope, {
      title: "Quarterly review",
      titleSource: "calendar",
    });
    for (const source of ["conversation", "app", "calendar"] as const) {
      const result = await name(scope, typed.id, "Generated", source);
      expect(result.renamed).toBe(false);
      expect(result.recording.title).toBe("Board prep");
    }
    for (const source of ["conversation", "app"] as const) {
      expect((await name(scope, fromCalendar.id, "Generated", source)).renamed).toBe(false);
    }
    expect((await getRecording(client.db, { ...scope, recordingId: fromCalendar.id })).title).toBe(
      "Quarterly review",
    );
  });

  test("a rename by a person is final", async () => {
    if (!client) return;
    const scope = await workspace();
    const recording = await meeting(scope);
    const renamed = await updateRecording(client.db, {
      ...scope,
      recordingId: recording.id,
      title: "Design review",
    });
    expect(renamed.titleSource).toBe("person");
    const result = await name(scope, recording.id, "Generated", "calendar");
    expect(result.renamed).toBe(false);
    expect(result.recording.title).toBe("Design review");
  });

  test("a blank name or a dictation is left alone", async () => {
    if (!client) return;
    const scope = await workspace();
    const recording = await meeting(scope);
    expect((await name(scope, recording.id, "   ", "conversation")).renamed).toBe(false);
    const dictation = await meeting(scope, { dictation: true });
    expect((await name(scope, dictation.id, "Named", "conversation")).renamed).toBe(false);
  });

  test("a rename that doesn't say where it came from, as a previous release's, is a person's", async () => {
    if (!client) return;
    const scope = await workspace();
    const recording = await meeting(scope);
    await shared!.admin`update recordings set title = 'Board prep' where id = ${recording.id}`;
    expect(await getRecording(client.db, { ...scope, recordingId: recording.id })).toMatchObject({
      title: "Board prep",
      titleSource: "person",
    });
    expect((await name(scope, recording.id, "Generated", "conversation")).renamed).toBe(false);
    // A change that leaves the title alone leaves its source alone.
    const unnamed = await meeting(scope);
    await shared!
      .admin`update recordings set title = title, metadata = '{"x":1}' where id = ${unnamed.id}`;
    expect((await getRecording(client.db, { ...scope, recordingId: unnamed.id })).titleSource).toBe(
      "default",
    );
  });

  test("the column accepts only known sources", async () => {
    if (!client) return;
    const scope = await workspace();
    const recording = await meeting(scope);
    await expect(
      shared!.admin`update recordings set title_source = 'robot' where id = ${recording.id}`,
    ).rejects.toThrow(/recordings_title_source_chk/u);
  });
});

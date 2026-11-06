import { beforeEach, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

type Shown = {
  kind: "plain" | "success" | "error" | "warning";
  title: string;
  options?:
    | {
        toasterId?: string;
        duration?: number;
        description?: string;
        action?: { label: string; onClick: () => void };
      }
    | undefined;
};
// Every notice shown, with the options it was shown with.
const shown: Shown[] = [];
mock.module("sonner", () => ({
  toast: Object.assign(
    (title: string, options: Shown["options"]) => {
      shown.push({ kind: "plain", title, options });
      return shown.length;
    },
    {
      success: (title: string, options: Shown["options"]) => {
        shown.push({ kind: "success", title, options });
        return shown.length;
      },
      error: (title: string, options: Shown["options"]) => {
        shown.push({ kind: "error", title, options });
        return shown.length;
      },
      warning: (title: string, options: Shown["options"]) => {
        shown.push({ kind: "warning", title, options });
        return shown.length;
      },
      dismiss: () => {},
    },
  ),
}));

const { ARCHIVE_UNDO_MS, archiveActionLabel, quotedChatName, requestSessionArchive } =
  await import("./archive-session");

const requests: Array<{ sessionId: string; body: unknown }> = [];
const retention: Array<{ sessionId: string; keepLive: boolean }> = [];
// Archive answers queued by a test; an empty queue archives.
const archiveAnswers: Array<Error> = [];
const retentionFailures = new Set<string>();
// False once the person has moved to another workspace.
let ownsWorkspace = true;
function appContext(permissions: string[] = ["sessions:control"]) {
  return {
    accessContext: {
      workspaceGrants: [{ workspaceId: "ws", permissions, permissionMode: "explicit" }],
    },
    captureWorkspaceInvocation: () => 1,
    ownsWorkspaceInvocation: () => ownsWorkspace,
    client: {
      updateSessionArchive: async (_workspaceId: string, sessionId: string, body: unknown) => {
        requests.push({ sessionId, body });
        const refusal = archiveAnswers.shift();
        if (refusal) throw refusal;
        return {
          id: sessionId,
          workspaceId: "ws",
          archived: (body as { archived: boolean }).archived,
        };
      },
      updateSessionRetention: async (
        _workspaceId: string,
        sessionId: string,
        body: { keepLive: boolean },
      ) => {
        if (retentionFailures.has(sessionId)) {
          throw new OpenGeniApiError(403, JSON.stringify({ message: "missing permission" }), {
            mutation: true,
            correlationId: "req-retention",
          });
        }
        retention.push({ sessionId, keepLive: body.keepLive });
        return {
          id: sessionId,
          workspaceId: "ws",
          retention: { keepLive: body.keepLive },
        };
      },
    },
  } as unknown as Parameters<typeof requestSessionArchive>[0];
}

const REFERENCE = "163bc913-264d-4d38-a0b5-2e4e955eecdb";
const KEPT_ACTIVE_SENTENCE =
  "This chat can't be archived. \"Keep this chat active\" is on. Turn it off in the chat's Agent tab first.";
function blocked(
  blockers: Array<{ kind: string; sessionId: string }>,
  message = KEPT_ACTIVE_SENTENCE,
) {
  return new OpenGeniApiError(
    409,
    JSON.stringify({ code: "session_archive_blocked", message, blockers }),
    { mutation: true, correlationId: REFERENCE },
  );
}
const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

beforeEach(() => {
  shown.length = 0;
  requests.length = 0;
  retention.length = 0;
  archiveAnswers.length = 0;
  retentionFailures.clear();
  ownsWorkspace = true;
});

/**
 * A caller like the app's: its rerun archives again straight away. Each
 * rerun's outcome (the updated chat, or what it threw) lands in `runs`.
 */
let workspaces = 0;
function caller(
  // A fresh workspace each time: what an earlier test's archive remembers
  // stays with that test.
  chat = { id: "chat", workspaceId: `ws-${++workspaces}` },
) {
  const reruns: boolean[] = [];
  const runs: Array<Promise<unknown>> = [];
  const archive = (archived: boolean): Promise<unknown> =>
    requestSessionArchive(appContext(), chat, archived, "Plan", (next) => {
      reruns.push(next);
      runs.push(archive(next).catch((error: unknown) => error));
    });
  return { reruns, runs, archive };
}

test("Archive is offered only to people who can control a chat that is not archived yet", () => {
  const chat = { workspaceId: "ws", archived: false };
  expect(archiveActionLabel(appContext(), chat)).toBe("Archive");
  expect(archiveActionLabel(appContext(), { ...chat, archived: true })).toBeNull();
  expect(archiveActionLabel(appContext(["sessions:read"]), chat)).toBeNull();
});

test("archiving shows Undo for a few seconds, says where to restore it, and Undo is the caller's", async () => {
  let undone = 0;
  const updated = await requestSessionArchive(
    appContext(),
    { id: "chat", workspaceId: "ws" },
    true,
    "Quarterly plan",
    () => (undone += 1),
  );
  expect(updated).toMatchObject({ archived: true });
  expect(requests).toEqual([{ sessionId: "chat", body: { archived: true } }]);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe("Archived “Quarterly plan”");
  expect(shown[0]!.options?.duration).toBe(ARCHIVE_UNDO_MS);
  expect(shown[0]!.options?.description).not.toContain("can't be restored");
  expect(shown[0]!.options?.description).toContain("restore it from there");
  expect(shown[0]!.options?.action?.label).toBe("Undo");
  shown[0]!.options!.action!.onClick();
  expect(undone).toBe(1);
});

test("undoing sends archived false and confirms it", async () => {
  await requestSessionArchive(appContext(), { id: "chat", workspaceId: "ws" }, false, "Plan");
  expect(requests).toEqual([{ sessionId: "chat", body: { archived: false } }]);
  expect(shown.map((notice) => [notice.kind, notice.title])).toEqual([
    ["success", "Archive undone."],
  ]);
});

test("restoring a stored chat says its content is coming back", async () => {
  const context = appContext();
  const client = (context as unknown as { client: Record<string, unknown> }).client;
  client.updateSessionArchive = async (_workspaceId: string, sessionId: string, body: unknown) => {
    requests.push({ sessionId, body });
    return {
      id: sessionId,
      workspaceId: "ws",
      archived: true,
      retention: {
        keepLive: false,
        archive: { state: "archived", archivedAt: null, restoring: true },
      },
    };
  };
  await requestSessionArchive(context, { id: "chat", workspaceId: "ws" }, false, "Plan");
  expect(requests).toEqual([{ sessionId: "chat", body: { archived: false } }]);
  expect(shown.map((notice) => [notice.kind, notice.title])).toEqual([
    ["success", "Restoring “Plan”"],
  ]);
  expect(shown[0]!.options?.description).toContain("coming back from long-term storage");
});

test("sub-chats in use are counted and named, and only Archive all archives them", async () => {
  const { reruns, runs, archive } = caller();
  archiveAnswers.push(
    blocked(
      [
        {
          kind: "active_sub_chat",
          sessionId: "owner",
          title: "Owner",
          reason: "messaged",
        } as never,
        {
          kind: "active_sub_chat",
          sessionId: "worker",
          title: "Worker",
          reason: "running",
        } as never,
        { kind: "active_sub_chat", sessionId: "goal", title: "", reason: "goal" } as never,
        { kind: "active_sub_chat", sessionId: "wait", title: "Waiter", reason: "waiting" } as never,
      ],
      "This chat can't be archived. 4 sub-chats are still in use.",
    ),
  );
  expect(await archive(true)).toBeNull();
  expect(requests).toHaveLength(1);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.kind).toBe("warning");
  expect(shown[0]!.title).toBe("4 sub-chats are still in use.");
  expect(shown[0]!.options?.description).toBe(
    "“Owner” (in use), “Worker” (running), An untitled chat (working on a goal) and 1 more. Archiving “Plan” stops them too.",
  );
  // It stays until the person decides.
  expect(shown[0]!.options?.duration).toBe(Number.POSITIVE_INFINITY);
  expect(shown[0]!.options?.action?.label).toBe("Archive all");

  shown[0]!.options!.action!.onClick();
  shown[0]!.options!.action!.onClick();
  await Promise.all(runs);
  expect(reruns).toEqual([true]);
  expect(requests.map((request) => request.body)).toEqual([
    { archived: true },
    { archived: true, confirmActiveSubChats: ["owner", "worker", "goal", "wait"] },
  ]);
  expect(shown.at(-1)!.title).toBe("Archived “Plan”");

  // A later Archive of the same chat confirms nothing on its own.
  await archive(true);
  expect(requests.at(-1)!.body).toEqual({ archived: true });
});

test("a long chat name is shortened without breaking a character", () => {
  const title = `${"a".repeat(58)}😀 and more`;
  expect(quotedChatName(title)).toBe(`“${"a".repeat(58)}😀…”`);
});

test("Keep this chat active offers one action: turn it off and archive, with Undo restoring it", async () => {
  const { reruns, runs, archive } = caller();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  expect(await archive(true)).toBeNull();
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe("Couldn't archive the chat.");
  expect(shown[0]!.options?.description).toBe("“Keep this chat active” is on.");
  expect(shown[0]!.options?.action?.label).toBe("Turn off and archive");
  // No status code or request reference anywhere.
  expect(JSON.stringify(shown)).not.toMatch(/409|Reference|163bc913/u);

  shown[0]!.options!.action!.onClick();
  await flush();
  expect(retention).toEqual([{ sessionId: "chat", keepLive: false }]);
  expect(reruns).toEqual([true]);

  // The caller's own archive runs again and succeeds, with the usual Undo.
  expect(await runs[0]).toMatchObject({ archived: true });
  expect(shown.at(-1)!.title).toBe("Archived “Plan”");
  shown.at(-1)!.options!.action!.onClick();
  expect(reruns).toEqual([true, false]);
  // Undo returns the chat as it was, the setting included.
  await runs[1];
  await flush();
  expect(retention).toEqual([
    { sessionId: "chat", keepLive: false },
    { sessionId: "chat", keepLive: true },
  ]);
  expect(shown.at(-1)!.title).toBe("Archive undone.");
});

test("a sub-chat kept active is named, and a failed archive turns the setting back on", async () => {
  const { runs, archive } = caller();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "sub-chat" }]));
  await archive(true);
  expect(shown[0]!.options?.description).toBe("A chat it started has “Keep this chat active” on.");
  const failure = new OpenGeniApiError(500, JSON.stringify({ message: "boom" }), {
    mutation: true,
  });
  archiveAnswers.push(failure);
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(await runs[0]).toBe(failure);
  await flush();
  expect(retention).toEqual([
    { sessionId: "sub-chat", keepLive: false },
    { sessionId: "sub-chat", keepLive: true },
  ]);
});

test("a chat still kept active after turning it off gets the plain sentence, not a second offer", async () => {
  const { runs, archive } = caller();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive(true);
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(((await runs[0]) as Error).message).toBe(KEPT_ACTIVE_SENTENCE);
  await flush();
  expect(shown).toHaveLength(1);
  expect(retention).toEqual([
    { sessionId: "chat", keepLive: false },
    { sessionId: "chat", keepLive: true },
  ]);
});

test("other refusals are the server's plain sentence, and a failed turn-off archives nothing", async () => {
  const { reruns, archive: archiveAs } = caller();
  const archive = () => archiveAs(true);
  const sentence =
    "This chat can't be archived. A scheduled task runs in this chat. Delete the task or let it start new chats first. Imported chats are already stored read-only.";
  const mixed = blocked(
    [
      { kind: "scheduled_task", sessionId: "chat" },
      { kind: "imported", sessionId: "chat" },
    ],
    sentence,
  );
  archiveAnswers.push(mixed);
  const refusal = await archive().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toBe(sentence);
  expect((refusal as Error).cause).toBe(mixed);
  expect(shown).toEqual([]);

  retentionFailures.add("chat");
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive();
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(reruns).toEqual([]);
  expect(shown.at(-1)).toMatchObject({
    kind: "error",
    title: "Couldn't turn off “Keep this chat active”.",
    options: {
      description: "You don't have permission to do this. Ask an admin for access.",
    },
  });
});

test("a mix of Keep this chat active and another reason gets the plain sentence, no offer", async () => {
  const { archive } = caller();
  const sentence =
    'This chat can\'t be archived. "Keep this chat active" is on, and a scheduled task runs in this chat.';
  archiveAnswers.push(
    blocked(
      [
        { kind: "keep_live", sessionId: "chat" },
        { kind: "scheduled_task", sessionId: "chat" },
      ],
      sentence,
    ),
  );
  const refusal = await archive(true).catch((error: unknown) => error);
  expect((refusal as Error).message).toBe(sentence);
  expect(shown).toEqual([]);
  expect(retention).toEqual([]);
});

test("Turn off and archive runs once, however quickly it is clicked again", async () => {
  const { reruns, runs, archive } = caller();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive(true);
  shown[0]!.options!.action!.onClick();
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(retention).toEqual([{ sessionId: "chat", keepLive: false }]);
  expect(reruns).toEqual([true]);
  expect(await runs[0]).toMatchObject({ archived: true });
});

test("when the archive doesn't start again, the setting goes back on", async () => {
  // The caller's rerun does nothing: an archive already in flight, say.
  const reruns: boolean[] = [];
  const chat = { id: "chat", workspaceId: `ws-${++workspaces}` };
  const archive = () =>
    requestSessionArchive(appContext(), chat, true, "Plan", (next) => reruns.push(next));
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive();
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(reruns).toEqual([true]);
  expect(retention).toEqual([
    { sessionId: "chat", keepLive: false },
    { sessionId: "chat", keepLive: true },
  ]);
  // Nothing remembered: a later refusal offers the action again.
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive();
  expect(shown.at(-1)!.options?.action?.label).toBe("Turn off and archive");
});

test("after moving to another workspace, Turn off and archive changes nothing", async () => {
  const { reruns, archive } = caller();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive(true);
  ownsWorkspace = false;
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(retention).toEqual([]);
  expect(reruns).toEqual([]);
});

test("Undo says so when Keep this chat active can't be turned back on", async () => {
  const { runs, archive } = caller();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive(true);
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(await runs[0]).toMatchObject({ archived: true });
  retentionFailures.add("chat");
  shown.at(-1)!.options!.action!.onClick();
  // The chat comes back without waiting for the setting.
  expect(await runs[1]).toMatchObject({ archived: false });
  await flush();
  expect(
    shown.slice(1).map((notice) => [notice.kind, notice.title, notice.options?.description]),
  ).toEqual([
    ["plain", "Archived “Plan”", expect.any(String)],
    [
      "warning",
      "Archive undone, but “Keep this chat active” is still off.",
      "Turn it on in the chat's Agent tab.",
    ],
  ]);
});

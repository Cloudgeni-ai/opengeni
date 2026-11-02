import { beforeEach, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

type Shown = {
  kind: "plain" | "success" | "error";
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
function appContext(permissions: string[] = ["sessions:control"]) {
  return {
    accessContext: {
      workspaceGrants: [{ workspaceId: "ws", permissions, permissionMode: "explicit" }],
    },
    captureWorkspaceInvocation: () => 1,
    ownsWorkspaceInvocation: () => true,
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
});

test("Archive is offered only to people who can control a chat that is not archived yet", () => {
  const chat = { workspaceId: "ws", archived: false };
  expect(archiveActionLabel(appContext(), chat)).toBe("Archive");
  expect(archiveActionLabel(appContext(), { ...chat, archived: true })).toBeNull();
  expect(archiveActionLabel(appContext(["sessions:read"]), chat)).toBeNull();
});

test("archiving shows Undo for a few seconds, says it becomes final, and Undo is the caller's", async () => {
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
  expect(shown[0]!.options?.description).toContain("can't be restored");
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

test("a long chat name is shortened without breaking a character", () => {
  const title = `${"a".repeat(58)}😀 and more`;
  expect(quotedChatName(title)).toBe(`“${"a".repeat(58)}😀…”`);
});

test("Keep this chat active offers one action: turn it off and archive, with Undo restoring it", async () => {
  const reruns: boolean[] = [];
  const chat = { id: "chat", workspaceId: "ws" };
  const archive = (archived: boolean) =>
    requestSessionArchive(appContext(), chat, archived, "Plan", (next) => reruns.push(next));
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
  expect(await archive(true)).toMatchObject({ archived: true });
  expect(shown.at(-1)!.title).toBe("Archived “Plan”");
  shown.at(-1)!.options!.action!.onClick();
  expect(reruns).toEqual([true, false]);
  // Undo returns the chat as it was, the setting included.
  await archive(false);
  await flush();
  expect(retention).toEqual([
    { sessionId: "chat", keepLive: false },
    { sessionId: "chat", keepLive: true },
  ]);
  expect(shown.at(-1)!.title).toBe("Archive undone.");
});

test("a sub-chat kept active is named, and a failed archive turns the setting back on", async () => {
  const reruns: boolean[] = [];
  const chat = { id: "chat", workspaceId: "ws" };
  const archive = (archived: boolean) =>
    requestSessionArchive(appContext(), chat, archived, "Plan", (next) => reruns.push(next));
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "sub-chat" }]));
  await archive(true);
  expect(shown[0]!.options?.description).toBe("A chat it started has “Keep this chat active” on.");
  shown[0]!.options!.action!.onClick();
  await flush();
  expect(retention).toEqual([{ sessionId: "sub-chat", keepLive: false }]);

  const failure = new OpenGeniApiError(500, JSON.stringify({ message: "boom" }), {
    mutation: true,
  });
  archiveAnswers.push(failure);
  await expect(archive(true)).rejects.toBe(failure);
  await flush();
  expect(retention).toEqual([
    { sessionId: "sub-chat", keepLive: false },
    { sessionId: "sub-chat", keepLive: true },
  ]);
});

test("a chat still kept active after turning it off gets the plain sentence, not a second offer", async () => {
  const reruns: boolean[] = [];
  const chat = { id: "chat", workspaceId: "ws" };
  const archive = () =>
    requestSessionArchive(appContext(), chat, true, "Plan", (next) => reruns.push(next));
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  await archive();
  shown[0]!.options!.action!.onClick();
  await flush();
  archiveAnswers.push(blocked([{ kind: "keep_live", sessionId: "chat" }]));
  const refusal = await archive().catch((error: unknown) => error);
  expect((refusal as Error).message).toBe(KEPT_ACTIVE_SENTENCE);
  await flush();
  expect(shown).toHaveLength(1);
  expect(retention).toEqual([
    { sessionId: "chat", keepLive: false },
    { sessionId: "chat", keepLive: true },
  ]);
});

test("other refusals are the server's plain sentence, and a failed turn-off archives nothing", async () => {
  const reruns: boolean[] = [];
  const chat = { id: "chat", workspaceId: "ws" };
  const archive = () =>
    requestSessionArchive(appContext(), chat, true, "Plan", (next) => reruns.push(next));
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

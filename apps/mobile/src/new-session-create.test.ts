import { expect, test } from "bun:test";
import { OpenGeniApiError, type CreateSessionRequest } from "@opengeni/sdk";
import { createSessionFromDraft } from "./new-session-create";

function draftConflict() {
  return new OpenGeniApiError(409, "{}", { code: "NEW_SESSION_DRAFT_CONFLICT" });
}

function recordingClient(refuse: (request: CreateSessionRequest) => unknown) {
  const requests: CreateSessionRequest[] = [];
  return {
    requests,
    async createSession(_workspaceId: string, request: CreateSessionRequest) {
      requests.push(request);
      const refusal = refuse(request);
      if (refusal) throw refusal;
      return { id: "chat" } as Awaited<ReturnType<typeof createSessionFromDraft>>;
    },
  };
}

test("a Send names the draft it was composed in", async () => {
  const client = recordingClient(() => null);
  await createSessionFromDraft(client, "work", { initialMessage: "hi" }, 3);
  expect(client.requests).toEqual([{ initialMessage: "hi", expectedNewSessionDraftRevision: 3 }]);
});

test("an older server's draft refusal is retried once without the draft", async () => {
  // A server from before Send wins refuses a trimmed or captioned message
  // that differs from the saved draft, every time.
  const client = recordingClient((request) =>
    request.expectedNewSessionDraftRevision === undefined ? null : draftConflict(),
  );
  const created = await createSessionFromDraft(
    client,
    "work",
    { initialMessage: "See the attached files." },
    2,
  );
  expect(created.id).toBe("chat");
  expect(client.requests).toEqual([
    { initialMessage: "See the attached files.", expectedNewSessionDraftRevision: 2 },
    { initialMessage: "See the attached files." },
  ]);
});

test("other failures are not retried", async () => {
  const refusal = new OpenGeniApiError(422, "{}", { code: "VALIDATION_ERROR" });
  const client = recordingClient(() => refusal);
  await expect(createSessionFromDraft(client, "work", { initialMessage: "hi" }, 2)).rejects.toBe(
    refusal,
  );
  expect(client.requests).toHaveLength(1);
});

test("a Send with no saved draft names none", async () => {
  const client = recordingClient(() => null);
  await createSessionFromDraft(client, "work", { initialMessage: "hi" }, null);
  expect(client.requests).toEqual([{ initialMessage: "hi" }]);
});

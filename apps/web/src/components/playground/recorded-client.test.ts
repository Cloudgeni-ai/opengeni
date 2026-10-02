import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_SETTINGS, QUESTIONS, type AgentSettings } from "./acme-script";
import { DEMO_WORKSPACE_ID, createRecordedClient, type RecordedAnswer } from "./recorded-client";

const until = async (check: () => boolean, ms = 8000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("the playground's recorded client", () => {
  test("lists two earlier chats, and a new chat first", async () => {
    const client = createRecordedClient({ settings: () => DEFAULT_AGENT_SETTINGS });
    const before = await client.listSessionPage(DEMO_WORKSPACE_ID, {});
    expect(before.sessions.map((session) => session.title)).toEqual([
      "Delivery address",
      "Pro plan perks",
    ]);
    const id = client.startChat(QUESTIONS.order);
    const after = await client.listSessionPage(DEMO_WORKSPACE_ID, {});
    expect(after.sessions[0]!.id).toBe(id);
    expect(after.sessions[0]!.title).toBe("Order #4417");
    client.dispose();
  });

  test("streams the answer and reports it with the chat's own settings", async () => {
    let settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, tools: true };
    const answers: RecordedAnswer[] = [];
    const client = createRecordedClient({
      settings: () => settings,
      onAnswered: (answer) => answers.push(answer),
    });
    const id = client.startChat(QUESTIONS.order);
    // Changing settings later doesn't change a chat already started.
    settings = DEFAULT_AGENT_SETTINGS;
    expect(client.settingsOf(id)!.tools).toBe(true);
    expect(client.isPlaying(id)).toBe(true);

    const abort = new AbortController();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const event of client.streamEvents(DEMO_WORKSPACE_ID, id, {
        signal: abort.signal,
      })) {
        seen.push(event.type);
        if (event.type === "turn.completed") abort.abort();
      }
    })();
    await until(() => answers.length === 1);
    await reading;
    expect(answers[0]).toMatchObject({ sessionId: id, question: "order" });
    expect(answers[0]!.settings.tools).toBe(true);
    expect(seen[0]).toBe("user.message");
    expect(seen).toContain("agent.toolCall.created");
    expect(client.isPlaying(id)).toBe(false);

    const all = await client.listEvents(DEMO_WORKSPACE_ID, id);
    expect(all.at(-1)!.type).toBe("session.status.changed");
    const tail = await client.listEvents(DEMO_WORKSPACE_ID, id, { after: all.length - 2 });
    expect(tail.map((event) => event.sequence)).toEqual([all.length - 1, all.length]);
    const older = await client.listEvents(DEMO_WORKSPACE_ID, id, { before: 3, limit: 1 });
    expect(older.map((event) => event.sequence)).toEqual([2]);
    client.dispose();
  });

  test("the composer's send plays an answer in the same chat", async () => {
    const answers: RecordedAnswer[] = [];
    const client = createRecordedClient({
      settings: () => DEFAULT_AGENT_SETTINGS,
      onAnswered: (answer) => answers.push(answer),
    });
    const id = client.startChat(QUESTIONS.order);
    await until(() => answers.length === 1);
    const sent = await client.submitComposerDraft(DEMO_WORKSPACE_ID, id, {
      text: "Was I charged twice?",
      clientEventId: "draft-1",
      expectedDraftRevision: 0,
      delivery: "send",
    } as never);
    expect(sent.accepted.type).toBe("user.message");
    expect((sent.accepted as { clientEventId?: string }).clientEventId).toBe("draft-1");
    await until(() => answers.length === 2);
    expect(answers[1]).toMatchObject({ sessionId: id, question: "charged" });
    client.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenGeniClient, type OpenGeniClientOptions } from "../src/client";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

type Sent = { url: string; body: Record<string, unknown> };

function clientWith(
  responses: Array<(() => Response) | null> = [],
  options: Pick<OpenGeniClientOptions, "messageTimeZone"> = {},
): { client: OpenGeniClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test_key",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      const next = responses.shift();
      return next
        ? next()
        : new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    }) as typeof fetch,
    ...options,
  });
  return { client, sent };
}

function rejected(message: string, status = 422): () => Response {
  return () =>
    new Response(
      JSON.stringify({ error: { status, code: "validation_failed", message, retryable: false } }),
      { status, headers: { "content-type": "application/json" } },
    );
}

const submit = {
  text: "hi",
  annotations: [],
  resources: [],
  model: "test-model",
  reasoningEffort: "medium" as const,
  latencyMode: "standard" as const,
  expectedDraftRevision: 1,
  clientEventId: "op-1",
  delivery: "send" as const,
};

const realGlobals = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};
const realTz = process.env.TZ;

function restore(name: keyof typeof realGlobals): void {
  const descriptor = realGlobals[name];
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

function pretendToBe(runtime: "browser" | "react-native"): void {
  if (runtime === "browser") {
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true });
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { product: "ReactNative" },
      configurable: true,
    });
  }
}

beforeEach(() => {
  process.env.TZ = "Europe/Oslo";
});

afterEach(() => {
  restore("window");
  restore("document");
  restore("navigator");
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

describe("messages carry the person's time zone", () => {
  test("a server process never attaches its own zone", async () => {
    const { client, sent } = clientWith();
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "remind me tomorrow at 9");
    await client.createSession(WORKSPACE_ID, { initialMessage: "hello" });
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submit);
    expect(sent.map((request) => request.body.timeZone ?? request.body.payload)).toEqual([
      { text: "remind me tomorrow at 9" },
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("an explicit valid zone is sent from anywhere; an invalid one is dropped", async () => {
    const { client, sent } = clientWith();
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", timeZone: "Asia/Tokyo" });
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", timeZone: "+09:00" });
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", timeZone: "europe/oslo" });
    expect(sent[0]!.body).toEqual({
      type: "user.message",
      payload: { text: "hi", timeZone: "Asia/Tokyo" },
    });
    expect(sent[1]!.body).toEqual({ type: "user.message", payload: { text: "hi" } });
    expect(sent[2]!.body).toEqual({ text: "hi", timeZone: "Europe/Oslo" });
  });

  test("a browser fills in the device zone on every message path", async () => {
    pretendToBe("browser");
    const { client, sent } = clientWith();
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "remind me tomorrow at 9");
    await client.createSession(WORKSPACE_ID, { initialMessage: "hello" });
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submit);
    expect(sent[0]!.body).toEqual({
      type: "user.message",
      payload: { text: "remind me tomorrow at 9", timeZone: "Europe/Oslo" },
    });
    expect(sent[1]!.body).toEqual({ initialMessage: "hello", timeZone: "Europe/Oslo" });
    expect(sent[2]!.body).toEqual({ text: "now", timeZone: "Europe/Oslo" });
    expect(sent[3]!.body).toEqual({ ...submit, timeZone: "Europe/Oslo" });
  });

  test("a person who travels sends their new zone", async () => {
    pretendToBe("browser");
    const { client, sent } = clientWith();
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "first");
    process.env.TZ = "America/New_York";
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "after landing");
    expect(sent.map((request) => (request.body.payload as { timeZone?: string }).timeZone)).toEqual(
      ["Europe/Oslo", "America/New_York"],
    );
  });

  test("an explicit zone wins, and messageTimeZone: false turns the device zone off", async () => {
    pretendToBe("browser");
    const { client, sent } = clientWith([], { messageTimeZone: false });
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "hi");
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", timeZone: "Asia/Tokyo" });
    expect(sent[0]!.body).toEqual({ type: "user.message", payload: { text: "hi" } });
    expect(sent[1]!.body).toEqual({
      type: "user.message",
      payload: { text: "hi", timeZone: "Asia/Tokyo" },
    });
  });

  test("an unusable explicit zone is dropped, not replaced by the device zone", async () => {
    pretendToBe("browser");
    const { client, sent } = clientWith();
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", timeZone: "+09:00" });
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, { text: "now", timeZone: "Mars/Base" });
    await client.createSession(WORKSPACE_ID, { initialMessage: "hello", timeZone: "" });
    expect(sent.map((request) => request.body)).toEqual([
      { type: "user.message", payload: { text: "hi" } },
      { text: "now" },
      { initialMessage: "hello" },
    ]);
  });

  test("a React Native app fills in the device zone", async () => {
    pretendToBe("react-native");
    const { client, sent } = clientWith();
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(sent[0]!.body).toEqual({ text: "now", timeZone: "Europe/Oslo" });
  });

  test("a UTC device or a message-less create sends no zone", async () => {
    pretendToBe("browser");
    const { client, sent } = clientWith();
    await client.createSession(WORKSPACE_ID, { startMode: "realtime", timeZone: "Asia/Tokyo" });
    process.env.TZ = "UTC";
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "hi");
    expect(sent[0]!.body).toEqual({ startMode: "realtime" });
    expect(sent[1]!.body).toEqual({ type: "user.message", payload: { text: "hi" } });
  });

  test("an older server that rejects the field gets the message again without it", async () => {
    pretendToBe("browser");
    const { client, sent } = clientWith([
      rejected("invalid session event"),
      null,
      rejected("invalid steer request"),
      null,
      rejected(
        'The server chooses session configuration; "timeZone" cannot be set from the browser.',
        400,
      ),
    ]);
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", clientEventId: "op-2" });
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    await client.createSession(WORKSPACE_ID, { initialMessage: "hello" });
    expect(sent.map((request) => request.body)).toEqual([
      {
        type: "user.message",
        clientEventId: "op-2",
        payload: { text: "hi", timeZone: "Europe/Oslo" },
      },
      { type: "user.message", clientEventId: "op-2", payload: { text: "hi" } },
      { text: "now", timeZone: "Europe/Oslo" },
      { text: "now" },
      { initialMessage: "hello", timeZone: "Europe/Oslo" },
      { initialMessage: "hello" },
    ]);
  });

  test("an older Site host that refuses the frame field gets the message again without it", async () => {
    pretendToBe("browser");
    const refusedField = (field: string) => () =>
      new Response(
        JSON.stringify({
          error: {
            status: 403,
            code: "forbidden",
            message: "A Site page can send message text only.",
            retryable: false,
            details: { code: "site_frame_field_forbidden", field },
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    const { client, sent } = clientWith([
      refusedField("payload.timeZone"),
      null,
      refusedField("resources"),
    ]);
    await client.sendMessage(WORKSPACE_ID, SESSION_ID, "hi");
    await expect(client.steerMessage(WORKSPACE_ID, SESSION_ID, "now")).rejects.toHaveProperty(
      "status",
      403,
    );
    expect(sent.map((request) => request.body)).toEqual([
      { type: "user.message", payload: { text: "hi", timeZone: "Europe/Oslo" } },
      { type: "user.message", payload: { text: "hi" } },
      { text: "now", timeZone: "Europe/Oslo" },
    ]);
  });

  test("a zone the caller chose is never silently dropped on rejection", async () => {
    const { client, sent } = clientWith([rejected("invalid session event")]);
    await expect(
      client.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", timeZone: "Asia/Tokyo" }),
    ).rejects.toHaveProperty("status", 422);
    expect(sent).toHaveLength(1);
  });
});

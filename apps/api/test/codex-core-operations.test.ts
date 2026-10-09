import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TranscriptionServiceError } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { buildSessionCodexRealtimeBroker, CodexRealtimeBrokerError } from "../src/codex-realtime";
import { createCodexSubscriptionTranscriptionProvider } from "../src/transcription/providers/codex-subscription";

// Transcription and realtime for an organization with a Codex cutover row.
// Every legacy Codex accessor is poisoned: a core or maintenance path that
// reached legacy state fails loudly.

const ACCOUNT = "00000000-0000-4000-8000-0000000000c3";
const WS = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000b2";
const VOICE = "11111111-0000-4000-8000-000000000001";
const VOICELESS = "11111111-0000-4000-8000-000000000002";
const settings = testSettings({ codexSubscriptionEnabled: true });
const db = {} as opengeniDb.Database;
const realOperationFetch = opengeniDb.buildSubscriptionCoreCodexOperationFetch;

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function mock<K extends keyof typeof opengeniDb>(name: K, impl: (...args: never[]) => unknown) {
  const spy = spyOn(opengeniDb, name as never).mockImplementation(impl as never);
  restores.push(() => (spy as { mockRestore(): void }).mockRestore());
  return spy as unknown as { mock: { calls: unknown[][] } };
}

function cutover(disposition: "core" | "maintenance") {
  mock("readCodexCutoverDisposition", async () => disposition);
  for (const legacy of [
    "listCodexAccountStatuses",
    "buildCodexTokenResolver",
    "getCodexCredentialStatus",
    "getSessionCodexState",
  ] as const) {
    mock(legacy, () => {
      throw new Error(`legacy Codex accessor ${legacy} must not run`);
    });
  }
}

function coreLease() {
  const acquired = mock("acquireSubscriptionCoreCodexOperationLease", async () => ({
    kind: "acquired",
    leasedUntil: new Date(Date.now() + 60_000),
  }));
  const released = mock("releaseSubscriptionCoreCodexOperationLease", async () => true);
  mock("renewSubscriptionCoreCodexOperationLease", async () => new Date(Date.now() + 60_000));
  const reserved = mock("reserveSubscriptionCoreCodexOperationRequest", async () => ({
    operationId: crypto.randomUUID(),
  }));
  const settled = mock("settleSubscriptionCoreCodexOperationRequest", async () => undefined);
  mock("buildSubscriptionCoreCodexOperationFetch", (...args) => {
    const [targetDb, scope, ref, connectionId, fetchImpl, options] = args;
    return realOperationFetch(targetDb, scope, ref, connectionId, fetchImpl, {
      ...(options as NonNullable<Parameters<typeof realOperationFetch>[5]>),
      reserve: opengeniDb.reserveSubscriptionCoreCodexOperationRequest,
      settle: opengeniDb.settleSubscriptionCoreCodexOperationRequest,
    });
  });
  mock("buildSubscriptionCoreCodexConnectionTokenResolver", () => ({
    getToken: async () => ({
      accessToken: "core-access",
      chatgptAccountId: "chatgpt-core",
      isFedramp: false,
      credentialVersion: 1,
      planType: "pro",
    }),
    refresh: async () => ({
      accessToken: "core-refreshed",
      chatgptAccountId: "chatgpt-core",
      isFedramp: false,
      credentialVersion: 2,
      planType: "pro",
    }),
  }));
  return { acquired, released, reserved, settled };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const audio = new Uint8Array([1, 2, 3]);
const request = {
  audio,
  mimeType: "audio/wav",
  filename: "a.wav",
  workspaceId: WS,
  accountId: ACCOUNT,
  subjectId: "user:caller",
  requestId: "request-1",
};

describe("Codex transcription on the shared core", () => {
  test("a sessionless operation leases a shared connection with explicit caller context", async () => {
    cutover("core");
    const candidates = mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { acquired, released, reserved, settled } = coreLease();
    const seen: string[] = [];
    const provider = createCodexSubscriptionTranscriptionProvider({
      settings,
      db,
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ text: "hello", language: "en" }), { status: 200 });
      }) as never,
    });
    expect(
      await provider.available({
        workspaceId: WS,
        subjectId: "user:caller",
        accountId: ACCOUNT,
      } as never),
    ).toBe(true);
    expect(await provider.transcribe(request)).toEqual({ text: "hello", languages: ["en"] });
    expect(seen).toEqual(["Bearer core-access"]);
    const scope = {
      kind: "workspace",
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "user:caller",
    };
    expect(candidates.mock.calls[1]![1]).toEqual(scope);
    expect(acquired.mock.calls[0]![1]).toEqual(scope);
    expect(acquired.mock.calls[0]![2]).toMatchObject({
      operationKind: "transcription",
      connectionId: VOICE,
      generation: 1,
    });
    expect(released.mock.calls).toHaveLength(1);
    expect(reserved.mock.calls).toHaveLength(1);
    expect(reserved.mock.calls[0]?.slice(1, 4)).toEqual([
      scope,
      acquired.mock.calls[0]?.[2],
      VOICE,
    ]);
    expect(settled.mock.calls[0]?.[2]).toMatchObject({ outcome: "response_received" });
  });

  test("a selected core operation that fails is never retried through another provider", async () => {
    cutover("core");
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { released, reserved, settled } = coreLease();
    let calls = 0;
    const provider = createCodexSubscriptionTranscriptionProvider({
      settings,
      db,
      fetch: (async () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      }) as never,
    });
    const failure = await provider.transcribe(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranscriptionServiceError);
    expect((failure as TranscriptionServiceError).fallbackSafe).toBe(false);
    // One forced refresh and retry, as on the legacy path; then final.
    expect(calls).toBe(2);
    expect(released.mock.calls).toHaveLength(1);
    expect(reserved.mock.calls.map((call) => call[4])).toEqual([
      { requestId: "transcription:request-1", transportAttempt: 1 },
      { requestId: "transcription:request-1", transportAttempt: 2 },
    ]);
    expect(settled.mock.calls).toHaveLength(2);
  });

  test("disconnect after dispatch preserves the whole transcription body before lease release", async () => {
    cutover("core");
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { released, settled } = coreLease();
    const started = deferred<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const provider = createCodexSubscriptionTranscriptionProvider({
      settings,
      db,
      fetch: (async () => {
        const response = new Response(new ReadableStream<Uint8Array>({ start: (c) => (body = c) }));
        started.resolve();
        return response;
      }) as typeof fetch,
    });
    const result = provider.transcribe(request);
    await started.promise;
    // The persisted source disappears; already-dispatched response is owned.
    mock("renewSubscriptionCoreCodexOperationLease", async () => null);
    mock("reserveSubscriptionCoreCodexOperationRequest", async () => {
      throw new Error("source disconnected");
    });
    body.enqueue(new TextEncoder().encode('{"text":"complete audio",'));
    expect(released.mock.calls).toHaveLength(0);
    expect(settled.mock.calls).toHaveLength(0);
    body.enqueue(new TextEncoder().encode('"language":"en"}'));
    body.close();
    expect(await result).toEqual({ text: "complete audio", languages: ["en"] });
    expect(settled.mock.calls[0]?.[2]).toMatchObject({ outcome: "response_received" });
    expect(released.mock.calls).toHaveLength(1);
  });

  test("a 401 after disconnect cannot reuse its bearer for a retry", async () => {
    cutover("core");
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { released, settled } = coreLease();
    let disconnected = false;
    const admissions = mock("reserveSubscriptionCoreCodexOperationRequest", async () => {
      if (disconnected) throw new Error("source disconnected");
      return { operationId: "first-request" };
    });
    let calls = 0;
    const provider = createCodexSubscriptionTranscriptionProvider({
      settings,
      db,
      fetch: (async () => {
        calls++;
        disconnected = true;
        return new Response("expired", { status: 401 });
      }) as typeof fetch,
    });
    const failure = await provider.transcribe(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranscriptionServiceError);
    expect((failure as TranscriptionServiceError).fallbackSafe).toBe(false);
    expect(calls).toBe(1);
    expect(admissions.mock.calls).toHaveLength(2);
    expect(settled.mock.calls).toHaveLength(1);
    expect(released.mock.calls).toHaveLength(1);
  });

  test("a truncated transcription body is unknown and not replayed", async () => {
    cutover("core");
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { reserved, released, settled } = coreLease();
    let calls = 0;
    const provider = createCodexSubscriptionTranscriptionProvider({
      settings,
      db,
      fetch: (async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("truncated"));
            },
          }),
        );
      }) as typeof fetch,
    });
    const failure = await provider.transcribe(request).catch((error: unknown) => error);
    expect((failure as TranscriptionServiceError).fallbackSafe).toBe(false);
    expect(calls).toBe(1);
    expect(reserved.mock.calls).toHaveLength(1);
    expect(settled.mock.calls[0]?.[2]).toMatchObject({ outcome: "unknown" });
    expect(released.mock.calls).toHaveLength(1);
  });

  test("a disabled cutover row is unavailable and reads no legacy table", async () => {
    cutover("maintenance");
    const provider = createCodexSubscriptionTranscriptionProvider({ settings, db });
    expect(await provider.available({ workspaceId: WS, accountId: ACCOUNT } as never)).toBe(false);
    const failure = await provider.transcribe(request).catch((error: unknown) => error);
    expect((failure as TranscriptionServiceError).fallbackSafe).toBe(false);
  });
});

describe("Codex realtime on the shared core", () => {
  function realtimeFixture() {
    cutover("core");
    mock("readSubscriptionCoreSessionOwner", async () => ({ ownerSubjectId: "user:owner" }));
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    mock("getActiveSessionHistoryItems", async () => []);
    mock("getSessionRealtimeContinuityEntries", async () => []);
    return coreLease();
  }
  const rtcRequest = { sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", version: "v3" as const };

  test("configuration and call creation reserve separately and hold the final SDP body", async () => {
    const { reserved, settled, released } = realtimeFixture();
    const started = deferred<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const broker = buildSessionCodexRealtimeBroker(
      db,
      settings,
      { accountId: ACCOUNT, workspaceId: WS, sessionId: SESSION },
      async (url) => {
        if (String(url).includes("statsig")) return Response.json({});
        const response = new Response(
          new ReadableStream<Uint8Array>({ start: (c) => (body = c) }),
          {
            headers: { location: "/realtime/calls/rtc_fake" },
          },
        );
        started.resolve();
        return response;
      },
    );
    const answer = broker({ request: rtcRequest });
    await started.promise;
    expect(reserved.mock.calls).toHaveLength(2);
    expect(settled.mock.calls).toHaveLength(1);
    expect(released.mock.calls).toHaveLength(0);
    mock("renewSubscriptionCoreCodexOperationLease", async () => null);
    body.enqueue(new TextEncoder().encode(rtcRequest.sdp));
    body.close();
    expect(await answer).toMatchObject({ sdp: rtcRequest.sdp, version: "v3" });
    expect(settled.mock.calls).toHaveLength(2);
    expect(released.mock.calls).toHaveLength(1);
  });

  test("disconnect between config and call fences the second physical request", async () => {
    const { settled, released } = realtimeFixture();
    let disconnected = false;
    const reserved = mock("reserveSubscriptionCoreCodexOperationRequest", async () => {
      if (disconnected) throw new Error("source disconnected");
      return { operationId: "config-request" };
    });
    let calls = 0;
    const broker = buildSessionCodexRealtimeBroker(
      db,
      settings,
      { accountId: ACCOUNT, workspaceId: WS, sessionId: SESSION },
      async () => {
        calls++;
        disconnected = true;
        return Response.json({});
      },
    );
    await expect(broker({ request: rtcRequest })).rejects.toBeInstanceOf(CodexRealtimeBrokerError);
    expect(calls).toBe(1);
    expect(reserved.mock.calls).toHaveLength(2);
    expect(settled.mock.calls).toHaveLength(1);
    expect(released.mock.calls).toHaveLength(1);
  });

  test("places a voice-capable shared connection under the session owner with a realtime lease", async () => {
    cutover("core");
    mock("readSubscriptionCoreSessionOwner", async () => ({ ownerSubjectId: "user:owner" }));
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICELESS, planType: "free", explicit: true },
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { acquired, released } = coreLease();
    // The pre-dispatch fence fails: the call must stop before the provider.
    mock("renewSubscriptionCoreCodexOperationLease", async () => null);
    mock("getActiveSessionHistoryItems", async () => []);
    mock("getSessionRealtimeContinuityEntries", async () => []);
    const broker = buildSessionCodexRealtimeBroker(
      db,
      settings,
      { accountId: ACCOUNT, workspaceId: WS, sessionId: SESSION },
      (async () => {
        throw new Error("provider must not be called");
      }) as never,
    );
    const failure = await broker({ request: { sdp: "v=0", version: "v3" } as never }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CodexRealtimeBrokerError);
    expect((failure as CodexRealtimeBrokerError).reason).toBe("credential_unavailable");
    expect(acquired.mock.calls[0]![1]).toEqual({
      kind: "session",
      accountId: ACCOUNT,
      workspaceId: WS,
      sessionId: SESSION,
      sessionOwnerSubjectId: "user:owner",
    });
    expect(acquired.mock.calls[0]![2]).toMatchObject({
      operationKind: "realtime",
      connectionId: VOICE,
    });
    expect(released.mock.calls).toHaveLength(1);
  });

  test("a disabled cutover row fails closed without legacy reads", async () => {
    cutover("maintenance");
    const broker = buildSessionCodexRealtimeBroker(
      db,
      settings,
      { accountId: ACCOUNT, workspaceId: WS, sessionId: SESSION },
      fetch,
    );
    const failure = await broker({ request: { sdp: "v=0", version: "v3" } as never }).catch(
      (error: unknown) => error,
    );
    expect((failure as CodexRealtimeBrokerError).reason).toBe("subscription_disabled");
  });
});

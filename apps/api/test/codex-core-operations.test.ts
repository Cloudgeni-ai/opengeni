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
  return { acquired, released };
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
    const { acquired, released } = coreLease();
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
  });

  test("a selected core operation that fails is never retried through another provider", async () => {
    cutover("core");
    mock("listSubscriptionCoreCodexOperationCandidates", async () => [
      { connectionId: VOICE, planType: "pro", explicit: false },
    ]);
    const { released } = coreLease();
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

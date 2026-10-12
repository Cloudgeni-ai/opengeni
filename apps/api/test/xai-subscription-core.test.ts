/**
 * SuperGrok consumers outside chat by the organization's SuperGrok route
 * (design 5.3, X2a): transcription, realtime, the video/transcription
 * availability and the status probe. Without the cutover receipt every
 * consumer keeps its legacy path; after it, only shared connections serve
 * (decision 3), nothing writes the session binding or legacy pin
 * (decision 6), and a maintenance hold fails closed. The core runtime is
 * scripted here; its SQL authority is the db package's real-PostgreSQL suite.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { SUPERGROK_REALTIME_MODEL_ID } from "@opengeni/config";

const settings = testSettings({ supergrokSubscriptionEnabled: true });
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const SHARED = "55555555-5555-4555-8555-555555555555";

let route: "legacy" | "core" | "maintenance";
let calls: string[];
let wakeFails = false;
let candidates: string[];
let probe: { kind: string };
let pool: {
  connections: Array<{
    connectionId: string;
    label: string | null;
    providerAccountId: string | null;
    source: "workspace" | "organization";
    status: string;
  }>;
  primaryConnectionId: string | null;
};
let personal: {
  connections: Array<{
    connectionId: string;
    label: string | null;
    providerAccountId: string | null;
    status: string;
  }>;
  ownPersonalWorkspace: boolean;
};
const PERSONAL = "66666666-6666-4666-8666-666666666666";

const token = (version: number) => ({
  credential: { accessToken: `core-access-${version}` },
  providerAccountId: "xai-user",
  providerState: {},
  planType: null,
  credentialVersion: version,
});

mock.module("@opengeni/db", () => ({
  ...realDb,
  getWorkspace: async () => ({ id: WORKSPACE, accountId: ACCOUNT }),
  getActiveSessionHistoryItems: async () => [],
  getSessionRealtimeContinuityEntries: async () => [],
  readSubscriptionCoreProviderRouteForWorkspace: async (
    _db: unknown,
    input: { provider: string },
  ) => {
    calls.push(`route:${input.provider}`);
    return route;
  },
  readSubscriptionCoreSessionOwner: async () => ({ ownerSubjectId: "user:owner" }),
  deliverSubscriptionCoreProviderWake: async (
    _db: unknown,
    provider: string,
    wake: { reason: string },
  ) => {
    calls.push(`wake:${provider}:${wake.reason}`);
    if (wakeFails) throw new Error("wake unavailable");
  },
  subscriptionCorePersonalConnections: () => ({
    readSubscriptionCorePersonalConnections: async (_db: unknown, scope: { subjectId: string }) => {
      calls.push(`personal-rows:${scope.subjectId}`);
      return personal;
    },
  }),
  subscriptionCoreAdministeredConnections: () => ({
    probeSubscriptionCoreAdministeredConnectionUsage: async (
      _db: unknown,
      _settings: unknown,
      scope: { kind: string; subjectId: string },
      connectionId: string,
    ) => {
      calls.push(`usage:${scope.kind}:${scope.subjectId}:${connectionId}`);
      return probe;
    },
  }),
  workspaceXaiSubscriptionActive: async () => {
    calls.push("legacy:active");
    return true;
  },
  getXaiSessionAccountPin: async () => {
    calls.push("legacy:pin-read");
    return null;
  },
  setXaiSessionAccountPin: async () => {
    throw new Error("the legacy pin must not be written");
  },
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance: async () => {
    calls.push("legacy:authority");
    throw new Error("legacy path reached");
  },
  subscriptionCoreOperationConnections: () => ({
    listSubscriptionCoreOperationCandidates: async (
      _db: unknown,
      scope: { kind: string; subjectId?: string; sessionOwnerSubjectId?: string | null },
    ) => {
      calls.push(`candidates:${scope.kind}:${scope.subjectId ?? scope.sessionOwnerSubjectId}`);
      return candidates.map((connectionId) => ({ connectionId }));
    },
    readSubscriptionCoreWorkspaceConnections: async () => pool,
    probeSubscriptionCoreConnectionLiveModels: async (
      _db: unknown,
      _settings: unknown,
      _scope: unknown,
      connectionId: string,
    ) => {
      calls.push(`live-models:${connectionId}`);
      return probe;
    },
    runSubscriptionCoreOperation: async (
      _db: unknown,
      _settings: unknown,
      scope: { kind: string },
      input: { candidates: string[]; operationKind: string },
      run: (operation: unknown) => Promise<unknown>,
    ) => {
      calls.push(`lease:${input.operationKind}:${scope.kind}:${input.candidates.join(",")}`);
      if (input.candidates.length === 0) return { kind: "unavailable" };
      let version = 1;
      return {
        kind: "ran",
        value: await run({
          connectionId: input.candidates[0],
          resolver: {
            getToken: async () => token(version),
            refresh: async () => {
              calls.push("refresh:core");
              version += 1;
              return token(version);
            },
          },
          fetch: async (url: string, init?: RequestInit) => {
            calls.push(`fetch:${new Headers(init?.headers).get("authorization")}`);
            return await upstream(url, init);
          },
          fence: async () => true,
        }),
      };
    },
  }),
}));

let upstream: (url: string, init?: RequestInit) => Promise<Response>;

const { createXaiSubscriptionTranscriptionProvider } =
  await import("../src/transcription/providers/xai-subscription");
const { createXaiRealtimeConnectionSecret, XaiRealtimeBrokerError } =
  await import("../src/xai-realtime");
const { readXaiCoreStatus, workspaceXaiOperationAvailable } =
  await import("../src/xai-subscription-core");

beforeEach(() => {
  route = "core";
  calls = [];
  candidates = [SHARED];
  probe = { kind: "read" };
  pool = {
    connections: [
      {
        connectionId: SHARED,
        label: "Team",
        providerAccountId: "xai-user",
        source: "organization",
        status: "active",
      },
    ],
    primaryConnectionId: SHARED,
  };
  personal = { connections: [], ownPersonalWorkspace: false };
  upstream = async () => Response.json({ text: "hello", language: "en" });
});

const transcribe = () =>
  createXaiSubscriptionTranscriptionProvider({ settings, db: {} as never }).transcribe({
    audio: new Uint8Array([1, 2, 3]),
    mimeType: "audio/webm",
    filename: "clip.webm",
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    subjectId: "user:caller",
    requestId: "request-1",
  } as never);

describe("SuperGrok transcription by route", () => {
  test("core: a sessionless transcription lease on a shared candidate of the caller's workspace", async () => {
    expect(await transcribe()).toEqual({ text: "hello", languages: ["en"] });
    expect(calls).toEqual([
      "route:xai",
      "candidates:workspace:user:caller",
      `lease:transcription:workspace:${SHARED}`,
      "fetch:Bearer core-access-1",
    ]);
  });

  test("core: a refused bearer refreshes once through the core seam and retries", async () => {
    let first = true;
    upstream = async () => {
      if (first) {
        first = false;
        return new Response("{}", { status: 401 });
      }
      return Response.json({ text: "again" });
    };
    expect(await transcribe()).toEqual({ text: "again", languages: [] });
    expect(calls.slice(-3)).toEqual([
      "fetch:Bearer core-access-1",
      "refresh:core",
      "fetch:Bearer core-access-2",
    ]);
  });

  test("core without a shared candidate and maintenance are final, never a fallback", async () => {
    candidates = [];
    await expect(transcribe()).rejects.toMatchObject({ code: "unavailable", fallbackSafe: false });
    route = "maintenance";
    calls = [];
    await expect(transcribe()).rejects.toMatchObject({ code: "unavailable", fallbackSafe: false });
    expect(calls).toEqual(["route:xai"]);
  });

  test("availability: legacy keeps its check, core needs a shared candidate, maintenance is off", async () => {
    const input = { accountId: ACCOUNT, workspaceId: WORKSPACE, subjectId: "user:caller" };
    route = "legacy";
    expect(await workspaceXaiOperationAvailable({} as never, settings, input)).toBe(true);
    expect(calls).toEqual(["route:xai", "legacy:active"]);
    route = "core";
    candidates = [];
    expect(await workspaceXaiOperationAvailable({} as never, settings, input)).toBe(false);
    candidates = [SHARED];
    expect(await workspaceXaiOperationAvailable({} as never, settings, input)).toBe(true);
    route = "maintenance";
    expect(await workspaceXaiOperationAvailable({} as never, settings, input)).toBe(false);
  });
});

describe("SuperGrok realtime by route", () => {
  const create = () =>
    createXaiRealtimeConnectionSecret({
      db: {} as never,
      settings,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      subjectId: "user:caller",
      sessionId: SESSION,
      model: SUPERGROK_REALTIME_MODEL_ID,
    } as never);

  test("maintenance fails closed before any credential read", async () => {
    route = "maintenance";
    await expect(create()).rejects.toBeInstanceOf(XaiRealtimeBrokerError);
    expect(calls.filter((call) => !call.startsWith("route:"))).toEqual([]);
  });

  test("core: the session owner's shared candidates under a realtime lease; no pin or binding", async () => {
    upstream = async () => Response.json({ value: "secret", expires_at: 1 });
    const secret = await create().catch((error: unknown) => error);
    expect(secret).toMatchObject({ token: "secret" });
    expect(calls).toContain("candidates:session:user:owner");
    expect(calls).toContain(`lease:realtime:session:${SHARED}`);
    expect(calls.some((call) => call.startsWith("legacy:"))).toBe(false);
  });

  test("core with SuperGrok subscriptions disabled for the deployment reads no credential", async () => {
    calls.length = 0;
    await expect(
      createXaiRealtimeConnectionSecret({
        db: {} as never,
        settings: testSettings({ supergrokSubscriptionEnabled: false }),
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: "user:caller",
        sessionId: SESSION,
        model: SUPERGROK_REALTIME_MODEL_ID,
      } as never),
    ).rejects.toBeInstanceOf(XaiRealtimeBrokerError);
    expect(calls.filter((call) => !call.startsWith("route:"))).toEqual([]);
  });
});

describe("SuperGrok status by route", () => {
  const read = () =>
    readXaiCoreStatus(
      { db: {} as never, settings },
      {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: "user:caller",
        models: async () => ["model"],
      },
    );

  test("legacy returns null so the route keeps the legacy status", async () => {
    route = "legacy";
    expect(await read()).toBeNull();
  });

  test("core validates the effective primary with one live model read", async () => {
    expect(await read()).toEqual({
      connected: true,
      valid: true,
      accountCount: 1,
      models: ["model"],
      activeAccount: { id: SHARED, label: "Team", subject: "xai-user", scope: "organization" },
    });
    expect(calls).toEqual(["route:xai", "personal-rows:user:caller", `live-models:${SHARED}`]);
    probe = { kind: "relogin" };
    expect(await read()).toMatchObject({ connected: true, valid: false, models: [] });
  });

  test("core without an effective primary, and maintenance, report nothing usable", async () => {
    pool = { ...pool, primaryConnectionId: null };
    expect(await read()).toEqual({ connected: true, valid: false, accountCount: 1 });
    route = "maintenance";
    expect(await read()).toEqual({ connected: false, valid: false, accountCount: 0 });
  });

  test("the viewer's own personal account counts; it is effective only in their Personal workspace without a shared primary", async () => {
    const own = {
      connectionId: PERSONAL,
      label: "Mine",
      providerAccountId: "xai-me",
      status: "active",
    };
    // A shared primary stays the effective account.
    personal = { connections: [own], ownPersonalWorkspace: true };
    expect(await read()).toMatchObject({
      connected: true,
      valid: true,
      accountCount: 2,
      activeAccount: { id: SHARED, scope: "organization" },
    });
    // Without one, the owner's personal account, validated as its owner.
    pool = { connections: [], primaryConnectionId: null };
    calls = [];
    expect(await read()).toEqual({
      connected: true,
      valid: true,
      accountCount: 1,
      models: ["model"],
      activeAccount: { id: PERSONAL, label: "Mine", subject: "xai-me", scope: "user" },
    });
    expect(calls).toEqual([
      "route:xai",
      "personal-rows:user:caller",
      `usage:personal_owner:user:caller:${PERSONAL}`,
    ]);
    // A live reading that ends a stored exhaustion wakes the organization's
    // SuperGrok core waiters; a failed wake never fails the status.
    probe = { kind: "read", recovered: true } as typeof probe;
    calls = [];
    expect(await read()).toMatchObject({ connected: true, valid: true });
    expect(calls.at(-1)).toBe("wake:xai:usage_recovered");
    wakeFails = true;
    expect(await read()).toMatchObject({ connected: true, valid: true });
    wakeFails = false;
    probe = { kind: "read" };
    // A paused personal account, or another workspace: connected, not effective.
    personal = { connections: [{ ...own, status: "needs_relogin" }], ownPersonalWorkspace: true };
    expect(await read()).toEqual({ connected: true, valid: false, accountCount: 1 });
    personal = { connections: [own], ownPersonalWorkspace: false };
    calls = [];
    expect(await read()).toEqual({ connected: true, valid: false, accountCount: 1 });
    expect(calls.some((call) => call.startsWith("usage:"))).toBe(false);
  });
});

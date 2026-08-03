import { describe, expect, test } from "bun:test";
import {
  createSessionRealtimeController,
  hasStoredSessionRealtimeOwnerProof,
  sessionRealtimeOwnerStorageKey,
  sessionRealtimeOwnerStorageNamespace,
  sessionRealtimeTransportKind,
  type SessionRealtimeClientLike,
  type SessionRealtimeModel,
} from "../src/realtime";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const MODELS: readonly SessionRealtimeModel[] = [
  "gpt-live-1-boulder-alpha",
  "opengeni-gateway/openai/gpt-realtime-2.1",
  "opengeni-gateway/openai/gpt-realtime-mini",
  "opengeni-gateway/xai/grok-voice-think-fast-2.0",
  "workspace-gateway/openai/gpt-realtime-2.1",
  "workspace-gateway/openai/gpt-realtime-mini",
  "workspace-gateway/xai/grok-voice-think-fast-2.0",
];

function storageFixture() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("@opengeni/sdk/realtime", () => {
  test("selects the exact existing Codex Live or Gateway transport for every public model", () => {
    for (const model of MODELS) {
      const expected = model === "gpt-live-1-boulder-alpha" ? "codex" : "gateway";
      expect(sessionRealtimeTransportKind(model)).toBe(expected);
      expect(sessionRealtimeOwnerStorageNamespace(model)).toBe(`${expected}-realtime-owner`);
      expect(sessionRealtimeOwnerStorageKey(WORKSPACE_ID, SESSION_ID, model)).toBe(
        `opengeni:${expected}-realtime-owner:${WORKSPACE_ID}:${SESSION_ID}`,
      );
    }
  });

  test("projects canonical owner proof through the provider-neutral facade", () => {
    const storage = storageFixture();
    const model = "workspace-gateway/openai/gpt-realtime-mini" as const;
    const key = sessionRealtimeOwnerStorageKey(WORKSPACE_ID, SESSION_ID, model);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        operationId: "33333333-3333-4333-8333-333333333333",
        browserInstanceId: "44444444-4444-4444-8444-444444444444",
        ownerKey: "opengeni-realtime-owner:55555555-5555-4555-8555-555555555555",
      }),
    );

    expect(
      hasStoredSessionRealtimeOwnerProof({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        model,
        storage,
      }),
    ).toBe(true);

    const controller = createSessionRealtimeController({
      client: {} as SessionRealtimeClientLike,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      model,
      storage,
      setInterval: () => 0,
      clearInterval: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    expect(controller.snapshot().status).toBe("recovering");
    controller.close();
  });

  test("keeps the complete proxy-client contract structural and backend-facing", () => {
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => ({ models: [] }),
      beginSessionRealtime: async () => ({}) as never,
      heartbeatSessionRealtime: async () => ({}) as never,
      negotiateCodexRealtimeWebrtc: async () => ({}) as never,
      negotiateGatewayRealtime: async () => ({}) as never,
      activateCodexRealtimeConnection: async () => ({}) as never,
      syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
      endSessionRealtime: async () => ({}) as never,
    } satisfies SessionRealtimeClientLike;

    expect(Object.keys(client).sort()).toEqual(
      [
        "activateCodexRealtimeConnection",
        "beginSessionRealtime",
        "endSessionRealtime",
        "getWorkspaceRealtimeModelCatalog",
        "heartbeatSessionRealtime",
        "negotiateCodexRealtimeWebrtc",
        "negotiateGatewayRealtime",
        "syncSessionRealtimeLedger",
      ].sort(),
    );
  });
});

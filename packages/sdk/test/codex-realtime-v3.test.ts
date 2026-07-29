import { describe, expect, test } from "bun:test";
import { createCodexRealtimeV3Bridge } from "../src/codex-realtime-v3";
import type {
  SessionRealtimeLedgerEntry,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
} from "../src/types";

const owner = {
  browserInstanceId: "browser-test",
  ownerKey: "owner-key-test-11111111-1111-4111-8111-111111111111",
  expectedVersion: 1,
};

function outbound(): SessionRealtimeLedgerEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    realtimeId: "22222222-2222-4222-8222-222222222222",
    operationId: "33333333-3333-4333-8333-333333333333",
    connectionEpoch: 1,
    sequence: 7,
    direction: "provider_out",
    kind: "delegation_result",
    role: null,
    providerEventId: null,
    delegationItemId: "delegation-1",
    sourceUpdateId: null,
    historyItemId: null,
    text: "completed on the same session",
    payload: {},
    clientAckedAt: null,
    providerAckedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Codex realtime V3 bridge", () => {
  test("durably reports provider startup, emits exact V3 delegation context, and ACKs only sent rows", async () => {
    const sent: string[] = [];
    const events = new EventTarget() as RTCDataChannel;
    Object.defineProperties(events, {
      readyState: { value: "open" },
      send: { value: (value: string) => sent.push(value) },
    });
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge({
      events,
      connectionId: "44444444-4444-4444-8444-444444444444",
      connectionEpoch: 1,
      startupFenceSequence: 7,
      modeVersion: 1,
      owner,
      sync: async (request): Promise<SyncSessionRealtimeLedgerResponse> => {
        requests.push(request);
        return { accepted: [], outbound: requests.length === 1 ? [outbound()] : [] };
      },
      randomUUID: () => "55555555-5555-4555-8555-555555555555",
    });

    await bridge.ingest(
      JSON.stringify({
        type: "session.started",
        event_id: "provider-event-1",
        session: { id: "provider-session-1" },
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      ...owner,
      providerStarted: {
        providerSessionId: "provider-session-1",
        providerEventId: "provider-event-1",
      },
    });
    expect(requests[0]).not.toHaveProperty("providerAckThroughSequence");
    expect(JSON.parse(sent[0]!)).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "completed on the same session" }],
    });
    expect(requests[1]).toMatchObject({ clientAckThroughSequence: 7 });
    expect(bridge.snapshot()).toMatchObject({ providerStarted: true, pendingInbound: 0 });
    bridge.close();
  });

  test("persists only pinned finalized V3 transcript/delegation events and rejects V2", async () => {
    const accepted: SyncSessionRealtimeLedgerRequest[] = [];
    const events = new EventTarget() as RTCDataChannel;
    Object.defineProperties(events, {
      readyState: { value: "open" },
      send: { value: () => undefined },
    });
    const bridge = createCodexRealtimeV3Bridge({
      events,
      connectionId: "44444444-4444-4444-8444-444444444444",
      connectionEpoch: 1,
      startupFenceSequence: 0,
      modeVersion: 1,
      owner,
      sync: async (request) => {
        accepted.push(request);
        return { accepted: [], outbound: [] };
      },
      randomUUID: () => "55555555-5555-4555-8555-555555555555",
    });
    await bridge.ingest(
      JSON.stringify({
        type: "input_transcript.added",
        event_id: "transcript-1",
        item: { id: "item-1", text: "final voice input" },
      }),
    );
    await bridge.ingest(JSON.stringify({ type: "response.function_call_arguments.done" }));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.entries).toEqual([
      expect.objectContaining({
        kind: "user_transcript",
        providerEventId: "transcript-1",
        text: "final voice input",
      }),
    ]);
    expect(bridge.snapshot().lastError).toContain("unsupported_type");
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";
import * as codexWire from "@opengeni/codex/realtime-v3";

import {
  CODEX_REALTIME_V3_PENDING_MAX_BYTES,
  CODEX_REALTIME_V3_PENDING_MAX_ENTRIES,
  createCodexRealtimeV3Bridge,
} from "../src/codex-realtime-v3";
import * as sdkWire from "../src/codex-realtime-v3-wire";
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

function dataChannel(send?: (value: string) => void): RTCDataChannel {
  const events = new EventTarget() as RTCDataChannel;
  Object.defineProperties(events, {
    readyState: { value: "open" },
    send: { value: send ?? (() => undefined) },
    close: { value: () => undefined },
  });
  return events;
}

function outbound(overrides: Partial<SessionRealtimeLedgerEntry> = {}): SessionRealtimeLedgerEntry {
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
    turnId: null,
    text: "completed on the same session",
    payload: {},
    clientAckedAt: null,
    providerAckedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function transcript(index: number, text = `event-${index}`): string {
  return JSON.stringify({
    type: "turn.done",
    event_id: `provider-${index}`,
    turn: { id: `turn-${index}`, role: "user", transcript: text },
  });
}

function uuidSource(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function bridgeOptions(input: {
  events?: RTCDataChannel;
  sync(request: SyncSessionRealtimeLedgerRequest): Promise<SyncSessionRealtimeLedgerResponse>;
  randomUUID?: () => string;
  onFatal?: (fatal: { code: "pending_overflow"; message: string }) => void;
}) {
  return {
    events: input.events ?? dataChannel(),
    connectionId: "44444444-4444-4444-8444-444444444444",
    connectionEpoch: 1,
    startupFenceSequence: 0,
    modeVersion: 1,
    owner,
    sync: input.sync,
    randomUUID: input.randomUUID ?? uuidSource(),
    onFatal: input.onFatal,
  };
}

describe("Codex realtime V3 wire parity", () => {
  test("keeps the SDK-local wire source byte-identical to Codex", async () => {
    const [codexBytes, sdkBytes] = await Promise.all([
      readFile(new URL("../../codex/src/realtime-v3.ts", import.meta.url)),
      readFile(new URL("../src/codex-realtime-v3-wire.ts", import.meta.url)),
    ]);
    expect(sdkBytes.equals(codexBytes)).toBe(true);
  });

  test("keeps every wire bound constant identical", () => {
    expect({
      context: sdkWire.CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
      event: sdkWire.CODEX_REALTIME_V3_MAX_EVENT_BYTES,
      identifier: sdkWire.CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES,
      initialCount: sdkWire.CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
      initialTokens: sdkWire.CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
      text: sdkWire.CODEX_REALTIME_V3_MAX_TEXT_BYTES,
    }).toEqual({
      context: codexWire.CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
      event: codexWire.CODEX_REALTIME_V3_MAX_EVENT_BYTES,
      identifier: codexWire.CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES,
      initialCount: codexWire.CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
      initialTokens: codexWire.CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
      text: codexWire.CODEX_REALTIME_V3_MAX_TEXT_BYTES,
    });
  });

  test("keeps valid, malformed, unsupported, and oversized parser results identical", () => {
    const payloads = [
      transcript(1, "hello"),
      "{",
      JSON.stringify({ type: "response.function_call_arguments.done" }),
      JSON.stringify({
        type: "turn.done",
        turn: {
          id: "turn-1",
          role: "assistant",
          transcript: "🙂".repeat(Math.floor(sdkWire.CODEX_REALTIME_V3_MAX_TEXT_BYTES / 4) + 1),
        },
      }),
      "x".repeat(sdkWire.CODEX_REALTIME_V3_MAX_EVENT_BYTES + 1),
    ];
    expect(payloads.map(sdkWire.parseCodexRealtimeV3Event)).toEqual(
      payloads.map(codexWire.parseCodexRealtimeV3Event),
    );
  });

  test("keeps context chunking and both append encoders identical", () => {
    const text = `${"a".repeat(700)}${"🙂".repeat(200)}`;
    expect(sdkWire.contextAppendChunks(text)).toEqual(codexWire.contextAppendChunks(text));
    expect(
      sdkWire.encodeCodexRealtimeV3DelegationContextAppend({
        delegationItemId: "delegation-1",
        text,
        channel: "speakable",
      }),
    ).toEqual(
      codexWire.encodeCodexRealtimeV3DelegationContextAppend({
        delegationItemId: "delegation-1",
        text,
        channel: "speakable",
      }),
    );
    expect(
      sdkWire.encodeCodexRealtimeV3SessionContextAppend({ text, channel: "commentary" }),
    ).toEqual(codexWire.encodeCodexRealtimeV3SessionContextAppend({ text, channel: "commentary" }));
  });
});

describe("Codex realtime V3 bridge", () => {
  test("persists one finalized transcript per turn and ignores live transcript deltas", async () => {
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
      }),
    );

    await bridge.ingest(
      JSON.stringify({
        type: "input_transcript.added",
        event_id: "delta-1",
        item: { id: "item-1", text: "hel" },
      }),
    );
    await bridge.ingest(transcript(1, "hello"));
    await bridge.ingest(transcript(1, "hello"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.entries).toEqual([
      expect.objectContaining({
        kind: "user_transcript",
        providerEventId: "provider-1",
        text: "hello",
        payload: { turnId: "turn-1" },
      }),
    ]);
    bridge.close();
  });

  test("delegates with the bounded finalized dialogue delta and an exact transcript fence", async () => {
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
      }),
    );
    await bridge.ingest(transcript(1, "Please inspect <this> & report"));
    await bridge.ingest(
      JSON.stringify({
        type: "turn.done",
        event_id: "provider-2",
        turn: { id: "turn-2", role: "assistant", transcript: "I can inspect it." },
      }),
    );
    await bridge.ingest(
      JSON.stringify({
        type: "delegation.created",
        event_id: "delegation-event-1",
        item: {
          id: "delegation-1",
          type: "delegation",
          target: "client",
          content: [{ type: "input_text", text: "Do it <safely>" }],
        },
      }),
    );

    const call = requests.flatMap((request) => request.entries ?? []).at(-1)!;
    expect(call).toMatchObject({
      kind: "delegation_call",
      delegationItemId: "delegation-1",
      payload: {
        inputTranscript: "Do it <safely>",
        transcriptFenceTurnIds: ["turn-1", "turn-2"],
      },
    });
    expect(call.text).toContain("<input>Do it &lt;safely&gt;</input>");
    expect(call.text).toContain("user: Please inspect &lt;this&gt; &amp; report");
    expect(call.text).toContain("assistant: I can inspect it.");
    expect(call.text).not.toContain("user: Do it &lt;safely&gt;");
    expect(call.text?.split("Do it &lt;safely&gt;")).toHaveLength(2);
    bridge.close();
  });

  test("does not repeat a matching finalized request in the delegation transcript delta", async () => {
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
      }),
    );
    await bridge.ingest(transcript(1, "Run the checks"));
    await bridge.ingest(
      JSON.stringify({
        type: "delegation.created",
        event_id: "delegation-event-1",
        item: {
          id: "delegation-1",
          type: "delegation",
          target: "client",
          content: [{ type: "input_text", text: "Run   the checks" }],
        },
      }),
    );

    const call = requests.flatMap((request) => request.entries ?? []).at(-1)!;
    expect(call.text).toBe(
      ["<realtime_delegation>", "  <input>Run   the checks</input>", "</realtime_delegation>"].join(
        "\n",
      ),
    );
    expect(call.payload).toMatchObject({ transcriptFenceTurnIds: ["turn-1"] });
    bridge.close();
  });

  test("marks a user turn finalized after delegation.created as covered by that delegation", async () => {
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
      }),
    );
    await bridge.ingest(
      JSON.stringify({
        type: "delegation.created",
        event_id: "delegation-event-1",
        item: {
          id: "delegation-1",
          type: "delegation",
          target: "client",
          content: [{ type: "input_text", text: "Run the checks" }],
        },
      }),
    );
    await bridge.ingest(transcript(1, "Run   the checks"));

    expect(requests.flatMap((request) => request.entries ?? []).at(-1)).toMatchObject({
      kind: "user_transcript",
      payload: { turnId: "turn-1", coveredByDelegationItemId: "delegation-1" },
    });
    bridge.close();
  });

  test("routes session context with explicit silent and speakable channels", async () => {
    const sent: string[] = [];
    const rows = [
      outbound({
        id: "44444444-4444-4444-8444-444444444451",
        operationId: "55555555-5555-4555-8555-555555555561",
        sequence: 11,
        kind: "session_update",
        delegationItemId: null,
        text: "typed human context",
        payload: { channel: null },
      }),
      outbound({
        id: "44444444-4444-4444-8444-444444444452",
        operationId: "55555555-5555-4555-8555-555555555562",
        sequence: 12,
        kind: "session_update",
        delegationItemId: null,
        text: "pre-existing work finished",
        payload: { channel: "speakable" },
      }),
    ];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => sent.push(value)),
        sync: async () => ({ accepted: [], outbound: rows }),
      }),
    );
    await bridge.flush();

    expect(sent.map((value) => JSON.parse(value))).toEqual([
      {
        type: "session.context.append",
        content: [{ type: "input_text", text: "typed human context" }],
      },
      {
        type: "session.context.append",
        channel: "speakable",
        content: [{ type: "input_text", text: "pre-existing work finished" }],
      },
    ]);
    bridge.close();
  });

  test("sealAndFlush drains parsed events and rejects later provider input", async () => {
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
      }),
    );
    const first = bridge.ingest(transcript(1, "persist before stop"));
    await bridge.sealAndFlush();
    await first;
    await bridge.ingest(transcript(2, "must be ignored after stop fence"));

    expect(requests.flatMap((request) => request.entries ?? []).map((entry) => entry.text)).toEqual(
      ["persist before stop"],
    );
    expect(bridge.snapshot().pendingInbound).toBe(0);
    bridge.close();
  });

  test("durably reports startup, client-ACKs receipt, and never fabricates a provider ACK", async () => {
    const sent: string[] = [];
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => sent.push(value)),
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: requests.length === 1 ? [outbound()] : [outbound()] };
        },
      }),
    );

    await bridge.ingest(
      JSON.stringify({
        type: "session.started",
        event_id: "provider-event-1",
        session: { id: "provider-session-1" },
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      providerStarted: {
        providerSessionId: "provider-session-1",
        providerEventId: "provider-event-1",
      },
    });
    expect(requests[1]).toMatchObject({ clientAckThroughSequence: 7 });
    expect(requests.every((request) => request.providerAckSequences === undefined)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(bridge.snapshot()).toMatchObject({
      providerStarted: true,
      clientAckThroughSequence: null,
      providerAckSequences: [],
    });
    bridge.close();
  });

  test("coalesces delegated progress as commentary and keeps the handoff active until result", async () => {
    const sent: string[] = [];
    let pending: SessionRealtimeLedgerEntry[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => sent.push(value)),
        sync: async () => ({ accepted: [], outbound: pending }),
      }),
    );
    await bridge.ingest(
      JSON.stringify({
        type: "delegation.created",
        event_id: "delegation-event-1",
        item: {
          id: "delegation-1",
          type: "delegation",
          target: "client",
          content: [{ type: "input_text", text: "Inspect it" }],
        },
      }),
    );
    expect(bridge.snapshot().activeDelegationId).toBe("delegation-1");

    pending = [
      outbound({
        id: "44444444-4444-4444-8444-444444444441",
        operationId: "55555555-5555-4555-8555-555555555551",
        sequence: 8,
        kind: "delegation_progress",
        text: "Checking ",
      }),
      outbound({
        id: "44444444-4444-4444-8444-444444444442",
        operationId: "55555555-5555-4555-8555-555555555552",
        sequence: 9,
        kind: "delegation_progress",
        text: "the workspace.",
      }),
    ];
    await bridge.flush();
    expect(JSON.parse(sent.at(-1)!)).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "commentary",
      content: [{ type: "input_text", text: "Checking the workspace." }],
    });
    expect(bridge.snapshot().activeDelegationId).toBe("delegation-1");

    pending = [
      outbound({
        id: "44444444-4444-4444-8444-444444444443",
        operationId: "55555555-5555-4555-8555-555555555553",
        sequence: 10,
        text: "Finished.",
      }),
    ];
    await bridge.flush();
    expect(JSON.parse(sent.at(-1)!)).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "Finished." }],
    });
    expect(bridge.snapshot().activeDelegationId).toBeNull();
    bridge.close();
  });

  test("human Steer continues through session context without a fabricated delegation result", async () => {
    const sent: string[] = [];
    let pending: SessionRealtimeLedgerEntry[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => sent.push(value)),
        sync: async () => ({ accepted: [], outbound: pending }),
      }),
    );
    await bridge.ingest(
      JSON.stringify({
        type: "delegation.created",
        event_id: "delegation-event-1",
        item: {
          id: "delegation-1",
          type: "delegation",
          target: "client",
          content: [{ type: "input_text", text: "Inspect it" }],
        },
      }),
    );
    expect(bridge.snapshot().activeDelegationId).toBe("delegation-1");

    pending = [
      outbound({
        id: "44444444-4444-4444-8444-444444444444",
        operationId: "55555555-5555-4555-8555-555555555555",
        sequence: 11,
        kind: "session_update",
        delegationItemId: null,
        text: "<session_user_message><delivery>steer</delivery><text>Focus on tests</text></session_user_message>",
        payload: { source: "human_input", delivery: "steer", channel: null },
      }),
    ];
    await bridge.flush();

    expect(JSON.parse(sent.at(-1)!)).toEqual({
      type: "session.context.append",
      content: [
        {
          type: "input_text",
          text: "<session_user_message><delivery>steer</delivery><text>Focus on tests</text></session_user_message>",
        },
      ],
    });
    expect(bridge.snapshot().activeDelegationId).toBeNull();
    bridge.close();
  });

  test("coalesces 65 valid events into exact FIFO batches of 64 and 1", async () => {
    const batches: string[][] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          batches.push(request.entries?.map((entry) => entry.text ?? "") ?? []);
          return { accepted: [], outbound: [] };
        },
      }),
    );

    await Promise.all(Array.from({ length: 65 }, (_, index) => bridge.ingest(transcript(index))));

    expect(batches.map((batch) => batch.length)).toEqual([64, 1]);
    expect(batches.flat()).toEqual(Array.from({ length: 65 }, (_, index) => `event-${index}`));
    expect(bridge.snapshot().pendingInbound).toBe(0);
    bridge.close();
  });

  test("restores a failed batch ahead of arrivals accepted while sync is pending", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstSync = new Promise<SyncSessionRealtimeLedgerResponse>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    const successfulBatches: string[][] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          calls += 1;
          if (calls === 1) return await firstSync;
          successfulBatches.push(request.entries?.map((entry) => entry.text ?? "") ?? []);
          return { accepted: [], outbound: [] };
        },
      }),
    );

    const initial = Array.from({ length: 64 }, (_, index) => bridge.ingest(transcript(index)));
    await Promise.resolve();
    const arrivals = [bridge.ingest(transcript(64)), bridge.ingest(transcript(65))];
    rejectFirst?.(new Error("temporary sync failure"));
    const settled = await Promise.allSettled([...initial, ...arrivals]);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    expect(calls).toBe(1);

    await bridge.flush();
    expect(calls).toBe(3);
    expect(successfulBatches.map((batch) => batch.length)).toEqual([64, 2]);
    expect(successfulBatches.flat()).toEqual(
      Array.from({ length: 66 }, (_, index) => `event-${index}`),
    );
    bridge.close();
  });

  test("quarantines malformed and oversized events while later valid events stay ordered", async () => {
    const accepted: string[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          accepted.push(...(request.entries?.map((entry) => entry.text ?? "") ?? []));
          return { accepted: [], outbound: [] };
        },
      }),
    );

    await bridge.ingest("{");
    await bridge.ingest(JSON.stringify({ type: "rate_limits.updated" }));
    await bridge.ingest(
      transcript(1, "🙂".repeat(Math.floor(sdkWire.CODEX_REALTIME_V3_MAX_TEXT_BYTES / 4) + 1)),
    );
    await Promise.all([bridge.ingest(transcript(2)), bridge.ingest(transcript(3))]);

    expect(accepted).toEqual(["event-2", "event-3"]);
    expect(bridge.snapshot().lastError).toContain("oversized_field");
    expect(bridge.snapshot()).toMatchObject({
      ignoredEventCount: 1,
      lastIgnoredEventType: "rate_limits.updated",
    });
    bridge.close();
  });

  test("crossing either hard pending bound emits one fatal and stops the generation", async () => {
    const fatals: Array<{ code: "pending_overflow"; message: string }> = [];
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
        onFatal: (fatal) => fatals.push(fatal),
      }),
    );

    const ingests = Array.from({ length: CODEX_REALTIME_V3_PENDING_MAX_ENTRIES + 1 }, (_, index) =>
      bridge.ingest(transcript(index)),
    );
    await Promise.all(ingests);
    await bridge.ingest(transcript(999));

    expect(fatals).toEqual([
      {
        code: "pending_overflow",
        message: "Codex realtime durable event buffer exceeded its hard limit",
      },
    ]);
    expect(requests).toEqual([]);
    expect(bridge.snapshot()).toMatchObject({
      pendingInbound: CODEX_REALTIME_V3_PENDING_MAX_ENTRIES,
      fatal: { code: "pending_overflow" },
    });
    bridge.close();

    const byteFatals: Array<{ code: "pending_overflow"; message: string }> = [];
    const byteRequests: SyncSessionRealtimeLedgerRequest[] = [];
    const byteBridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        sync: async (request) => {
          byteRequests.push(request);
          return { accepted: [], outbound: [] };
        },
        onFatal: (fatal) => byteFatals.push(fatal),
      }),
    );
    const maxText = "x".repeat(sdkWire.CODEX_REALTIME_V3_MAX_TEXT_BYTES);
    const byteIngests: Array<Promise<void>> = [];
    for (let index = 0; index < CODEX_REALTIME_V3_PENDING_MAX_ENTRIES; index += 1) {
      byteIngests.push(byteBridge.ingest(transcript(index, maxText)));
      if (byteBridge.snapshot().fatal) break;
    }
    await Promise.all(byteIngests);

    expect(byteFatals).toHaveLength(1);
    expect(byteRequests).toEqual([]);
    expect(byteBridge.snapshot().pendingInbound).toBeLessThan(
      CODEX_REALTIME_V3_PENDING_MAX_ENTRIES,
    );
    expect(byteBridge.snapshot().pendingInboundBytes).toBeLessThanOrEqual(
      CODEX_REALTIME_V3_PENDING_MAX_BYTES,
    );
    byteBridge.close();
  });

  test("replays un-provider-ACKed outbound rows on reconnect without looping on one bridge", async () => {
    const firstSent: string[] = [];
    const firstRequests: SyncSessionRealtimeLedgerRequest[] = [];
    const first = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => firstSent.push(value)),
        sync: async (request) => {
          firstRequests.push(request);
          return { accepted: [], outbound: [outbound()] };
        },
      }),
    );
    await first.flush();
    first.close();

    const secondSent: string[] = [];
    const secondRequests: SyncSessionRealtimeLedgerRequest[] = [];
    const second = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => secondSent.push(value)),
        sync: async (request) => {
          secondRequests.push(request);
          return {
            accepted: [],
            outbound: [outbound({ clientAckedAt: new Date().toISOString() })],
          };
        },
      }),
    );
    await second.flush();

    expect(firstSent).toHaveLength(1);
    expect(secondSent).toHaveLength(1);
    expect([...firstRequests, ...secondRequests]).not.toContainEqual(
      expect.objectContaining({ providerAckSequences: expect.anything() }),
    );
    expect(firstRequests).toHaveLength(2);
    expect(secondRequests).toHaveLength(1);
    second.close();
  });

  test("keeps a partially sent row replayable and provider-ACK-free", async () => {
    let sends = 0;
    let failSecondChunk = true;
    const sent: string[] = [];
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    const bridge = createCodexRealtimeV3Bridge(
      bridgeOptions({
        events: dataChannel((value) => {
          sends += 1;
          if (failSecondChunk && sends === 2) {
            failSecondChunk = false;
            throw new Error("provider channel rejected chunk");
          }
          sent.push(value);
        }),
        sync: async (request) => {
          requests.push(request);
          return { accepted: [], outbound: [outbound({ text: "x".repeat(900) })] };
        },
      }),
    );

    await expect(bridge.flush()).rejects.toThrow("provider channel rejected chunk");
    expect(bridge.snapshot()).toMatchObject({
      clientAckThroughSequence: 7,
      providerAckSequences: [],
    });
    await bridge.flush();

    expect(requests.some((request) => request.clientAckThroughSequence === 7)).toBe(true);
    expect(requests.every((request) => request.providerAckSequences === undefined)).toBe(true);
    expect(sent.length).toBeGreaterThan(2);
    bridge.close();
  });
});

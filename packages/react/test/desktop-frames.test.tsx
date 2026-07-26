/* ----------------------------------------------------------------------------
   Self-hosted desktop: the `relay-frames` transport paints PNG-per-frame onto a
   <canvas> (no RFB). These tests inject a fake WebSocket that speaks the proven
   relay wire protocol (Open → OpenAck → StreamFrame) and assert the viewer
   reaches `connected` after decoding+painting the first frame, plus graceful
   error on an ack rejection.
   -------------------------------------------------------------------------- */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  StreamFrame,
  StreamKind,
  StreamOpen,
  StreamOpenAck,
  StreamRole,
} from "@opengeni/agent-proto";
import { act } from "react";
import { registerDom, renderComponent, flush } from "./render-hook";
import { fakeCapabilities } from "./sandbox-fixtures";
import { DesktopViewer } from "../src/components/desktop-viewer";
import type {
  DesktopWebSocketFactory,
  DesktopWebSocketLike,
} from "../src/hooks/use-relay-frame-stream";

registerDom();

// Relay datagram tags (byte[0]).
const TAG_OPEN = 1;
const TAG_OPENACK = 2;
const TAG_FRAME = 3;
function datagram(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

// A tiny, valid 1x1 transparent PNG (decoded from base64 so the byte array stays
// readable). `createImageBitmap` is stubbed, so the exact pixels don't matter —
// only that it is a non-empty PNG the frame carries end-to-end.
const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** A fake WebSocket that records what the hook sends and lets the test dispatch
 *  relay datagrams back to it. Matches `DesktopWebSocketLike`. */
class FakeWebSocket implements DesktopWebSocketLike {
  binaryType = "blob";
  readonly sent: ArrayBuffer[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, ev: { data?: unknown } = {}): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev);
  }
}

/** Dispatch a relay event to the socket inside `act` so the synchronous React
 *  state updates it triggers are flushed without a warning. */
async function dispatch(socket: FakeWebSocket, type: string, ev: { data?: unknown } = {}) {
  await act(async () => {
    socket.emit(type, ev);
  });
}

function relayCapability() {
  return {
    ...fakeCapabilities().DesktopStream,
    transport: "relay-frames" as const,
    client: "frames" as const,
    mode: "read-only" as const,
    url: "wss://relay.example/stream?ws=W1&agent=A1&port=6080&channel=C1",
    token: "stream-token",
    // Already acknowledged so the consent gate does not block connection.
    requiresAcknowledgment: false,
    acknowledged: true,
  };
}

describe("DesktopViewer — relay-frames (self-hosted PNG stream)", () => {
  const realCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  let decoded: number;

  beforeEach(() => {
    decoded = 0;
    // jsdom/happy-dom lacks createImageBitmap; stub it so a "decode+paint" is
    // observable and deterministic (1x1 bitmap with a close()).
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = mock(async (_blob: Blob) => {
      decoded += 1;
      return { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap;
    });
  });
  afterEach(() => {
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCreateImageBitmap;
  });

  test("Open → OpenAck(accepted) → StreamFrame reaches connected and paints a PNG", async () => {
    let socket: FakeWebSocket | undefined;
    const factory: DesktopWebSocketFactory = (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    };

    const r = await renderComponent(
      <DesktopViewer capability={relayCapability()} webSocketFactory={factory} />,
    );
    await flush(5);

    // The canvas mount was appended into the viewer's container.
    expect(r.container.querySelector("[data-opengeni-desktop-frames]")).not.toBeNull();
    expect(socket).toBeDefined();
    expect(socket!.binaryType).toBe("arraybuffer");

    // WS opens → the hook sends exactly the Open datagram for a CLIENT desktop
    // channel, keyed off the url's query params.
    await dispatch(socket!, "open");
    expect(socket!.sent.length).toBe(1);
    const openBuf = new Uint8Array(socket!.sent[0]!);
    expect(openBuf[0]).toBe(TAG_OPEN);
    const open = StreamOpen.decode(openBuf.subarray(1));
    expect(open.channel?.channelId).toBe("C1");
    expect(open.channel?.workspaceId).toBe("W1");
    expect(open.channel?.agentId).toBe("A1");
    expect(open.channel?.port).toBe(6080);
    expect(open.channel?.kind).toBe(StreamKind.STREAM_KIND_DESKTOP);
    expect(open.role).toBe(StreamRole.STREAM_ROLE_CLIENT);
    expect(open.token).toBe("stream-token");

    // Still connecting until the first frame paints.
    const surface = r.container.querySelector("[data-opengeni-desktop]");
    expect(surface?.getAttribute("data-state")).not.toBe("connected");

    // Relay accepts the channel.
    const ack = datagram(
      TAG_OPENACK,
      StreamOpenAck.encode({ accepted: true, error: undefined, resumeFromSeq: "0" }).finish(),
    );
    await dispatch(socket!, "message", { data: ack.buffer });

    // A frame carrying the 1x1 PNG → decode + paint → connected.
    const frame = datagram(
      TAG_FRAME,
      StreamFrame.encode({
        channelId: "C1",
        seq: "1",
        data: PNG_1x1,
        producedAtMs: "0",
      }).finish(),
    );
    await dispatch(socket!, "message", { data: frame.buffer });
    await flush(5);

    expect(decoded).toBeGreaterThan(0);
    expect(surface?.getAttribute("data-state")).toBe("connected");

    await r.unmount();
    // Teardown closes the socket.
    expect(socket!.closed).toBe(true);
  });

  test("an ack rejection surfaces a graceful error overlay (no crash)", async () => {
    let socket: FakeWebSocket | undefined;
    const factory: DesktopWebSocketFactory = (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    };

    const r = await renderComponent(
      <DesktopViewer capability={relayCapability()} webSocketFactory={factory} />,
    );
    await flush(5);
    await dispatch(socket!, "open");

    const ack = datagram(
      TAG_OPENACK,
      StreamOpenAck.encode({
        accepted: false,
        error: { code: 0, message: "lease fenced", retryable: false, detail: {} },
        resumeFromSeq: "0",
      }).finish(),
    );
    await dispatch(socket!, "message", { data: ack.buffer });
    await flush(5);

    const surface = r.container.querySelector("[data-opengeni-desktop]");
    expect(surface?.getAttribute("data-state")).toBe("error");
    // The disconnected overlay shows the relay's reason + a Reconnect affordance.
    expect(r.container.textContent).toContain("lease fenced");
    expect(r.container.textContent).toContain("Reconnect");

    await r.unmount();
  });
});

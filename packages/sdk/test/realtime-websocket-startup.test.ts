import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RealtimeControllerTransportStarter } from "../src/codex-realtime-controller";
import { createRealtimeWebsocketTransportStarter } from "../src/realtime-websocket-transport";

// Controlled browser primitives exercise the actual starter, not a live browser,
// microphone, CSP policy, provider connection or media device.
const original = {
  WebSocket: globalThis.WebSocket,
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: globalThis.AudioWorkletNode,
};
let constructorFailure = false;
let openFailure = false;
let captureFailure = false;
let moduleReady: Promise<void> | null = null;

class FakeNode {
  connected = false;
  disconnected = false;
  onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null =
    null;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static captureReady = Promise.withResolvers<void>();
  sampleRate = 24_000;
  state = "running";
  destination = {};
  currentTime = 0;
  closeCalls = 0;
  source = new FakeNode();
  processor: FakeNode | null = null;
  audioWorklet = moduleReady ? { addModule: () => moduleReady! } : undefined;
  constructor() {
    FakeAudio.instances.push(this);
  }
  createMediaStreamSource() {
    if (captureFailure) throw new Error("controlled capture failure");
    return this.source;
  }
  createScriptProcessor() {
    FakeAudio.captureReady.resolve();
    return (this.processor = new FakeNode());
  }
  async resume() {}
  async close() {
    this.closeCalls += 1;
    this.state = "closed";
  }
}

class FakeWorklet extends FakeNode {
  port = { onmessage: null };
}

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  static opened = Promise.withResolvers<void>();
  readyState = 0;
  closeCalls = 0;
  sent: Array<{ type: string }> = [];
  constructor(..._args: unknown[]) {
    super();
    if (constructorFailure)
      throw new DOMException("controlled constructor failure", "SecurityError");
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      if (openFailure) this.dispatchEvent(new Event("error"));
      else {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        FakeSocket.opened.resolve();
      }
    });
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

beforeEach(() => {
  constructorFailure = openFailure = captureFailure = false;
  moduleReady = null;
  FakeAudio.instances = [];
  FakeAudio.captureReady = Promise.withResolvers<void>();
  FakeSocket.instances = [];
  FakeSocket.opened = Promise.withResolvers<void>();
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.AudioContext = FakeAudio as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = FakeWorklet as unknown as typeof AudioWorkletNode;
});
afterEach(() => {
  Object.assign(globalThis, original);
});

type Input = Parameters<RealtimeControllerTransportStarter>[0];
const answer = {
  protocol: "openai" as const,
  protocols: ["realtime", "fixture-token"],
  sessionUpdate: null,
  token: "fixture-token",
  url: "wss://provider.invalid",
  upstreamModelId: "fixture",
  expiresAt: null,
  connectionId: "55555555-5555-4555-8555-555555555555",
  connectionEpoch: 1,
  startupFenceSequence: 0,
  modeVersion: 1,
  initialItems: [],
  instructions: "fixture",
  replay: false,
};

function fixture(negotiate: () => Promise<typeof answer> = async () => answer) {
  const tracks = ["audio", "audio", "video"].map((kind) => ({
    kind,
    readyState: "live",
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
      this.readyState = "ended";
    },
    addEventListener() {},
    removeEventListener() {},
  }));
  const abort = new AbortController();
  const input = {
    client: { negotiateRealtimeWebsocket: negotiate },
    workspaceId: "workspace",
    sessionId: "session",
    signal: abort.signal,
    media: {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    },
    onEventsCreated() {},
    onConnectionHealth() {},
    onMicrophoneEnded() {},
    onAudibleOutputState() {},
  } as unknown as Input;
  return { input, tracks, abort };
}

function expectReleased(f: ReturnType<typeof fixture>) {
  for (const context of FakeAudio.instances) expect(context.state).toBe("closed");
  for (const socket of FakeSocket.instances) expect(socket.readyState).toBe(3);
  expect(f.tracks.map((track) => track.stopCalls)).toEqual([1, 1, 1]);
}

describe("WebSocket startup cleanup (controlled browser primitives)", () => {
  test("constructor throw closes warmed AudioContext and every captured track", async () => {
    constructorFailure = true;
    const f = fixture();
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled constructor failure",
    );
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(0);
    expectReleased(f);
  });

  test("negotiation rejection closes capture and every track before any socket exists", async () => {
    const f = fixture(async () => {
      throw new Error("controlled negotiation failure");
    });
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled negotiation failure",
    );
    expect(FakeSocket.instances).toHaveLength(0);
    expectReleased(f);
  });

  test("async open failure closes socket, capture and every track", async () => {
    openFailure = true;
    const f = fixture();
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "failed to open",
    );
    expectReleased(f);
  });

  test("capture failure releases every track and the partially prepared connection", async () => {
    captureFailure = true;
    const f = fixture();
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled capture failure",
    );
    expectReleased(f);
  });

  test("missing negotiator releases all input tracks without warming capture", async () => {
    const f = fixture();
    f.input.client = {} as Input["client"];
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "does not support",
    );
    expect(FakeAudio.instances).toHaveLength(0);
    expectReleased(f);
  });

  test("aborted negotiation releases tracks and never constructs a socket", async () => {
    const f = fixture(async () => {
      f.abort.abort(new Error("controlled abort"));
      return answer;
    });
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled abort",
    );
    expect(FakeSocket.instances).toHaveLength(0);
    expectReleased(f);
  });

  test("a startup callback throw also closes the newly constructed socket", async () => {
    const f = fixture();
    f.input.onEventsCreated = () => {
      throw new Error("controlled callback failure");
    };
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled callback failure",
    );
    expectReleased(f);
  });

  test("abort while capture is warming cannot return a closed connection as successful", async () => {
    const module = Promise.withResolvers<void>();
    moduleReady = module.promise;
    const f = fixture();
    const pending = createRealtimeWebsocketTransportStarter()(f.input);
    await FakeSocket.opened.promise;
    f.abort.abort(new Error("controlled capture abort"));
    module.resolve();
    await expect(pending).rejects.toThrow("controlled capture abort");
    expectReleased(f);
  });

  test("a throwing track stop cannot prevent releasing the remaining tracks", async () => {
    constructorFailure = true;
    const f = fixture();
    f.tracks[0]!.stop = function () {
      this.stopCalls += 1;
      throw new Error("controlled track stop failure");
    };
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled constructor failure",
    );
    expectReleased(f);
  });

  test("connected callback cancellation preserves its reason and releases every track", async () => {
    const f = fixture();
    const reason = new Error("controlled connected callback abort");
    f.input.onConnectionHealth = (state) => {
      if (state === "connected") f.abort.abort(reason);
    };
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toBe(reason);
    expectReleased(f);
  });

  test("late capture module resolution does not reconnect disposed capture", async () => {
    const module = Promise.withResolvers<void>();
    moduleReady = module.promise;
    const f = fixture(async () => {
      throw new Error("controlled negotiation failure");
    });
    await expect(createRealtimeWebsocketTransportStarter()(f.input)).rejects.toThrow(
      "controlled negotiation failure",
    );
    module.resolve();
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    expectReleased(f);
    expect(FakeAudio.instances[0]!.source.connected).toBe(false);
  });

  test("success keeps caller-owned tracks live and normal stop remains idempotent", async () => {
    const f = fixture();
    const connection = await createRealtimeWebsocketTransportStarter()(f.input);
    expect(connection.media).toBe(f.input.media);
    expect(connection.microphoneHealthy?.()).toBe(true);
    expect(f.tracks.map((track) => track.stopCalls)).toEqual([0, 0, 0]);
    connection.stop();
    connection.stop();
    expect(FakeAudio.instances[0]!.closeCalls).toBe(1);
    expect(FakeSocket.instances[0]!.closeCalls).toBe(1);
    // Successful connection media remains owned/stopped by the controller.
    expect(f.tracks.map((track) => track.stopCalls)).toEqual([0, 0, 0]);
  });

  test("the connect request carries the host's language and voice settings", async () => {
    const requests: unknown[] = [];
    const f = fixture();
    (f.input as { client: unknown }).client = {
      negotiateRealtimeWebsocket: async (_w: string, _s: string, request: unknown) => {
        requests.push(request);
        return answer;
      },
    };
    const withSettings = {
      ...f.input,
      language: "nb-NO",
      voiceSettings: { voice: "library-voice-id", language: "no", turnEagerness: "high" },
    } as Input;
    const connection = await createRealtimeWebsocketTransportStarter()(withSettings);
    connection.stop();
    expect(requests[0]).toMatchObject({
      language: "nb-NO",
      voiceSettings: { voice: "library-voice-id", language: "no", turnEagerness: "high" },
    });
  });

  test("capture still overlaps negotiation without transmitting audio before the socket is ready", async () => {
    const negotiation = Promise.withResolvers<typeof answer>();
    const f = fixture(() => negotiation.promise);
    const pending = createRealtimeWebsocketTransportStarter()(f.input);
    await FakeAudio.captureReady.promise;
    const capture = FakeAudio.instances[0]!.processor!;
    const frame = { inputBuffer: { getChannelData: () => new Float32Array(128) } };
    capture.onaudioprocess!(frame);
    expect(FakeSocket.instances).toHaveLength(0);
    negotiation.resolve(answer);
    const connection = await pending;
    expect(FakeSocket.instances[0]!.sent).toEqual([]);
    capture.onaudioprocess!(frame);
    expect(FakeSocket.instances[0]!.sent.map((event) => event.type)).toEqual([
      "input_audio_buffer.append",
    ]);
    connection.stop();
    expect(FakeAudio.instances[0]!.state).toBe("closed");
    expect(f.tracks.map((track) => track.stopCalls)).toEqual([0, 0, 0]);
  });
});

describe("context delivery to the voice model", () => {
  async function connected() {
    let events: RTCDataChannel | null = null;
    const f = fixture();
    (f.input as { onEventsCreated: (channel: RTCDataChannel) => void }).onEventsCreated = (
      channel,
    ) => {
      events = channel;
    };
    const connection = await createRealtimeWebsocketTransportStarter()(f.input);
    const socket = FakeSocket.instances[0]!;
    const append = async (message: Record<string, unknown>) => {
      events!.send(JSON.stringify(message));
      await Promise.resolve();
    };
    const providerEvent = (event: Record<string, unknown>) =>
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    const items = () =>
      socket.sent
        .filter((event) => event.type === "conversation.item.create")
        .map((event) => (event as unknown as { item: Record<string, unknown> }).item);
    return { connection, socket, append, providerEvent, items };
  }
  const progress = (text: string) => ({
    type: "delegation.context.append",
    delegation_item_id: "call_1",
    channel: "commentary",
    content: [{ type: "text", text }],
  });

  // Eleven Realtime keeps user items unread until a response is requested and
  // rejects more than ten; one item per streamed fragment overflowed it.
  test("progress is held and sent as one item when the person starts speaking", async () => {
    const live = await connected();
    for (const fragment of ["Checking ", "the employee ", "list."])
      await live.append(progress(fragment));
    await live.append({
      type: "session.context.append",
      channel: "commentary",
      content: [{ type: "text", text: "Kari was added." }],
    });
    expect(live.items()).toEqual([]);

    live.providerEvent({ type: "input_audio_buffer.speech_started" });
    expect(live.items()).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<execution_progress>\nChecking the employee list.\n</execution_progress>\n<session_update>\nKari was added.\n</session_update>",
          },
        ],
      },
    ]);
    // Nothing new is held, so further speech sends nothing.
    live.providerEvent({ type: "input_audio_buffer.speech_started" });
    expect(live.items()).toHaveLength(1);
    live.connection.stop();
  });

  test("held progress precedes a speakable result and its response request", async () => {
    const live = await connected();
    await live.append(progress("Opening the project."));
    await live.append({
      type: "delegation.context.append",
      delegation_item_id: "call_1",
      channel: "speakable",
      content: [{ type: "text", text: "Done." }],
    });
    expect(
      live.socket.sent.map((event) =>
        event.type === "conversation.item.create"
          ? (event as unknown as { item: { type: string } }).item.type
          : event.type,
      ),
    ).toEqual(["message", "function_call_output", "response.create"]);
    expect(live.items()[0]).toMatchObject({
      content: [
        {
          text: "<execution_progress>\nOpening the project.\n</execution_progress>",
        },
      ],
    });
    live.connection.stop();
  });
});

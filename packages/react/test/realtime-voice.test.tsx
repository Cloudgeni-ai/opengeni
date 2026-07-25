import { afterEach, describe, expect, test } from "bun:test";
import type {
  CreateSessionVoiceGrantResponse,
  RealtimeVoiceAdapter,
  RealtimeVoiceAdapterEvent,
  RealtimeVoiceAdapterSession,
  SessionVoiceCapability,
  SessionVoiceGrant,
} from "@opengeni/sdk";
import { createBrowserRealtimeVoiceAdapter } from "../src/realtime-voice/browser-adapter";
import { RealtimeVoiceOrb } from "../src/components/realtime-voice-orb";
import {
  realtimeVoiceClientEventId,
  useRealtimeVoice,
  type RealtimeVoiceController,
  type UseRealtimeVoiceOptions,
} from "../src/hooks/use-realtime-voice";
import {
  actRun,
  flush,
  registerDom,
  renderComponent,
  renderHook,
  type RenderedComponent,
} from "./render-hook";

registerDom();

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

const availableCapability: SessionVoiceCapability = {
  target: { workspaceId, sessionId },
  provider: "codex-subscription",
  mode: "full-duplex",
  experimental: true,
  status: "available",
  reason: null,
  retryAt: null,
  retention: {
    inputAudio: "ephemeral",
    partialTranscripts: "ephemeral",
    acceptedTranscripts: "ordinary-session",
    providerState: "ephemeral",
  },
  checks: {
    feature: "enabled",
    subscription: "enabled",
    workspacePolicy: "accepted",
    protocol: "verified",
    gateway: "available",
    credential: "available",
    capacity: "available",
  },
  limits: {
    grantTtlSeconds: 60,
    maxSessionSeconds: 900,
    maxInputAudioBytes: 32 * 1024 * 1024,
    maxConcurrentSessions: 1,
    workspaceAudioBudgetSeconds: null,
  },
};

const unavailableCapability: SessionVoiceCapability = {
  ...availableCapability,
  status: "unavailable",
  reason: "codex_realtime_protocol_unverified",
  checks: {
    ...availableCapability.checks,
    protocol: "unverified",
    gateway: "unavailable",
    credential: "not_evaluated",
    capacity: "not_evaluated",
  },
};

const grant: SessionVoiceGrant = {
  id: "33333333-3333-4333-8333-333333333333",
  target: { workspaceId, sessionId },
  provider: "codex-subscription",
  mode: "full-duplex",
  experimental: true,
  protocol: "opengeni.realtime.v1",
  gatewayUrl: "wss://api.example.test/voice/3333",
  expiresAt: "2026-07-25T01:00:00.000Z",
};

class FixtureAdapter implements RealtimeVoiceAdapter {
  listener: ((event: RealtimeVoiceAdapterEvent) => void) | null = null;
  connects = 0;
  closes = 0;
  interrupts = 0;
  spoken: Array<{ messageId: string; text: string }> = [];
  connectError: Error | null = null;
  closeImpl: (() => Promise<void>) | null = null;

  async connect(
    _grant: SessionVoiceGrant,
    listener: (event: RealtimeVoiceAdapterEvent) => void,
  ): Promise<RealtimeVoiceAdapterSession> {
    this.connects += 1;
    this.listener = listener;
    if (this.connectError) throw this.connectError;
    listener({ type: "connected" });
    return {
      interrupt: async () => {
        this.interrupts += 1;
      },
      speak: async (message) => {
        this.spoken.push(message);
      },
      close: async () => {
        await this.closeImpl?.();
        this.closes += 1;
      },
    };
  }

  emit(event: RealtimeVoiceAdapterEvent): void {
    if (!this.listener) throw new Error("adapter is not connected");
    this.listener(event);
  }
}

function client(
  capability: SessionVoiceCapability,
  response: CreateSessionVoiceGrantResponse = { capability, grant: null },
) {
  return {
    getSessionVoiceCapability: async () => capability,
    createSessionVoiceGrant: async () => response,
  };
}

function options(
  adapter: RealtimeVoiceAdapter,
  overrides: Partial<UseRealtimeVoiceOptions> = {},
): UseRealtimeVoiceOptions {
  return {
    client: client(availableCapability, { capability: availableCapability, grant }),
    workspaceId,
    sessionId,
    adapter,
    sessionStatus: "idle",
    onFinalTranscript: async () => true,
    ...overrides,
  };
}

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

describe("useRealtimeVoice", () => {
  test("an unavailable grant never connects the adapter or requests microphone access", async () => {
    let mediaRequests = 0;
    const adapter = createBrowserRealtimeVoiceAdapter({
      mediaDevices: {
        getUserMedia: async () => {
          mediaRequests += 1;
          throw new Error("must not request media");
        },
      },
    });
    const hook = await renderHook(
      () =>
        useRealtimeVoice(
          options(adapter, {
            client: client(unavailableCapability),
          }),
        ),
      undefined,
    );
    await flush();
    expect(hook.result.current.status).toBe("unavailable");
    await actRun(() => hook.result.current.start());
    expect(mediaRequests).toBe(0);
    expect(hook.result.current.capability?.reason).toBe("codex_realtime_protocol_unverified");
    await hook.unmount();
  });

  test("maps microphone denial to controlled UI state", async () => {
    const adapter = new FixtureAdapter();
    adapter.connectError = new DOMException("denied", "NotAllowedError");
    const hook = await renderHook(() => useRealtimeVoice(options(adapter)), undefined);
    await flush();
    await actRun(() => hook.result.current.start());
    expect(adapter.connects).toBe(1);
    expect(hook.result.current).toMatchObject({
      status: "error",
      errorCode: "permission_denied",
    });
    await hook.unmount();
  });

  test("deduplicates accepted finals and sends them through the ordinary callback", async () => {
    const adapter = new FixtureAdapter();
    const finals: string[] = [];
    const hook = await renderHook(
      () =>
        useRealtimeVoice(
          options(adapter, {
            onFinalTranscript: async (text) => {
              finals.push(text);
              return true;
            },
          }),
        ),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    await actRun(async () => {
      adapter.emit({ type: "transcript.final", text: "  ", providerAcceptanceId: "same" });
      adapter.emit({
        type: "transcript.final",
        text: "run the check",
        providerAcceptanceId: "same",
      });
      adapter.emit({
        type: "transcript.final",
        text: "run the check",
        providerAcceptanceId: "same",
      });
      await Promise.resolve();
    });
    expect(finals).toEqual(["run the check"]);
    expect(hook.result.current.status).toBe("executing");
    await hook.unmount();
  });

  test("serializes distinct finals and gives each one a stable ordinary Send key", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter = new FixtureAdapter();
    const submissions: Array<{ text: string; acceptanceId: string; clientEventId: string }> = [];
    const hook = await renderHook(
      () =>
        useRealtimeVoice(
          options(adapter, {
            onFinalTranscript: async (text, context) => {
              submissions.push({
                text,
                acceptanceId: context.providerAcceptanceId,
                clientEventId: context.clientEventId,
              });
              if (context.providerAcceptanceId === "first") await firstGate;
              return true;
            },
          }),
        ),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    await actRun(async () => {
      adapter.emit({ type: "transcript.final", text: "first turn", providerAcceptanceId: "first" });
      adapter.emit({
        type: "transcript.final",
        text: "second turn",
        providerAcceptanceId: "second",
      });
      await Promise.resolve();
    });
    expect(submissions.map(({ text }) => text)).toEqual(["first turn"]);
    releaseFirst();
    await flush();
    expect(submissions).toEqual([
      {
        text: "first turn",
        acceptanceId: "first",
        clientEventId: realtimeVoiceClientEventId(workspaceId, sessionId, "first"),
      },
      {
        text: "second turn",
        acceptanceId: "second",
        clientEventId: realtimeVoiceClientEventId(workspaceId, sessionId, "second"),
      },
    ]);
    await hook.unmount();
  });

  test("retains an outcome-unknown final and retries it only after explicit Start", async () => {
    const adapter = new FixtureAdapter();
    const contexts: string[] = [];
    let attempts = 0;
    const hook = await renderHook(
      () =>
        useRealtimeVoice(
          options(adapter, {
            reconnectDelayMs: 0,
            onFinalTranscript: async (_text, context) => {
              attempts += 1;
              contexts.push(context.clientEventId);
              return attempts > 1;
            },
          }),
        ),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    await actRun(async () => {
      adapter.emit({
        type: "transcript.final",
        text: "do not duplicate me",
        providerAcceptanceId: "ambiguous",
      });
      await Promise.resolve();
    });
    await flush();
    expect(attempts).toBe(1);
    expect(adapter.closes).toBe(1);
    expect(hook.result.current).toMatchObject({
      status: "error",
      pendingTranscript: "do not duplicate me",
      errorCode: "unknown",
    });
    await flush();
    expect(attempts).toBe(1);

    await actRun(() => hook.result.current.start());
    expect(attempts).toBe(2);
    expect(contexts[1]).toBe(contexts[0]);
    expect(adapter.connects).toBe(2);
    expect(hook.result.current.pendingTranscript).toBeNull();
    await hook.unmount();
  });

  test("uses the same durable Send key when a gateway redelivers after a true remount", async () => {
    const redelivered = {
      type: "transcript.final",
      text: "recover the ambiguous final",
      providerAcceptanceId: "remount-ambiguous",
    } as const;
    const clientEventIds: string[] = [];
    const firstAdapter = new FixtureAdapter();
    const first = await renderHook(
      () =>
        useRealtimeVoice(
          options(firstAdapter, {
            onFinalTranscript: async (_text, context) => {
              clientEventIds.push(context.clientEventId);
              return false;
            },
          }),
        ),
      undefined,
    );
    await flush();
    await actRun(() => first.result.current.start());
    await actRun(async () => {
      firstAdapter.emit(redelivered);
      await Promise.resolve();
    });
    await flush();
    expect(first.result.current.pendingTranscript).toBe(redelivered.text);
    await first.unmount();

    const secondAdapter = new FixtureAdapter();
    const second = await renderHook(
      () =>
        useRealtimeVoice(
          options(secondAdapter, {
            onFinalTranscript: async (_text, context) => {
              clientEventIds.push(context.clientEventId);
              return true;
            },
          }),
        ),
      undefined,
    );
    await flush();
    expect(second.result.current.pendingTranscript).toBeNull();
    await actRun(() => second.result.current.start());
    await actRun(async () => {
      secondAdapter.emit(redelivered);
      await Promise.resolve();
    });
    await flush();

    expect(clientEventIds).toEqual([
      realtimeVoiceClientEventId(workspaceId, sessionId, redelivered.providerAcceptanceId),
      realtimeVoiceClientEventId(workspaceId, sessionId, redelivered.providerAcceptanceId),
    ]);
    expect(second.result.current.pendingTranscript).toBeNull();
    await second.unmount();
  });

  test("coalesces error plus closed into one cleanup and reconnects with a fresh grant", async () => {
    const adapter = new FixtureAdapter();
    let grants = 0;
    const voiceClient = {
      getSessionVoiceCapability: async () => availableCapability,
      createSessionVoiceGrant: async () => {
        grants += 1;
        return {
          capability: availableCapability,
          grant: { ...grant, id: `${String(grants).padStart(8, "0")}-3333-4333-8333-333333333333` },
        };
      },
    };
    const hook = await renderHook(
      () =>
        useRealtimeVoice(
          options(adapter, {
            client: voiceClient,
            reconnectDelayMs: 0,
            maxReconnectAttempts: 2,
          }),
        ),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    const failedGeneration = adapter.listener;
    await actRun(async () => {
      failedGeneration?.({ type: "error", code: "network", recoverable: true });
      failedGeneration?.({ type: "closed", reason: "error" });
      await Promise.resolve();
    });
    await flush();
    expect(grants).toBe(2);
    expect(adapter.connects).toBe(2);
    expect(adapter.closes).toBe(1);
    expect(hook.result.current.status).toBe("listening");
    await hook.unmount();
  });

  for (const terminalEvent of [
    { type: "error", code: "provider", recoverable: false } as const,
    { type: "closed", reason: "expired" } as const,
  ]) {
    test(`closes a host adapter before ${terminalEvent.type} state and permits a clean restart`, async () => {
      let releaseClose!: () => void;
      const closeGate = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const adapter = new FixtureAdapter();
      adapter.closeImpl = async () => await closeGate;
      const hook = await renderHook(() => useRealtimeVoice(options(adapter)), undefined);
      await flush();
      await actRun(() => hook.result.current.start());

      await actRun(async () => {
        adapter.emit(terminalEvent);
        await Promise.resolve();
      });
      expect(adapter.closes).toBe(0);
      expect(hook.result.current.status).toBe("listening");

      releaseClose();
      await flush();
      expect(adapter.closes).toBe(1);
      expect(hook.result.current.status).toBe(terminalEvent.type === "error" ? "error" : "closed");

      adapter.closeImpl = null;
      await actRun(() => hook.result.current.start());
      expect(adapter.connects).toBe(2);
      expect(hook.result.current.status).toBe("listening");
      await hook.unmount();
    });
  }

  test("caps failed fresh-grant reconnect attempts", async () => {
    const adapter = new FixtureAdapter();
    const hook = await renderHook(
      () => useRealtimeVoice(options(adapter, { reconnectDelayMs: 0, maxReconnectAttempts: 2 })),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    adapter.connectError = new Error("gateway down");
    await actRun(async () => {
      adapter.emit({ type: "error", code: "network", recoverable: true });
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(adapter.connects).toBe(3);
    expect(hook.result.current).toMatchObject({ status: "error", errorCode: "network" });
    await hook.unmount();
  });

  test("times out a transport generation that ignores AbortSignal", async () => {
    let connects = 0;
    const hangingAdapter: RealtimeVoiceAdapter = {
      connect: async () => {
        connects += 1;
        return await new Promise<RealtimeVoiceAdapterSession>(() => undefined);
      },
    };
    const hook = await renderHook(
      () =>
        useRealtimeVoice(options(hangingAdapter, { connectTimeoutMs: 5, maxReconnectAttempts: 0 })),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    await flush(10);
    expect(connects).toBe(1);
    expect(hook.result.current).toMatchObject({ status: "error", errorCode: "network" });
    await hook.unmount();
  });

  test("barge-in stops playback without closing accepted work", async () => {
    const adapter = new FixtureAdapter();
    const hook = await renderHook(() => useRealtimeVoice(options(adapter)), undefined);
    await flush();
    await actRun(() => hook.result.current.start());
    await actRun(() => adapter.emit({ type: "speaking.started", messageId: "message-1" }));
    expect(hook.result.current.status).toBe("speaking");
    await actRun(() => hook.result.current.interrupt());
    expect(adapter.interrupts).toBe(1);
    expect(adapter.closes).toBe(0);
    expect(hook.result.current.status).toBe("listening");
    await hook.unmount();
  });

  test("speaks each completed durable assistant message once and maps session states", async () => {
    const adapter = new FixtureAdapter();
    const hook = await renderHook(
      (props: { status: UseRealtimeVoiceOptions["sessionStatus"]; messageId: string | null }) =>
        useRealtimeVoice(
          options(adapter, {
            sessionStatus: props.status,
            completedAssistantMessage: props.messageId
              ? { id: props.messageId, text: "Durable answer" }
              : null,
          }),
        ),
      { status: "idle", messageId: null },
    );
    await flush();
    await actRun(() => hook.result.current.start());
    await hook.rerender({ status: "running", messageId: null });
    expect(hook.result.current.status).toBe("executing");
    await hook.rerender({ status: "requires_action", messageId: null });
    expect(hook.result.current.status).toBe("awaiting-approval");
    await hook.rerender({ status: "idle", messageId: "message-1" });
    await flush();
    expect(hook.result.current.status).toBe("listening");
    expect(adapter.spoken).toEqual([{ messageId: "message-1", text: "Durable answer" }]);
    await hook.rerender({ status: "idle", messageId: "message-1" });
    await flush();
    expect(adapter.spoken).toHaveLength(1);
    await hook.unmount();
  });

  test("closes and fences the prior transport when the target session changes", async () => {
    const adapter = new FixtureAdapter();
    const hook = await renderHook<RealtimeVoiceController, string>(
      (targetSessionId: string) =>
        useRealtimeVoice(options(adapter, { sessionId: targetSessionId })),
      sessionId,
    );
    await flush();
    await actRun(() => hook.result.current.start());
    await hook.rerender("44444444-4444-4444-8444-444444444444");
    await flush();
    expect(adapter.closes).toBe(1);
    expect(hook.result.current.status).toBe("idle");
    await hook.unmount();
  });

  test("closes active media before reading a refreshed capability", async () => {
    let releaseClose!: () => void;
    let closeFinished = false;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const adapter = new FixtureAdapter();
    adapter.closeImpl = async () => {
      await closeGate;
      closeFinished = true;
    };
    let capabilityReads = 0;
    const voiceClient = {
      getSessionVoiceCapability: async () => {
        capabilityReads += 1;
        if (capabilityReads > 1) expect(closeFinished).toBe(true);
        return availableCapability;
      },
      createSessionVoiceGrant: async () => ({ capability: availableCapability, grant }),
    };
    const hook = await renderHook(
      () => useRealtimeVoice(options(adapter, { client: voiceClient })),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());

    const refreshing = hook.result.current.refreshCapability();
    await flush();
    expect(capabilityReads).toBe(1);
    releaseClose();
    await actRun(() => refreshing);
    expect(capabilityReads).toBe(2);
    await hook.unmount();
  });

  test("fences late adapter events after capability becomes unavailable", async () => {
    let currentCapability = availableCapability;
    const adapter = new FixtureAdapter();
    const finals: string[] = [];
    const hook = await renderHook(
      () =>
        useRealtimeVoice(
          options(adapter, {
            client: {
              getSessionVoiceCapability: async () => currentCapability,
              createSessionVoiceGrant: async () => ({ capability: availableCapability, grant }),
            },
            onFinalTranscript: async (text) => {
              finals.push(text);
              return true;
            },
          }),
        ),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.start());

    currentCapability = unavailableCapability;
    await actRun(() => hook.result.current.refreshCapability());
    adapter.emit({ type: "transcript.partial", text: "late partial" });
    adapter.emit({
      type: "transcript.final",
      text: "late final",
      providerAcceptanceId: "late-final",
    });
    await flush();
    expect(hook.result.current.status).toBe("unavailable");
    expect(hook.result.current.partial).toBe("");
    expect(finals).toEqual([]);
    await hook.unmount();
  });
});

describe("browser realtime voice adapter", () => {
  test("has no construction side effects and uses only the OpenGeni WSS grant", async () => {
    let mediaRequests = 0;
    let trackStops = 0;
    let recorderStarts = 0;
    let recorderStops = 0;
    let playedAudio = 0;
    const sent: unknown[] = [];
    const events: RealtimeVoiceAdapterEvent[] = [];
    const socket = new FakeSocket(sent);
    const adapter = createBrowserRealtimeVoiceAdapter({
      mediaDevices: {
        getUserMedia: async () => {
          mediaRequests += 1;
          return {
            getTracks: () => [{ stop: () => (trackStops += 1) }],
          } as unknown as MediaStream;
        },
      },
      createSocket: (url, protocol) => {
        expect(url).toBe(grant.gatewayUrl);
        expect(protocol).toBe("opengeni.realtime.v1");
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createRecorder: () =>
        ({
          ondataavailable: null,
          start: () => (recorderStarts += 1),
          stop: () => (recorderStops += 1),
        }) as unknown as MediaRecorder,
      playAudio: () => {
        playedAudio += 1;
      },
    });
    expect(mediaRequests).toBe(0);
    const session = await adapter.connect(grant, (event) => events.push(event), {
      signal: new AbortController().signal,
    });
    expect(mediaRequests).toBe(1);
    expect(recorderStarts).toBe(1);
    socket.message(new ArrayBuffer(1));
    expect(playedAudio).toBe(0);
    await session.speak({ messageId: "message-1", text: "Durable answer" });
    socket.message(new ArrayBuffer(1));
    expect(playedAudio).toBe(0);
    socket.message(
      JSON.stringify({ type: "speaking.started", messageId: "provider-only-message" }),
    );
    socket.message(new ArrayBuffer(1));
    expect(playedAudio).toBe(0);
    socket.message(JSON.stringify({ type: "speaking.started", messageId: "message-1" }));
    socket.message(new ArrayBuffer(1));
    expect(playedAudio).toBe(1);
    socket.message(JSON.stringify({ type: "error", code: "provider", recoverable: true }));
    expect(events.at(-1)).toEqual({ type: "error", code: "provider", recoverable: true });
    await session.interrupt();
    await session.close();
    expect(
      sent.map((value) => (typeof value === "string" ? JSON.parse(value).type : value)),
    ).toEqual(["session.start", "assistant.output", "playback.interrupt", "session.close"]);
    expect(trackStops).toBe(1);
    expect(recorderStops).toBe(1);
  });

  test("an abort during microphone authorization fences socket creation", async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    let socketCreations = 0;
    let trackStops = 0;
    const controller = new AbortController();
    const adapter = createBrowserRealtimeVoiceAdapter({
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            resolveMedia = resolve;
          }),
      },
      createSocket: () => {
        socketCreations += 1;
        throw new Error("must not create a socket after abort");
      },
      createRecorder: () => {
        throw new Error("must not create a recorder after abort");
      },
    });
    const connecting = adapter.connect(grant, () => undefined, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("target changed"));
    resolveMedia({
      getTracks: () => [{ stop: () => (trackStops += 1) }],
    } as unknown as MediaStream);
    await expect(connecting).rejects.toThrow("target changed");
    expect(socketCreations).toBe(0);
    expect(trackStops).toBe(1);
  });

  test("stops acquired microphone tracks exactly once when socket construction throws", async () => {
    let trackStops = 0;
    const adapter = createBrowserRealtimeVoiceAdapter({
      mediaDevices: {
        getUserMedia: async () =>
          ({
            getTracks: () => [{ stop: () => (trackStops += 1) }],
          }) as unknown as MediaStream,
      },
      createSocket: () => {
        throw new Error("socket construction failed");
      },
      createRecorder: () => {
        throw new Error("recorder must not be created after socket failure");
      },
    });

    await expect(
      adapter.connect(grant, () => undefined, { signal: new AbortController().signal }),
    ).rejects.toThrow("socket construction failed");
    expect(trackStops).toBe(1);
  });

  for (const terminalEvent of [
    { type: "error", code: "provider", recoverable: false } as const,
    { type: "closed", reason: "expired" } as const,
  ]) {
    test(`cleans media before notifying ${terminalEvent.type} gateway termination`, async () => {
      let trackStops = 0;
      let recorderStops = 0;
      const cleanupAtNotification: Array<[number, number]> = [];
      const socket = new FakeSocket([]);
      const adapter = createBrowserRealtimeVoiceAdapter({
        mediaDevices: {
          getUserMedia: async () =>
            ({
              getTracks: () => [{ stop: () => (trackStops += 1) }],
            }) as unknown as MediaStream,
        },
        createSocket: () => {
          queueMicrotask(() => socket.open());
          return socket as unknown as WebSocket;
        },
        createRecorder: () =>
          ({
            ondataavailable: null,
            start: () => undefined,
            stop: () => (recorderStops += 1),
          }) as unknown as MediaRecorder,
      });
      const connected = await adapter.connect(
        grant,
        (event) => {
          if (event.type === terminalEvent.type) {
            cleanupAtNotification.push([trackStops, recorderStops]);
          }
        },
        { signal: new AbortController().signal },
      );
      socket.message(JSON.stringify(terminalEvent));
      expect(cleanupAtNotification).toEqual([[1, 1]]);
      await connected.close();
      expect(trackStops).toBe(1);
      expect(recorderStops).toBe(1);
    });
  }

  test("cleans media before reporting a physical socket close", async () => {
    let trackStops = 0;
    let recorderStops = 0;
    const cleanupAtNotification: Array<[number, number]> = [];
    const socket = new FakeSocket([]);
    const adapter = createBrowserRealtimeVoiceAdapter({
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [{ stop: () => (trackStops += 1) }] }) as unknown as MediaStream,
      },
      createSocket: () => {
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createRecorder: () =>
        ({
          ondataavailable: null,
          start: () => undefined,
          stop: () => (recorderStops += 1),
        }) as unknown as MediaRecorder,
    });
    await adapter.connect(
      grant,
      (event) => {
        if (event.type === "error" || event.type === "closed") {
          cleanupAtNotification.push([trackStops, recorderStops]);
        }
      },
      { signal: new AbortController().signal },
    );
    socket.close();
    expect(cleanupAtNotification).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});

describe("RealtimeVoiceOrb", () => {
  test("keeps the exact target and text fallback visible in unavailable state", async () => {
    let textFallbacks = 0;
    mounted = await renderComponent(
      <RealtimeVoiceOrb
        status="unavailable"
        targetLabel="This session — Production audit"
        targetSessionId={sessionId}
        unavailableReason="codex_realtime_protocol_unverified"
        onStart={() => undefined}
        onStop={() => undefined}
        onInterrupt={() => undefined}
        onTextFallback={() => (textFallbacks += 1)}
      />,
    );
    expect(mounted.container.textContent).toContain("This session — Production audit");
    expect(mounted.container.textContent).toContain(
      "Experimental Codex audio protocol is not yet verified",
    );
    expect(mounted.container.textContent).toContain(sessionId);
    await actRun(() =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Use text composer instead"]')
        ?.click(),
    );
    expect(textFallbacks).toBe(1);
  });
});

class FakeSocket {
  readyState = 0;
  binaryType = "";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private listeners = new Map<string, Set<() => void>>();

  constructor(private readonly sent: unknown[]) {}

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener();
  }

  message(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

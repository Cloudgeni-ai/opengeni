import { describe, expect, mock, test } from "bun:test";
import type { RawNativeCallEvent } from "../src/realtime/call-events";

// The Android call module: the iOS module's surface. Without system calls
// turned on, it reports no system call screen and no agent calls.
const calls: string[] = [];
let listener: ((event: RawNativeCallEvent) => void) | null = null;
const androidModule: Record<string, unknown> = {
  configure: (includeInRecents: boolean) => void calls.push(`configure:${includeInRecents}`),
  startCall: async (callId: string, title: string, target: string | null) =>
    void calls.push(`start:${callId}:${title}:${String(target)}`),
  reportConnected: (callId: string) => void calls.push(`connected:${callId}`),
  endCall: async (callId: string, failed: boolean) => void calls.push(`end:${callId}:${failed}`),
  setMuted: async () => undefined,
  setSpeaker: async (on: boolean) => void calls.push(`speaker:${on}`),
  takePendingStartRequest: async () => null,
  addListener: (_name: "onCallEvent", next: (event: RawNativeCallEvent) => void) => {
    listener = next;
    return { remove: () => (listener = null) };
  },
};

mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => (name === "OpenGeniCall" ? androidModule : null),
}));

const { createExpoCallAdapter } = await import("../src/realtime/expo-call");

describe("Expo call adapter on Android", () => {
  test("sets up call audio without claiming a system call or agent calls", async () => {
    const adapter = createExpoCallAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter!.showsSystemCall).toBe(false);
    expect(adapter!.incoming).toBeUndefined();

    const events: unknown[] = [];
    const unsubscribe = adapter!.subscribe((event) => events.push(event));
    await adapter!.startCall({ callId: "ABC-1", title: "Call", target: null });
    listener?.({ type: "routeChanged", route: "speaker", reason: "activated" });
    await adapter!.setSpeaker(false);
    await adapter!.endCall("ABC-1", "failed");
    unsubscribe();

    expect(calls).toEqual([
      "configure:true",
      "start:abc-1:Call:null",
      "speaker:false",
      "end:abc-1:true",
    ]);
    expect(events).toEqual([{ type: "routeChanged", route: "speaker", reason: "activated" }]);
    expect(listener).toBeNull();
  });

  test("a build without system calls offers no agent calls even with the functions", () => {
    Object.assign(androidModule, {
      capabilities: () => ({ systemCall: false, incoming: false }),
      getVoipToken: async () => null,
      takeIncomingCalls: async () => [],
      endIncomingCall: () => undefined,
    });
    const adapter = createExpoCallAdapter();
    expect(adapter!.showsSystemCall).toBe(false);
    expect(adapter!.incoming).toBeUndefined();
  });

  test("with system calls and push, calls show as system calls and agents can ring", async () => {
    const ended: string[] = [];
    Object.assign(androidModule, {
      capabilities: () => ({ systemCall: true, incoming: true }),
      getVoipToken: async () => null,
      takeIncomingCalls: async () => [
        {
          type: "incoming",
          state: "ringing",
          callId: "CALL-1",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          title: "Deploy watcher",
          reason: "Production is down",
        },
      ],
      endIncomingCall: (callId: string, reason: string) => void ended.push(`${callId}:${reason}`),
    });
    const adapter = createExpoCallAdapter();
    expect(adapter!.showsSystemCall).toBe(true);
    // Android rings through the app's ordinary push token.
    expect(await adapter!.incoming!.getVoipToken()).toBeNull();
    const ringing = await adapter!.incoming!.takeIncomingCalls();
    expect(ringing).toHaveLength(1);
    expect(ringing[0]).toMatchObject({ callId: "call-1", state: "ringing" });
    adapter!.incoming!.endIncomingCall("CALL-1", "answeredElsewhere");
    expect(ended).toEqual(["call-1:answeredElsewhere"]);
    // Without the call audio device a ringing call connects on answer.
    expect(adapter!.incoming!.connectsBeforeAnswer).toBe(false);
  });

  test("a ringing call connects before answer only when the module says it can", () => {
    Object.assign(androidModule, { connectsBeforeAnswer: () => true });
    expect(createExpoCallAdapter()!.incoming!.connectsBeforeAnswer).toBe(true);
    Object.assign(androidModule, { connectsBeforeAnswer: () => false });
    expect(createExpoCallAdapter()!.incoming!.connectsBeforeAnswer).toBe(false);
  });

  test("a build before the full-screen check rings full screen as before", () => {
    const incoming = createExpoCallAdapter()!.incoming!;
    expect(incoming.canRingFullScreen).toBeUndefined();
    expect(incoming.openFullScreenRingSettings).toBeUndefined();
  });

  test("reads full-screen rings afresh each time and opens their setting", async () => {
    let fullScreenRing = false;
    const opened: string[] = [];
    Object.assign(androidModule, {
      capabilities: () => ({ systemCall: true, incoming: true, fullScreenRing }),
      openFullScreenRingSettings: async () => {
        opened.push("settings");
        return true;
      },
    });
    const incoming = createExpoCallAdapter()!.incoming!;
    expect(incoming.canRingFullScreen!()).toBe(false);
    fullScreenRing = true;
    expect(incoming.canRingFullScreen!()).toBe(true);
    expect(await incoming.openFullScreenRingSettings!()).toBe(true);
    expect(opened).toEqual(["settings"]);
  });

  test("voice commands: launcher shortcuts and start requests that name the workspace", async () => {
    const written: unknown[] = [];
    const pinned: unknown[] = [];
    // Builds before voice commands offer neither.
    expect(createExpoCallAdapter()!.setCallCommands).toBeUndefined();
    expect(createExpoCallAdapter()!.pinCallCommand).toBeUndefined();
    Object.assign(androidModule, {
      setCallCommands: async (commands: unknown[]) => void written.push(commands),
      pinCallCommand: async (command: unknown) => {
        pinned.push(command);
        return true;
      },
      takePendingStartRequest: async () => ({ target: "s1", workspaceId: "w2" }),
    });
    const adapter = createExpoCallAdapter()!;
    const command = { id: "c1", workspaceId: "w2", sessionId: "s1", name: "Research" };
    await adapter.setCallCommands!([command]);
    expect(written).toEqual([[{ ...command, synonyms: [] }]]);
    expect(await adapter.pinCallCommand!(command)).toBe(true);
    expect(pinned).toEqual([{ ...command, synonyms: [] }]);
    expect(await adapter.takePendingStartRequest()).toEqual({ target: "s1", workspaceId: "w2" });
    Object.assign(androidModule, {
      takePendingStartRequest: async () => ({ target: null, workspaceId: "w2" }),
    });
    expect(await adapter.takePendingStartRequest()).toEqual({ target: null, workspaceId: null });
    Object.assign(androidModule, { takePendingStartRequest: async () => null });
  });
});

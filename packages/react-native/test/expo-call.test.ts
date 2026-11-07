import { describe, expect, mock, test } from "bun:test";
import type { RawNativeCallEvent } from "../src/realtime/call-events";

// The Android call module: the iOS module's surface without system call
// screens or agent calls.
const calls: string[] = [];
let listener: ((event: RawNativeCallEvent) => void) | null = null;
const androidModule = {
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
});

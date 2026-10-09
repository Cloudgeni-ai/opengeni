import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { SessionRealtimeControllerSnapshot } from "@opengeni/sdk/realtime";
import { registerDom, renderHook } from "../../react/test/render-hook";
import {
  nativeRealtimeModelSupported,
  useNativeRealtimeCall,
  type NativeCallAdapter,
  type NativeCallEvent,
  type NativeCallRealtime,
} from "../src/realtime/native-call";
import { parseNativeCallEvent } from "../src/realtime/call-events";

registerDom();

function snapshot(
  status: SessionRealtimeControllerSnapshot["status"],
  inputMuted = false,
): SessionRealtimeControllerSnapshot {
  return {
    status,
    realtimeId: null,
    mode: null,
    bridge: null,
    microphone: "inactive",
    inputMuted,
    audibleOutput: "inactive",
    outputMuted: false,
    connectionGeneration: 0,
    reconnectAttempt: 0,
    diagnostic: null,
    error: status === "error" ? "Voice failed" : null,
  };
}

function fakeRealtime() {
  const log: string[] = [];
  const realtime: NativeCallRealtime = {
    snapshot: snapshot("idle"),
    canStart: true,
    admissionBlocker: null,
    start: async () => void log.push("realtime.start"),
    stop: async () => void log.push("realtime.stop"),
    setInputMuted: (muted) => void log.push(`realtime.mute:${muted}`),
  };
  return { realtime, log };
}

function fakeCall() {
  const log: string[] = [];
  let lastCallId: string | null = null;
  let listener: ((event: NativeCallEvent) => void) | null = null;
  const call: NativeCallAdapter = {
    startCall: async ({ callId, title }) => {
      lastCallId = callId;
      log.push(`call.start:${title}`);
    },
    reportConnected: () => void log.push("call.connected"),
    endCall: async (_id, reason = "ended") => void log.push(`call.end:${reason}`),
    setMuted: async (_id, muted) => void log.push(`call.mute:${muted}`),
    setSpeaker: async (on) => void log.push(`call.speaker:${on}`),
    subscribe: (next) => {
      listener = next;
      return () => (listener = null);
    },
    takePendingStartRequest: async () => null,
  };
  return {
    call,
    log,
    callId: () => lastCallId!,
    emit: (event: NativeCallEvent) => listener?.(event),
  };
}

async function setup() {
  const voice = fakeRealtime();
  const system = fakeCall();
  const hook = await renderHook(
    (realtime: NativeCallRealtime) =>
      useNativeRealtimeCall({ realtime, call: system.call, title: "Release plan" }),
    voice.realtime,
  );
  const status = async (next: SessionRealtimeControllerSnapshot["status"], muted = false) =>
    await hook.rerender({ ...voice.realtime, snapshot: snapshot(next, muted) });
  return { voice, system, hook, status };
}

describe("native realtime call", () => {
  test.each([null, "explicit-session"])(
    "preserves the requested Phone-recents handle (%s)",
    async (target) => {
      const voice = fakeRealtime();
      const system = fakeCall();
      let recorded: string | null | undefined;
      const original = system.call.startCall;
      system.call.startCall = async (input) => {
        recorded = input.target;
        await original(input);
      };
      const hook = await renderHook(
        () =>
          useNativeRealtimeCall({
            realtime: voice.realtime,
            call: system.call,
            title: "Call",
            target,
          }),
        undefined,
      );
      await act(async () => {
        await hook.result.current.start();
      });
      expect(recorded).toBe(target);
      await hook.unmount();
    },
  );
  test("reports the system call, starts voice, and shows connected once voice is live", async () => {
    const { voice, system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    expect(system.log).toEqual(["call.start:Release plan"]);
    expect(voice.log).toEqual(["realtime.start"]);
    expect(hook.result.current.systemCall).toBe(true);
    expect(hook.result.current.phase).toBe("connecting");
    await status("starting");
    await status("active");
    await status("active");
    expect(hook.result.current.phase).toBe("active");
    expect(system.log.filter((entry) => entry === "call.connected")).toHaveLength(1);
  });

  test("hanging up from the lock screen stops voice", async () => {
    const { voice, system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("active");
    await act(async () => {
      system.emit({ type: "ended", callId: "someone-else" });
    });
    expect(voice.log).not.toContain("realtime.stop");
    await act(async () => {
      system.emit({ type: "ended", callId: system.callId() });
    });
    expect(voice.log).toContain("realtime.stop");
    expect(hook.result.current.phase).toBe("idle");
    // The system already ended it; the app must not end it again.
    expect(system.log.filter((entry) => entry.startsWith("call.end"))).toEqual([]);
  });

  test("voice failing ends the system call as failed and surfaces the error", async () => {
    const { system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("error");
    expect(system.log).toContain("call.end:failed");
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.error).toBe("Voice failed");
  });

  test("ending in the app stops voice and hangs up normally", async () => {
    const { voice, system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("active");
    await act(async () => await hook.result.current.end());
    expect(voice.log).toContain("realtime.stop");
    expect(system.log).toContain("call.end:ended");
    expect(hook.result.current.phase).toBe("idle");
  });

  test("mute is mirrored between the app and the system call", async () => {
    const { voice, system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("active");
    await act(async () => hook.result.current.setMuted(true));
    expect(voice.log).toContain("realtime.mute:true");
    expect(system.log).toContain("call.mute:true");
  });

  test("an admission blocker refuses to start a call", async () => {
    const voice = fakeRealtime();
    const system = fakeCall();
    const hook = await renderHook(
      (realtime: NativeCallRealtime) =>
        useNativeRealtimeCall({ realtime, call: system.call, title: "Plan" }),
      { ...voice.realtime, canStart: false, admissionBlocker: "Resume this session first." },
    );
    await expect(hook.result.current.start()).rejects.toThrow("Resume this session first.");
    expect(system.log).toEqual([]);
  });

  test("works without a system call service", async () => {
    const voice = fakeRealtime();
    const hook = await renderHook(
      (realtime: NativeCallRealtime) => useNativeRealtimeCall({ realtime, title: "Plan" }),
      voice.realtime,
    );
    await act(async () => await hook.result.current.start());
    expect(voice.log).toEqual(["realtime.start"]);
    expect(hook.result.current.systemCall).toBe(false);
  });

  test("a refused system call still talks, as an in-app call", async () => {
    const voice = fakeRealtime();
    const system = fakeCall();
    system.call.startCall = async () => {
      throw new Error("CallKit refused the call");
    };
    const hook = await renderHook(
      (realtime: NativeCallRealtime) =>
        useNativeRealtimeCall({ realtime, call: system.call, title: "Plan" }),
      voice.realtime,
    );
    await act(async () => await hook.result.current.start());
    expect(voice.log).toEqual(["realtime.start"]);
    expect(hook.result.current.systemCall).toBe(false);
    expect(hook.result.current.error).toBeNull();
    await hook.rerender({ ...voice.realtime, snapshot: snapshot("active") });
    expect(hook.result.current.phase).toBe("active");
    await act(async () => hook.result.current.setMuted(true));
    await act(async () => await hook.result.current.end());
    // Nothing reaches the system for a call it never accepted.
    expect(system.log).toEqual([]);
    expect(voice.log).toContain("realtime.stop");
  });
});

describe("native call events and models", () => {
  test("parses native events and drops unknown ones", () => {
    expect(parseNativeCallEvent({ type: "ended", callId: "a" })).toEqual({
      type: "ended",
      callId: "a",
    });
    expect(parseNativeCallEvent({ type: "routeChanged", route: "carplay" })).toEqual({
      type: "routeChanged",
      route: "other",
    });
    expect(parseNativeCallEvent({ type: "startRequested" })).toEqual({
      type: "startRequested",
      target: null,
    });
    expect(parseNativeCallEvent({ type: "mystery" })).toBeNull();
  });

  test("only WebRTC voice models run natively", () => {
    expect(nativeRealtimeModelSupported("gpt-live-1-boulder-alpha")).toBe(true);
    expect(nativeRealtimeModelSupported("opengeni-azure/gpt-live-1")).toBe(true);
    expect(nativeRealtimeModelSupported("supergrok/grok-voice-think-fast-2.0")).toBe(false);
  });
});

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

  test("an adapter that only sets up call audio (Android) is driven like a call without claiming a system call", async () => {
    const voice = fakeRealtime();
    const system = fakeCall();
    system.call.showsSystemCall = false;
    const hook = await renderHook(
      (realtime: NativeCallRealtime) =>
        useNativeRealtimeCall({ realtime, call: system.call, title: "Plan" }),
      voice.realtime,
    );
    await act(async () => await hook.result.current.start());
    expect(hook.result.current.systemCall).toBe(false);
    expect(hook.result.current.speaker).toBe(true);
    await hook.rerender({ ...voice.realtime, snapshot: snapshot("active") });
    await act(async () => await hook.result.current.end());
    expect(system.log).toEqual(["call.start:Plan", "call.connected", "call.end:ended"]);
    await hook.unmount();
  });

  test("a live call that is silent on one side says why, and stops once audio flows", async () => {
    const { voice, hook } = await setup();
    await act(async () => await hook.result.current.start());
    const silent = (kind: "no_input_audio" | "output_silent" | null, inputMuted = false) =>
      hook.rerender({
        ...voice.realtime,
        snapshot: {
          ...snapshot("active", inputMuted),
          diagnostic: kind
            ? { kind, message: kind, recoverable: true, connectionGeneration: 1, attempt: 0 }
            : null,
        },
      });
    await silent(null);
    expect(hook.result.current.notice).toBeNull();
    await silent("no_input_audio");
    expect(hook.result.current.notice).toBe(
      "Your microphone isn't picking up any sound. Check that no other app is using it.",
    );
    // Muting silences the microphone on purpose.
    await silent("no_input_audio", true);
    expect(hook.result.current.notice).toBeNull();
    await silent("output_silent");
    expect(hook.result.current.notice).toBe(
      "A reply arrived but couldn't be played. Check your volume.",
    );
    await silent(null);
    expect(hook.result.current.notice).toBeNull();
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

describe("call audio route", () => {
  // The call adapter keeps the route stable while voice starts (on iOS, WebRTC
  // is given the call's own audio configuration), so the hook never moves the
  // route itself: it shows where audio plays and passes on the person's choice.
  const speakerCalls = (log: string[]) => log.filter((entry) => entry.startsWith("call.speaker"));

  test("a call starts on the loudspeaker and voice coming up does not touch the route", async () => {
    const { system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    expect(hook.result.current.speaker).toBe(true);
    await act(async () => {
      system.emit({ type: "routeChanged", route: "speaker", reason: "activated" });
    });
    await status("active");
    expect(speakerCalls(system.log)).toEqual([]);
    expect(hook.result.current.speaker).toBe(true);
    expect(hook.result.current.route).toBe("speaker");
  });

  test("the screen follows the route the person picks on the system call screen", async () => {
    const { system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("active");
    await act(async () => {
      system.emit({ type: "routeChanged", route: "receiver", reason: "override" });
    });
    expect(hook.result.current.speaker).toBe(false);
    expect(hook.result.current.route).toBe("receiver");
    expect(speakerCalls(system.log)).toEqual([]);
  });

  test("the person's choice in the app goes to the call adapter", async () => {
    const { system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("active");
    await act(async () => hook.result.current.setSpeaker(false));
    expect(speakerCalls(system.log)).toEqual(["call.speaker:false"]);
    expect(hook.result.current.speaker).toBe(false);
  });

  test("AirPods and headphones are shown as they are", async () => {
    const { system, hook, status } = await setup();
    await act(async () => await hook.result.current.start());
    await status("active");
    await act(async () => {
      system.emit({ type: "routeChanged", route: "bluetooth", reason: "newDevice" });
    });
    expect(speakerCalls(system.log)).toEqual([]);
    expect(hook.result.current.route).toBe("bluetooth");
    expect(hook.result.current.speaker).toBe(false);
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
    expect(
      parseNativeCallEvent({ type: "routeChanged", route: "receiver", reason: "categoryChange" }),
    ).toEqual({ type: "routeChanged", route: "receiver", reason: "categoryChange" });
    expect(
      parseNativeCallEvent({ type: "routeChanged", route: "speaker", reason: "wakeFromSleep" }),
    ).toEqual({ type: "routeChanged", route: "speaker", reason: "other" });
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

import { describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { registerDom, renderHook } from "../../react/test/render-hook";
import type { NativeCallAdapter } from "../src/realtime/native-call";

registerDom();

type AlertButton = { text: string; style?: string; onPress?: () => void };
const alerts: Array<{ title: string; message: string; buttons: AlertButton[] }> = [];
let appStateListener: ((state: string) => void) | null = null;
mock.module("react-native", () => ({
  Alert: {
    alert: (title: string, message: string, buttons: AlertButton[]) =>
      void alerts.push({ title, message, buttons }),
  },
  AppState: {
    addEventListener: (_event: "change", listener: (state: string) => void) => {
      appStateListener = listener;
      return { remove: () => (appStateListener = null) };
    },
  },
}));

const { useFullScreenRings } = await import("../src/realtime/full-screen-rings");

function adapter(incoming: Partial<NonNullable<NativeCallAdapter["incoming"]>> | null) {
  return {
    startCall: async () => undefined,
    reportConnected: () => undefined,
    endCall: async () => undefined,
    setMuted: async () => undefined,
    setSpeaker: async () => undefined,
    subscribe: () => () => undefined,
    takePendingStartRequest: async () => null,
    incoming: incoming
      ? {
          getVoipToken: async () => null,
          takeIncomingCalls: async () => [],
          endIncomingCall: () => undefined,
          ...incoming,
        }
      : undefined,
  } satisfies NativeCallAdapter;
}

describe("full-screen rings", () => {
  test("a phone that always rings full screen never asks", async () => {
    alerts.length = 0;
    for (const call of [null, adapter(null), adapter({})]) {
      const hook = await renderHook(() => useFullScreenRings(call), undefined);
      expect(hook.result.current.allowed).toBe(true);
      act(() => hook.result.current.ask());
      expect(await hook.result.current.openSettings()).toBe(false);
      await hook.unmount();
    }
    expect(alerts).toEqual([]);
    expect(appStateListener).toBeNull();
  });

  test("asks with an explanation and opens the setting, then re-checks on return", async () => {
    alerts.length = 0;
    let allowed = false;
    const opened: string[] = [];
    const call = adapter({
      canRingFullScreen: () => allowed,
      openFullScreenRingSettings: async () => {
        opened.push("settings");
        return true;
      },
    });
    const hook = await renderHook(() => useFullScreenRings(call), undefined);
    expect(hook.result.current.allowed).toBe(false);
    expect(hook.result.current.messages.title).toBe("Let calls ring full screen");

    act(() => hook.result.current.ask());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toBe("Let calls ring full screen");
    expect(alerts[0]!.message).toContain("full-screen notifications");
    expect(alerts[0]!.buttons.map((button) => button.text)).toEqual(["Not now", "Open settings"]);
    await act(async () => alerts[0]!.buttons[1]!.onPress!());
    expect(opened).toEqual(["settings"]);

    // The person allows it in system settings and comes back.
    allowed = true;
    await act(async () => appStateListener!("background"));
    expect(hook.result.current.allowed).toBe(false);
    await act(async () => appStateListener!("active"));
    expect(hook.result.current.allowed).toBe(true);

    act(() => hook.result.current.ask());
    expect(alerts).toHaveLength(1);
    await hook.unmount();
    expect(appStateListener).toBeNull();
  });

  test("a failing check or settings call counts as allowed or not opened", async () => {
    const call = adapter({
      canRingFullScreen: () => {
        throw new Error("module gone");
      },
      openFullScreenRingSettings: async () => {
        throw new Error("no settings");
      },
    });
    const hook = await renderHook(() => useFullScreenRings(call), undefined);
    expect(hook.result.current.allowed).toBe(true);
    expect(await hook.result.current.openSettings()).toBe(false);
    await hook.unmount();
  });
});

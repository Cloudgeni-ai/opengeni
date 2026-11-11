import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";
import type { NativeCallAdapter } from "./native-call";

export type FullScreenRingMessages = {
  title: string;
  message: string;
  openSettings: string;
  notNow: string;
};

export const DEFAULT_FULL_SCREEN_RING_MESSAGES = (t: OpenGeniText): FullScreenRingMessages => ({
  title: t("native.realtime.fullScreenRings.title"),
  message: t("native.realtime.fullScreenRings.message"),
  openSettings: t("native.realtime.fullScreenRings.openSettings"),
  notNow: t("native.realtime.fullScreenRings.notNow"),
});

export type FullScreenRings = {
  /**
   * Whether agents' rings show full screen over the lock screen. False only
   * on Android 14 and later while the person has not allowed full-screen
   * notifications for the app; true on iOS, older Android, and builds that
   * cannot ring. Read again whenever the app returns to the foreground.
   */
  allowed: boolean;
  /**
   * When rings are not allowed full screen, explain why in an alert that
   * offers to open the system setting; does nothing otherwise. Call it when
   * the person turns on agent calls.
   */
  ask(): void;
  /** Open the system setting directly; false when it could not be opened. */
  openSettings(): Promise<boolean>;
  /** The default explanation, for a host's own settings row or footer. */
  messages: FullScreenRingMessages;
};

function readAllowed(callAdapter: NativeCallAdapter | null): boolean {
  const check = callAdapter?.incoming?.canRingFullScreen;
  if (!check) return true;
  try {
    return check() !== false;
  } catch {
    return true;
  }
}

/**
 * Whether agents' calls ring full screen on this phone, kept current as the
 * app returns to the foreground (for example from the system setting), with
 * a ready prompt that sends the person to the setting. Hosts with their own
 * calls settings call `ask()` when the person turns agent calls on and show
 * `messages.message` with an "open settings" action while `allowed` is false.
 */
export function useFullScreenRings(
  callAdapter: NativeCallAdapter | null,
  options: { messages?: Partial<FullScreenRingMessages> } = {},
): FullScreenRings {
  const t = useOpenGeniText();
  const [allowed, setAllowed] = useState(() => readAllowed(callAdapter));
  const messages = useMemo(
    () => ({ ...DEFAULT_FULL_SCREEN_RING_MESSAGES(t), ...options.messages }),
    [t, options.messages],
  );
  const latest = useRef({ callAdapter, messages });
  latest.current = { callAdapter, messages };

  useEffect(() => {
    setAllowed(readAllowed(callAdapter));
    if (!callAdapter?.incoming?.canRingFullScreen) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setAllowed(readAllowed(callAdapter));
    });
    return () => subscription.remove();
  }, [callAdapter]);

  const openSettings = useCallback(async () => {
    const open = latest.current.callAdapter?.incoming?.openFullScreenRingSettings;
    if (!open) return false;
    try {
      return await open();
    } catch {
      return false;
    }
  }, []);

  const ask = useCallback(() => {
    const { callAdapter: adapter, messages: text } = latest.current;
    if (readAllowed(adapter)) {
      setAllowed(true);
      return;
    }
    setAllowed(false);
    Alert.alert(text.title, text.message, [
      { text: text.notNow, style: "cancel" },
      { text: text.openSettings, onPress: () => void openSettings() },
    ]);
  }, [openSettings]);

  return { allowed, ask, openSettings, messages };
}

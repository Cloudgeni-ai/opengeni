import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";

/** A device setting, not account data: whether shaking the phone opens Send feedback. */
const STORAGE_KEY = "opengeni:native:shake-to-send-feedback";

let enabled = true;
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function load(): Promise<void> {
  loaded ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((value) => {
      enabled = value !== "off";
      emit();
    })
    .catch(() => undefined);
  return loaded;
}

export function setShakeToSendFeedback(next: boolean): void {
  enabled = next;
  emit();
  void AsyncStorage.setItem(STORAGE_KEY, next ? "on" : "off").catch(() => undefined);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => enabled;

export function useShakeToSendFeedback(): boolean {
  useEffect(() => {
    void load();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

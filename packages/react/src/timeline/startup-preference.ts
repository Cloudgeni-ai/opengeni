import { useSyncExternalStore } from "react";

const KEY = "opengeni:startup-details:v1";
const EVENT = "opengeni:startup-details-changed";
let fallback = false;
function snapshot() {
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return fallback;
  }
}
function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
export function setStartupDetails(value: boolean) {
  fallback = value;
  try {
    window.localStorage.setItem(KEY, String(value));
  } catch {
    /* Private storage is optional. */
  }
  window.dispatchEvent(new Event(EVENT));
}
/** Presentation preference only. Startup evidence is always retained. */
export function useStartupDetails() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

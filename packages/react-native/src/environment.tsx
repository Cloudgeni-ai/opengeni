import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { NativeLinkAdapter, OpenGeniReactNativeAdapters } from "./adapters";
import { sha256HexToArrayBuffer } from "./adapters";

/**
 * The event a shimmed `window` or `document` listener receives. Web listeners
 * read fields such as `event.persisted` (pageshow), so every dispatch carries a
 * real event object shaped like the browser's, never `undefined`.
 */
interface NativeEnvironmentEvent {
  readonly type: string;
  readonly target: object;
  readonly currentTarget: object;
  readonly srcElement: object;
  readonly timeStamp: number;
  readonly bubbles: false;
  readonly cancelable: false;
  readonly composed: false;
  readonly isTrusted: false;
  readonly eventPhase: number;
  readonly defaultPrevented: false;
  /** `pageshow` and `pagehide`: the page was never restored from a back/forward cache. */
  readonly persisted?: boolean;
  /** `focus` and `blur`: there is no other element focus moved from or to. */
  readonly relatedTarget?: null;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  composedPath(): object[];
}

type NativeEventListener =
  | ((event: NativeEnvironmentEvent) => void)
  | { handleEvent(event: NativeEnvironmentEvent): void };

type NativeListenerOptions = boolean | { once?: boolean } | undefined;

interface EventTargetLike {
  addEventListener(
    type: string,
    listener: NativeEventListener | null | undefined,
    options?: NativeListenerOptions,
  ): void;
  removeEventListener(type: string, listener: NativeEventListener | null | undefined): void;
  dispatch(type: string, target: object): void;
}

const AT_TARGET = 2;

/** Build the browser-shaped event for `type`, with the fields web listeners read for it. */
function createNativeEnvironmentEvent(
  type: string,
  target: object,
  stopImmediate: () => void = () => {},
): NativeEnvironmentEvent {
  const event: NativeEnvironmentEvent = {
    type,
    target,
    currentTarget: target,
    srcElement: target,
    timeStamp: typeof performance === "object" ? performance.now() : Date.now(),
    bubbles: false,
    cancelable: false,
    composed: false,
    isTrusted: false,
    eventPhase: AT_TARGET,
    defaultPrevented: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    stopImmediatePropagation: stopImmediate,
    composedPath: () => [target],
    ...(type === "pageshow" || type === "pagehide" ? { persisted: false } : {}),
    ...(type === "focus" || type === "blur" ? { relatedTarget: null } : {}),
  };
  return event;
}

function reportListenerError(type: string, error: unknown): void {
  // A browser reports a throwing listener and keeps dispatching; it never
  // fails the code that fired the event. Here that code is the app-state
  // subscription, where an uncaught throw would end the app.
  console.error(`Opengeni: a "${type}" listener threw`, error);
}

function createEventTarget(): EventTargetLike {
  const listeners = new Map<string, Map<NativeEventListener, { once: boolean }>>();
  return {
    addEventListener: (type, listener, options) => {
      if (!listener) return;
      const existing = listeners.get(type) ?? new Map<NativeEventListener, { once: boolean }>();
      if (existing.has(listener)) return;
      existing.set(listener, { once: typeof options === "object" && options.once === true });
      listeners.set(type, existing);
    },
    removeEventListener: (type, listener) => {
      if (listener) listeners.get(type)?.delete(listener);
    },
    dispatch: (type, target) => {
      const registered = listeners.get(type);
      if (!registered) return;
      let stopped = false;
      const event = createNativeEnvironmentEvent(type, target, () => {
        stopped = true;
      });
      for (const [listener, { once }] of [...registered]) {
        if (stopped) break;
        // A listener removed by an earlier one during this dispatch is skipped, as in a browser.
        if (!registered.has(listener)) continue;
        if (once) registered.delete(listener);
        try {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        } catch (error) {
          reportListenerError(type, error);
        }
      }
    },
  };
}

interface InstalledEnvironment {
  cleanup(): void;
}

/** Install only the browser-compatible primitives currently read by the official session hooks. */
export function installOpenGeniReactNativeEnvironment(
  adapters: OpenGeniReactNativeAdapters,
): InstalledEnvironment {
  const globals = globalThis;
  const windowTarget = createEventTarget();
  const documentTarget = createEventTarget();
  const existingWindow = Reflect.get(globals, "window");
  const existingSessionStorage = Reflect.get(globals, "sessionStorage");
  const existingDocument = Reflect.get(globals, "document");
  const existingCrypto = Reflect.get(globals, "crypto");
  const nativeWindow = createDelegatingObject(isObject(existingWindow) ? existingWindow : globals);
  let lifecycleState = adapters.lifecycle.currentState();

  const sessionStorage = {
    getItem: (key: string) => adapters.persistence.getItem(key),
    setItem: (key: string, value: string) => adapters.persistence.setItem(key, value),
    removeItem: (key: string) => adapters.persistence.removeItem(key),
    clear: () => adapters.persistence.clear(),
    key: () => null,
    get length() {
      return 0;
    },
  };

  const nativeCrypto = createDelegatingObject(isObject(existingCrypto) ? existingCrypto : null);
  const subtleValue = isObject(existingCrypto) ? Reflect.get(existingCrypto, "subtle") : undefined;
  const nativeSubtle = createDelegatingObject(isObject(subtleValue) ? subtleValue : null);
  Reflect.set(nativeCrypto, "randomUUID", () => adapters.crypto.randomUUID());
  Reflect.set(
    nativeSubtle,
    "digest",
    async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name.toUpperCase() !== "SHA-256") {
        throw new TypeError(`Unsupported native digest algorithm: ${name}`);
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return sha256HexToArrayBuffer(await adapters.crypto.sha256Hex(bytes));
    },
  );
  Reflect.set(nativeCrypto, "subtle", nativeSubtle);
  Reflect.set(globals, "crypto", nativeCrypto);

  Reflect.set(nativeWindow, "sessionStorage", sessionStorage);
  if (typeof Reflect.get(nativeWindow, "setTimeout") !== "function") {
    Reflect.set(nativeWindow, "setTimeout", globalThis.setTimeout.bind(globalThis));
  }
  if (typeof Reflect.get(nativeWindow, "clearTimeout") !== "function") {
    Reflect.set(nativeWindow, "clearTimeout", globalThis.clearTimeout.bind(globalThis));
  }
  if (typeof Reflect.get(nativeWindow, "addEventListener") !== "function") {
    Reflect.set(
      nativeWindow,
      "addEventListener",
      (type: string, listener: NativeEventListener | null, options?: NativeListenerOptions) =>
        windowTarget.addEventListener(type, listener, options),
    );
  }
  if (typeof Reflect.get(nativeWindow, "removeEventListener") !== "function") {
    Reflect.set(
      nativeWindow,
      "removeEventListener",
      (type: string, listener: NativeEventListener | null) =>
        windowTarget.removeEventListener(type, listener),
    );
  }
  Reflect.set(globals, "window", nativeWindow);
  Reflect.set(globals, "sessionStorage", sessionStorage);

  const nativeDocument = {
    get visibilityState() {
      return lifecycleState === "active" ? "visible" : "hidden";
    },
    hasFocus: () => lifecycleState === "active",
    addEventListener: (
      type: string,
      listener: NativeEventListener | null,
      options?: NativeListenerOptions,
    ) => documentTarget.addEventListener(type, listener, options),
    removeEventListener: (type: string, listener: NativeEventListener | null) =>
      documentTarget.removeEventListener(type, listener),
  };
  Reflect.set(globals, "document", nativeDocument);
  installAbortSignalCompat();

  const unsubscribe = adapters.lifecycle.subscribe((next) => {
    const wasActive = lifecycleState === "active";
    lifecycleState = next;
    documentTarget.dispatch("visibilitychange", nativeDocument);
    if (!wasActive && next === "active") windowTarget.dispatch("pageshow", nativeWindow);
  });

  return {
    cleanup: () => {
      unsubscribe();
      restoreGlobal(globals, "window", nativeWindow, existingWindow);
      restoreGlobal(globals, "sessionStorage", sessionStorage, existingSessionStorage);
      restoreGlobal(globals, "document", nativeDocument, existingDocument);
      restoreGlobal(globals, "crypto", nativeCrypto, existingCrypto);
    },
  };
}

function restoreGlobal(
  target: typeof globalThis,
  key: string,
  installedValue: unknown,
  previousValue: unknown,
): void {
  if (Reflect.get(target, key) !== installedValue) return;
  if (previousValue === undefined) Reflect.deleteProperty(target, key);
  else Reflect.set(target, key, previousValue);
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * React Native's AbortController drops `abort(reason)` and has no
 * `signal.throwIfAborted()`. Connect flows and the client tell "the person
 * closed the sign-in window" from a failure by the abort reason. Both only add
 * standard behaviour, so they are installed once, when missing, and kept.
 */
function installAbortSignalCompat(): void {
  const Controller = globalThis.AbortController;
  if (typeof Controller !== "function") return;
  const marker = new Error("probe");
  const probe = new Controller();
  const signalPrototype = Object.getPrototypeOf(probe.signal) as object | null;
  probe.abort(marker);
  if (probe.signal.reason !== marker) {
    const abort = Reflect.get(Controller.prototype, "abort") as (this: AbortController) => void;
    Reflect.set(Controller.prototype, "abort", function (this: AbortController, reason?: unknown) {
      if (!this.signal.aborted)
        Object.defineProperty(this.signal, "reason", {
          configurable: true,
          value: reason === undefined ? abortError() : reason,
        });
      abort.call(this);
    });
  }
  if (signalPrototype && typeof Reflect.get(signalPrototype, "throwIfAborted") !== "function") {
    Reflect.set(signalPrototype, "throwIfAborted", function (this: AbortSignal) {
      if (this.aborted) throw this.reason ?? abortError();
    });
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function createDelegatingObject(prototype: object | null): object {
  const value = {};
  Object.setPrototypeOf(value, prototype);
  return value;
}

export interface NativeEnvironmentContextValue {
  adapters: OpenGeniReactNativeAdapters;
  active: boolean;
}

const NativeEnvironmentContext = createContext<NativeEnvironmentContextValue | null>(null);

export interface OpenGeniReactNativeProviderProps {
  adapters: OpenGeniReactNativeAdapters;
  children: ReactNode;
  loadingFallback?: ReactNode;
}

export function OpenGeniReactNativeProvider({
  adapters,
  children,
  loadingFallback = null,
}: OpenGeniReactNativeProviderProps) {
  const [hydrated, setHydrated] = useState(false);
  const [active, setActive] = useState(adapters.lifecycle.currentState() === "active");

  useEffect(() => {
    let mounted = true;
    setHydrated(false);
    void adapters.persistence.hydrate().then(() => {
      if (!mounted) return;
      setHydrated(true);
    });
    const unsubscribe = adapters.lifecycle.subscribe((state) => setActive(state === "active"));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [adapters]);

  useLayoutEffect(() => {
    const installed = installOpenGeniReactNativeEnvironment(adapters);
    return () => {
      // React removes parent layout effects before passive effects in deleted children.
      // Keep the browser primitives alive until those official hook cleanups have run.
      globalThis.setTimeout(() => installed.cleanup(), 0);
    };
  }, [adapters]);

  const value = useMemo(() => ({ adapters, active }), [active, adapters]);
  if (!hydrated) return loadingFallback;
  return (
    <NativeEnvironmentContext.Provider value={value}>{children}</NativeEnvironmentContext.Provider>
  );
}

export function useOpenGeniReactNativeEnvironment(): NativeEnvironmentContextValue {
  const value = useContext(NativeEnvironmentContext);
  if (!value) {
    throw new Error("Opengeni native hooks require OpenGeniReactNativeProvider");
  }
  return value;
}

/**
 * The host's link adapter, if any. Works outside the provider, where it is
 * undefined. Opening links lives in `./links` so this module stays free of
 * runtime `react-native` imports.
 */
export function useNativeLinkAdapter(): NativeLinkAdapter | undefined {
  return useContext(NativeEnvironmentContext)?.adapters.links;
}

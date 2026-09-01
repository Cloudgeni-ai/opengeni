export type ComposerDraftLocalStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type SessionRuntimeEnvironment = {
  clock: {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  ids: { randomUUID(): string };
  random?: (() => number) | undefined;
  scheduleMicrotask?: ((callback: () => void) => void) | undefined;
  visibility?: {
    getState(): "visible" | "hidden";
    subscribe(listener: () => void): () => void;
  };
  draftStorage?: ComposerDraftLocalStorage;
  objectUrls?: {
    create(value: Blob): string;
    revoke(url: string): void;
  };
};

export function defaultSessionRuntimeEnvironment(): SessionRuntimeEnvironment {
  return {
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) =>
        globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    ids: {
      randomUUID: () =>
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `attachment:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
    },
    random: () => Math.random(),
    scheduleMicrotask: (callback) => queueMicrotask(callback),
    ...(typeof document === "undefined"
      ? {}
      : {
          visibility: {
            getState: () =>
              document.visibilityState === "hidden" ? "hidden" : "visible",
            subscribe(listener: () => void) {
              document.addEventListener("visibilitychange", listener);
              window.addEventListener("pageshow", listener);
              return () => {
                document.removeEventListener("visibilitychange", listener);
                window.removeEventListener("pageshow", listener);
              };
            },
          },
        }),
    ...(typeof URL === "undefined"
      ? {}
      : {
          objectUrls: {
            create: (value: Blob) => URL.createObjectURL(value),
            revoke: (url: string) => URL.revokeObjectURL(url),
          },
        }),
    ...(typeof window === "undefined"
      ? {}
      : (() => {
          try {
            return { draftStorage: window.sessionStorage };
          } catch {
            return {};
          }
        })()),
  };
}

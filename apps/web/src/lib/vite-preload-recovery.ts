const VITE_PRELOAD_RECOVERY_STORAGE_KEY = "opengeni:vite-preload-recovery-build";

type PreloadRecoveryTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type PreloadRecoveryStorage = Pick<Storage, "getItem" | "setItem">;
type SessionStorageOwner = Pick<Window, "sessionStorage">;

export type VitePreloadRecoveryOptions = {
  target: PreloadRecoveryTarget;
  storage: PreloadRecoveryStorage;
  buildId: string;
  reload: () => void;
};

export function availableSessionStorage(owner: SessionStorageOwner): Storage | null {
  try {
    return owner.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Recover a page that still references hashed assets removed by a newer
 * deployment. Vite emits this event before a rejected lazy import reaches
 * React, so one guarded reload can fetch the current HTML and asset manifest.
 */
export function installVitePreloadRecovery({
  target,
  storage,
  buildId,
  reload,
}: VitePreloadRecoveryOptions): () => void {
  const onPreloadError: EventListener = (event) => {
    try {
      if (storage.getItem(VITE_PRELOAD_RECOVERY_STORAGE_KEY) === buildId) return;
      storage.setItem(VITE_PRELOAD_RECOVERY_STORAGE_KEY, buildId);
    } catch {
      // Without durable per-tab state, reloading could loop on a broken asset.
      return;
    }

    event.preventDefault();
    reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

export function currentViteBuildId(document: Document): string {
  const entryScripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
  ).map((script) => script.src);
  return entryScripts.join("|") || document.baseURI;
}

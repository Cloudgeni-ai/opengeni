import type { DesktopRfbFactory } from "@opengeni/sdk";

/** Host-owned imports keep optional peers outside the root's bundler graph. */
export type WorkbenchPeerLoader<T = unknown> = () => Promise<T>;
export type CodeEditorLanguage = "javascript" | "json" | "python" | "markdown" | "css" | "html";
export type CodeEditorLanguages = Partial<Record<CodeEditorLanguage, WorkbenchPeerLoader>>;
export type CodeEditorPeers = { module: unknown; languages?: CodeEditorLanguages | undefined };
export type SandboxTerminalPeers = {
  Terminal: unknown;
  FitAddon: unknown;
  WebLinksAddon: unknown;
  loadWebgl?: WorkbenchPeerLoader | undefined;
};

function optionalPeer<T>(setup: string) {
  let loader: WorkbenchPeerLoader<T> | null = null;
  let loaded: Promise<T> | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    register(next: WorkbenchPeerLoader<T> | null): void {
      if (next === loader) return;
      loader = next;
      loaded = null;
      version += 1;
      for (const listener of listeners) listener();
    },
    revision: () => version,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load(): Promise<T> {
      if (!loader) return Promise.reject(new Error(`Call ${setup} to enable this surface`));
      if (!loaded) {
        // A synchronous host-loader failure is also a rejected, retryable load.
        const pending = Promise.resolve()
          .then(loader)
          .catch((error: unknown) => {
            if (loaded === pending) loaded = null;
            throw error;
          });
        loaded = pending;
      }
      return loaded;
    },
  };
}

export const sandboxTerminalPeers = optionalPeer<SandboxTerminalPeers>(
  "enableSandboxTerminal() from @opengeni/react/terminal",
);
export const codeEditorPeers = optionalPeer<CodeEditorPeers>(
  "enableCodeEditor() from @opengeni/react/editor",
);
export const desktopViewerPeers = optionalPeer<DesktopRfbFactory>(
  "enableDesktopViewer() from @opengeni/react/desktop",
);

export const registerSandboxTerminal = sandboxTerminalPeers.register;
export const registerCodeEditor = codeEditorPeers.register;
export const registerDesktopViewer = desktopViewerPeers.register;

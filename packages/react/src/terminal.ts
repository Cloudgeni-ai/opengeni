import {
  registerSandboxTerminal,
  type SandboxTerminalPeers,
  type WorkbenchPeerLoader,
} from "./lib/workbench-peers";

export { SandboxTerminal } from "./components/sandbox-terminal";
export type { SandboxTerminalProps, XtermTheme } from "./components/sandbox-terminal";
export { registerSandboxTerminal } from "./lib/workbench-peers";

async function loadTerminal(): Promise<SandboxTerminalPeers> {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
  ]);
  return { Terminal, FitAddon, WebLinksAddon };
}

/** Opt in once on a terminal route; WebGL remains a separate optional import. */
export function enableSandboxTerminal(options?: { webgl?: WorkbenchPeerLoader | undefined }): void {
  const loadWebgl = options?.webgl;
  registerSandboxTerminal(
    loadWebgl ? async () => ({ ...(await loadTerminal()), loadWebgl }) : loadTerminal,
  );
}

// Every optional workbench peer the web app turns on, in one call: highlighted
// diffs and file views, the sandbox terminal, the desktop viewer and the code
// editor with its language grammars. Call it once, from the module that
// renders the session app (lazily, so the peers stay out of the first load).
// It names every peer, so the host installs all of them; a host that wants
// only some calls the single `enable*` functions instead.
import { enableDesktopViewer } from "./desktop";
import { enablePierreDiffs } from "./diffs";
import { enableCodeEditor } from "./editor";
import { enableSandboxTerminal } from "./terminal";

export function enableWorkbench(): void {
  enablePierreDiffs();
  enableSandboxTerminal({ webgl: () => import("@xterm/addon-webgl") });
  enableDesktopViewer();
  enableCodeEditor({
    javascript: async () =>
      (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
    json: async () => (await import("@codemirror/lang-json")).json(),
    python: async () => (await import("@codemirror/lang-python")).python(),
    markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
    css: async () => (await import("@codemirror/lang-css")).css(),
    html: async () => (await import("@codemirror/lang-html")).html(),
  });
}

import { enableCodeEditor } from "@opengeni/react/editor";
import { enableDesktopViewer } from "@opengeni/react/desktop";
import { enableSandboxTerminal } from "@opengeni/react/terminal";

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

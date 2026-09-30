import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { CodeEditor } from "../src/components/code-editor";
import { DesktopViewer } from "../src/components/desktop-viewer";
import { SandboxTerminal } from "../src/components/sandbox-terminal";
import {
  codeEditorPeers,
  desktopViewerPeers,
  registerCodeEditor,
  registerDesktopViewer,
  registerSandboxTerminal,
  sandboxTerminalPeers,
} from "../src/lib/workbench-peers";
import { fakeCapabilities } from "./sandbox-fixtures";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
afterEach(() => {
  registerCodeEditor(null);
  registerDesktopViewer(null);
  registerSandboxTerminal(null);
});

const terminalResult = {
  chunks: [],
  running: false,
  write: null,
  activePtyId: null,
  close: () => {},
  error: null,
};

describe("optional workbench peer registration", () => {
  test("registration and server rendering never execute loaders", () => {
    let loads = 0;
    const unexpected = async (): Promise<never> => {
      loads += 1;
      throw new Error("SSR must not load a peer");
    };
    registerCodeEditor(unexpected);
    registerDesktopViewer(unexpected);
    registerSandboxTerminal(unexpected);
    const html = renderToString(
      <>
        <CodeEditor path="src/app.ts" initialContents="saved" onSave={async () => {}} />
        <SandboxTerminal result={terminalResult} placeholder="terminal placeholder" />
        <DesktopViewer capability={fakeCapabilities().DesktopStream} />
      </>,
    );
    expect(html).toContain("terminal placeholder");
    expect(loads).toBe(0);
  });

  test("a missing peer is explicit, loads are shared, and failed imports retry", async () => {
    await expect(codeEditorPeers.load()).rejects.toThrow("enableCodeEditor()");
    let attempts = 0;
    registerCodeEditor(async () => {
      if (++attempts === 1) throw new Error("temporary chunk failure");
      return { module: "loaded" };
    });
    const first = codeEditorPeers.load();
    expect(codeEditorPeers.load()).toBe(first);
    await expect(first).rejects.toThrow("temporary chunk failure");
    expect(await codeEditorPeers.load()).toEqual({ module: "loaded" });
    expect(attempts).toBe(2);
  });

  test("an old rejected load cannot invalidate a replacement registration", async () => {
    let rejectOld!: (error: Error) => void;
    registerCodeEditor(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = codeEditorPeers.load();
    const rejected = old.catch((error: unknown) => error);
    await Promise.resolve();
    registerCodeEditor(async () => ({ module: "replacement" }));
    const replacement = codeEditorPeers.load();
    rejectOld(new Error("old loader failed"));
    expect(await rejected).toEqual(new Error("old loader failed"));
    await replacement;
    expect(codeEditorPeers.load()).toBe(replacement);
  });

  test("the textarea fallback upgrades after registration and tolerates a missing grammar", async () => {
    const view = await renderComponent(
      <CodeEditor path="src/app.ts" initialContents="saved" onSave={async () => {}} />,
    );
    try {
      await flush();
      expect(view.container.querySelector("textarea")).not.toBeNull();
      await act(async () => {
        registerCodeEditor(async () => ({
          module: {
            default: ({ value }: { value: string }) => <div data-test-editor>{value}</div>,
            keymap: { of: (bindings: unknown[]) => bindings },
            Prec: { highest: (extension: unknown) => extension },
          },
          languages: {
            javascript: async () => {
              throw new Error("grammar not installed");
            },
          },
        }));
      });
      await flush();
      expect(view.container.querySelector("[data-test-editor]")?.textContent).toBe("saved");
      expect(view.container.querySelector("textarea")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a mounted VNC viewer retries after its default factory is registered", async () => {
    const view = await renderComponent(
      <DesktopViewer capability={fakeCapabilities().DesktopStream} />,
    );
    let connections = 0;
    let disconnects = 0;
    try {
      await flush();
      expect(view.container.textContent).toContain("enableDesktopViewer()");
      await act(async () => {
        registerDesktopViewer(async () => () => {
          connections += 1;
          return {
            viewOnly: false,
            scaleViewport: false,
            clipViewport: false,
            addEventListener: () => {},
            removeEventListener: () => {},
            disconnect: () => {
              disconnects += 1;
            },
          };
        });
      });
      await flush();
      expect(connections).toBe(1);
      expect(view.container.textContent).not.toContain("enableDesktopViewer()");
      expect(await desktopViewerPeers.load()).toBe(await desktopViewerPeers.load());
    } finally {
      await view.unmount();
    }
    expect(disconnects).toBe(1);
  });

  test("a mounted terminal handles absent peers and retries with a DOM renderer", async () => {
    let opened = 0;
    let disposed = 0;
    class Terminal {
      cols = 80;
      rows = 24;
      constructor(public options: Record<string, unknown>) {}
      open() {
        opened += 1;
      }
      dispose() {
        disposed += 1;
      }
      focus() {}
      clear() {}
      write() {}
      loadAddon() {}
      onData() {
        return { dispose() {} };
      }
      onResize() {
        return { dispose() {} };
      }
    }
    const view = await renderComponent(<SandboxTerminal result={terminalResult} />);
    try {
      await flush();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "enableSandboxTerminal()",
      );
      const terminal = view.container.querySelector<HTMLElement>("[data-opengeni-terminal]")!;
      Object.defineProperties(terminal, {
        clientWidth: { value: 320 },
        clientHeight: { value: 180 },
      });
      await act(async () => {
        registerSandboxTerminal(async () => ({
          Terminal,
          FitAddon: class {
            fit() {}
          },
          WebLinksAddon: class {
            dispose() {}
          },
        }));
      });
      await flush(30);
      expect(opened).toBe(1);
      expect(terminal.getAttribute("data-og-term-renderer")).toBe("dom");
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(await sandboxTerminalPeers.load()).toBe(await sandboxTerminalPeers.load());
    } finally {
      await view.unmount();
    }
    expect(disposed).toBe(1);
  });

  test("an old WebGL load cannot attach or update the replacement terminal", async () => {
    let resolveWebgl!: (module: unknown) => void;
    let webglLoads = 0;
    let webglConstructions = 0;
    const webgl = new Promise((resolve) => {
      resolveWebgl = resolve;
    });
    const instances: Terminal[] = [];
    class Terminal {
      cols = 80;
      rows = 24;
      addons = 0;
      disposed = false;
      constructor(public options: Record<string, unknown>) {
        instances.push(this);
      }
      open() {}
      dispose() {
        this.disposed = true;
      }
      focus() {}
      clear() {}
      write() {}
      loadAddon() {
        this.addons += 1;
      }
      onData() {
        return { dispose() {} };
      }
      onResize() {
        return { dispose() {} };
      }
    }
    const peers = {
      Terminal,
      FitAddon: class {
        fit() {}
      },
      WebLinksAddon: class {
        dispose() {}
      },
    };
    const view = await renderComponent(<SandboxTerminal result={terminalResult} />);
    try {
      const terminal = view.container.querySelector<HTMLElement>("[data-opengeni-terminal]")!;
      Object.defineProperties(terminal, {
        clientWidth: { value: 320 },
        clientHeight: { value: 180 },
      });
      await act(async () => {
        registerSandboxTerminal(async () => ({
          ...peers,
          loadWebgl: () => {
            webglLoads += 1;
            return webgl;
          },
        }));
      });
      await flush();
      expect(webglLoads).toBe(1);
      expect(instances[0]?.addons).toBe(2);
      await act(async () => {
        registerSandboxTerminal(async () => peers);
      });
      await flush(30);
      expect(instances[0]?.disposed).toBe(true);
      expect(instances).toHaveLength(2);
      expect(terminal.getAttribute("data-og-term-renderer")).toBe("dom");
      await act(async () => {
        resolveWebgl({
          WebglAddon: class {
            constructor() {
              webglConstructions += 1;
            }
            dispose() {}
          },
        });
      });
      await flush();
      expect(webglConstructions).toBe(0);
      expect(instances[0]?.addons).toBe(2);
      expect(terminal.getAttribute("data-og-term-renderer")).toBe("dom");
      expect(terminal.getAttribute("data-opengeni-terminal-ready")).toBe("true");
    } finally {
      await view.unmount();
    }
  });
});

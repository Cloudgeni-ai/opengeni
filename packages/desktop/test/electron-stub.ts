import { EventEmitter } from "node:events";

class FakeNotification extends EventEmitter {
  static isSupported() {
    return false;
  }
}

/** A page's process: runs scripts, and can be made to fail or hang. */
export class FakeWebContents extends EventEmitter {
  /** How every page answers a script, unless one page is told otherwise. */
  static answer: (code: string) => Promise<unknown> = async () => 200;
  answer: ((code: string) => Promise<unknown>) | null = null;
  readonly scripts: string[] = [];

  constructor() {
    super();
    // A page whose process is gone answers nothing again.
    this.on("render-process-gone", () => {
      this.answer = () => Promise.reject(new Error("Render frame was disposed"));
    });
  }

  executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    return (this.answer ?? FakeWebContents.answer)(code);
  }

  setWindowOpenHandler(_handler: unknown): void {}
}

/** A window that keeps what was done to it; every one made is in `made`. */
export class FakeBrowserWindow extends EventEmitter {
  static made: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  destroyed = false;
  visible = false;
  shows = 0;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(readonly options: Record<string, unknown> = {}) {
    super();
    FakeBrowserWindow.made.push(this);
  }

  loadURL(_url: string): Promise<void> {
    return Promise.resolve();
  }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }
  hide(): void {
    this.visible = false;
  }
  showInactive(): void {
    this.visible = true;
    this.shows += 1;
  }
  getBounds() {
    return this.bounds;
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }
}

const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };

/**
 * The part of Electron the main-process modules under test use. Bun shares
 * module mocks across test files, and which file's mock a module sees depends
 * on load order, so every test file mocks Electron with this same stub.
 */
export const electronStub = {
  app: { isPackaged: true },
  BaseWindow: EventEmitter,
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: EventEmitter,
  clipboard: {},
  contextBridge: { exposeInMainWorld: (_key: string, _api: unknown): void => {} },
  ipcRenderer: new EventEmitter(),
  webFrame: { getZoomFactor: () => 1 },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  nativeTheme: {},
  screen: {
    getAllDisplays: () => [display],
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  shell: { openExternal: async (_url: string): Promise<void> => {} },
  Menu: { buildFromTemplate: (template: unknown) => template },
  Tray: EventEmitter,
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  Notification: FakeNotification,
};

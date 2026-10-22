import { EventEmitter } from "node:events";

class FakeNotification extends EventEmitter {
  static isSupported() {
    return false;
  }
}

/**
 * The part of Electron the main-process modules under test use. Bun shares
 * module mocks across test files, and which file's mock a module sees depends
 * on load order, so every test file mocks Electron with this same stub.
 */
export const electronStub = {
  app: { isPackaged: true },
  BaseWindow: EventEmitter,
  WebContentsView: EventEmitter,
  clipboard: {},
  nativeTheme: {},
  screen: {},
  shell: { openExternal: async (_url: string): Promise<void> => {} },
  Menu: { buildFromTemplate: (template: unknown) => template },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  Notification: FakeNotification,
};

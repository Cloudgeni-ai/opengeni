import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_IPC,
  DESKTOP_WELCOME_GLOBAL,
  type DesktopWelcomeBridge,
  type WelcomeState,
} from "../contract";

const bridge: DesktopWelcomeBridge = {
  state: () => ipcRenderer.invoke(DESKTOP_IPC.welcomeState) as Promise<WelcomeState>,
  signIn: (serverUrl) => ipcRenderer.invoke(DESKTOP_IPC.welcomeSignIn, serverUrl),
  cancel: () => ipcRenderer.invoke(DESKTOP_IPC.welcomeCancel),
  onChange: (listener) => {
    const handler = (_event: IpcRendererEvent, state: WelcomeState) => listener(state);
    ipcRenderer.on(DESKTOP_IPC.welcomeChanged, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC.welcomeChanged, handler);
    };
  },
};

contextBridge.exposeInMainWorld(DESKTOP_WELCOME_GLOBAL, bridge);
document.documentElement.dataset.platform = process.platform;

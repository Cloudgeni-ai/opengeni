// The bridge in the app window. Sandboxed preload: only `electron`'s renderer
// modules are available. The bridge exists only on the app's own local server;
// the main process checks the sender again on every call.

import { contextBridge, ipcRenderer } from "electron";
import type { ThisComputerHost, ThisComputerStatus } from "@opengeni/sdk/this-computer";

import {
  SIMPLE_BRIDGE_GLOBAL,
  SIMPLE_IPC,
  SIMPLE_ORIGIN_ARGUMENT,
  type OpengeniSimpleBridge,
} from "./ipc";

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const origin = argument(SIMPLE_ORIGIN_ARGUMENT);
const productName = argument("opengeni-simple-product") ?? "Opengeni Simple";

if (origin && window.location.origin === origin) {
  const thisComputer: ThisComputerHost = {
    platform:
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    productName,
    status: (workspaceId) =>
      ipcRenderer.invoke(SIMPLE_IPC.computerStatus, workspaceId) as Promise<ThisComputerStatus>,
    connect: (workspaceId, options) =>
      ipcRenderer.invoke(SIMPLE_IPC.computerConnect, workspaceId, {
        screenControl: Boolean(options.screenControl),
      }) as Promise<ThisComputerStatus>,
    pause: () => ipcRenderer.invoke(SIMPLE_IPC.computerPause) as Promise<void>,
    resume: () => ipcRenderer.invoke(SIMPLE_IPC.computerResume) as Promise<void>,
    requestPermission: (id) =>
      ipcRenderer.invoke(SIMPLE_IPC.computerRequestPermission, id) as Promise<void>,
    disconnect: (workspaceId) =>
      ipcRenderer.invoke(SIMPLE_IPC.computerDisconnect, workspaceId) as Promise<void>,
    onChange: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(SIMPLE_IPC.computerChanged, handler);
      return () => {
        ipcRenderer.removeListener(SIMPLE_IPC.computerChanged, handler);
      };
    },
  };
  const bridge: OpengeniSimpleBridge = { productName, thisComputer };
  contextBridge.exposeInMainWorld(SIMPLE_BRIDGE_GLOBAL, bridge);
}

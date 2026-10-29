import { expect, mock, test } from "bun:test";
import * as React from "../../../packages/react/node_modules/react";
import { flush, registerDom, renderHook } from "../../../packages/react/test/render-hook";

let canCreatePrivate = true;
// The standalone Expo app has its own React installation; use the renderer's
// instance for this DOM hook test, just as Metro resolves one React on device.
mock.module("react", () => React);
const { act } = React;
let defaultVisibility = "private";
const client = {
  getSessionTenancyCreateCapabilities: async () => ({ canCreatePrivate, defaultVisibility }),
  listGitHubRepositories: async () => ({ repositories: [] }),
  listMachines: async () => ({ machines: [] }),
  listChannels: async () => [],
  listCapabilities: async () => ({ items: [] }),
};
mock.module("@/account", () => ({ useAccount: () => ({ client }) }));
mock.module("@/native-menu", () => ({ NativeMenu: () => null }));
mock.module("@/web-links", () => ({ openOnWeb: () => {}, webPaths: {} }));
mock.module("expo-haptics", () => ({}));
mock.module("react-native", () => ({
  Pressable: () => null,
  ScrollView: () => null,
  Text: () => null,
  View: () => null,
}));
mock.module("@opengeni/react-native/timeline", () => ({
  fontStyle: () => ({}),
  Icon: () => null,
  useNativeTimelineTheme: () => ({}),
}));
const { useNewSessionOptions } = await import("./new-session-options");
registerDom();

test("privacy label, restored draft and create request agree with the server default", async () => {
  const view = await renderHook(() => useNewSessionOptions("workspace"), undefined);
  try {
    await flush();
    expect(view.result.current.visibility).toBe("private");
    expect(view.result.current.request().visibility).toBe("private");
    await act(async () => view.result.current.setVisibility("workspace"));
    expect(view.result.current.visibility).toBe("workspace");
    expect(view.result.current.request().visibility).toBe("workspace");
    await act(async () => view.result.current.reset());
    expect(view.result.current.visibility).toBe("private");
    await act(async () => view.result.current.apply({ visibility: "workspace" }));
    expect(view.result.current.choices.visibility).toBe("workspace");
    expect(view.result.current.request().visibility).toBe("workspace");
  } finally {
    await view.unmount();
  }
});

test("a workspace without private chats cannot restore an unavailable private choice", async () => {
  canCreatePrivate = false;
  defaultVisibility = "workspace";
  const view = await renderHook(() => useNewSessionOptions("public-workspace"), undefined);
  try {
    await flush();
    await act(async () => view.result.current.apply({ visibility: "private" }));
    expect(view.result.current.visibility).toBe("workspace");
    expect(view.result.current.request().visibility).toBe("workspace");
  } finally {
    await view.unmount();
  }
});

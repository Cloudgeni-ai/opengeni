import { expect, test } from "bun:test";
import type { ThisComputerHost, ThisComputerStatus } from "@opengeni/sdk/this-computer";
import { useThisComputer } from "../src/components/this-computer/use-this-computer";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

function fakeHost(readings: ThisComputerStatus[]) {
  const listeners = new Set<() => void>();
  let index = 0;
  const host: ThisComputerHost = {
    platform: "linux",
    productName: "App",
    status: async () => ({ ...readings[Math.min(index++, readings.length - 1)]! }),
    connect: async () => ({ ...readings[readings.length - 1]! }),
    pause: async () => undefined,
    resume: async () => undefined,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { host, changed: () => listeners.forEach((listener) => listener()) };
}

const connected: ThisComputerStatus = {
  state: "connected",
  busy: false,
  error: null,
  machineName: "studio",
};

test("the result stays the same object while readings say the same thing", async () => {
  const { host, changed } = fakeHost([connected, connected, { ...connected, state: "paused" }]);
  const hook = await renderHook(() => useThisComputer(host, "workspace-1"), undefined);
  await flush();
  const first = hook.result.current;
  expect(first.status?.state).toBe("connected");

  await actRun(() => changed());
  await flush();
  expect(hook.result.current).toBe(first);

  await actRun(() => changed());
  await flush();
  expect(hook.result.current).not.toBe(first);
  expect(hook.result.current.status?.state).toBe("paused");
  expect(hook.result.current.pause).toBe(first.pause);
  await hook.unmount();
});

test("shows a change even when reading the status takes longer than polling", async () => {
  const pending: ((status: ThisComputerStatus) => void)[] = [];
  let calls = 0;
  const reading = (granted: boolean): ThisComputerStatus => ({
    ...connected,
    permissions: [{ id: "screenRecording", granted }],
  });
  const host: ThisComputerHost = {
    platform: "macos",
    productName: "App",
    status: () => {
      calls += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
    connect: async () => reading(true),
    pause: async () => undefined,
    resume: async () => undefined,
    onChange: () => () => undefined,
  };
  const hook = await renderHook(() => useThisComputer(host, "workspace-1"), undefined);
  // The first reading is in flight; reads asked for meanwhile wait for it
  // instead of replacing it.
  await actRun(() => {
    hook.result.current.refresh();
    hook.result.current.refresh();
  });
  expect(calls).toBe(1);
  await actRun(() => pending.shift()!(reading(false)));
  await flush();
  expect(hook.result.current.status?.permissions?.[0]?.granted).toBe(false);
  // The one read asked for meanwhile runs once the first is done.
  expect(calls).toBe(2);
  await actRun(() => pending.shift()!(reading(true)));
  await flush();
  expect(hook.result.current.status?.permissions?.[0]?.granted).toBe(true);
  expect(calls).toBe(2);
  await hook.unmount();
});

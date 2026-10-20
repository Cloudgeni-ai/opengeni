import { expect, test } from "bun:test";
import type { ThisComputerHost, ThisComputerStatus } from "@opengeni/sdk/this-computer";
import { useThisComputer } from "../src/components/this-computer/use-this-computer";
import { actRun, flush, registerDom, renderHook, renderComponent } from "./render-hook";
import { ThisComputerCard } from "../src/components/this-computer/this-computer-card";
import { ThisComputerSetup } from "../src/components/this-computer/this-computer-setup";
import type { UseThisComputerResult } from "../src/components/this-computer/use-this-computer";

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

test("service permission setup never treats a reconnect's missing report as a grant", async () => {
  let ready = 0;
  const noop = async () => undefined;
  const render = (status: ThisComputerStatus) => {
    const computer: UseThisComputerResult = {
      status,
      acting: false,
      actionError: null,
      canDisconnect: true,
      refresh: () => undefined,
      connect: async () => status,
      pause: noop,
      resume: noop,
      disconnect: noop,
      requestPermission: noop,
    };
    return (
      <ThisComputerSetup
        open
        onOpenChange={() => undefined}
        computer={computer}
        platform="macos"
        productName="Desktop App"
        container={document.body}
        onReady={() => ready++}
      />
    );
  };
  const initial: ThisComputerStatus = {
    ...connected,
    management: "service",
    permissionAppName: "Opengeni Agent",
    permissions: [
      { id: "screenRecording", granted: true },
      { id: "accessibility", granted: false },
    ],
  };
  const view = await renderComponent(render(initial));
  try {
    expect(document.body.textContent).toContain("Let Opengeni Agent click and type");
    await view.rerender(render({ ...connected, management: "service", reconnecting: true }));
    expect(document.body.textContent).not.toContain("Step 1 of 0");
    expect(document.body.textContent).not.toContain("Allowed");
    expect(ready).toBe(0);
    await view.rerender(render(initial));
    expect(document.body.textContent).toContain("Let Opengeni Agent click and type");
    expect(ready).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("a product-owned connect flow needs no app install and reports callback failure without false readiness", async () => {
  let calls = 0;
  let ready = 0;
  let reject!: (error: Error) => void;
  const view = await renderComponent(
    <ThisComputerCard
      productName="Acme"
      rationale="Use the files on your computer."
      onConnect={() => {
        calls += 1;
        return new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      }}
      onReady={() => {
        ready += 1;
      }}
    />,
  );
  expect(view.container.textContent).not.toContain("Get Acme");
  const button = view.container.querySelector<HTMLButtonElement>("button")!;
  await actRun(() => {
    button.click();
    button.click();
  });
  expect(calls).toBe(1);
  expect(button.disabled).toBe(true);
  await actRun(() => reject(new Error("Disconnected")));
  await flush();
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  expect(button.disabled).toBe(false);
  expect(ready).toBe(0);
  await view.unmount();
});

test("the shared card connects directly, reports actual readiness and does not require an intro click", async () => {
  const { host, changed } = fakeHost([connected]);
  let state: ThisComputerStatus = { ...connected, state: "not_installed" };
  let calls = 0;
  let setup = 0;
  let ready = 0;
  host.status = async () => state;
  host.connect = async () => {
    calls += 1;
    state = connected;
    changed();
    return state;
  };
  function Card() {
    const computer = useThisComputer(host, "workspace");
    return (
      <ThisComputerCard
        productName="Acme"
        computer={computer}
        onSetup={() => {
          setup += 1;
        }}
        onReady={() => {
          ready += 1;
        }}
      />
    );
  }
  const view = await renderComponent(<Card />);
  await flush();
  await actRun(() => view.container.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  expect(calls).toBe(1);
  expect(setup).toBe(0);
  expect(ready).toBe(1);
  expect(view.container.textContent).toContain("Agents can use studio");
  await view.unmount();
});

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

test("repeated connect clicks share one host mutation", async () => {
  const { host } = fakeHost([connected]);
  let finish!: (status: ThisComputerStatus) => void;
  let calls = 0;
  host.connect = () => {
    calls += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const hook = await renderHook(() => useThisComputer(host, "workspace-1"), undefined);
  let first!: Promise<ThisComputerStatus | null>;
  let duplicate!: Promise<ThisComputerStatus | null>;
  await actRun(() => {
    first = hook.result.current.connect({ screenControl: true });
    duplicate = hook.result.current.connect({ screenControl: true });
  });
  expect(calls).toBe(1);
  expect(await duplicate).toBeNull();
  await actRun(() => finish(connected));
  expect(await first).toEqual(connected);
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

import { expect, setSystemTime, test } from "bun:test";
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
      pending: null,
      asking: null,
      allowPermissions: () => undefined,
      refresh: () => undefined,
      connect: async () => status,
      turnOn: async () => status,
      turnOff: noop,
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

test("turning it on shows one state at a time and follows the computer back when it falls back", async () => {
  const noop = async () => undefined;
  const off: ThisComputerStatus = { ...connected, state: "not_connected", management: "service" };
  const waiting: ThisComputerStatus = { ...connected, management: "service", reconnecting: true };
  const ready: ThisComputerStatus = { ...connected, management: "service" };
  const removed: ThisComputerStatus = {
    ...off,
    errorCode: "removed",
    error: "This computer is no longer in this workspace.",
  };
  const render = (status: ThisComputerStatus) => {
    const computer: UseThisComputerResult = {
      status,
      acting: false,
      actionError: null,
      canDisconnect: true,
      pending: null,
      asking: null,
      allowPermissions: () => undefined,
      refresh: () => undefined,
      connect: async () => waiting,
      turnOn: async () => waiting,
      turnOff: noop,
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
      />
    );
  };
  const text = () => document.body.textContent ?? "";
  const view = await renderComponent(render(off));
  try {
    const turnOn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Turn on",
    );
    await actRun(() => turnOn!.click());
    await flush();
    await view.rerender(render(waiting));
    expect(text()).toContain("Turning on studio…");
    expect(text()).toContain("Waiting for the Opengeni agent on this computer to come online.");
    expect(text()).not.toContain("You're all set");

    await view.rerender(render(ready));
    expect(text()).toContain("You're all set");
    expect(text()).not.toContain("Waiting for");
    expect(text()).not.toContain("Turning on");

    // The agent stopped reporting: not all set any more.
    await view.rerender(render(waiting));
    expect(text()).toContain("Turning on studio…");
    expect(text()).not.toContain("You're all set");

    // Removed elsewhere meanwhile: back to the start, as if never set up.
    await view.rerender(render(removed));
    expect(text()).not.toContain("removed");
    expect(text()).not.toContain("You're all set");
    expect(text()).not.toContain("Waiting for");
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).toContain("Turn on");
    expect(buttons).not.toContain("Reconnect");
  } finally {
    await view.unmount();
  }
});

test("turning computer use on does what it needs: resume, register afresh, or nothing", async () => {
  const run = async (
    readings: ThisComputerStatus[],
  ): Promise<{ calls: string[]; result: ThisComputerStatus | null }> => {
    const calls: string[] = [];
    let index = 0;
    const read = () => ({ ...readings[Math.min(index, readings.length - 1)]! });
    const host: ThisComputerHost = {
      platform: "macos",
      productName: "App",
      status: async () => read(),
      connect: async (_workspace, options) => {
        calls.push(`connect:${options.screenControl}`);
        index = readings.length - 1;
        return read();
      },
      pause: async () => {
        calls.push("pause");
      },
      resume: async () => {
        calls.push("resume");
        index += 1;
      },
      onChange: () => () => undefined,
    };
    const hook = await renderHook(() => useThisComputer(host, "workspace"), undefined);
    await flush();
    let result: ThisComputerStatus | null = null;
    await actRun(async () => {
      result = await hook.result.current.turnOn();
    });
    await flush();
    expect(hook.result.current.pending).toBeNull();
    await hook.unmount();
    return { calls, result };
  };
  const paused: ThisComputerStatus = { ...connected, state: "paused" };
  const off: ThisComputerStatus = { ...connected, state: "not_connected" };
  const removed: ThisComputerStatus = {
    ...off,
    errorCode: "removed",
    error: "This computer is no longer in this workspace.",
  };

  // Off is paused: resuming keeps the registration.
  expect((await run([paused, connected])).calls).toEqual(["resume"]);
  // Never set up, or removed on the server: a fresh registration.
  expect((await run([off, connected])).calls).toEqual(["connect:true"]);
  expect((await run([removed, connected])).calls).toEqual(["connect:true"]);
  // Paused, and the registration turned out to be gone: resume, then register.
  expect((await run([paused, removed, connected])).calls).toEqual(["resume", "connect:true"]);
  // Already on: nothing to do.
  expect((await run([connected])).calls).toEqual([]);
  // On but failing: start it again.
  const failing = { ...connected, reconnecting: true, errorCode: "offline" as const, error: "x" };
  expect((await run([failing, connected])).calls).toEqual(["resume"]);
});

test("turning computer use off pauses it and shows off at once", async () => {
  const { host } = fakeHost([connected]);
  let finish!: () => void;
  host.pause = () => new Promise<void>((resolve) => (finish = resolve));
  const hook = await renderHook(() => useThisComputer(host, "workspace"), undefined);
  await flush();
  let done!: Promise<void>;
  await actRun(() => {
    done = hook.result.current.turnOff();
  });
  expect(hook.result.current.pending).toBe("off");
  expect(hook.result.current.acting).toBe(true);
  await actRun(async () => {
    finish();
    await done;
  });
  expect(hook.result.current.pending).toBeNull();
  await hook.unmount();
});

function permissionHost(granted: { screenRecording: boolean }) {
  const asked: string[] = [];
  const read = (): ThisComputerStatus => ({
    ...connected,
    permissions: [{ id: "screenRecording", granted: granted.screenRecording }],
  });
  const host: ThisComputerHost = {
    platform: "macos",
    productName: "App",
    status: async () => read(),
    connect: async () => read(),
    pause: async () => undefined,
    resume: async () => undefined,
    requestPermission: async (id) => {
      asked.push(id);
    },
    onChange: () => () => undefined,
  };
  return { host, asked, read };
}

function withFocus(focused: () => boolean): () => void {
  const previous = Object.getOwnPropertyDescriptor(document, "hasFocus");
  Object.defineProperty(document, "hasFocus", { configurable: true, value: focused });
  return () => {
    if (previous) Object.defineProperty(document, "hasFocus", previous);
    else Reflect.deleteProperty(document, "hasFocus");
  };
}

test("asking ends by itself when no system window comes up, and goes on while the person is away", async () => {
  let focused = true;
  const restore = withFocus(() => focused);
  const { host, asked } = permissionHost({ screenRecording: false });
  const hook = await renderHook(
    () => useThisComputer(host, "workspace", { askQuietMs: 40 }),
    undefined,
  );
  try {
    await flush();
    // macOS already decided: nothing opens, the app keeps focus, asking stops once.
    await actRun(() => hook.result.current.allowPermissions());
    expect(hook.result.current.asking).toBe("screenRecording");
    await actRun(() => new Promise((resolve) => setTimeout(resolve, 150)));
    await flush();
    expect(hook.result.current.asking).toBeNull();
    expect(asked).toEqual(["screenRecording"]);

    // In System Settings (the app in the background): it keeps asking.
    focused = false;
    await actRun(() => hook.result.current.allowPermissions());
    await actRun(() => new Promise((resolve) => setTimeout(resolve, 150)));
    await flush();
    expect(hook.result.current.asking).toBe("screenRecording");
  } finally {
    restore();
    await hook.unmount();
  }
});

test("asks for what a just-returned reading lacks, before the shared one catches up", async () => {
  const { host, asked, read } = permissionHost({ screenRecording: true });
  const hook = await renderHook(() => useThisComputer(host, "workspace"), undefined);
  try {
    await flush();
    // The hook's reading has everything; the one an action returned doesn't.
    await actRun(() => hook.result.current.allowPermissions());
    expect(asked).toEqual([]);
    await actRun(() =>
      hook.result.current.allowPermissions({
        ...read(),
        permissions: [{ id: "screenRecording", granted: false }],
      }),
    );
    expect(asked).toEqual(["screenRecording"]);
  } finally {
    await hook.unmount();
  }
});

test("turning off goes straight to Off, never On again in between", async () => {
  let paused = false;
  const host: ThisComputerHost = {
    platform: "macos",
    productName: "App",
    status: async () => (paused ? { ...connected, state: "paused" } : connected),
    connect: async () => connected,
    pause: async () => {
      paused = true;
    },
    resume: async () => undefined,
    onChange: () => () => undefined,
  };
  const seen: string[] = [];
  const hook = await renderHook(() => {
    const computer = useThisComputer(host, "workspace");
    seen.push(`${computer.pending ?? "-"}:${computer.status?.state ?? "none"}`);
    return computer;
  }, undefined);
  try {
    await flush();
    await actRun(async () => {
      await hook.result.current.turnOff();
    });
    // Once nothing is pending any more, the reading already says paused.
    const settled = seen.filter((entry) => entry.startsWith("-:"));
    expect(settled.at(-1)).toBe("-:paused");
    expect(settled.slice(settled.indexOf("-:connected") + 1).includes("-:connected")).toBe(false);
  } finally {
    await hook.unmount();
  }
});

test("turning on asks for each missing permission in turn, and stops when the person declines", async () => {
  const listeners = new Set<() => void>();
  const asked: string[] = [];
  let granted = { screenRecording: false, accessibility: false };
  let state: ThisComputerStatus["state"] = "not_connected";
  const read = (): ThisComputerStatus => ({
    ...connected,
    state,
    permissions: [
      { id: "screenRecording", granted: granted.screenRecording },
      { id: "accessibility", granted: granted.accessibility },
    ],
  });
  const host: ThisComputerHost = {
    platform: "macos",
    productName: "App",
    status: async () => read(),
    connect: async () => {
      state = "connected";
      return read();
    },
    pause: async () => undefined,
    resume: async () => undefined,
    requestPermission: async (id) => {
      asked.push(id);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const changed = () => listeners.forEach((listener) => listener());
  const hook = await renderHook(() => useThisComputer(host, "workspace"), undefined);
  await flush();
  try {
    // One step: on, then straight to the first missing permission.
    await actRun(async () => {
      await hook.result.current.turnOn();
    });
    await flush();
    expect(asked).toEqual(["screenRecording"]);
    expect(hook.result.current.asking).toBe("screenRecording");

    // Allowed: the next one is asked for without another click.
    granted = { ...granted, screenRecording: true };
    await actRun(changed);
    await flush();
    expect(asked).toEqual(["screenRecording", "accessibility"]);
    expect(hook.result.current.asking).toBe("accessibility");

    // Back in the app without allowing it: asking stops, with no new prompt.
    setSystemTime(new Date(Date.now() + 5_000));
    await actRun(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(hook.result.current.asking).toBeNull();
    expect(asked).toHaveLength(2);

    // "Open System Settings" asks for that one again, on request only.
    await actRun(() => hook.result.current.allowPermissions());
    await flush();
    expect(asked).toEqual(["screenRecording", "accessibility", "accessibility"]);
    // Allowed now: everything is in place and asking ends by itself.
    granted = { ...granted, accessibility: true };
    await actRun(changed);
    await flush();
    expect(hook.result.current.asking).toBeNull();
    expect(asked).toHaveLength(3);
  } finally {
    setSystemTime();
    await hook.unmount();
  }
});

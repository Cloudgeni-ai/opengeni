import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, Suspense, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

import { useLatestCallback } from "./context";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("useLatestCallback", () => {
  test("keeps one identity while dispatching to the latest render", async () => {
    let current: (() => string) | null = null;

    function Harness({ value }: { value: string }) {
      current = useLatestCallback(() => value);
      return null;
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness value="first" />));
    const initial = current as unknown as () => string;

    expect(initial()).toBe("first");

    await act(async () => root.render(<Harness value="second" />));

    expect(current as unknown as () => string).toBe(initial);
    expect(initial()).toBe("second");
    await act(async () => root.unmount());
  });

  test("never exposes a callback from a suspended, uncommitted render", async () => {
    let current: (() => string) | null = null;
    let blocked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    function Harness({ value }: { value: string }) {
      current = useLatestCallback(() => value);
      return null;
    }

    function CommitGate() {
      if (blocked) throw gate;
      return null;
    }

    const view = (value: string) => (
      <Suspense fallback={null}>
        <Harness value={value} />
        <CommitGate />
      </Suspense>
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(view("committed")));
    const committed = current as unknown as () => string;

    blocked = true;
    act(() => root.render(view("not-committed")));
    expect(current as unknown as () => string).toBe(committed);
    expect(committed()).toBe("committed");

    blocked = false;
    await act(async () => release());
    expect(committed()).toBe("not-committed");
    await act(async () => root.unmount());
  });

  test("publishes the committed body before descendant layout effects run", async () => {
    const observed: string[] = [];

    function Observer({ read }: { read: () => string }) {
      useLayoutEffect(() => {
        observed.push(read());
      });
      return null;
    }

    function Harness({ value }: { value: string }) {
      const read = useLatestCallback(() => value);
      return <Observer read={read} />;
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness value="first" />));
    await act(async () => root.render(<Harness value="second" />));

    expect(observed).toEqual(["first", "second"]);
    await act(async () => root.unmount());
  });
});

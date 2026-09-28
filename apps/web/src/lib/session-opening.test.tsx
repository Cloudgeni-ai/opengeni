import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSessionOpening } from "./session-opening";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function Probe({ id, ready }: { id: string; ready: boolean }) {
  return <span>{useSessionOpening(id, ready).opened ? "opened" : "pending"}</span>;
}

test("failed initialization/retry stays pending, later reads preserve the open composer, and A-B-A is a new visit", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (id: string, ready: boolean) => {
    await act(async () => root.render(<Probe id={id} ready={ready} />));
  };
  try {
    await render("workspace:A", false);
    expect(container.textContent).toBe("pending");
    await render("workspace:A", false); // first read failed, retry pending
    expect(container.textContent).toBe("pending");
    await render("workspace:A", true);
    expect(container.textContent).toBe("opened");
    await render("workspace:A", false); // later history navigation/reconnect
    expect(container.textContent).toBe("opened");
    await render("workspace:B", false);
    expect(container.textContent).toBe("pending");
    await render("workspace:A", false);
    expect(container.textContent).toBe("pending");
    await render("workspace:A", true); // success or trusted creation handoff
    expect(container.textContent).toBe("opened");
    await render("other-workspace:A", false);
    expect(container.textContent).toBe("pending");
  } finally {
    await act(async () => root.unmount());
  }
});

test("observed history outlives an empty reload, independently of known-empty initialization", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  function HistoryProbe({ id, hasEvents }: { id: string; hasEvents: boolean }) {
    const value = useSessionOpening(id, true, hasEvents);
    return (
      <span>
        {value.opened ? (value.hasObservedHistory ? "history" : "known-empty") : "pending"}
      </span>
    );
  }
  const render = async (id: string, hasEvents: boolean) => {
    await act(async () => root.render(<HistoryProbe id={id} hasEvents={hasEvents} />));
  };
  try {
    await render("A", false);
    expect(container.textContent).toBe("known-empty");
    await render("A", true);
    expect(container.textContent).toBe("history");
    await render("A", false); // pending, rejected, or retried latest-tail read
    expect(container.textContent).toBe("history");
    await render("B", false);
    expect(container.textContent).toBe("known-empty");
    await render("A", false);
    expect(container.textContent).toBe("known-empty");
  } finally {
    await act(async () => root.unmount());
  }
});

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeferredChatMedia } from "./deferred-chat-media";

let ownsDom = false;
let previousAct: PropertyDescriptor | undefined;
let previousObserver: PropertyDescriptor | undefined;
let root: Root;
let container: HTMLDivElement;
let notify: IntersectionObserverCallback;
let options: IntersectionObserverInit | undefined;
let mounts = 0;
let unmounts = 0;
let disconnects = 0;

beforeAll(() => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});
beforeEach(() => {
  mounts = unmounts = disconnects = 0;
  options = undefined;
  previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
        notify = callback;
        options = init;
      }
      observe() {}
      disconnect() {
        disconnects++;
      }
    },
  });
  container = document.createElement("div");
  container.setAttribute("data-og-timeline-scroller", "");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
  else Reflect.deleteProperty(globalThis, "IntersectionObserver");
});
afterAll(async () => {
  if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (ownsDom) await GlobalRegistrator.unregister();
});

function Media() {
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return <iframe title="Preview" sandbox="" />;
}
const render = () =>
  act(async () =>
    root.render(
      <DeferredChatMedia height={450} label="Site preview">
        <Media />
      </DeferredChatMedia>,
    ),
  );
const intersect = (isIntersecting: boolean) =>
  act(async () =>
    notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver),
  );

test("reserves the slot without mounting offscreen loaders and observes the chat viewport", async () => {
  await render();
  expect(mounts).toBe(0);
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector<HTMLElement>("[style]")?.style.height).toBe("450px");
  expect(options?.root).toBe(container);
  expect(options?.rootMargin).toBe("200px 0px");
  await intersect(false);
  expect(mounts).toBe(0);
  await intersect(true);
  expect(mounts).toBe(1);
  expect(disconnects).toBeGreaterThan(0);
  await intersect(false);
  await render();
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
});

test("explicit activation works without an intersection notification", async () => {
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(mounts).toBe(1);
});

test("browsers without IntersectionObserver can still load media", async () => {
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  await render();
  expect(mounts).toBe(1);
});

test("queued notifications after unmount do not start media work", async () => {
  await render();
  await act(async () => root.render(null));
  await intersect(true);
  expect(mounts).toBe(0);
});

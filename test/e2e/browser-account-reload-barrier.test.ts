import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { observeReloadCapabilities } from "./browser-account-reload-barrier";

const url =
  "http://localhost/v1/workspaces/11111111-1111-4111-8111-111111111111/sessions/22222222-2222-4222-8222-222222222222/stream-capabilities";
function fixture() {
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
  const frame = {};
  let phase = "slot-revocation-reauthentication";
  const observer = observeReloadCapabilities(page as unknown as Page, {
    url,
    actorEpoch: "7",
    actorEpochHeader: "actor",
    phase: () => phase,
  });
  const request = (override = {}) => {
    const read = {
      url: () => url,
      method: () => "GET",
      frame: () => frame,
      headers: () => ({ actor: "7" }),
      ...override,
    };
    page.emit("request", read);
    return read;
  };
  const finish = (read: ReturnType<typeof request>, status = 404) => {
    page.emit("response", { url: read.url, request: () => read, status: () => status });
    page.emit("requestfinished", read);
  };
  const console = () =>
    page.emit("console", {
      location: () => ({ url }),
      type: () => "error",
      text: () => "Failed to load resource: the server responded with a status of 404 (Not Found)",
    });
  return {
    page,
    observer,
    request,
    finish,
    console,
    changePhase: () => {
      phase = "later";
    },
  };
}

test("late identified response AND console must precede gate clear", async () => {
  const f = fixture();
  const first = f.request(),
    second = f.request();
  f.finish(first);
  f.console();
  let cleared = false;
  const barrier = f.observer.wait(500).then(() => {
    cleared = true;
  });
  await Bun.sleep(20);
  expect(cleared).toBe(false);
  f.finish(second);
  await Bun.sleep(20);
  expect(cleared).toBe(false);
  f.console();
  await barrier;
  expect(cleared).toBe(true);
  f.observer.dispose();
  expect(f.page.eventNames()).toEqual([]);
});

test("extra reload request fails before or during wait", async () => {
  for (const during of [false, true]) {
    const f = fixture();
    f.request();
    f.request();
    if (!during) f.request();
    const barrier = f.observer.wait(500);
    if (during) f.request();
    await expect(barrier).rejects.toThrow("identity/count");
    f.observer.dispose();
  }
});

test("unrelated pending traffic is not drained, but missing reload identities fail", async () => {
  const f = fixture();
  f.request({ url: () => "http://localhost/unrelated-still-pending" });
  for (let i = 0; i < 2; i++) {
    f.finish(f.request());
    f.console();
  }
  await f.observer.wait(20);
  f.observer.dispose();
  for (const count of [0, 1]) {
    const missing = fixture();
    for (let i = 0; i < count; i++) missing.request();
    await expect(missing.observer.wait()).rejects.toThrow("identity/count");
    missing.observer.dispose();
  }
});

test("unknown URL origin, query, actor, method or frame cannot borrow allowance", async () => {
  for (const override of [
    { url: () => url.replace("localhost", "other.test") },
    { url: () => `${url}?extra=1` },
    { headers: () => ({}) },
    { headers: () => ({ actor: "8" }) },
    { method: () => "POST" },
    { frame: () => ({}) },
  ]) {
    const f = fixture();
    f.request();
    f.request(override);
    await expect(f.observer.wait()).rejects.toThrow("identity/count");
    f.observer.dispose();
  }
});

test("timeout fails for a pending response or missing console", async () => {
  for (const finishSecond of [false, true]) {
    const f = fixture();
    const first = f.request(),
      second = f.request();
    f.finish(first);
    f.console();
    if (finishSecond) f.finish(second);
    await expect(f.observer.wait(20)).rejects.toThrow("timeout");
    f.observer.dispose();
  }
});

test("excess console, wrong status, failed terminal, unmatched response and phase fail closed", async () => {
  for (const mode of ["console", "status", "failed", "unmatched", "phase"]) {
    const f = fixture();
    const first = f.request(),
      second = f.request();
    f.finish(first);
    f.console();
    f.finish(second);
    f.console();
    if (mode === "console") f.console();
    if (mode === "status") f.finish(first, 500);
    if (mode === "failed") f.page.emit("requestfailed", first);
    if (mode === "unmatched") f.finish({ ...first });
    if (mode === "phase") f.changePhase();
    await expect(f.observer.wait()).rejects.toThrow();
    f.observer.dispose();
  }
});

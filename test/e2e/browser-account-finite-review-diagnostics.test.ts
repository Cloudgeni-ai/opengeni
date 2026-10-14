import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright";

import {
  createFiniteReviewReadDiagnostics,
  finiteReviewDiagnosticPath,
  installFiniteReviewBrowserCapture,
  sanitizeFiniteReviewBrowserCapture,
} from "./browser-account-finite-review-diagnostics";

const REVIEW_EVENT = "opengeni:knowledge-review-updated";
const SAFE_PATH = "/v1/workspaces/:workspace/knowledge/entries/search";
const SECRET_URL =
  "https://private-user:private-password@private-host/v1/workspaces/private-workspace/knowledge/entries/search?authorization=private-token&email=private-person#private-fragment";
class TestPage extends EventEmitter {
  browser: unknown = null;
  reader: (() => Promise<unknown>) | undefined;
  scripts = 0;
  async addInitScript() {
    this.scripts++;
  }
  async evaluate() {
    return this.reader ? this.reader() : this.browser;
  }
  mainFrame() {
    return this;
  }
  asPage() {
    return this as unknown as Page;
  }
}
const request = (url = SECRET_URL, method = "POST") => ({
  url: () => url,
  method: () => method,
  headers: () => {
    throw new Error("Headers must never be read");
  },
  postData: () => {
    throw new Error("Body must never be read");
  },
  failure: () => {
    throw new Error("Failure strings must never be read");
  },
});
function browserCapture(capacity = 128) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    readyState: "complete",
    hasFocus: () => true,
  });
  const window = Object.assign(new EventTarget(), { top: null as unknown });
  window.top = window;
  let tick = 0;
  runInNewContext(`(${installFiniteReviewBrowserCapture.toString()})({ capacity: ${capacity} })`, {
    window,
    document,
    performance: { now: () => ++tick },
  });
  const diagnostic = (
    window as unknown as {
      __opengeniFiniteReviewReadDiagnostics: {
        markIteration(value: number): void;
        snapshot(): {
          events: Array<{ kind: string; iteration: number | null }>;
          dropped: number;
          invocations: number;
          knownListeners: number | null;
        };
      };
    }
  ).__opengeniFiniteReviewReadDiagnostics;
  return { window, document, diagnostic };
}

describe("finite review failure diagnostics", () => {
  test("URL projection emits only the literal known path, with no credential/query/identity values", () => {
    expect(finiteReviewDiagnosticPath(SECRET_URL)).toBe(SAFE_PATH);
    expect(
      finiteReviewDiagnosticPath("/v1/workspaces/private/knowledge/entries/search?cookie=secret"),
    ).toBe(SAFE_PATH);
    for (const value of [
      null,
      {},
      "not-a-url",
      "file:///v1/workspaces/private/knowledge/entries/search",
      "https://private/authorization/private-token",
      "https://private/v1/workspaces/private/knowledge/entries/search/secret",
      "x".repeat(8193),
    ]) {
      expect(finiteReviewDiagnosticPath(value)).toBeNull();
    }
  });

  test("browser boundary drops arbitrary strings/fields and limits entries", () => {
    const input = {
      cookie: "private-cookie",
      events: Array.from({ length: 1000 }, (_, index) => ({
        kind: "listener-invoked",
        ms: index + 0.1234,
        iteration: index,
        listenerId: 1,
        visibility: "private-visibility",
        readyState: "private-state",
        focused: "private-person",
        knownListeners: 1,
        url: SECRET_URL,
        headers: { authorization: "private-token" },
        body: "private-body",
      })),
      dropped: 872,
      registrations: 1,
      removals: 0,
      invocations: 1000,
      knownListeners: 1,
    };
    const snapshot = sanitizeFiniteReviewBrowserCapture(input);
    expect(snapshot.events).toHaveLength(128);
    expect(snapshot.dropped).toBe(872);
    expect(
      snapshot.events.every(
        (event) =>
          event.visibility === "unavailable" &&
          event.readyState === "unavailable" &&
          event.iteration === null &&
          event.focused === false,
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(
      sanitizeFiniteReviewBrowserCapture({
        events: [
          { kind: "private-kind", ms: 1 },
          { kind: "focus", ms: Infinity },
          { kind: "focus", ms: 1e308 },
        ],
      }).events,
    ).toHaveLength(0);
    expect(sanitizeFiniteReviewBrowserCapture(null).available).toBe(false);
  });

  test("runner ring retains the newest exact network IDs and never reads sensitive fields", () => {
    const page = new TestPage();
    let now = 10;
    const diagnostic = createFiniteReviewReadDiagnostics(page.asPage(), {
      capacity: 4,
      now: () => now++,
    });
    const first = request();
    const second = request();
    diagnostic.mark(0, "response-wait");
    page.emit("request", first);
    page.emit("request", request("https://private/other", "GET"));
    page.emit("request", request("https://private/other"));
    page.emit("request", second);
    page.emit("response", { request: () => first, status: () => 200, url: () => SECRET_URL });
    page.emit("requestfailed", second);
    page.emit("requestfinished", first);
    const snapshot = diagnostic.snapshot();
    expect(snapshot.events).toHaveLength(4);
    expect(snapshot.dropped).toBe(2);
    expect(snapshot.events.map((event) => event.requestId)).toEqual([2, 1, 2, 1]);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "request-dispatch",
      "response",
      "requestfailed",
      "requestfinished",
    ]);
    expect(snapshot.events.map((event) => event.ms)).toEqual([3, 4, 5, 6]);
    expect(
      snapshot.events.every((event) => event.hasQuery === true && event.matchesWaiter === false),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  test("all matching response-wait methods are observed but unknown method values are scrubbed", () => {
    const page = new TestPage();
    const diagnostic = createFiniteReviewReadDiagnostics(page.asPage());
    for (const method of ["GET", "POST", "OPTIONS", "HEAD", "private-provider-credential"]) {
      page.emit("request", request(SECRET_URL, method));
    }
    expect(diagnostic.snapshot().events.map((event) => event.method)).toEqual([
      "GET",
      "POST",
      "OPTIONS",
      "HEAD",
      "other",
    ]);
    expect(JSON.stringify(diagnostic.snapshot())).not.toContain("private");
  });

  test("success is silent and installation never flushes", async () => {
    const page = new TestPage();
    const output: unknown[] = [];
    const diagnostic = createFiniteReviewReadDiagnostics(page.asPage(), {
      emit: (value) => output.push(value),
    });
    await diagnostic.install();
    diagnostic.mark(99, "browser-assertion");
    diagnostic.snapshot();
    expect(page.scripts).toBe(1);
    expect(output).toEqual([]);
  });

  test("failure flushes once before teardown and rethrows the original error identity", async () => {
    const page = new TestPage();
    const order: string[] = [];
    const output: unknown[] = [];
    const original = new Error(SECRET_URL);
    page.reader = async () => {
      order.push("read-before-teardown");
      return { events: [], headers: "private-cookie" };
    };
    const diagnostic = createFiniteReviewReadDiagnostics(page.asPage(), {
      emit: (value) => {
        order.push("emit");
        output.push(value);
      },
    });
    let received: unknown;
    try {
      try {
        throw original;
      } catch (error) {
        await diagnostic.rethrowFailure(error);
      } finally {
        order.push("teardown");
      }
    } catch (error) {
      received = error;
    }
    expect(received).toBe(original);
    expect(order).toEqual(["read-before-teardown", "emit", "teardown"]);
    expect(output).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("private");
    await expect(diagnostic.rethrowFailure(original)).rejects.toBe(original);
    expect(output).toHaveLength(1);
  });

  test("snapshot/writer failures cannot mask even a non-Error original throw", async () => {
    const page = new TestPage();
    page.reader = async () => {
      throw new Error(SECRET_URL);
    };
    const original = { original: true };
    const diagnostic = createFiniteReviewReadDiagnostics(page.asPage(), {
      emit: () => {
        throw new Error(SECRET_URL);
      },
    });
    await expect(diagnostic.rethrowFailure(original)).rejects.toBe(original);
  });

  test("hung failure snapshot is bounded and still emits runner evidence", async () => {
    const page = new TestPage();
    page.reader = () => new Promise(() => {});
    const output: unknown[] = [];
    const original = new Error("original timeout");
    const diagnostic = createFiniteReviewReadDiagnostics(page.asPage(), {
      emit: (value) => output.push(value),
    });
    await expect(diagnostic.rethrowFailure(original)).rejects.toBe(original);
    expect(output).toHaveLength(1);
    expect((output[0] as { browser: { available: boolean } }).browser.available).toBe(false);
  });

  test("original callback receives the same this/event/return semantics, duplicates and removals remain native", () => {
    const { window, diagnostic } = browserCapture();
    const calls: Array<{ target: unknown; event: Event }> = [];
    const listener = function (this: EventTarget, event: Event) {
      calls.push({ target: this, event });
      event.preventDefault();
    };
    window.addEventListener(REVIEW_EVENT, listener);
    window.addEventListener(REVIEW_EVENT, listener, { capture: false });
    diagnostic.markIteration(17);
    const event = new Event(REVIEW_EVENT, { cancelable: true });
    expect(window.dispatchEvent(event)).toBe(false);
    expect(calls).toEqual([{ target: window, event }]);
    expect(diagnostic.snapshot().invocations).toBe(1);
    expect(diagnostic.snapshot().knownListeners).toBeNull();
    window.removeEventListener(REVIEW_EVENT, listener, { capture: false });
    window.dispatchEvent(new Event(REVIEW_EVENT));
    expect(calls).toHaveLength(1);
  });

  test("once/abort/native option getters are forwarded unchanged without additional reads", () => {
    const { window, diagnostic } = browserCapture();
    const baseline = new EventTarget();
    let baselineReads = 0;
    let observedReads = 0;
    let calls = 0;
    const listener = () => calls++;
    baseline.addEventListener(REVIEW_EVENT, () => {}, {
      get capture() {
        baselineReads++;
        return false;
      },
      once: true,
    });
    window.addEventListener(REVIEW_EVENT, listener, {
      get capture() {
        observedReads++;
        return false;
      },
      once: true,
    });
    window.dispatchEvent(new Event(REVIEW_EVENT));
    window.dispatchEvent(new Event(REVIEW_EVENT));
    expect(observedReads).toBe(baselineReads);
    expect(calls).toBe(1);
    const controller = new AbortController();
    window.addEventListener(REVIEW_EVENT, listener, { signal: controller.signal });
    controller.abort();
    window.dispatchEvent(new Event(REVIEW_EVENT));
    expect(calls).toBe(1);
    expect(diagnostic.snapshot().invocations).toBe(1);
  });

  test("browser ring is bounded and lifecycle/invalid iteration data cannot carry secrets", () => {
    const { window, document, diagnostic } = browserCapture(4);
    for (let index = 0; index < 100; index++) {
      diagnostic.markIteration(index);
      window.dispatchEvent(new Event(REVIEW_EVENT));
    }
    diagnostic.markIteration(1000);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    const snapshot = sanitizeFiniteReviewBrowserCapture(diagnostic.snapshot());
    expect(snapshot.events).toHaveLength(4);
    expect(snapshot.dropped).toBe(200);
    expect(snapshot.events.at(-1)?.kind).toBe("snapshot");
    expect(snapshot.events.at(-1)?.visibility).toBe("hidden");
    expect(snapshot.events.at(-1)?.iteration).toBeNull();
  });

  test("invalid or oversized browser capacity cannot make capture unbounded", () => {
    for (const capacity of [NaN, Infinity, 10000]) {
      const { window, diagnostic } = browserCapture(capacity);
      for (let index = 0; index < 200; index++) window.dispatchEvent(new Event(REVIEW_EVENT));
      expect(diagnostic.snapshot().events).toHaveLength(128);
    }
  });
});

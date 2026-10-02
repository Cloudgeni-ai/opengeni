import { afterEach, describe, expect, test } from "bun:test";
import {
  CLIENT_ERROR_REVISION_PATTERN,
  CLIENT_ERROR_ROUTE_PATTERN,
} from "@opengeni/contracts/client-error-report";

import {
  beaconSender,
  clientRevision,
  clientRoutePattern,
  createClientErrorReporter,
  hasObservedChunkLoadFailure,
  installGlobalClientErrorReporting,
  installVitePreloadErrorReporting,
  isChunkLoadError,
  reportCaughtClientError,
  resetChunkLoadFailureState,
  routePatternFromMatches,
  routePatternFromRoutes,
  type ClientErrorKind,
} from "./client-error-reporting";

afterEach(() => {
  resetChunkLoadFailureState();
});

describe("client error report projection", () => {
  test("keeps route patterns and drops anything that could be a concrete URL", () => {
    expect(clientRoutePattern("/workspaces/$workspaceId/sessions/$sessionId")).toBe(
      "/workspaces/$workspaceId/sessions/$sessionId",
    );
    expect(clientRoutePattern("/workspaces/$workspaceId/")).toBe("/workspaces/$workspaceId");
    expect(clientRoutePattern("/")).toBe("/");
    expect(clientRoutePattern("/workspaces/$workspaceId/variable-sets")).toBe(
      "/workspaces/$workspaceId/variable-sets",
    );
    for (const concrete of [
      "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/sessions",
      "/workspaces/abc123",
      "https://app.example.test/",
      "/billing?checkout=success",
      "/device#code",
      "",
      undefined,
      null,
    ]) {
      expect(clientRoutePattern(concrete)).toBe("unknown");
    }
  });

  test("a projected route is always one the API admits and the log keeps", () => {
    // The browser, the API route, and the public log projection share one
    // grammar; anything the projection emits must satisfy it.
    for (const fullPath of [
      "/",
      "/workspaces/$workspaceId/sessions/$sessionId",
      "/workspaces/$workspaceId/",
      "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7",
      `/${"a".repeat(200)}`,
      undefined,
    ]) {
      expect(CLIENT_ERROR_ROUTE_PATTERN.test(clientRoutePattern(fullPath))).toBe(true);
    }
    expect(clientRoutePattern(`/${"a".repeat(200)}`)).toBe("unknown");
    for (const revision of ["0123456789abcdef", "dev", "rev with spaces", undefined]) {
      expect(CLIENT_ERROR_REVISION_PATTERN.test(clientRevision(revision))).toBe(true);
    }
  });

  test("maps a loading route branch to its leaf pattern", () => {
    expect(routePatternFromRoutes([{ id: "__root__", fullPath: "/" }])).toBe("unknown");
    expect(routePatternFromRoutes([])).toBe("unknown");
    expect(
      routePatternFromRoutes([
        { id: "__root__", fullPath: "/" },
        { id: "/workspaces/$workspaceId", fullPath: "/workspaces/$workspaceId" },
        { id: "/workspaces/$workspaceId/rigs", fullPath: "/workspaces/$workspaceId/rigs" },
      ]),
    ).toBe("/workspaces/$workspaceId/rigs");
  });

  test("maps a root-only match (not found) to unknown", () => {
    expect(routePatternFromMatches([{ routeId: "__root__", fullPath: "/" }])).toBe("unknown");
    expect(routePatternFromMatches([])).toBe("unknown");
    expect(
      routePatternFromMatches([
        { routeId: "__root__", fullPath: "/" },
        { routeId: "/workspaces/$workspaceId", fullPath: "/workspaces/$workspaceId" },
        {
          routeId: "/workspaces/$workspaceId/rigs/$rigId",
          fullPath: "/workspaces/$workspaceId/rigs/$rigId",
        },
      ]),
    ).toBe("/workspaces/$workspaceId/rigs/$rigId");
  });

  test("accepts only token-shaped revisions", () => {
    expect(clientRevision("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(clientRevision("dev")).toBe("dev");
    expect(clientRevision("rev with spaces")).toBe("unknown");
    expect(clientRevision("")).toBe("unknown");
  });

  test("recognizes stale dynamic-import failures across browsers", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://app.example.test/assets/session-abc.js",
      "error loading dynamically imported module: https://app.example.test/assets/x.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/session-abc.css",
      "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of text/html",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("client error reporter", () => {
  test("sends only kind, route pattern, and revision", () => {
    const sent: string[] = [];
    const reporter = createClientErrorReporter({ send: (body) => sent.push(body), revision: "r1" });
    expect(reporter.report("route_error", "/workspaces/$workspaceId/sessions")).toBe(true);
    expect(sent.map((body) => JSON.parse(body))).toEqual([
      { kind: "route_error", route: "/workspaces/$workspaceId/sessions", revision: "r1" },
    ]);
  });

  test("dedupes a repeated kind and route, then caps the total per window", () => {
    let now = 0;
    const sent: string[] = [];
    const reporter = createClientErrorReporter({
      send: (body) => sent.push(body),
      revision: "r1",
      now: () => now,
      dedupeWindowMs: 1_000,
      maxReportsPerWindow: 3,
      rateWindowMs: 10_000,
    });
    expect(reporter.report("window_error", "/")).toBe(true);
    expect(reporter.report("window_error", "/")).toBe(false);
    expect(reporter.report("chunk_load", "/")).toBe(true);
    now = 1_000;
    expect(reporter.report("window_error", "/")).toBe(true);
    expect(reporter.report("route_error", "/billing")).toBe(false);
    now = 10_000;
    expect(reporter.report("route_error", "/billing")).toBe(true);
    expect(sent).toHaveLength(4);
  });

  test("a failing transport never throws into the caller", () => {
    const reporter = createClientErrorReporter({
      send: () => {
        throw new Error("offline");
      },
      revision: "r1",
    });
    expect(() => reporter.report("route_error", "/")).not.toThrow();
  });

  test("the beacon is a credential-free simple request that survives unload", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const send = beaconSender("/v1/client-errors", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      throw new TypeError("network down");
    }) as unknown as typeof fetch);
    send('{"kind":"route_error"}');
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/v1/client-errors");
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
  });
});

describe("global error listeners", () => {
  function install() {
    const target = new EventTarget() as unknown as Window;
    const reports: Array<[ClientErrorKind, string]> = [];
    const uninstall = installGlobalClientErrorReporting({
      target,
      routePattern: () => "/workspaces/$workspaceId/sessions",
      report: (kind, route) => reports.push([kind, route]),
    });
    const dispatch = (type: string, fields: Record<string, unknown>) =>
      target.dispatchEvent(Object.assign(new Event(type), fields));
    return { reports, uninstall, dispatch };
  }

  test("classifies window errors and unhandled rejections", () => {
    const { reports, dispatch } = install();
    dispatch("error", { message: "TypeError: x is undefined", error: new TypeError("x") });
    dispatch("unhandledrejection", { reason: new Error("request failed") });
    dispatch("unhandledrejection", {
      reason: new TypeError("Failed to fetch dynamically imported module: /assets/a.js"),
    });
    // The tab now runs a replaced build; what follows is its consequence.
    dispatch("error", { message: "TypeError: y is undefined", error: new TypeError("y") });
    expect(reports).toEqual([
      ["window_error", "/workspaces/$workspaceId/sessions"],
      ["unhandled_rejection", "/workspaces/$workspaceId/sessions"],
      ["chunk_load", "/workspaces/$workspaceId/sessions"],
    ]);
  });

  test("ignores benign layout notices, opaque cross-origin errors, and aborts", () => {
    const { reports, dispatch, uninstall } = install();
    dispatch("error", { message: "ResizeObserver loop completed with undelivered notifications." });
    dispatch("error", { message: "Script error." });
    dispatch("unhandledrejection", { reason: new DOMException("aborted", "AbortError") });
    expect(reports).toEqual([]);
    uninstall();
    dispatch("error", { message: "late", error: new Error("late") });
    expect(reports).toEqual([]);
  });
});

describe("chunk-load failures", () => {
  function recorder() {
    const reports: Array<[ClientErrorKind, string]> = [];
    return {
      reports,
      report: (kind: ClientErrorKind, route: string) => reports.push([kind, route]),
    };
  }

  test("a Vite preload error is reported once, whether or not recovery reloads", () => {
    const target = new EventTarget();
    const { reports, report } = recorder();
    const uninstall = installVitePreloadErrorReporting({
      target,
      routePattern: () => "/workspaces/$workspaceId/sessions/$sessionId",
      report,
    });
    expect(hasObservedChunkLoadFailure()).toBe(false);
    // A stylesheet and the module itself can each fail for one import.
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reports).toEqual([["chunk_load", "/workspaces/$workspaceId/sessions/$sessionId"]]);
    expect(hasObservedChunkLoadFailure()).toBe(true);
    uninstall();
    resetChunkLoadFailureState();
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reports).toHaveLength(1);
  });

  test("failures that follow a chunk-load failure are not reported again", () => {
    const { reports, report } = recorder();
    const route = () => "/billing";
    reportCaughtClientError(new TypeError("x is undefined"), "route_error", route, report);
    expect(reports).toEqual([["route_error", "/billing"]]);

    const target = new EventTarget();
    installVitePreloadErrorReporting({ target, routePattern: route, report });
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    // The follow-on of a cancelled Vite preload: the import resolved to undefined.
    reportCaughtClientError(
      new TypeError("Cannot read properties of undefined (reading 'default')"),
      "route_error",
      route,
      report,
    );
    reportCaughtClientError(new Error("late"), "unhandled_rejection", route, report);
    expect(reports).toEqual([
      ["route_error", "/billing"],
      ["chunk_load", "/billing"],
    ]);
  });

  test("a chunk-load error caught without a Vite event is reported once as chunk_load", () => {
    const { reports, report } = recorder();
    const stale = new TypeError("Importing a module script failed.");
    reportCaughtClientError(stale, "route_error", () => "/", report);
    reportCaughtClientError(stale, "unhandled_rejection", () => "/", report);
    expect(reports).toEqual([["chunk_load", "/"]]);
    expect(hasObservedChunkLoadFailure()).toBe(true);
  });
});

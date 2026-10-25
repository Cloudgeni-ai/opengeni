import { describe, expect, test } from "bun:test";
import {
  NETWORK_BODY_STALL_MS,
  NETWORK_LONG_POLL_MS,
  requestIgnoredForIdle,
  requestLoad,
  type TrackedRequest,
} from "../src/network-idle";

const request = (overrides: Partial<TrackedRequest> = {}): TrackedRequest => ({
  method: "GET",
  url: "https://example.test/data",
  loaderId: "loader-1",
  browserInitiated: false,
  stream: false,
  ignored: false,
  type: "Fetch",
  frameId: "frame-1",
  sessionId: "session-1",
  startedAt: 1_000,
  respondedAt: null,
  dataAt: null,
  ...overrides,
});

describe("requests a page does not wait for", () => {
  test.each(["Ping", "CSPViolationReport", "Prefetch", "Media", "Manifest"])(
    "%s never counts as loading",
    (type) => {
      expect(requestIgnoredForIdle(type, "https://example.test/x", false)).toBe(true);
    },
  );

  test.each(["Document", "Fetch", "XHR", "Script", "Stylesheet", "Image", "Font", "Other"])(
    "%s counts",
    (type) => {
      expect(requestIgnoredForIdle(type, "https://example.test/x", false)).toBe(false);
    },
  );

  test("local blob: and data: URLs and the browser's own icon fetch never count", () => {
    expect(requestIgnoredForIdle("Script", "blob:https://example.test/1234", false)).toBe(true);
    expect(requestIgnoredForIdle("Image", "data:image/png;base64,AAAA", false)).toBe(true);
    expect(requestIgnoredForIdle("Other", "https://example.test/favicon.ico", true)).toBe(true);
  });
});

describe("an open request's load state", () => {
  test("a request the ledger lost still counts", () => {
    expect(requestLoad(undefined, 5_000)).toBe("loading");
  });

  test("event streams and ignored requests are quiet at once", () => {
    expect(requestLoad(request({ stream: true }), 1_000)).toBe("quiet");
    expect(requestLoad(request({ ignored: true }), 1_000)).toBe("quiet");
  });

  test("a request waiting for its response loads until it is taken for a long poll", () => {
    expect(requestLoad(request(), 1_000 + NETWORK_LONG_POLL_MS - 1)).toBe("loading");
    expect(requestLoad(request(), 1_000 + NETWORK_LONG_POLL_MS)).toBe("long_poll");
  });

  test("a body that keeps receiving data keeps loading however long it takes", () => {
    const streaming = request({ respondedAt: 2_000, dataAt: 30_000 });
    expect(requestLoad(streaming, 30_000 + NETWORK_BODY_STALL_MS - 1)).toBe("loading");
  });

  test("a body with no data for the stall window is quiet", () => {
    // Headers arrived, then nothing: an unread body or a held-open stream.
    expect(requestLoad(request({ respondedAt: 2_000 }), 2_000 + NETWORK_BODY_STALL_MS)).toBe(
      "quiet",
    );
    expect(
      requestLoad(request({ respondedAt: 2_000, dataAt: 4_000 }), 4_000 + NETWORK_BODY_STALL_MS),
    ).toBe("quiet");
    // A long-answered request is judged by its body, not by its age.
    expect(requestLoad(request({ respondedAt: 20_000 }), 21_000)).toBe("loading");
  });
});

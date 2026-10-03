import { describe, expect, test } from "bun:test";

import { devApiProxyTarget } from "./vite-dev-proxy";

describe("dev API proxy target", () => {
  test("forwards to the configured API, or the loopback API port", () => {
    expect(devApiProxyTarget(undefined, undefined)).toBe("http://127.0.0.1:8000");
    expect(devApiProxyTarget("http://127.0.0.1:8123", "8123")).toBe("http://127.0.0.1:8123");
  });

  test("never forwards to itself when the browser uses the web origin", () => {
    expect(devApiProxyTarget("http://homeserver:3000", "8000")).toBe("http://127.0.0.1:8000");
    expect(devApiProxyTarget("not a url", "8001")).toBe("http://127.0.0.1:8001");
  });
});

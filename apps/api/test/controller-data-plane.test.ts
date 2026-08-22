import { describe, expect, test } from "bun:test";
import {
  BrowserControlRequestError,
  BrowserControlTransportError,
} from "@opengeni/runtime/sandbox";
import {
  controllerCacheAllowsHostFetch,
  controllerCachedUrlIsUsable,
  isOpenSandboxSignedControllerUrl,
  shouldPersistControllerDataPlaneUrl,
  withCachedController,
} from "../src/controller-data-plane";

describe("withCachedController", () => {
  test("uses a healthy cached endpoint without provisioning", async () => {
    const calls: string[] = [];
    const result = await withCachedController({
      cachedUrl: "https://controller.test/",
      createCachedClient: (url) => `cached:${url}`,
      invalidateCachedUrl: async () => calls.push("invalidate"),
      provisionClient: async () => {
        calls.push("provision");
        return "provisioned";
      },
      use: async (client) => {
        calls.push(client);
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(calls).toEqual(["cached:https://controller.test/"]);
  });

  test("invalidates a failed transport and provisions exactly once", async () => {
    const calls: string[] = [];
    const result = await withCachedController({
      cachedUrl: "https://stale.test/",
      createCachedClient: () => "cached",
      invalidateCachedUrl: async () => calls.push("invalidate"),
      provisionClient: async () => {
        calls.push("provision");
        return "provisioned";
      },
      use: async (client) => {
        calls.push(`use:${client}`);
        if (client === "cached") throw new BrowserControlTransportError("offline");
        return "recovered";
      },
    });
    expect(result).toBe("recovered");
    expect(calls).toEqual(["use:cached", "invalidate", "provision", "use:provisioned"]);
  });

  test("does not replay semantic or non-retryable failures", async () => {
    for (const error of [
      new Error("semantic failure"),
      new BrowserControlRequestError(409, {
        code: "operation_conflict",
        message: "conflict",
        retryable: false,
      }),
    ]) {
      let provisions = 0;
      await expect(
        withCachedController({
          cachedUrl: "https://controller.test/",
          createCachedClient: () => "cached",
          invalidateCachedUrl: async () => undefined,
          provisionClient: async () => {
            provisions += 1;
            return "provisioned";
          },
          use: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(provisions).toBe(0);
    }
  });
});

describe("controllerCacheAllowsHostFetch", () => {
  test("allows native tunnel roots that host-fetch JSON", () => {
    expect(controllerCacheAllowsHostFetch("wss://box.modal.host/")).toBe(true);
    expect(controllerCacheAllowsHostFetch("wss://box.modal.host:443/")).toBe(true);
  });

  test("rejects OpenSandbox lifecycle proxy prefixes that rewrite Authorization", () => {
    expect(
      controllerCacheAllowsHostFetch("ws://127.0.0.1:18090/v1/sandboxes/sbx-1/proxy/7682"),
    ).toBe(false);
  });

  test("allows OSEP-0011 signed URI prefixes that preserve Authorization", () => {
    expect(
      controllerCacheAllowsHostFetch(
        "ws://127.0.0.1:28888/sbx-1/7682/s6ph0/sigsigsig/v1/browser-sessions/session/targets/t/frames",
      ),
    ).toBe(true);
  });

  test("rejects malformed cached URLs fail-closed", () => {
    expect(controllerCacheAllowsHostFetch("https://controller.example/")).toBe(false);
    expect(controllerCacheAllowsHostFetch("not-a-url")).toBe(false);
  });
});

describe("signed controller cache", () => {
  const native = "wss://box.modal.host/";
  const expired =
    "ws://127.0.0.1:28888/sbx-1/7682/1/sigsigsig/v1/browser-sessions/session/targets/t/frames";
  const freshExpires = Math.floor(Date.parse("2099-01-01T00:00:00.000Z") / 1000).toString(36);
  const fresh = `ws://127.0.0.1:28888/sbx-1/7682/${freshExpires}/sigsigsig/v1/browser-sessions/session/targets/t/frames`;

  test("does not persist OpenSandbox signed URLs as durable controller cache", () => {
    expect(isOpenSandboxSignedControllerUrl(fresh)).toBe(true);
    expect(isOpenSandboxSignedControllerUrl(native)).toBe(false);
    expect(
      shouldPersistControllerDataPlaneUrl({
        backend: "opensandbox",
        signedEndpoints: true,
        url: fresh,
      }),
    ).toBe(false);
    expect(
      shouldPersistControllerDataPlaneUrl({
        backend: "modal",
        signedEndpoints: false,
        url: native,
      }),
    ).toBe(true);
  });

  test("treats expired signed URLs as unusable cache", () => {
    expect(controllerCachedUrlIsUsable(fresh)).toBe(true);
    expect(controllerCachedUrlIsUsable(expired)).toBe(false);
    expect(controllerCachedUrlIsUsable(native)).toBe(true);
  });
});

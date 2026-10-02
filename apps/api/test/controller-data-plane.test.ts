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
  withControllerTransportRecovery,
} from "../src/controller-data-plane";

function recoveryScope() {
  return {
    channelOperation: "browser.read" as const,
    placementKind: "sandbox_group" as const,
    recoveryState: { attempted: false },
    admitRecovery: async () => undefined,
  };
}

describe("withControllerTransportRecovery", () => {
  test("never provisions or replays ordinary control and lifecycle mutations", async () => {
    for (const channelOperation of [
      "browser.control",
      "browser.attach",
      "browser.create",
      "browser.end",
      "browser.suspend",
      "browser.resume",
    ] as const) {
      for (const transportAlreadyFailed of [false, true]) {
        const calls: string[] = [];
        const error = new BrowserControlTransportError("uncertain mutation");
        await expect(
          withControllerTransportRecovery({
            ...recoveryScope(),
            channelOperation,
            transportAlreadyFailed,
            use: async () => {
              calls.push("dispatch");
              throw error;
            },
            admitRecovery: async () => {
              calls.push("admit");
            },
            recover: async () => {
              calls.push("provision", "replay");
              return "replayed";
            },
          }),
        ).rejects.toBe(error);
        expect(calls).toEqual(["dispatch"]);
      }
    }
  });

  test("does not provision attached, connected, or external browser placements", async () => {
    for (const placementKind of [
      "attached_device",
      "connected_machine",
      "external_provider",
    ] as const) {
      const error = new BrowserControlTransportError("unavailable");
      let provisions = 0;
      await expect(
        withControllerTransportRecovery({
          ...recoveryScope(),
          placementKind,
          transportAlreadyFailed: true,
          use: async () => {
            throw error;
          },
          recover: async () => {
            provisions += 1;
            return "recovered";
          },
        }),
      ).rejects.toBe(error);
      expect(provisions).toBe(0);
    }
  });

  test("rejects stale controller authority before provisioning", async () => {
    const calls: string[] = [];
    const error = new Error("BrowserSession controller authority changed");
    await expect(
      withControllerTransportRecovery({
        ...recoveryScope(),
        transportAlreadyFailed: true,
        use: async () => "unused",
        admitRecovery: async () => {
          calls.push("revalidate-generation");
          throw error;
        },
        recover: async () => {
          calls.push("provision");
          return "recovered";
        },
      }),
    ).rejects.toBe(error);
    expect(calls).toEqual(["revalidate-generation"]);
  });

  test("journaled action recovery stays bounded across repeated Channel A callbacks", async () => {
    const scope = recoveryScope();
    const calls: string[] = [];
    const error = new BrowserControlTransportError("still unavailable");
    const callback = () =>
      withControllerTransportRecovery({
        ...scope,
        channelOperation: "browser.action",
        transportAlreadyFailed: true,
        use: async () => {
          calls.push("fresh-handle");
          throw error;
        },
        admitRecovery: async () => {
          calls.push("revalidate-generation");
        },
        recover: async () => {
          calls.push("provision");
          throw error;
        },
      });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(callback()).rejects.toBe(error);
    }
    expect(calls).toEqual(["revalidate-generation", "provision", "fresh-handle", "fresh-handle"]);
  });

  test("does not provision a healthy active controller", async () => {
    let provisions = 0;
    expect(
      await withControllerTransportRecovery({
        ...recoveryScope(),
        transportAlreadyFailed: false,
        use: async () => "healthy",
        recover: async () => {
          provisions += 1;
          return "recovered";
        },
      }),
    ).toBe("healthy");
    expect(provisions).toBe(0);
  });

  test("restarts once when a fresh placement still reaches a stopped sidecar", async () => {
    const calls: string[] = [];
    expect(
      await withControllerTransportRecovery({
        ...recoveryScope(),
        transportAlreadyFailed: false,
        use: async () => {
          calls.push("fresh-tunnel");
          throw new BrowserControlTransportError("sidecar stopped");
        },
        recover: async () => {
          calls.push("ensure-sidecar", "recover-bound-session", "read");
          return "recovered";
        },
      }),
    ).toBe("recovered");
    expect(calls).toEqual(["fresh-tunnel", "ensure-sidecar", "recover-bound-session", "read"]);
  });

  test("provisions immediately after the cached tunnel already failed", async () => {
    const calls: string[] = [];
    expect(
      await withControllerTransportRecovery({
        ...recoveryScope(),
        transportAlreadyFailed: true,
        use: async () => {
          calls.push("dead-tunnel");
          throw new BrowserControlTransportError("stopped");
        },
        recover: async () => {
          calls.push("ensure-sidecar");
          return "recovered";
        },
      }),
    ).toBe("recovered");
    expect(calls).toEqual(["ensure-sidecar"]);
  });

  test("never retries a failed recovery", async () => {
    const error = new BrowserControlTransportError("still unavailable");
    let provisions = 0;
    await expect(
      withControllerTransportRecovery({
        ...recoveryScope(),
        transportAlreadyFailed: false,
        use: async () => {
          throw error;
        },
        recover: async () => {
          provisions += 1;
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(provisions).toBe(1);
  });

  test("leaves semantic failures with the active-session caller", async () => {
    for (const error of [
      new Error("invalid response"),
      new BrowserControlRequestError(404, {
        code: "resource_unavailable",
        message: "BrowserSession controller session is absent",
        retryable: false,
      }),
      new BrowserControlRequestError(409, {
        code: "operation_conflict",
        message: "uncertain mutation",
        retryable: false,
      }),
    ]) {
      let provisions = 0;
      await expect(
        withControllerTransportRecovery({
          ...recoveryScope(),
          transportAlreadyFailed: false,
          use: async () => {
            throw error;
          },
          recover: async () => {
            provisions += 1;
            return "recovered";
          },
        }),
      ).rejects.toBe(error);
      expect(provisions).toBe(0);
    }
  });
});

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

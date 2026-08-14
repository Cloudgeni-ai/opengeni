import { describe, expect, test } from "bun:test";
import {
  BrowserControlRequestError,
  BrowserControlTransportError,
} from "@opengeni/runtime/sandbox";
import { withCachedController } from "../src/controller-data-plane";

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

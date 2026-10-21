import { afterEach, describe, expect, test } from "bun:test";
import type { App, Image, ModalClient } from "modal";
import {
  __resetSharedModalClientsForTest,
  ambientCreateBoundary,
  cachedModalApp,
  cachedModalImage,
  sharedModalClient,
  withModalCreateBoundary,
} from "../src/sandbox/providers/modal-shared-client";

const CREATE = "/modal.client.ModalClient/SandboxCreate";

function fakeCall(path: string, response: unknown = { ok: true }) {
  return {
    method: { path },
    request: {},
    requestStream: false,
    responseStream: false,
    // oxlint-disable-next-line require-yield -- unary call: the generator only returns.
    next: async function* () {
      return response;
    },
  };
}

async function drive(call: ReturnType<typeof fakeCall>): Promise<unknown> {
  const generator = (ambientCreateBoundary as (...args: unknown[]) => AsyncGenerator)(call, {});
  const result = await generator.next();
  return result.value;
}

afterEach(() => __resetSharedModalClientsForTest());

describe("shared Modal client", () => {
  test("one client per credential, environment and endpoint", () => {
    const a = sharedModalClient({ tokenId: "id", tokenSecret: "secret", environment: "main" });
    expect(sharedModalClient({ tokenId: "id", tokenSecret: "secret", environment: "main" })).toBe(
      a,
    );
    expect(
      sharedModalClient({ tokenId: "id", tokenSecret: "other", environment: "main" }),
    ).not.toBe(a);
    expect(
      sharedModalClient({ tokenId: "id", tokenSecret: "secret", environment: "dev" }),
    ).not.toBe(a);
  });

  test("ordinary calls pass through without a create boundary", async () => {
    expect(await drive(fakeCall("/modal.client.ModalClient/ContainerExec", "exec"))).toBe("exec");
  });

  test("SandboxCreate outside an active create boundary fails closed", async () => {
    await expect(drive(fakeCall(CREATE))).rejects.toThrow("active durable create boundary");
  });

  test("SandboxCreate inside a boundary reaches only that boundary, until it settles", async () => {
    const seen: string[] = [];
    // oxlint-disable-next-line require-yield -- a unary middleware only returns.
    const boundary = async function* (call: { method: { path: string } }) {
      seen.push(call.method.path);
      return { sandboxId: "sb-1" };
    };
    let late: Promise<unknown> | undefined;
    const result = await withModalCreateBoundary(boundary as never, async () => {
      const value = await drive(fakeCall(CREATE));
      // Work started inside the create inherits its async context.
      late = new Promise((resolve) => setTimeout(resolve, 5)).then(
        async () => await drive(fakeCall(CREATE)),
      );
      return value;
    });
    expect(result).toEqual({ sandboxId: "sb-1" });
    expect(seen).toEqual([CREATE]);
    await expect(late!).rejects.toThrow("active durable create boundary");
    expect(seen).toEqual([CREATE]);
  });

  test("concurrent creates each keep their own boundary", async () => {
    const make = (id: string) =>
      // oxlint-disable-next-line require-yield -- a unary middleware only returns.
      async function* () {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { sandboxId: id };
      };
    const [one, two] = await Promise.all([
      withModalCreateBoundary(make("sb-one") as never, async () => await drive(fakeCall(CREATE))),
      withModalCreateBoundary(make("sb-two") as never, async () => await drive(fakeCall(CREATE))),
    ]);
    expect(one).toEqual({ sandboxId: "sb-one" });
    expect(two).toEqual({ sandboxId: "sb-two" });
  });
});

describe("memoized Modal lookups", () => {
  test("app lookups are shared per client and failures are not cached", async () => {
    let calls = 0;
    let fail = true;
    const client = {
      apps: {
        fromName: async (name: string) => {
          calls += 1;
          if (fail) throw new Error("transient");
          return { appId: `ap-${name}`, name, environmentName: "main" };
        },
      },
    } as unknown as ModalClient;
    await expect(cachedModalApp(client, "app", { createIfMissing: true })).rejects.toThrow(
      "transient",
    );
    fail = false;
    const first = await cachedModalApp(client, "app", { createIfMissing: true });
    const second = await cachedModalApp(client, "app", { createIfMissing: true });
    expect(second).toBe(first);
    expect(calls).toBe(2);
  });

  test("registry images are built once per client and failed builds retry", async () => {
    let builds = 0;
    let fail = true;
    const client = {
      images: {
        fromRegistry: (tag: string) => ({
          build: async () => {
            builds += 1;
            if (fail) throw new Error("import failed");
            return { imageId: `im-${tag}` } as unknown as Image;
          },
        }),
      },
    } as unknown as ModalClient;
    const app = { appId: "ap-1", environmentName: "main" } as App;
    const ref = { kind: "tag" as const, value: "registry/image@sha256:abc" };
    await expect(cachedModalImage(client, app, ref)).rejects.toThrow("import failed");
    fail = false;
    const first = await cachedModalImage(client, app, ref);
    expect(await cachedModalImage(client, app, ref)).toBe(first);
    expect(builds).toBe(2);
  });
});

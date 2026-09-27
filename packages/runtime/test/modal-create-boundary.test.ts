import { describe, expect, test } from "bun:test";
import {
  createModalProviderCreateBoundary,
  modalCreateOperationName,
} from "../src/sandbox/providers/modal-create-boundary";

const operationId = "11111111-1111-4111-8111-111111111111";
const path = "/modal.client.ModalClient/SandboxCreate";
const request = () => ({ appId: "ap-test", definition: { imageId: "im-test" }, tags: [] });
type Boundary = ReturnType<typeof createModalProviderCreateBoundary>;
async function invoke(
  boundary: Boundary,
  next: (request: any, options: any) => Promise<unknown>,
  overrides: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
) {
  const iterator = boundary(
    {
      method: { path },
      requestStream: false,
      responseStream: false,
      request: request(),
      // eslint-disable-next-line require-yield -- Unary nice-grpc returns its response through the generator's return value.
      next: async function* (wire: unknown, opts: unknown) {
        return await next(wire, opts);
      },
      ...overrides,
    } as never,
    options,
  );
  let result = await iterator.next();
  while (!result.done) result = await iterator.next();
  return result.value;
}

describe("Modal physical-create boundary", () => {
  test("persists intent before dispatch and receipt before returning; preserves unrelated fields", async () => {
    const events: string[] = [];
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async (intent) => {
        events.push("intent");
        expect(intent).toMatchObject({ operationId, appId: "ap-test", imageId: "im-test" });
        expect(intent.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(JSON.stringify(intent)).not.toContain("private-value");
      },
      onReceipt: async (receipt) => {
        events.push("receipt");
        expect(receipt.instanceId).toBe("sb-test");
      },
    });
    const response = await invoke(
      boundary,
      async (wire, opts) => {
        events.push("dispatch");
        expect(wire.definition).toEqual({
          imageId: "im-test",
          name: modalCreateOperationName(operationId),
          secretIds: ["private-value"],
        });
        expect(wire.tags).toEqual([
          { tagName: "fixture", tagValue: "test" },
          { tagName: "opengeni_provider_create_operation_id", tagValue: operationId },
        ]);
        expect(opts.retries).toBe(0);
        return { sandboxId: "sb-test" };
      },
      {
        request: {
          ...request(),
          definition: { imageId: "im-test", secretIds: ["private-value"] },
          tags: [{ tagName: "fixture", tagValue: "test" }],
        },
      },
      { retries: 9 },
    );
    expect(response).toEqual({ sandboxId: "sb-test" });
    expect(events).toEqual(["intent", "dispatch", "receipt"]);
  });

  test("failed admission and concurrent calls never dispatch", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched = 0;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async () => {
        await waiting;
        throw new Error("database acknowledgement lost");
      },
      onReceipt: async () => {
        throw new Error("must not reach receipt");
      },
    });
    const dispatch = async () => {
      dispatched++;
      return { sandboxId: "sb-test" };
    };
    const first = invoke(boundary, dispatch);
    await expect(invoke(boundary, dispatch)).rejects.toThrow("already attempted");
    release();
    await expect(first).rejects.toThrow("database acknowledgement lost");
    expect(dispatched).toBe(0);
  });

  test.each(["transport lost", "receipt lost"])("%s does not license a replay", async (failure) => {
    let dispatched = 0;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async () => {},
      onReceipt: async () => {
        throw new Error("receipt lost");
      },
    });
    const dispatch = async () => {
      dispatched++;
      if (failure === "transport lost") throw new Error(failure);
      return { sandboxId: "sb-test" };
    };
    await expect(invoke(boundary, dispatch)).rejects.toThrow(failure);
    await expect(invoke(boundary, dispatch)).rejects.toThrow("already attempted");
    expect(dispatched).toBe(1);
  });

  test("cancellation after the provider reply still records its identity", async () => {
    const controller = new AbortController();
    let recorded: string | undefined;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async () => {},
      onReceipt: async ({ instanceId }) => {
        expect(controller.signal.aborted).toBe(true);
        recorded = instanceId;
      },
    });
    await invoke(
      boundary,
      async () => {
        controller.abort();
        return { sandboxId: "sb-test" };
      },
      {},
      { signal: controller.signal },
    );
    expect(recorded).toBe("sb-test");
  });

  test("preparation RPCs pass through without consuming create authority", async () => {
    let claims = 0;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async () => {
        claims++;
      },
      onReceipt: async () => {},
    });
    await expect(
      invoke(
        boundary,
        async () => {
          throw new Error("missing image");
        },
        { method: { path: "/modal.client.ModalClient/ImageGet" } },
      ),
    ).rejects.toThrow("missing image");
    expect(claims).toBe(0);
    await invoke(boundary, async () => ({ sandboxId: "sb-test" }));
    expect(claims).toBe(1);
  });

  test("malformed or conflicting wire identities fail before admission", async () => {
    let claims = 0;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async () => {
        claims++;
      },
      onReceipt: async () => {},
    });
    for (const wire of [
      {},
      { ...request(), definition: { imageId: "im-test", name: "someone-else" } },
    ]) {
      await expect(
        invoke(
          boundary,
          async () => {
            throw new Error("unexpected dispatch");
          },
          { request: wire },
        ),
      ).rejects.toThrow("wire identity");
    }
    expect(claims).toBe(0);
  });

  test("missing returned identity remains fenced", async () => {
    const boundary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async () => {},
      onReceipt: async () => {
        throw new Error("unexpected receipt");
      },
    });
    await expect(invoke(boundary, async () => ({}))).rejects.toThrow("remains uncertain");
    await expect(invoke(boundary, async () => ({ sandboxId: "sb-test" }))).rejects.toThrow(
      "already attempted",
    );
  });
});

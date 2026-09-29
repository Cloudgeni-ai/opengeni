import { createHash } from "node:crypto";
import type { ModalClient } from "modal";

type ModalMiddleware = NonNullable<
  NonNullable<ConstructorParameters<typeof ModalClient>[0]>["grpcMiddleware"]
>[number];

const CREATE_PATH = "/modal.client.ModalClient/SandboxCreate";
const OPERATION_TAG = "opengeni_provider_create_operation_id";

export type ModalCreateIntent = {
  operationId: string;
  name: string;
  appId: string;
  imageId: string;
  requestSha256: string;
};

export function modalCreateOperationName(operationId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(operationId)) {
    throw new Error("Modal create requires a UUID operation identity");
  }
  return `opengeni-create-${operationId}`;
}

/** One controller per attempted physical create, on a dedicated Modal client.
 *
 * Modal 0.9.0 runs this middleware outside its retry middleware. Disable retries
 * for this RPC: the SDK otherwise invents a new, unpersisted idempotency key.
 * Preparation (image builds, secret hydration) runs before this boundary. Once
 * beforeDispatch starts, even an interrupted database acknowledgement is an
 * uncertain attempt. Neither an exception nor named lookup absence licenses a
 * second dispatch. The durable lease, not this in-memory latch, owns recovery.
 *
 * Names/tags are atomic positive-discovery aids, never a quiescence guarantee.
 * No raw request, environment, or secret material leaves this adapter.
 */
export function createModalProviderCreateBoundary(input: {
  operationId: string;
  beforeDispatch: (intent: ModalCreateIntent) => Promise<void>;
  onReceipt: (receipt: ModalCreateIntent & { instanceId: string }) => Promise<void>;
}): ModalMiddleware {
  const name = modalCreateOperationName(input.operationId);
  let attempted = false;
  return async function* modalProviderCreateBoundary(call, options) {
    if (call.method.path !== CREATE_PATH) return yield* call.next(call.request, options);
    if (call.requestStream || call.responseStream) {
      throw new Error("Modal SandboxCreate unexpectedly became a streaming RPC");
    }
    if (attempted)
      throw new Error("Modal provider create was already attempted; reconcile its receipt");
    const request = call.request as {
      appId?: unknown;
      definition?: { imageId?: unknown; name?: unknown; [key: string]: unknown };
      tags?: Array<{ tagName: string; tagValue: string }>;
    };
    if (
      typeof request.appId !== "string" ||
      !request.appId ||
      typeof request.definition?.imageId !== "string" ||
      !request.definition.imageId ||
      (request.definition.name && request.definition.name !== name) ||
      !Array.isArray(request.tags) ||
      request.tags.some(
        (tag) => tag.tagName === OPERATION_TAG && tag.tagValue !== input.operationId,
      )
    ) {
      throw new Error("Modal SandboxCreate wire identity does not match the owned operation");
    }
    const wireRequest = {
      ...request,
      definition: { ...request.definition, name },
      tags: [
        ...request.tags.filter((tag) => tag.tagName !== OPERATION_TAG),
        { tagName: OPERATION_TAG, tagValue: input.operationId },
      ],
    };
    const intent: ModalCreateIntent = {
      operationId: input.operationId,
      name,
      appId: request.appId,
      imageId: request.definition.imageId,
      requestSha256: createHash("sha256").update(JSON.stringify(wireRequest)).digest("hex"),
    };
    attempted = true;
    await input.beforeDispatch(intent);
    // Middleware is generic over every Modal RPC. The exact method/path and
    // validated request above narrow this one operation's protobuf boundary.
    const dispatchOptions = { ...options, retries: 0 };
    const response = yield* call.next(wireRequest as typeof call.request, dispatchOptions);
    const instanceId = (response as { sandboxId?: unknown } | null)?.sandboxId;
    if (typeof instanceId !== "string" || !instanceId.startsWith("sb-")) {
      throw new Error(
        "Modal create returned no physical sandbox identity; operation remains uncertain",
      );
    }
    // Persist even if the caller has since cancelled. Cancellation cannot erase
    // an already-created provider instance or turn it into a never-sent request.
    await input.onReceipt({ ...intent, instanceId });
    return response;
  };
}

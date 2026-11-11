import { ModalClient } from "modal";

type ControlPlane = Pick<
  ModalClient["cpClient"],
  "sandboxGetTaskId" | "taskGetCommandRouterAccess"
>;

type CommandClient = Pick<ModalClient, "cpClient" | "version"> &
  Partial<Pick<ModalClient, "profile" | "logger">>;
type GrpcMiddleware = NonNullable<
  NonNullable<ConstructorParameters<typeof ModalClient>[0]>["grpcMiddleware"]
>[number];
/** This dedicated command client never retries a request behind the caller's
 * back and preserves the exact cancellation signal, including streaming RPCs. */
export const modalCommandAbortMiddleware: GrpcMiddleware = async function* (call, options) {
  options.signal?.throwIfAborted();
  return yield* call.next(call.request, options);
};

// Version-pinned compatibility boundary: 0.9.0's retryMiddleware drops signal
// for streaming and retries=0. Its public custom middleware runs OUTSIDE that
// branch, so cannot repair it. Override only this dedicated instance's factory
// hook before construction; never mutate the SDK's global prototype or use
// negative/fractional retry counts to manipulate its branch conditions.
type PublicModalClient = Pick<ModalClient, keyof ModalClient>;
const ModalClientBase: new (
  options?: ConstructorParameters<typeof ModalClient>[0],
) => PublicModalClient = ModalClient;
class ModalCommandClient extends ModalClientBase {
  retryMiddleware(): GrpcMiddleware {
    return modalCommandAbortMiddleware;
  }
}
const controlClients = new WeakMap<object, PublicModalClient>();

export function commandControlPlane(client: CommandClient): ControlPlane {
  // Minimal injected control planes are used by deterministic unit tests.
  // Production installation requires the authenticated SDK profile below.
  if (!client.profile) return client.cpClient;
  if (typeof Reflect.get(ModalClient.prototype, "retryMiddleware") !== "function")
    throw new Error("Verified Modal command cancellation contract is unavailable");
  let controlled = controlClients.get(client);
  if (!controlled) {
    const profile = client.profile;
    if (!profile.tokenId || !profile.tokenSecret)
      throw new Error("Modal command control requires its original authenticated profile");
    controlled = new ModalCommandClient({
      tokenId: profile.tokenId,
      tokenSecret: profile.tokenSecret,
      endpoint: profile.serverUrl,
      environment: profile.environment ?? "",
      ...(profile.maxThrottleWaitSecs !== undefined
        ? { maxThrottleWaitSecs: profile.maxThrottleWaitSecs }
        : {}),
      ...(client.logger ? { logger: client.logger } : {}),
    });
    controlClients.set(client, controlled);
  }
  return controlled.cpClient;
}

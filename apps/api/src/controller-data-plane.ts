import {
  BrowserControlRequestError,
  BrowserControlTransportError,
  exposedPortAllowsHostFetch,
  exposedPortEndpointFromUrl,
  parseOpenSandboxSignedUriPath,
  signedEndpointNeedsRefresh,
} from "@opengeni/runtime/sandbox";
import type { InteractionPlacement } from "@opengeni/contracts";
import type { ChannelAOperation } from "./sandbox/channel-a";

/** Modal/Daytona/Blaxel tunnels serve browserd at `/`, so a cached
 * controller-only session can host-fetch JSON. OpenSandbox's lifecycle proxy
 * prefixes `/v1/sandboxes/<id>/proxy/<port>` and rewrites Authorization; JSON
 * must stay on an exec-capable in-box curl session. OSEP-0011 signed URIs are
 * Authorization-preserving and host-fetch like a native tunnel, but they are
 * not durable cache keys. */
export function controllerCacheAllowsHostFetch(url: string): boolean {
  try {
    return exposedPortAllowsHostFetch(exposedPortEndpointFromUrl(url));
  } catch {
    return false;
  }
}

export function isOpenSandboxSignedControllerUrl(url: string): boolean {
  try {
    return parseOpenSandboxSignedUriPath(new URL(url).pathname) !== null;
  } catch {
    return false;
  }
}

/** Signed Channel B URLs expire. Do not treat a lease-cached signed URI as an
 * infinite controller endpoint. Unsigned native `/` tunnels stay cacheable. */
export function controllerCachedUrlIsUsable(url: string, nowMs = Date.now()): boolean {
  if (!controllerCacheAllowsHostFetch(url)) return false;
  if (!isOpenSandboxSignedControllerUrl(url)) return true;
  try {
    return !signedEndpointNeedsRefresh(new URL(url).pathname, nowMs);
  } catch {
    return false;
  }
}

export function shouldPersistControllerDataPlaneUrl(input: {
  backend: string | null | undefined;
  signedEndpoints: boolean;
  url: string;
}): boolean {
  if (input.backend === "opensandbox" && input.signedEndpoints) return false;
  return controllerCachedUrlIsUsable(input.url);
}

/** Prefer a lease-fenced controller endpoint for the idempotent create path.
 * Only a transport-class failure invalidates the cache and provisions once;
 * semantic failures belong to the caller and must never be replayed. */
export async function withCachedController<C, T>(options: {
  cachedUrl: string | null;
  createCachedClient: (url: string) => C;
  prepareCachedClient?: (client: C) => Promise<void>;
  invalidateCachedUrl: () => Promise<unknown>;
  provisionClient: () => Promise<C>;
  use: (client: C) => Promise<T>;
}): Promise<T> {
  if (options.cachedUrl) {
    try {
      const client = options.createCachedClient(options.cachedUrl);
      await options.prepareCachedClient?.(client);
      return await options.use(client);
    } catch (error) {
      if (!isRetryableControllerTransport(error)) throw error;
      await options.invalidateCachedUrl().catch(() => undefined);
    }
  }
  return await options.use(await options.provisionClient());
}

export function isRetryableControllerTransport(error: unknown): boolean {
  return (
    error instanceof BrowserControlTransportError ||
    (error instanceof BrowserControlRequestError && error.retryable)
  );
}

/** A stopped sidecar needs provisioning on its original, fenced placement.
 * Only reads and journaled actions may recover, once across provider retries.
 * Revalidate controller authority before starting the sidecar. */
export async function withControllerTransportRecovery<T>(options: {
  channelOperation: ChannelAOperation;
  placementKind: InteractionPlacement["kind"];
  recoveryState: { attempted: boolean };
  transportAlreadyFailed: boolean;
  use: () => Promise<T>;
  admitRecovery: () => Promise<void>;
  recover: () => Promise<T>;
}): Promise<T> {
  if (
    (options.channelOperation !== "browser.read" &&
      options.channelOperation !== "browser.action") ||
    options.placementKind !== "sandbox_group" ||
    options.recoveryState.attempted
  ) {
    return await options.use();
  }
  if (!options.transportAlreadyFailed) {
    try {
      return await options.use();
    } catch (error) {
      if (!isRetryableControllerTransport(error)) throw error;
    }
  }
  options.recoveryState.attempted = true;
  await options.admitRecovery();
  return await options.recover();
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ModalClient, type App, type Image } from "modal";

type ModalMiddleware = NonNullable<
  NonNullable<ConstructorParameters<typeof ModalClient>[0]>["grpcMiddleware"]
>[number];

const CREATE_PATH = "/modal.client.ModalClient/SandboxCreate";

export type SharedModalClientOptions = {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
  endpoint?: string;
  imageBuilderVersion?: string;
};

type BoundaryScope = { middleware: ModalMiddleware; active: boolean };

const createBoundaries = new AsyncLocalStorage<BoundaryScope>();

/**
 * The one middleware installed on every shared client. A physical
 * SandboxCreate is only ever dispatched through the create boundary of the
 * operation that is currently running it (see {@link withModalCreateBoundary}).
 * A SandboxCreate outside an active boundary fails closed: work started inside
 * an earlier create (timers, background reads) inherits that create's async
 * context, and must never reuse its fenced, already-attempted boundary.
 */
export const ambientCreateBoundary: ModalMiddleware = async function* (call, options) {
  const scope = createBoundaries.getStore();
  if (scope?.active) return yield* scope.middleware(call, options);
  if (call.method.path === CREATE_PATH) {
    throw new Error("Modal SandboxCreate requires an active durable create boundary");
  }
  return yield* call.next(call.request, options);
};

const clients = new Map<string, ModalClient>();

function clientKey(options: SharedModalClientOptions): string {
  return JSON.stringify([
    options.tokenId ?? "",
    options.tokenSecret ? createHash("sha256").update(options.tokenSecret).digest("hex") : "",
    options.environment ?? "",
    options.endpoint ?? "",
    options.imageBuilderVersion ?? "",
  ]);
}

/**
 * One Modal client per credential, environment and endpoint for the whole
 * process. A fresh client pays a new TLS channel, an AuthTokenGet and an
 * EnvironmentGetOrCreate (about 0.4 to 0.7 s from a worker) before its first
 * useful call, and Modal's close() never releases the gRPC channel. The shared
 * client refreshes its own auth token and multiplexes every sandbox's control
 * calls over one channel. Callers must never close it.
 */
export function sharedModalClient(options: SharedModalClientOptions): ModalClient {
  const key = clientKey(options);
  const existing = clients.get(key);
  if (existing) return existing;
  const client = new ModalClient({
    ...(options.tokenId ? { tokenId: options.tokenId } : {}),
    ...(options.tokenSecret ? { tokenSecret: options.tokenSecret } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    grpcMiddleware: [ambientCreateBoundary],
  });
  // Same adaptation the pinned Agents adapter applies to its own clients.
  const patchable = client as unknown as {
    imageBuilderVersion?: (version?: string) => unknown;
  };
  if (options.imageBuilderVersion !== undefined && patchable.imageBuilderVersion) {
    const original = patchable.imageBuilderVersion.bind(client);
    patchable.imageBuilderVersion = (version?: string) =>
      original(version ?? options.imageBuilderVersion);
  }
  clients.set(key, client);
  return client;
}

/**
 * Run one physical create with its own durable boundary on the shared client.
 * Only SandboxCreate calls made inside `run` reach `middleware`; the scope is
 * deactivated as soon as `run` settles.
 */
export async function withModalCreateBoundary<T>(
  middleware: ModalMiddleware,
  run: () => Promise<T>,
): Promise<T> {
  const scope: BoundaryScope = { middleware, active: true };
  try {
    return await createBoundaries.run(scope, run);
  } finally {
    scope.active = false;
  }
}

const APP_CACHE_TTL_MS = 10 * 60_000;
const apps = new WeakMap<ModalClient, Map<string, { expiresAt: number; app: Promise<App> }>>();

/** apps.fromName, memoized per shared client for a bounded time. A failed
 * lookup is never cached. */
export async function cachedModalApp(
  client: ModalClient,
  appName: string,
  params: { environment?: string; createIfMissing?: boolean },
): Promise<App> {
  let byName = apps.get(client);
  if (!byName) apps.set(client, (byName = new Map()));
  const key = JSON.stringify([appName, params.environment ?? "", params.createIfMissing === true]);
  const now = Date.now();
  const hit = byName.get(key);
  if (hit && hit.expiresAt > now) return await hit.app;
  const app = client.apps.fromName(appName, {
    ...(params.environment ? { environment: params.environment } : {}),
    ...(params.createIfMissing !== undefined ? { createIfMissing: params.createIfMissing } : {}),
  });
  const entry = { expiresAt: now + APP_CACHE_TTL_MS, app };
  byName.set(key, entry);
  try {
    return await app;
  } catch (error) {
    if (byName.get(key) === entry) byName.delete(key);
    throw error;
  }
}

const images = new WeakMap<ModalClient, Map<string, Promise<Image>>>();

/**
 * A built provider image for an immutable registry reference or image ID,
 * resolved once per shared client. A built Image carries its imageId, so
 * sandbox creation skips ImageGetOrCreate. Failures are never cached: Modal
 * memoizes failed imports by definition, and the next create retries.
 */
export async function cachedModalImage(
  client: ModalClient,
  app: App,
  selector: { kind: "tag" | "id"; value: string },
): Promise<Image> {
  let byRef = images.get(client);
  if (!byRef) images.set(client, (byRef = new Map()));
  const key = `${selector.kind}:${app.environmentName ?? ""}:${selector.value}`;
  const hit = byRef.get(key);
  if (hit) return await hit;
  const image =
    selector.kind === "id"
      ? client.images.fromId(selector.value)
      : client.images.fromRegistry(selector.value).build(app);
  byRef.set(key, image);
  try {
    return await image;
  } catch (error) {
    if (byRef.get(key) === image) byRef.delete(key);
    throw error;
  }
}

/** Test-only: drop every shared client and memoized lookup. */
export function __resetSharedModalClientsForTest(): void {
  clients.clear();
}

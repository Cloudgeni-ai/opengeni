import { Client, Metadata, credentials } from "@grpc/grpc-js";
import { rootCertificates } from "node:tls";
import { types } from "node:util";
import protobuf from "protobufjs";

// Narrow read-only projection of modal@0.9.0. Unlike ModalClient's constructor,
// this transport never reads .modal.toml, MODAL_PROFILE, MODAL_SERVER_URL or
// ambient token/environment settings. It owns its channel and explicit pair.
// This is NOT a host authorizer, original-context issuer or capture ingress.
// No production caller or public sandbox export enables this private seam.
export const modalOriginalReadSchema = protobuf.parse(`syntax = "proto3";
message Empty {}
message AuthToken { string token = 1; }
message Namespace { string workspace_name = 1; string username = 2; }
message Task { string task_id = 1; }
message RouterAccess { string jwt = 1; string url = 2; }
`).root;

export type ModalOriginalReadSnapshot = Readonly<{
  serverUrl: string;
  tokenId: string;
  tokenSecret: string;
  // Explicit even when empty. Namespace/access RPCs do not transmit this
  // selection; the protected host binding must retain and check it separately.
  environment: string;
}>;

const refused = () => new Error("Invalid or unavailable Modal original read transport");
const prefix = "/modal.client.ModalClient/";
const maxWireBytes = 1024 * 1024;
const snapshotKeys = ["serverUrl", "tokenId", "tokenSecret", "environment"];

function snapshotInput(input: ModalOriginalReadSnapshot): ModalOriginalReadSnapshot {
  // Reject traps before inspection. This inert snapshot is transport hygiene,
  // not authenticated provenance or a substitute for protected host joins.
  if (!input || typeof input !== "object" || types.isProxy(input)) throw refused();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw refused();
  const properties = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(properties);
  if (
    keys.length !== snapshotKeys.length ||
    keys.some((key) => !snapshotKeys.includes(key as string))
  )
    throw refused();
  for (const key of snapshotKeys) {
    const property = properties[key];
    if (!property || !("value" in property) || typeof property.value !== "string") throw refused();
  }
  const { serverUrl, tokenId, tokenSecret, environment } = Object.fromEntries(
    snapshotKeys.map((key) => [key, properties[key]!.value]),
  ) as ModalOriginalReadSnapshot;
  // gRPC metadata strings must be printable ASCII. Preserve exact bytes;
  // trimming/coercion would compare one pair and send another.
  if (
    !/^[\x20-\x7e]{1,8192}$/.test(tokenId) ||
    !/^[\x20-\x7e]{1,8192}$/.test(tokenSecret) ||
    environment.length > 200 ||
    serverUrl.length > 1024
  )
    throw refused();
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw refused();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw refused();
  return Object.freeze({ serverUrl, tokenId, tokenSecret, environment });
}

function encode(type: string, value: object): Buffer {
  const codec = modalOriginalReadSchema.lookupType(type);
  return Buffer.from(codec.encode(codec.fromObject(value)).finish());
}

/** Private low-level transport only. A valid snapshot, TLS response or class
 * instance grants no original custody/namespace binding/effect permission.
 * Host actor/grant/config/claim joins and genuine acquisition ingress remain
 * separate. There is deliberately no Create, Start, stdin, cancel or TaskGet.
 */
export class ModalOriginalReadWire {
  readonly #snapshot: ModalOriginalReadSnapshot;
  readonly #client: Client;
  readonly #pending = new Map<Promise<unknown>, AbortController>();
  #closed = false;
  #closing?: Promise<void>;

  constructor(snapshot: ModalOriginalReadSnapshot, trustedRoots?: Buffer) {
    this.#snapshot = snapshotInput(snapshot);
    if (
      trustedRoots &&
      (types.isProxy(trustedRoots) ||
        !Buffer.isBuffer(trustedRoots) ||
        trustedRoots.length > maxWireBytes)
    )
      throw refused();
    const endpoint = new URL(this.#snapshot.serverUrl);
    // Explicit bundled roots avoid grpc's ambient root-file override. Tests
    // supply isolated fixture roots; a host must capture this TLS policy too.
    const roots = trustedRoots
      ? Buffer.from(trustedRoots)
      : Buffer.from(rootCertificates.join("\n"));
    this.#client = new Client(
      `${endpoint.hostname}:${endpoint.port || "443"}`,
      credentials.createSsl(roots),
      {
        "grpc.max_receive_message_length": maxWireBytes,
        "grpc.max_send_message_length": maxWireBytes,
        "grpc.enable_retries": 0,
      },
    );
  }

  /** Local observation census, never global physical-writer quiescence. */
  get pendingObservations(): number {
    return this.#pending.size;
  }

  private unary(
    method: "AuthTokenGet" | "WorkspaceNameLookup" | "TaskGetCommandRouterAccess",
    input: "Empty" | "Task",
    output: "AuthToken" | "Namespace" | "RouterAccess",
    request: object,
    controller: AbortController,
    deadline: number,
    token?: string,
  ): Promise<protobuf.Message> {
    controller.signal.throwIfAborted();
    if (this.#closed || Date.now() >= deadline) throw refused();
    const metadata = new Metadata();
    metadata.set("x-modal-client-type", "8");
    metadata.set("x-modal-client-version", "1.0.0");
    metadata.set("x-modal-libmodal-version", "modal-js/0.9.0");
    metadata.set("x-modal-token-id", this.#snapshot.tokenId);
    metadata.set("x-modal-token-secret", this.#snapshot.tokenSecret);
    if (token) metadata.set("x-modal-auth-token", token);
    return new Promise((resolve, reject) => {
      const call = this.#client.makeUnaryRequest(
        prefix + method,
        (value: object) => encode(input, value),
        (bytes) => modalOriginalReadSchema.lookupType(output).decode(bytes),
        request,
        metadata,
        { deadline },
        (error, response) => {
          controller.signal.removeEventListener("abort", abort);
          // Only the actual RPC callback settles this promise. Abort requests
          // cancellation but cannot race a waiter into releasing the slot.
          // Provider details/headers/tokens never escape in errors or causes.
          if (controller.signal.aborted || error || !response) reject(refused());
          else resolve(response);
        },
      );
      const abort = () => call.cancel();
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
    });
  }

  private observe<T>(
    read: (controller: AbortController, deadline: number, token: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // One joined acquisition at a time. Timeout/abort cannot free it for an
    // overlapping replacement while the underlying native promise is pending.
    if (this.#closed || this.#pending.size || signal?.aborted) return Promise.reject(refused());
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const operation = (async () => {
      const deadline = Date.now() + 30_000;
      const auth = await this.unary("AuthTokenGet", "Empty", "AuthToken", {}, controller, deadline);
      const { token } = modalOriginalReadSchema.lookupType("AuthToken").toObject(auth) as {
        token?: string;
      };
      if (!token || !/^[\x20-\x7e]{1,16384}$/.test(token)) throw refused();
      // No token cache/refresh background task or hidden retry. Each admitted
      // read uses this exact pair and one bounded auth+read RPC chain.
      return await read(controller, deadline, token);
    })().catch(() => {
      // Include synchronous serializer/channel errors and invalid provider
      // responses in the same nonsecret refusal; none is physical-loss proof.
      throw refused();
    });
    this.#pending.set(operation, controller);
    const settled = () => {
      signal?.removeEventListener("abort", abort);
      this.#pending.delete(operation);
    };
    void operation.then(settled, settled);
    return operation;
  }

  readNamespace(
    signal?: AbortSignal,
  ): Promise<Readonly<{ responseField: "workspaceName" | "username"; value: string }>> {
    return this.observe(async (controller, deadline, token) => {
      const response = await this.unary(
        "WorkspaceNameLookup",
        "Empty",
        "Namespace",
        {},
        controller,
        deadline,
        token,
      );
      const { workspaceName, username } = modalOriginalReadSchema
        .lookupType("Namespace")
        .toObject(response) as {
        workspaceName?: string;
        username?: string;
      };
      const responseField = workspaceName ? "workspaceName" : "username";
      const value = workspaceName || username;
      if (!value || value.length > 200) throw refused();
      // Honest source field, not an invented immutable provider principal or a
      // once-bound/captured record. Protected ingress must bind it separately.
      return Object.freeze({ responseField, value });
    }, signal);
  }

  readRouterAccess(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ url: string; jwt: string }>> {
    if (typeof taskId !== "string" || !taskId || taskId.length > 200)
      return Promise.reject(refused());
    return this.observe(async (controller, deadline, token) => {
      const response = await this.unary(
        "TaskGetCommandRouterAccess",
        "Task",
        "RouterAccess",
        { taskId },
        controller,
        deadline,
        token,
      );
      const { url, jwt } = modalOriginalReadSchema
        .lookupType("RouterAccess")
        .toObject(response) as {
        url?: string;
        jwt?: string;
      };
      if (!url || url.length > 1024 || !jwt || !/^[\x20-\x7e]{1,16384}$/.test(jwt)) throw refused();
      let endpoint: URL;
      try {
        endpoint = new URL(url);
      } catch {
        throw refused();
      }
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/"
      )
        throw refused();
      // Ephemeral credentials only. This return value must never enter a
      // descriptor, journal, error, log or workflow history.
      return Object.freeze({ url, jwt });
    }, signal);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const controller of this.#pending.values()) controller.abort();
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending.keys()]);
      this.#client.close();
    })();
    return this.#closing;
  }
}

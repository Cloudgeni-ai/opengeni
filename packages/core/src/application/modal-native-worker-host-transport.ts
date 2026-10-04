import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import type { Settings } from "@opengeni/config";
import {
  ModalNativeConfigurationCaptureRefV2,
  ModalNativeOriginalScopeV2,
  ModalNativeProofGrantRefV2,
} from "@opengeni/contracts/modal-native-proof-v2";
import { z } from "zod";

// Private transport only. This module is not an ordinary access-token entry,
// native acquisition issuer, custody authorizer, public registrar or effect CAS.
// A successful MAC authenticates this host transport, NOT the named human,
// live origin, grant, configuration, provider response or physical settlement.
const PREFIX = "ogmnp2_";
const SUBKEY_DOMAIN = "opengeni:modal-native-worker-host:transport:subkey:v2";
const MESSAGE_DOMAIN = "opengeni:modal-native-worker-host:transport:message:v2\0";
const TRANSPORT_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 16_384;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const nativeByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const uuid = z.string().uuid();
const revision = z.number().int().positive().safe();
const base = {
  protocol: z.literal("opengeni-modal-native-worker-host-proof"),
  version: z.literal(2),
  principalKind: z.literal("worker_host"),
  purpose: z.literal("original-native-custody-proof"),
  scope: ModalNativeOriginalScopeV2,
  configurationCaptureRef: ModalNativeConfigurationCaptureRefV2,
  proofGrantRef: ModalNativeProofGrantRefV2,
  requestId: uuid,
};
const acquisition = z
  .object({
    claimId: uuid,
    nonce: uuid,
    claimRevision: revision,
    recordRevision: revision,
    captureId: uuid,
    acquisitionId: uuid,
  })
  .strict();
const intent = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("declare_preparation") }).strict(),
  z
    .object({ ...base, action: z.literal("claim_namespace_read"), recordRevision: revision })
    .strict(),
  z
    .object({ ...base, action: z.literal("claim_original_command_read"), recordRevision: revision })
    .strict(),
  z.object({ ...base, action: z.literal("capture_namespace_binding"), acquisition }).strict(),
  z.object({ ...base, action: z.literal("capture_original_page"), acquisition }).strict(),
  z.object({ ...base, action: z.literal("reconcile_same_capture"), acquisition }).strict(),
  z.object({ ...base, action: z.literal("settle_original_acquisition"), acquisition }).strict(),
]);
const timing = z
  .object({
    bodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
type Intent = z.infer<typeof intent>;
export type NativeWorkerHostTransportDescriptionV2 = Intent & z.infer<typeof timing>;

declare const transportBrand: unique symbol;
export type NativeWorkerHostTransport = Readonly<{ [transportBrand]: true }>;
declare const verifiedBrand: unique symbol;
export type VerifiedNativeWorkerHostTransport = Readonly<{ [verifiedBrand]: true }>;
const transports = new WeakMap<NativeWorkerHostTransport, Buffer>();
const verified = new WeakMap<
  VerifiedNativeWorkerHostTransport,
  {
    transport: NativeWorkerHostTransport;
    description: NativeWorkerHostTransportDescriptionV2;
  }
>();

/** Inspect before schema parsing; getters/Proxies must not execute inside the
 * signing boundary. This is JSON correlation, never an authority constructor. */
function ownJson(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("Unsupported native host transport input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== "object" || types.isProxy(value))
    throw new Error("Unsupported native host transport input");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new Error("Unsupported native host transport input");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((key) => !(array && key === "length"));
  if (array && keys.length !== (value as unknown[]).length)
    throw new Error("Unsupported native host transport input");
  for (const key of keys) {
    if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/u.test(key)))
      throw new Error("Unsupported native host transport input");
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor))
      throw new Error("Unsupported native host transport input");
    ownJson(descriptor.value, depth + 1);
  }
}

function bodyHash(body: Uint8Array): string {
  if (types.isProxy(body) || !types.isUint8Array(body))
    throw new Error("Unsupported native host transport body");
  // Native getters ignore caller-owned byteLength/buffer/offset overrides. Reject
  // shared backing storage: its bytes could change concurrently during the copy.
  const length = nativeByteLength.call(body) as number;
  const backing = nativeBuffer.call(body) as ArrayBuffer;
  if (length > MAX_BODY_BYTES || !types.isArrayBuffer(backing))
    throw new Error("Unsupported native host transport body");
  const snapshot = new Uint8Array(length);
  try {
    snapshot.set(new Uint8Array(backing, nativeByteOffset.call(body) as number, length));
    return createHash("sha256").update(snapshot).digest("hex");
  } catch {
    throw new Error("Unsupported native host transport body");
  } finally {
    snapshot.fill(0);
  }
}

function keyFor(transport: NativeWorkerHostTransport): Buffer {
  const key = transports.get(transport);
  if (!key) throw new Error("Native host transport is unavailable");
  return key;
}

function mac(key: Buffer, encoded: string): Buffer {
  return createHmac("sha256", key).update(MESSAGE_DOMAIN).update(PREFIX).update(encoded).digest();
}

/** Host startup only. Deliberately DOES NOT call resolveFirstPartyDelegationSecret:
 * neither configured access-key substitution nor the public local/test fallback
 * can select this new purpose root. Missing explicit deployment secret is OFF.
 * No variable lookup, provider request, config mutation or persistence occurs. */
export function configuredNativeWorkerHostTransport(
  settings: Pick<Settings, "delegationSecret">,
): NativeWorkerHostTransport | null {
  if (!settings || typeof settings !== "object" || types.isProxy(settings)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(settings, "delegationSecret");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
  const secret = descriptor.value.trim();
  if (!secret) return null;
  const transient = Buffer.from(secret, "utf8");
  try {
    const key = createHmac("sha256", transient).update(SUBKEY_DOMAIN).digest();
    const handle = Object.freeze(Object.create(null)) as NativeWorkerHostTransport;
    transports.set(handle, key);
    return handle;
  } finally {
    transient.fill(0);
  }
}

/** Release only this transport's derived-key copy, not a config/grant/custody
 * lifecycle or observation slot. Outstanding native I/O needs its own join. */
export function disposeNativeWorkerHostTransport(transport: NativeWorkerHostTransport): void {
  const key = transports.get(transport);
  if (key) key.fill(0);
  transports.delete(transport);
}

/** Private worker/core transport serialization. The caller MUST first establish
 * canonical original-host admission. This helper cannot establish that admission
 * and is intentionally not exported from the core package's public entrypoints. */
export function signNativeWorkerHostTransport(
  transport: NativeWorkerHostTransport,
  input: Intent,
  body: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const key = keyFor(transport);
  ownJson(input);
  const parsed = intent.safeParse(input);
  const clock = z.number().int().nonnegative().safe().safeParse(nowSeconds);
  if (!parsed.success || !clock.success) throw new Error("Unsupported native host transport input");
  const timed = timing.safeParse({
    bodySha256: bodyHash(body),
    issuedAt: clock.data,
    expiresAt: clock.data + TRANSPORT_TTL_SECONDS,
  });
  if (!timed.success) throw new Error("Unsupported native host transport input");
  const description: NativeWorkerHostTransportDescriptionV2 = {
    ...parsed.data,
    ...timed.data,
  };
  const encoded = Buffer.from(JSON.stringify(description), "utf8").toString("base64url");
  if (PREFIX.length + encoded.length + 1 + 43 > MAX_ENVELOPE_BYTES)
    throw new Error("Unsupported native host transport input");
  return `${PREFIX}${encoded}.${mac(key, encoded).toString("base64url")}`;
}

/** Only host transport authenticity is verified. A later narrow authorizer must
 * independently source-join original live/maintenance authority, configuration,
 * grant, claim, acquisition, body fields/cursors and exact action-specific CAS. */
export function verifyNativeWorkerHostTransport(
  transport: NativeWorkerHostTransport,
  envelope: string,
  body: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifiedNativeWorkerHostTransport | null {
  const key = keyFor(transport);
  if (
    typeof envelope !== "string" ||
    envelope.length > MAX_ENVELOPE_BYTES ||
    !envelope.startsWith(PREFIX)
  )
    return null;
  const pieces = envelope.slice(PREFIX.length).split(".");
  if (pieces.length !== 2) return null;
  const [encoded, signature] = pieces as [string, string];
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) return null;
  const received = Buffer.from(signature, "base64url");
  if (received.length !== 32 || received.toString("base64url") !== signature) return null;
  if (!timingSafeEqual(received, mac(key, encoded))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const { bodySha256, issuedAt, expiresAt, ...rawIntent } = decoded;
    const description = {
      ...intent.parse(rawIntent),
      ...timing.parse({ bodySha256, issuedAt, expiresAt }),
    };
    if (
      !Number.isSafeInteger(nowSeconds) ||
      nowSeconds < 0 ||
      description.issuedAt > nowSeconds ||
      description.expiresAt <= nowSeconds ||
      description.expiresAt - description.issuedAt !== TRANSPORT_TTL_SECONDS ||
      description.bodySha256 !== bodyHash(body) ||
      Buffer.from(JSON.stringify(description), "utf8").toString("base64url") !== encoded
    )
      return null;
    const proof = Object.freeze(Object.create(null)) as VerifiedNativeWorkerHostTransport;
    verified.set(proof, { transport, description });
    return proof;
  } catch {
    return null;
  }
}

/** Request-local inspection of a previously verified MAC, NOT current admission.
 * The narrow host authorizer must still recheck expiry and current authority/CAS.
 * Copying a description, token or ref cannot mint grant or native-I/O authority. */
export function nativeWorkerHostTransportDescription(
  transport: NativeWorkerHostTransport,
  proof: VerifiedNativeWorkerHostTransport,
): NativeWorkerHostTransportDescriptionV2 {
  keyFor(transport);
  const record = verified.get(proof);
  if (!record || record.transport !== transport)
    throw new Error("Native host transport proof is unavailable");
  return structuredClone(record.description);
}

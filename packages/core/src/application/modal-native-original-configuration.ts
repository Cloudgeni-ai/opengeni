import { createHash, createHmac, timingSafeEqual, type Hmac } from "node:crypto";
import { rootCertificates } from "node:tls";
import { types } from "node:util";
import type { Settings } from "@opengeni/config";
import { ModalNativePreparationDeclarationV2 } from "@opengeni/contracts/modal-native-proof-v2";

// PRIVATE, unused configuration groundwork, not a host authorizer, capture
// receipt, original grant, native context or effect permit. The canonical host
// must authenticate and join live original authority before committing this
// draft into protected storage, and before using its matched snapshot for I/O.
// Never project its equality bytes into logs, status, errors or workflow history.
const SUBKEY_DOMAIN = "opengeni:modal-native:configuration-equality:subkey:v2";
const MESSAGE_DOMAIN = "opengeni:modal-native:configuration-equality:framed:v2\0";
const MAX_DECLARATION_BYTES = 4 * 1024 * 1024;
const SERVER_URL = "https://api.modal.com:443";
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const nativeByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
type ConfigurationSettings = Pick<
  Settings,
  "modalTokenId" | "modalTokenSecret" | "modalEnvironment" | "environmentsEncryptionKey"
>;

export type NativeOriginalConfigurationSnapshot = Readonly<{
  serverUrl: string;
  tokenId: string;
  tokenSecret: string;
  environment: string;
}>;

function readProfile(environment: string) {
  return Object.freeze({
    protocol: "modal-direct-original-read-grpc-v1" as const,
    version: 1 as const,
    sourceGitBlob: "7599f5b80cf111a25f78f427cfb2616d7e24b36c" as const,
    serverUrl: SERVER_URL,
    serverSelection: "host-pinned-modal-0.9-default" as const,
    credentialSelection: "explicit-deployment-settings-pair-only" as const,
    environmentSelection: "explicit-own-settings-no-default" as const,
    environment,
    environmentTransmittedByCpReads: false as const,
    namespaceSelection: "unbound-until-authenticated-once-capture" as const,
    modalProjectionVersion: "0.9.0" as const,
    grpcJsVersion: "1.14.4" as const,
    protobufJsVersion: "7.6.5" as const,
    rpcPrefix: "/modal.client.ModalClient/" as const,
    methods: ["AuthTokenGet", "WorkspaceNameLookup", "TaskGetCommandRouterAccess"] as const,
    authHeaders: {
      clientType: "8",
      clientVersion: "1.0.0",
      libmodalVersion: "modal-js/0.9.0",
    } as const,
    tlsPolicy: "explicit-node-tls-rootCertificates-v1" as const,
    tlsRootsSha256: createHash("sha256").update(rootCertificates.join("\n")).digest("hex"),
    retries: 0 as const,
    nativeChainDeadlineMs: 30_000 as const,
    maxWireBytes: 1_048_576 as const,
  });
}

type PrivateDescription = Readonly<{
  protocol: "opengeni-modal-native-configuration-equality";
  version: 2;
  purpose: "original-native-custody-proof";
  configurationCaptureRef: ModalNativePreparationDeclarationV2["configurationCaptureRef"];
  proofGrantRef: ModalNativePreparationDeclarationV2["proofGrantRef"];
  declarationJson: string;
  declarationSha256: string;
  profile: ReturnType<typeof readProfile>;
  keySelection: "existing-environments-encryption-root-current-only";
  algorithm: "hmac-sha256";
  subkeyDomain: typeof SUBKEY_DOMAIN;
  messageDomain: typeof MESSAGE_DOMAIN;
}>;

/** Sensitive PRIVATE storage draft, not proof that any row or grant committed. */
export type NativeOriginalConfigurationDraftV2 = Readonly<{
  description: PrivateDescription;
  equality: Uint8Array;
}>;

declare const sampleBrand: unique symbol;
export type NativeOriginalConfigurationSample = Readonly<{ [sampleBrand]: true }>;
type SampleState = {
  snapshot: NativeOriginalConfigurationSnapshot;
  description: PrivateDescription;
  declarationBytes: Buffer;
  equality: Buffer;
};
const samples = new WeakMap<NativeOriginalConfigurationSample, SampleState>();

function settingsStrings(input: ConfigurationSettings): Record<string, string> | null {
  if (!input || typeof input !== "object" || types.isProxy(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result: Record<string, string> = {};
  for (const key of [
    "modalTokenId",
    "modalTokenSecret",
    "modalEnvironment",
    "environmentsEncryptionKey",
  ]) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !("value" in property) || typeof property.value !== "string") return null;
    result[key] = property.value;
  }
  if (
    !/^[\x20-\x7e]{1,8192}$/.test(result.modalTokenId!) ||
    !/^[\x20-\x7e]{1,8192}$/.test(result.modalTokenSecret!) ||
    result.modalEnvironment!.length > 200 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(result.environmentsEncryptionKey!)
  )
    return null;
  return result;
}

function copyDeclaration(input: Uint8Array): Buffer | null {
  if (!input || types.isProxy(input) || !types.isUint8Array(input)) return null;
  try {
    const byteLength = nativeByteLength.call(input) as number;
    const byteOffset = nativeByteOffset.call(input) as number;
    const buffer = nativeBuffer.call(input) as ArrayBuffer;
    if (byteLength === 0 || byteLength > MAX_DECLARATION_BYTES || types.isSharedArrayBuffer(buffer))
      return null;
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    return null;
  }
}

function frame(hmac: Hmac, label: string, bytes: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  hmac.update(label).update("\0").update(length).update(bytes);
}

/** Samples ONLY explicit own settings, without environment/profile/SDK lookup.
 * A parsed declaration merely supplies correlation. Genuine known app/image
 * provenance and same-transaction host/grant/admission checks remain external.
 */
export function sampleNativeOriginalConfiguration(
  settings: ConfigurationSettings,
  declarationBytes: Uint8Array,
): NativeOriginalConfigurationSample | null {
  const selected = settingsStrings(settings);
  const body = copyDeclaration(declarationBytes);
  if (!selected || !body) {
    body?.fill(0);
    return null;
  }
  let root: Buffer | undefined;
  let subkey: Buffer | undefined;
  let tokenId: Buffer | undefined;
  let tokenSecret: Buffer | undefined;
  let profileBytes: Buffer | undefined;
  let retained = false;
  try {
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    const declaration = ModalNativePreparationDeclarationV2.parse(JSON.parse(json));
    root = Buffer.from(selected.environmentsEncryptionKey!, "base64");
    if (root.length !== 32 || root.toString("base64") !== selected.environmentsEncryptionKey)
      return null;
    const snapshot = Object.freeze({
      serverUrl: SERVER_URL,
      tokenId: selected.modalTokenId!,
      tokenSecret: selected.modalTokenSecret!,
      environment: selected.modalEnvironment!,
    });
    const description: PrivateDescription = Object.freeze({
      protocol: "opengeni-modal-native-configuration-equality",
      version: 2,
      purpose: "original-native-custody-proof",
      configurationCaptureRef: declaration.configurationCaptureRef,
      proofGrantRef: declaration.proofGrantRef,
      declarationJson: json,
      declarationSha256: createHash("sha256").update(body).digest("hex"),
      profile: readProfile(snapshot.environment),
      keySelection: "existing-environments-encryption-root-current-only",
      algorithm: "hmac-sha256",
      subkeyDomain: SUBKEY_DOMAIN,
      messageDomain: MESSAGE_DOMAIN,
    });
    subkey = createHmac("sha256", root).update(SUBKEY_DOMAIN).digest();
    tokenId = Buffer.from(snapshot.tokenId, "utf8");
    tokenSecret = Buffer.from(snapshot.tokenSecret, "utf8");
    profileBytes = Buffer.from(JSON.stringify(description), "utf8");
    const hmac = createHmac("sha256", subkey).update(MESSAGE_DOMAIN);
    frame(hmac, "original-declaration", body);
    frame(hmac, "private-configuration", profileBytes);
    frame(hmac, "exact-token-id", tokenId);
    frame(hmac, "exact-token-secret", tokenSecret);
    const sample = Object.freeze({}) as NativeOriginalConfigurationSample;
    samples.set(sample, { snapshot, description, declarationBytes: body, equality: hmac.digest() });
    retained = true;
    return sample;
  } catch {
    // Fixed refusal, never validator details, credentials or keyed material.
    return null;
  } finally {
    root?.fill(0);
    subkey?.fill(0);
    tokenId?.fill(0);
    tokenSecret?.fill(0);
    profileBytes?.fill(0);
    if (!retained) body.fill(0);
  }
}

/** Private draft extraction for protected storage only; never a status DTO. */
export function privateNativeOriginalConfigurationDraft(
  sample: NativeOriginalConfigurationSample,
): NativeOriginalConfigurationDraftV2 | null {
  const state = samples.get(sample);
  return state
    ? { description: structuredClone(state.description), equality: Uint8Array.from(state.equality) }
    : null;
}

/** Same sampled strings for a future authenticated native caller; NOT a grant. */
export function nativeOriginalConfigurationSnapshot(
  sample: NativeOriginalConfigurationSample,
): NativeOriginalConfigurationSnapshot | null {
  return samples.get(sample)?.snapshot ?? null;
}

/** PRIVATE equality check only. No public oracle, grant renewal or key fallback.
 * Restart reconstruction still requires an authenticated protected original row.
 */
export function currentNativeOriginalConfigurationMatches(
  sample: NativeOriginalConfigurationSample,
  settings: ConfigurationSettings,
): boolean {
  const state = samples.get(sample);
  if (!state) return false;
  const current = sampleNativeOriginalConfiguration(settings, state.declarationBytes);
  if (!current) return false;
  try {
    const candidate = samples.get(current)!;
    return (
      state.equality.length === 32 &&
      candidate.equality.length === 32 &&
      timingSafeEqual(state.equality, candidate.equality)
    );
  } finally {
    disposeNativeOriginalConfigurationSample(current);
  }
}

/** Wipes owned mutable copies, not JS immutable strings or native I/O/custody.
 * A future owning native caller must join its real callbacks separately.
 */
export function disposeNativeOriginalConfigurationSample(
  sample: NativeOriginalConfigurationSample,
) {
  const state = samples.get(sample);
  if (!state) return;
  state.declarationBytes.fill(0);
  state.equality.fill(0);
  samples.delete(sample);
}

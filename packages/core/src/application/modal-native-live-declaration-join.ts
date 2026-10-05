import { types } from "node:util";
import type { Settings } from "@opengeni/config";
import { ModalNativePreparationDeclarationV2 } from "@opengeni/contracts/modal-native-proof-v2";
import {
  lockLiveNativeOriginalOriginTx,
  type Database,
  type ModalNativeLiveOriginProjection,
  type ModalNativeLiveOriginResult,
} from "@opengeni/db";
import { z } from "zod";
import {
  currentNativeOriginalConfigurationMatches,
  disposeNativeOriginalConfigurationSample,
  sampleNativeOriginalConfiguration,
  type NativeOriginalConfigurationSample,
} from "./modal-native-original-configuration";
import {
  configuredNativeWorkerHostTransport,
  disposeNativeWorkerHostTransport,
  nativeWorkerHostTransportDescription,
  verifyNativeWorkerHostTransport,
} from "./modal-native-worker-host-transport";

// Unused PRIVATE request/data join. NOT the canonical claimed-worker issuer,
// custody authorizer, committed grant, native context or one-use effect permit.
// No consumer may turn this data into authority from its type/shape alone.
// A future canonical host entry must establish its actual worker provenance and
// atomically consume this join with protected declaration/config/grant/cold
// insertion in this SAME transaction, before any provider-prefix I/O.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const nativeOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const request = z
  .object({
    protocol: z.literal("opengeni-modal-native-live-declaration-join"),
    version: z.literal(2),
    requestId: z.string().uuid(),
    workflowId: z.string().min(1).max(1024),
    workflowRunId: z.string().min(1).max(1024),
    activityId: z.string().min(1).max(1024),
    initiatingHumanSubjectId: z
      .string()
      .regex(/^user:.+/u)
      .max(1024),
    declarationJson: z.string().min(1).max(MAX_BODY_BYTES),
  })
  .strict();

type JoinSettings = Pick<
  Settings,
  | "delegationSecret"
  | "modalTokenId"
  | "modalTokenSecret"
  | "modalEnvironment"
  | "environmentsEncryptionKey"
>;

/** Sensitive request-local data only. Do not publish/log/cache across commit.
 * The sample contains immutable credential strings which disposal cannot erase.
 * This result has no native-I/O, replay, custody or effect authority. */
export type NativeLiveDeclarationJoin = Readonly<{
  requestId: string;
  declaration: ModalNativePreparationDeclarationV2;
  projection: ModalNativeLiveOriginProjection;
  configuration: NativeOriginalConfigurationSample;
}>;
export type NativeLiveDeclarationJoinResult =
  | { kind: "joined_data"; data: NativeLiveDeclarationJoin }
  | { kind: "off" }
  | { kind: "refused" }
  | Exclude<ModalNativeLiveOriginResult, { kind: "live" }>;

function ownedBody(input: Uint8Array): Buffer | null {
  if (!input || types.isProxy(input) || !types.isUint8Array(input)) return null;
  try {
    const length = nativeLength.call(input) as number;
    const backing = nativeBuffer.call(input) as ArrayBuffer;
    if (length > MAX_BODY_BYTES || !types.isArrayBuffer(backing)) return null;
    return Buffer.from(new Uint8Array(backing, nativeOffset.call(input) as number, length));
  } catch {
    return null;
  }
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Own bytes BEFORE either verifying or parsing. After the blocking SQL join,
 * re-read the explicit CURRENT deployment root/profile and reverify current
 * expiry over those SAME owned bytes. A historical MAC witness is insufficient.
 * No tenant/subject GUC change, general access-token resolver, provider await,
 * fallback, registration or error-to-success conversion occurs here.
 *
 * Input execution/human fields are signed CORRELATION, not caller authority:
 * compare them to the exact DB-derived accepted original projection. This does
 * NOT independently prove that the canonical worker produced the request.
 * Enter an existing scoped transaction before any tenancy/control/row lock;
 * consume the result in that transaction and dispose its sample afterward. */
export async function lockNativeLiveDeclarationJoinTx(
  scopedTx: Database,
  settings: JoinSettings,
  envelope: string,
  inputBody: Uint8Array,
): Promise<NativeLiveDeclarationJoinResult> {
  const initialTransport = configuredNativeWorkerHostTransport(settings);
  if (!initialTransport) return { kind: "off" };
  let body: Buffer | null = null;
  let sample: NativeOriginalConfigurationSample | null = null;
  let retained = false;
  try {
    body = ownedBody(inputBody);
    if (!body) return { kind: "refused" };
    const proof = verifyNativeWorkerHostTransport(initialTransport, envelope, body);
    if (!proof) return { kind: "refused" };
    const description = nativeWorkerHostTransportDescription(initialTransport, proof);
    if (description.action !== "declare_preparation") return { kind: "refused" };
    let parsed: z.infer<typeof request>;
    try {
      parsed = request.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    } catch {
      return { kind: "refused" };
    }
    const declarationBytes = Buffer.from(parsed.declarationJson, "utf8");
    let declaration: ModalNativePreparationDeclarationV2;
    try {
      declaration = ModalNativePreparationDeclarationV2.parse(JSON.parse(parsed.declarationJson));
      if (
        parsed.requestId !== description.requestId ||
        Object.keys(declaration.scope).some(
          (key) =>
            declaration.scope[key as keyof typeof declaration.scope] !==
            description.scope[key as keyof typeof description.scope],
        ) ||
        declaration.configurationCaptureRef.id !== description.configurationCaptureRef.id ||
        declaration.configurationCaptureRef.revision !==
          description.configurationCaptureRef.revision ||
        declaration.proofGrantRef.id !== description.proofGrantRef.id ||
        declaration.proofGrantRef.epoch !== description.proofGrantRef.epoch
      )
        return { kind: "refused" };
      sample = sampleNativeOriginalConfiguration(settings, declarationBytes);
      if (!sample) return { kind: "off" };
    } catch {
      return { kind: "refused" };
    } finally {
      declarationBytes.fill(0);
    }

    const origin = await lockLiveNativeOriginalOriginTx(scopedTx, declaration.scope);
    if (origin.kind !== "live") return origin;
    const currentTransport = configuredNativeWorkerHostTransport(settings);
    if (!currentTransport) return { kind: "refused" };
    try {
      if (
        !verifyNativeWorkerHostTransport(currentTransport, envelope, body) ||
        !currentNativeOriginalConfigurationMatches(sample, settings)
      )
        return { kind: "refused" };
    } finally {
      disposeNativeWorkerHostTransport(currentTransport);
    }
    const projection = origin.projection;
    if (
      Object.keys(declaration.scope).some(
        (key) =>
          declaration.scope[key as keyof typeof declaration.scope] !==
          projection.scope[key as keyof typeof projection.scope],
      ) ||
      projection.initiator.initiatingHumanSubjectId !== parsed.initiatingHumanSubjectId ||
      projection.execution.workflowId !== parsed.workflowId ||
      projection.execution.workflowRunId !== parsed.workflowRunId ||
      projection.execution.activityId !== parsed.activityId ||
      projection.providerRecoveryCount !== declaration.providerRecoveryCount
    )
      return { kind: "refused" };
    const data = Object.freeze({
      requestId: parsed.requestId,
      declaration: freezeJson(declaration),
      projection: freezeJson(structuredClone(projection)),
      configuration: sample,
    });
    retained = true;
    return { kind: "joined_data", data };
  } finally {
    body?.fill(0);
    disposeNativeWorkerHostTransport(initialTransport);
    if (!retained && sample) disposeNativeOriginalConfigurationSample(sample);
  }
}

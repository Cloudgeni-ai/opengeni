import { z } from "zod";
import { ModalRouterProviderCommand } from "./sandbox-provider-command";

/** Secret-free descriptions for the NEW native proof protocol. Parsing any
 * value below establishes correlation ONLY. It does not authenticate a host,
 * native response, grant, election, capture, Start, or semantic continuation.
 * Frozen reservation/journal v1 values are never adopted into this protocol. */
export const MODAL_NATIVE_PROOF_PROTOCOL_VERSION = 2 as const;
export const MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT =
  "db6d33c8a1142e5ffe3d1a130d8b9f9d819e46832ad0417d41d5606b7fe25ab1" as const;

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
// Fresh readiness must round-trip through the retained original-command schema.
// Reuse its exact UUID domain; do not widen it or change the frozen compiler.
const commandExecId = uuid.pipe(ModalRouterProviderCommand.shape.execId);
const positive = z.number().int().positive().safe();
const nonnegative = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const empty = z.object({}).strict();
const noItems = z.tuple([]);
const entrypoint = z.tuple([z.literal("sleep"), z.literal("infinity")]);
const sourceSha = "bb830ded1925e1d927d1fc221b2329d961f9a57eafdd9a85bf13fb7cfc982599";

/** This entire profile is declared BEFORE even namespace lookup. It is a
 * reviewed literal, not caller-selected defaults or an arbitrary self-hash. */
export const ModalNativeFreshNormalizationV1 = z
  .object({
    recipeId: z.literal("modal-native-fresh-v1"),
    recipeRevision: z.literal(1),
    schema: z.literal("modal.client.ModalClient/SandboxCreate"),
    encoding: z.literal("modal-create-json-v1"),
    sdkVersion: z.literal("0.9.0"),
    sdkSourceSha256: z.literal(sourceSha),
    entrypoint,
    createWorkdir: z.literal("/tmp"),
    env: empty,
    mounts: noItems,
    restore: z.null(),
    idleTimeout: z.literal("unset"),
    gpu: z.literal("unset"),
    gpuProto: z
      .object({ type: z.literal(0), count: z.literal(0), gpuType: z.literal("") })
      .strict(),
    cpuLimit: z.literal("unset"),
    memoryLimit: z.literal("unset"),
    pty: z.literal("unset"),
    regions: z.literal("unset"),
    proxy: z.literal("unset"),
    readinessProbe: z.literal("unset"),
    environmentVariables: z.literal("unset"),
    network: z
      .object({
        access: z.literal("OPEN"),
        outboundCidrs: noItems,
        outboundDomains: noItems,
        inboundCidrs: noItems,
        i6pn: z.literal(false),
      })
      .strict(),
    volumes: noItems,
    cloudBucketMounts: noItems,
    secrets: noItems,
    ports: noItems,
    cloud: z.literal(""),
    verbose: z.literal(false),
    includeOidcIdentityToken: z.literal(false),
    experimentalOptions: empty,
    experimentalOptionsV2: empty,
    customDomain: z.literal(""),
  })
  .strict();
export type ModalNativeFreshNormalizationV1 = z.infer<typeof ModalNativeFreshNormalizationV1>;

function freezeLiteral<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeLiteral(child);
    Object.freeze(value);
  }
  return value;
}

/** Public, credential-free recipe data. The host must normatively select this
 * literal before I/O; possessing a copy supplies no issuance provenance. */
export const MODAL_NATIVE_FRESH_NORMALIZATION_V1 = freezeLiteral(
  ModalNativeFreshNormalizationV1.parse({
    recipeId: "modal-native-fresh-v1",
    recipeRevision: 1,
    schema: "modal.client.ModalClient/SandboxCreate",
    encoding: "modal-create-json-v1",
    sdkVersion: "0.9.0",
    sdkSourceSha256: sourceSha,
    entrypoint: ["sleep", "infinity"],
    createWorkdir: "/tmp",
    env: {},
    mounts: [],
    restore: null,
    idleTimeout: "unset",
    gpu: "unset",
    gpuProto: { type: 0, count: 0, gpuType: "" },
    cpuLimit: "unset",
    memoryLimit: "unset",
    pty: "unset",
    regions: "unset",
    proxy: "unset",
    readinessProbe: "unset",
    environmentVariables: "unset",
    network: {
      access: "OPEN",
      outboundCidrs: [],
      outboundDomains: [],
      inboundCidrs: [],
      i6pn: false,
    },
    volumes: [],
    cloudBucketMounts: [],
    secrets: [],
    ports: [],
    cloud: "",
    verbose: false,
    includeOidcIdentityToken: false,
    experimentalOptions: {},
    experimentalOptionsV2: {},
    customDomain: "",
  }),
);

export const ModalNativePreparationRecipeV2 = z
  .object({
    version: z.literal(1),
    recipeId: z.literal("modal-native-fresh-v1"),
    recipeRevision: z.literal(1),
    createWorkdir: z.literal("/tmp"),
    entrypoint,
    normalization: ModalNativeFreshNormalizationV1,
    compilerFingerprint: z.literal(MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT),
  })
  .strict();
export type ModalNativePreparationRecipeV2 = z.infer<typeof ModalNativePreparationRecipeV2>;

export const MODAL_NATIVE_PREPARATION_RECIPE_V2 = freezeLiteral(
  ModalNativePreparationRecipeV2.parse({
    version: 1,
    recipeId: "modal-native-fresh-v1",
    recipeRevision: 1,
    createWorkdir: "/tmp",
    entrypoint: ["sleep", "infinity"],
    normalization: MODAL_NATIVE_FRESH_NORMALIZATION_V1,
    compilerFingerprint: MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT,
  }),
);

/** Exactly the old reservation vocabulary, NOT an extension to its keys. */
export const ModalNativeFreshBlueprintV1 = z
  .object({
    version: z.literal(1),
    adapterId: z.literal("modal-native-fresh-creator-reservation-v1"),
    create: z
      .object({
        operationId: uuid,
        appId: z.string().regex(/^ap-[A-Za-z0-9_-]{1,200}$/u),
        imageId: z.string().regex(/^im-[A-Za-z0-9_-]{1,200}$/u),
        cpu: z
          .number()
          .positive()
          .max(128)
          .refine(
            (v) =>
              Number.isSafeInteger(Math.trunc(v * 1000)) &&
              Math.trunc(v * 1000) >= 1 &&
              Math.trunc(v * 1000) / 1000 === v,
          ),
        memoryMiB: z.number().int().min(128).max(1048576).safe(),
        timeoutSeconds: z.number().int().min(1).max(86400).safe(),
        env: empty,
        mounts: noItems,
      })
      .strict(),
    restore: z.null(),
    readiness: z
      .object({
        operationId: uuid,
        execId: commandExecId,
        commandArgs: z.tuple([z.literal("/bin/true")]),
        workdir: z.literal("/tmp"),
        env: empty,
      })
      .strict(),
    publishOperationId: uuid,
    cleanup: z
      .object({ operationId: uuid, requires: z.literal("physical-terminal-proof") })
      .strict(),
  })
  .strict();
export type ModalNativeFreshBlueprintV1 = z.infer<typeof ModalNativeFreshBlueprintV1>;

/** Full pre-election identity. routeEpoch is NOT the physical lease epoch;
 * creatorId is NOT an elected owner or a replacement accepted attempt. */
export const ModalNativeOriginalScopeV2 = z
  .object({
    version: z.literal(2),
    declarationId: uuid,
    planId: uuid,
    creatorId: uuid,
    accountId: uuid,
    workspaceId: uuid,
    sessionId: uuid,
    turnId: uuid,
    attemptId: uuid,
    executionGeneration: positive,
    triggerEventId: uuid,
    sandboxGroupId: uuid,
    routeKind: z.literal("home"),
    routeTargetId: z.null(),
    routeEpoch: nonnegative,
  })
  .strict()
  .refine((v) => v.creatorId !== v.attemptId && v.creatorId !== v.planId, {
    message: "A declared creator is distinct from the accepted attempt and plan",
  });
export type ModalNativeOriginalScopeV2 = z.infer<typeof ModalNativeOriginalScopeV2>;

/** References must resolve through the complete protected scope/config join.
 * They are neither credentials nor canonical/native authentication receipts. */
export const ModalNativeConfigurationCaptureRefV2 = z
  .object({ id: uuid, revision: positive })
  .strict();
export type ModalNativeConfigurationCaptureRefV2 = z.infer<
  typeof ModalNativeConfigurationCaptureRefV2
>;
export const ModalNativeProofGrantRefV2 = z.object({ id: uuid, epoch: positive }).strict();
export type ModalNativeProofGrantRefV2 = z.infer<typeof ModalNativeProofGrantRefV2>;
export const ModalNativeReservedLeaseRefV2 = z.object({ id: uuid, epoch: nonnegative }).strict();
export type ModalNativeReservedLeaseRefV2 = z.infer<typeof ModalNativeReservedLeaseRefV2>;

export const ModalNativePreparationDeclarationV2 = z
  .object({
    version: z.literal(2),
    scope: ModalNativeOriginalScopeV2,
    blueprint: ModalNativeFreshBlueprintV1,
    preparationRecipe: ModalNativePreparationRecipeV2,
    configurationCaptureRef: ModalNativeConfigurationCaptureRefV2,
    proofGrantRef: ModalNativeProofGrantRefV2,
    providerRecoveryCount: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    namespaceState: z.literal("unbound"),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = [
      v.scope.planId,
      v.scope.creatorId,
      v.blueprint.create.operationId,
      v.blueprint.readiness.operationId,
      v.blueprint.readiness.execId,
      v.blueprint.publishOperationId,
      v.blueprint.cleanup.operationId,
    ];
    if (new Set(ids).size !== 7)
      ctx.addIssue({
        code: "custom",
        message: "All seven supplied operation identities must be distinct",
      });
  });
export type ModalNativePreparationDeclarationV2 = z.infer<
  typeof ModalNativePreparationDeclarationV2
>;

const safeEndpoint = z
  .string()
  .url()
  .max(1024)
  .refine(
    (v) => {
      try {
        const url = new URL(v);
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        );
      } catch {
        return false;
      }
    },
    { message: "Only a credential-free captured HTTPS endpoint is supported" },
  );

/** Separate bind-once append, linked to the SAME captured configuration and
 * claim. This deliberately has no invented immutable provider-principal ID.
 * Only a trusted native issuer + authenticated host ingress can attest it. */
export const ModalNativeNamespaceEvidenceV2 = z
  .object({
    version: z.literal(2),
    scope: ModalNativeOriginalScopeV2,
    configurationCaptureRef: ModalNativeConfigurationCaptureRefV2,
    proofGrantRef: ModalNativeProofGrantRefV2,
    claimId: uuid,
    nonce: uuid,
    claimRevision: positive,
    recordRevision: positive,
    captureId: uuid,
    purpose: z.literal("original-namespace-read"),
    reservation: ModalNativeReservedLeaseRefV2,
    source: z.literal("modal-client-workspace-name-lookup-v1"),
    responseField: z.enum(["workspaceName", "username"]),
    binding: z
      .object({
        version: z.literal(1),
        serverUrl: safeEndpoint,
        workspaceName: z.string().min(1).max(200),
        environment: z.string().max(200),
      })
      .strict(),
  })
  .strict();
export type ModalNativeNamespaceEvidenceV2 = z.infer<typeof ModalNativeNamespaceEvidenceV2>;

const claimFields = {
  version: z.literal(2),
  scope: ModalNativeOriginalScopeV2,
  configurationCaptureRef: ModalNativeConfigurationCaptureRefV2,
  proofGrantRef: ModalNativeProofGrantRefV2,
  claimId: uuid,
  nonce: uuid,
  claimRevision: positive,
  recordRevision: positive,
  captureId: uuid,
  expiresAt: z.string().datetime(),
};

/** Scheduling custody ONLY. No lease/task grant is fabricated to authorize
 * this prerequisite lookup. A reserved lease supplies exclusion, not effects. */
export const ModalNativeNamespaceReadClaimV2 = z
  .object({
    ...claimFields,
    purpose: z.literal("original-namespace-read"),
    reservation: ModalNativeReservedLeaseRefV2,
  })
  .strict();
export type ModalNativeNamespaceReadClaimV2 = z.infer<typeof ModalNativeNamespaceReadClaimV2>;

/** Exact original router command and authoritative prior cursors; no retarget,
 * new TaskGet adoption, legacy locator, PTY, Start, stdin or process-cancel API. */
export const ModalNativeOriginalCommandReadClaimV2 = z
  .object({
    ...claimFields,
    purpose: z.literal("original-readiness-read"),
    reservation: ModalNativeReservedLeaseRefV2,
    physicalOwnerGeneration: positive,
    operationId: uuid,
    providerBindingKey: z.string().min(1).max(1024),
    command: ModalRouterProviderCommand.refine((v) => v.pty !== true),
  })
  .strict();
export type ModalNativeOriginalCommandReadClaimV2 = z.infer<
  typeof ModalNativeOriginalCommandReadClaimV2
>;

/** Preserve the actual runtime descriptor's encoding/fingerprint domain. This
 * is passive protobuf PREFLIGHT, not the RPC's transmitted bytes or permission. */
export const ModalNativePreparedStartDescriptionV1 = z
  .object({
    taskId: z.string().min(1).max(200),
    execId: commandExecId,
    descriptorProtocol: z.literal("modal-prepared-start-descriptor"),
    descriptorVersion: z.literal(1),
    readinessRecipe: z.literal("modal-exec-readiness-bin-true-v1"),
    readinessRecipeVersion: z.literal(1),
    startMessage: z.literal("Start"),
    rpcMethod: z.literal("/modal.task_command_router.TaskCommandRouter/TaskExecStart"),
    encoderVersion: z.literal("protobufjs@7.6.5"),
    preflight: z
      .object({
        encoding: z.literal("modal-start-protobuf-preflight-v1"),
        sha256: digest,
        byteLength: positive.max(1024 * 1024),
        encoderFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict();
export type ModalNativePreparedStartDescriptionV1 = z.infer<
  typeof ModalNativePreparedStartDescriptionV1
>;

/** Host/native acquisition objects are intentionally NOT constructed here.
 * Raw DTOs, copied refs and any schema-success result cannot mint those objects.
 * Capture needs issuer-authenticated OWN bytes, the exact original claim and a
 * durable capture key; unknown ACK reconciles that same key/acquisition. */
export type ModalNativeProofCaptureStatusV2 =
  | { status: "committed"; captureId: string; receiptId: string; recordRevision: number }
  | { status: "absent_fenced"; captureId: string }
  | { status: "conflict"; captureId: string }
  | { status: "unresolved"; captureId: string };

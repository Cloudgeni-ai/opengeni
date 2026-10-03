import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import { canonicalModalCheckpointProviderBinding } from "@opengeni/contracts";

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const empty = z.object({}).strict();
const binding = z
  .object({
    version: z.literal(1),
    serverUrl: z.string().max(2048),
    workspaceName: z.string().min(1).max(200),
    environment: z.string().max(200),
  })
  .strict();
const blueprint = z
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
          .refine((value) => {
            const milli = Math.trunc(1000 * value);
            return Number.isSafeInteger(milli) && milli >= 1 && milli / 1000 === value;
          }),
        memoryMiB: z.number().int().safe().min(128).max(1_048_576),
        timeoutSeconds: z.number().int().safe().min(1).max(86_400),
        env: empty,
        mounts: z.tuple([]),
      })
      .strict(),
    restore: z.null(),
    readiness: z
      .object({
        operationId: uuid,
        execId: uuid,
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

/** A new wrapper around the unchanged reservation vocabulary. These additional
 * fields MUST NOT be passed as extra keys to the reservation-v1 DB API. */
const specSchema = z
  .object({
    version: z.literal(1),
    recipeId: z.literal("modal-native-fresh-v1"),
    recipeRevision: z.literal(1),
    createWorkdir: z.literal("/tmp"),
    entrypoint: z.tuple([z.literal("sleep"), z.literal("infinity")]),
    origin: z
      .object({
        version: z.literal(1),
        planId: uuid,
        creatorId: uuid,
        accountId: uuid,
        workspaceId: uuid,
        sessionId: uuid,
        turnId: uuid,
        attemptId: uuid,
        executionGeneration: z.number().int().positive().safe(),
        triggerEventId: uuid,
        sandboxGroupId: uuid,
        routeKind: z.literal("home"),
        routeTargetId: z.null(),
        routeEpoch: z.number().int().nonnegative().safe(),
        providerBindingKey: z.string().min(1).max(4096),
        providerBinding: binding,
      })
      .strict(),
    blueprint,
  })
  .strict();
export type NativeFreshCreateSpec = z.infer<typeof specSchema>;

type Immutable<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;

const normalization = {
  recipeId: "modal-native-fresh-v1",
  recipeRevision: 1,
  schema: "modal.client.ModalClient/SandboxCreate",
  encoding: "modal-create-json-v1",
  sdkVersion: "0.9.0",
  // Reviewed installed source; this is a pinned normalization fingerprint,
  // not a runtime file read or an attestation of transmitted protobuf bytes.
  sdkSourceSha256: "bb830ded1925e1d927d1fc221b2329d961f9a57eafdd9a85bf13fb7cfc982599",
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
} as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const compilerFingerprint = sha256(JSON.stringify(normalization));

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
freeze(normalization);

/** Inspect descriptors before parsing/cloning: no getter, callback, class,
 * sparse array, hidden key or non-JSON input may provide a specification. */
function ownData(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("Unsupported native fresh-create specification");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return;
    throw new Error("Unsupported native fresh-create specification");
  }
  // Native detection must precede reflection, including for revoked Proxies.
  if (typeof value !== "object" || types.isProxy(value))
    throw new Error("Unsupported native fresh-create specification");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new Error("Unsupported native fresh-create specification");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((key) => !(array && key === "length"));
  if (array && keys.length !== (value as unknown[]).length)
    throw new Error("Unsupported native fresh-create specification");
  for (const key of keys) {
    if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/u.test(key)))
      throw new Error("Unsupported native fresh-create specification");
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor))
      throw new Error("Unsupported native fresh-create specification");
    ownData(descriptor.value, depth + 1);
  }
}

/** Modal 0.9.0 buildSandboxCreateRequestProto + generated fromPartial defaults,
 * followed by the atomic name/tag injection of modal-create-boundary. Property
 * order and intentionally undefined fields are part of this JSON correlation
 * recipe. Pinned-SDK parity tests, not generic SDK reentry, guard this mirror. */
function normalizedRequest(spec: NativeFreshCreateSpec) {
  const create = spec.blueprint.create;
  return {
    appId: create.appId,
    definition: {
      entrypointArgs: [...spec.entrypoint],
      mountIds: [],
      imageId: create.imageId,
      secretIds: [],
      resources: {
        memoryMb: create.memoryMiB,
        milliCpu: Math.trunc(1000 * create.cpu),
        gpuConfig: { type: 0, count: 0, gpuType: "" },
        memoryMbMax: 0,
        ephemeralDiskMb: 0,
        milliCpuMax: 0,
        rdma: false,
      },
      cloudProvider: 0,
      timeoutSecs: (create.timeoutSeconds * 1000) / 1000,
      workdir: spec.createWorkdir,
      nfsMounts: [],
      runtimeDebug: false,
      blockNetwork: false,
      s3Mounts: [],
      cloudBucketMounts: [],
      volumeMounts: [],
      ptyInfo: undefined,
      schedulerPlacement: undefined,
      workerId: "",
      openPorts: { ports: [] },
      i6pnEnabled: false,
      networkAccess: { networkAccessType: 1, allowedCidrs: [], allowedDomains: [] },
      proxyId: undefined,
      enableSnapshot: false,
      snapshotVersion: undefined,
      cloudProviderStr: "",
      runscRuntimeVersion: undefined,
      runtime: undefined,
      verbose: false,
      name: `opengeni-create-${create.operationId}`,
      experimentalOptions: {},
      experimentalOptionsV2: {},
      preloadPathPrefixes: [],
      idleTimeoutSecs: undefined,
      directSandboxCommandsEnabled: false,
      RestoreInstanceType: "",
      customDomain: "",
      includeOidcIdentityToken: false,
      readinessProbe: undefined,
      inboundCidrAllowlist: [],
      environmentVariables: undefined,
    },
    environmentName: "",
    tags: [{ tagName: "opengeni_provider_create_operation_id", tagValue: create.operationId }],
  };
}

export type NativeFreshCreateCompilation = Immutable<{
  version: 1;
  recipeId: "modal-native-fresh-v1";
  recipeRevision: 1;
  compilerFingerprint: string;
  normalization: typeof normalization;
  spec: NativeFreshCreateSpec;
  normalizedRequest: ReturnType<typeof normalizedRequest>;
  requestJson: string;
  request: {
    encoding: "modal-create-json-v1";
    sha256: string;
    byteLength: number;
    encoderFingerprint: string;
  };
}>;

/** Opaque local compilation handle. It is correlation data, never an accepted
 * operation, authenticated principal, reservation or fresh dispatch grant. */
export type NativeFreshCreatePreparation = Readonly<object>;
const prepared = new WeakMap<object, NativeFreshCreateCompilation>();

/** Synchronous, credentials-free and zero provider/DB/config I/O. Requires all
 * IDs and the complete known fresh recipe before election. Never creates IDs,
 * resolves apps/images, invokes SDK helpers or consumes dispatch authority. */
export function compileNativeFreshCreate(
  input: NativeFreshCreateSpec,
): NativeFreshCreatePreparation {
  try {
    ownData(input);
    const copied: unknown = structuredClone(input);
    if (Buffer.byteLength(JSON.stringify(copied)) > 32_768)
      throw new Error("Unsupported native fresh-create specification");
    const spec = specSchema.parse(copied);
    const { origin, blueprint: plan } = spec;
    const canonical = canonicalModalCheckpointProviderBinding(origin.providerBinding);
    const serverUrl = new URL(origin.providerBinding.serverUrl);
    if (
      !canonical ||
      canonical.key !== origin.providerBindingKey ||
      (["serverUrl", "workspaceName", "environment"] as const).some(
        (field) => canonical.binding[field] !== origin.providerBinding[field],
      ) ||
      !["https:", "http:"].includes(serverUrl.protocol) ||
      serverUrl.username ||
      serverUrl.password ||
      serverUrl.search ||
      serverUrl.hash ||
      origin.creatorId === origin.attemptId
    )
      throw new Error("Unsupported native fresh-create specification");
    const ids = [
      origin.planId,
      origin.creatorId,
      plan.create.operationId,
      plan.readiness.operationId,
      plan.readiness.execId,
      plan.publishOperationId,
      plan.cleanup.operationId,
    ];
    if (new Set(ids).size !== 7) throw new Error("Unsupported native fresh-create specification");
    const request = normalizedRequest(spec);
    const requestJson = JSON.stringify(request);
    const compilation: NativeFreshCreateCompilation = freeze({
      version: 1,
      recipeId: "modal-native-fresh-v1",
      recipeRevision: 1,
      compilerFingerprint,
      normalization,
      spec,
      normalizedRequest: request,
      requestJson,
      request: {
        encoding: "modal-create-json-v1",
        sha256: sha256(requestJson),
        byteLength: Buffer.byteLength(requestJson),
        encoderFingerprint: compilerFingerprint,
      },
    });
    const handle = Object.freeze({});
    prepared.set(handle, compilation);
    return handle;
  } catch {
    // Do not echo arbitrary input, provider tokens or schema diagnostics.
    throw new Error("Unsupported native fresh-create specification");
  }
}

/** Authenticates ONLY local compiler issuance. The full frozen record contains
 * no credential/JWT, grant, DB receipt or transmitted-byte attestation. */
export function describeNativeFreshCreate(
  handle: NativeFreshCreatePreparation,
): NativeFreshCreateCompilation {
  const compilation = prepared.get(handle);
  if (!compilation) throw new Error("Unknown native fresh-create preparation");
  return compilation;
}

import { z } from "zod";
import { RetainedArtifactReferenceSchema } from "./retained-output";

export const INTERACTION_PROTOCOL_VERSION = 1 as const;
export const BROWSER_CONTROL_PROTOCOL_VERSION = INTERACTION_PROTOCOL_VERSION;
export const BROWSER_CONTROL_WEBSOCKET_PROTOCOL = "opengeni.browser.v1" as const;
export const COMPUTER_CONTROL_WEBSOCKET_PROTOCOL = "opengeni.computer.v1" as const;
export const BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX = "opengeni.auth." as const;
export const BROWSER_CONTROL_MAX_JSON_BYTES = 40 * 1024 * 1024;
export const BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES = 64 * 1024;
export const BROWSER_PROFILE_ARTIFACT_FORMAT =
  "opengeni.chromium-profile.v1+gzip+aes-256-gcm" as const;
export const BROWSER_STATE_ARTIFACT_CONTENT_TYPE =
  "application/vnd.opengeni.browser-profile+octet-stream" as const;
export const INTERACTION_MAX_SEMANTIC_NODES = 10_000;
export const INTERACTION_MAX_CHANGED_NODES = 2_000;
export const INTERACTION_MAX_DIAGNOSTIC_ENTRIES = 1_000;
export const INTERACTION_MAX_ACTIONS_PER_BATCH = 32;

const opaqueGeneration = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const boundedOpaqueId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const boundedUrl = z
  .string()
  .min(1)
  .max(16_384)
  .refine(
    (value) => {
      try {
        return new URL(value).href.length > 0;
      } catch {
        return false;
      }
    },
    { message: "URL must be absolute" },
  );
const boundedHttpUrl = boundedUrl.refine(
  (value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  },
  { message: "URL must use HTTP(S) and cannot contain credentials" },
);
const canonicalWebOrigin = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          !url.username &&
          !url.password &&
          value === url.origin
        );
      } catch {
        return false;
      }
    },
    { message: "origin must be a canonical HTTP(S) origin" },
  );
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

export const InteractionPlacement = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sandbox_group"),
      sandboxGroupId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connected_machine"),
      sandboxId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attached_device"),
      deviceId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_provider"),
      providerId: boundedOpaqueId,
      placementId: boundedOpaqueId,
    })
    .strict(),
]);
export type InteractionPlacement = z.infer<typeof InteractionPlacement>;

export const InteractionControllerBinding = z
  .object({
    controllerId: boundedOpaqueId,
    controllerGeneration: opaqueGeneration,
    placementInstanceId: boundedOpaqueId,
  })
  .strict();
export type InteractionControllerBinding = z.infer<typeof InteractionControllerBinding>;

export const InteractionAssociation = z
  .object({
    sessionId: z.string().uuid(),
    turnId: z.string().uuid().nullable(),
    attemptId: z.string().uuid().nullable(),
    relationship: z.enum(["created", "using", "observing", "related"]),
    actorSubjectId: z.string().min(1).max(1_024),
    lastUsedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type InteractionAssociation = z.infer<typeof InteractionAssociation>;

export const InteractionActor = z
  .object({
    kind: z.enum(["agent", "human", "system"]),
    subjectId: z.string().min(1).max(1_024),
    sessionId: z.string().uuid().optional(),
    turnId: z.string().uuid().optional(),
    attemptId: z.string().uuid().optional(),
    executionGeneration: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((actor, context) => {
    const attemptFields = [actor.turnId, actor.attemptId, actor.executionGeneration];
    const attemptFieldCount = attemptFields.filter((value) => value !== undefined).length;
    if (attemptFieldCount !== 0 && (attemptFieldCount !== 3 || actor.sessionId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "turnId, attemptId, executionGeneration, and sessionId must be supplied together",
      });
    }
  });
export type InteractionActor = z.infer<typeof InteractionActor>;

export const InteractionLifecycle = z.enum([
  "starting",
  "active",
  "suspending",
  "suspended",
  "restoring",
  "repair_required",
  "lost",
  "ending",
  "ended",
  "failed",
]);
export type InteractionLifecycle = z.infer<typeof InteractionLifecycle>;

export const BrowserSessionCapabilities = z
  .object({
    semanticObservation: z.boolean(),
    screenshots: z.boolean(),
    liveFrames: z.boolean(),
    humanInput: z.boolean(),
    tabs: z.boolean(),
    downloads: z.boolean(),
    uploads: z.boolean(),
    clipboard: z.boolean(),
    diagnostics: z.boolean(),
    rawCdp: z.boolean(),
    linkedComputer: z.boolean(),
    privateCheckpoint: z.boolean(),
    identityPublication: z.boolean(),
    parallelTargets: z.boolean(),
  })
  .strict();
export type BrowserSessionCapabilities = z.infer<typeof BrowserSessionCapabilities>;

export const BrowserSession = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    lifecycle: InteractionLifecycle,
    placement: InteractionPlacement,
    controller: InteractionControllerBinding.nullable(),
    driverId: boundedOpaqueId,
    engine: z.enum(["chromium", "chrome", "firefox", "webkit", "lightpanda", "external"]),
    engineVersion: z.string().min(1).max(256).nullable(),
    headless: z.boolean(),
    identityId: z.string().uuid().nullable(),
    baseRevisionId: z.string().uuid().nullable(),
    networkRouteId: z.string().uuid().nullable(),
    linkedComputerSessionId: z.string().uuid().nullable(),
    capabilities: BrowserSessionCapabilities,
    associations: z.array(InteractionAssociation).max(1_000),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }),
    failureCode: boundedOpaqueId.nullable(),
  })
  .strict();
export type BrowserSession = z.infer<typeof BrowserSession>;

/** One live Chrome-profile bridge installed on an enrolled machine. This is a
 *  transport endpoint, not saved browser/login state: BrowserIdentity remains
 *  the immutable, reusable state abstraction. */
export const AttachedBrowserDeviceCapabilities = z
  .object({
    tabInventory: z.boolean(),
    debuggerAttachment: z.boolean(),
    semanticObservation: z.boolean(),
    screenshots: z.boolean(),
    liveFrames: z.boolean(),
    humanInput: z.boolean(),
    diagnostics: z.boolean(),
    rawCdp: z.boolean(),
    linkedComputer: z.boolean(),
  })
  .strict();
export type AttachedBrowserDeviceCapabilities = z.infer<typeof AttachedBrowserDeviceCapabilities>;

export const AttachedBrowserDeviceAnnouncement = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    profileLabel: z.string().trim().min(1).max(200).nullable(),
    browserName: z.string().trim().min(1).max(100),
    browserVersion: z.string().trim().min(1).max(256),
    extensionVersion: z.string().trim().min(1).max(256),
    platform: z.enum(["linux", "macos", "windows"]),
    architecture: z.enum(["x64", "arm64"]),
    connectionGeneration: opaqueGeneration,
    inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tabCount: z.number().int().nonnegative().max(100_000),
    capabilities: AttachedBrowserDeviceCapabilities,
  })
  .strict();
export type AttachedBrowserDeviceAnnouncement = z.infer<typeof AttachedBrowserDeviceAnnouncement>;

export const AttachedBrowserInventorySnapshot = z
  .object({
    bridgeGeneration: opaqueGeneration,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    devices: z.array(AttachedBrowserDeviceAnnouncement).max(10_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    for (const [index, device] of snapshot.devices.entries()) {
      if (ids.has(device.id)) {
        context.addIssue({
          code: "custom",
          path: ["devices", index, "id"],
          message: "device ids must be unique within one inventory snapshot",
        });
      }
      ids.add(device.id);
    }
  });
export type AttachedBrowserInventorySnapshot = z.infer<typeof AttachedBrowserInventorySnapshot>;

export const AttachedBrowserDevice = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    profileLabel: z.string().trim().min(1).max(200).nullable(),
    browserName: z.string().trim().min(1).max(100),
    browserVersion: z.string().trim().min(1).max(256),
    extensionVersion: z.string().trim().min(1).max(256),
    platform: z.enum(["linux", "macos", "windows"]),
    architecture: z.enum(["x64", "arm64"]),
    state: z.enum(["connected", "disconnected"]),
    connectionGeneration: opaqueGeneration,
    inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tabCount: z.number().int().nonnegative().max(100_000),
    capabilities: AttachedBrowserDeviceCapabilities,
    lastSeenAt: z.string().datetime({ offset: true }),
    disconnectedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((device, context) => {
    if ((device.state === "connected") !== (device.disconnectedAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["disconnectedAt"],
        message: "connected state and disconnectedAt must agree",
      });
    }
  });
export type AttachedBrowserDevice = z.infer<typeof AttachedBrowserDevice>;

export const AttachedBrowserDeviceListResponse = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    devices: z.array(AttachedBrowserDevice).max(10_000),
  })
  .strict();
export type AttachedBrowserDeviceListResponse = z.infer<typeof AttachedBrowserDeviceListResponse>;

export const AttachedBrowserTab = z
  .object({
    id: boundedOpaqueId,
    windowId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    index: z.number().int().nonnegative().max(100_000),
    title: z.string().max(8_192),
    url: boundedUrl.nullable(),
    active: z.boolean(),
    pinned: z.boolean(),
    incognito: z.boolean(),
    audible: z.boolean(),
    discarded: z.boolean(),
    controllable: z.boolean(),
    unavailableReason: z.string().trim().min(1).max(2_048).nullable(),
  })
  .strict()
  .superRefine((tab, context) => {
    if (tab.controllable === (tab.unavailableReason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "unavailableReason is required exactly when a tab is not controllable",
      });
    }
  });
export type AttachedBrowserTab = z.infer<typeof AttachedBrowserTab>;

export const AttachedBrowserTabListResponse = z
  .object({
    deviceId: z.string().uuid(),
    connectionGeneration: opaqueGeneration,
    inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tabs: z.array(AttachedBrowserTab).max(100_000),
  })
  .strict();
export type AttachedBrowserTabListResponse = z.infer<typeof AttachedBrowserTabListResponse>;

export const BrowserIdentityStatus = z.enum(["active", "archived"]);
export type BrowserIdentityStatus = z.infer<typeof BrowserIdentityStatus>;

export const BrowserRevisionComponentKind = z.enum([
  "chromium_profile",
  "normalized_web_state",
  "provider_snapshot",
]);
export type BrowserRevisionComponentKind = z.infer<typeof BrowserRevisionComponentKind>;

export const BrowserRevisionPortability = z.enum(["portable", "provider_bound", "placement_bound"]);
export type BrowserRevisionPortability = z.infer<typeof BrowserRevisionPortability>;

/** Public, non-secret compatibility declaration for one immutable state
 *  component. Object keys, provider snapshot handles, and encryption material
 *  never enter this contract. */
export const BrowserRevisionMaterialization = z
  .object({
    portability: BrowserRevisionPortability,
    reason: z.string().trim().min(1).max(2_048).nullable(),
    platform: z.enum(["linux", "macos", "windows"]).nullable(),
    architecture: z.enum(["x64", "arm64"]).nullable(),
    engine: z.enum(["chromium", "chrome", "firefox", "webkit", "lightpanda", "external"]),
    engineVersion: z.string().min(1).max(256).nullable(),
    driverId: boundedOpaqueId,
    driverSchemaVersion: z.number().int().positive().max(1_000_000),
    profileCrypto: z.enum(["chromium_basic", "chromium_mock_keychain", "platform_bound"]),
    providerId: boundedOpaqueId.nullable(),
    placement: InteractionPlacement.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.portability === "portable" && (value.providerId || value.placement)) {
      context.addIssue({
        code: "custom",
        message: "portable state cannot carry a binding",
      });
    }
    if (
      value.portability === "provider_bound" &&
      (!value.providerId || value.placement || !value.reason)
    ) {
      context.addIssue({
        code: "custom",
        message: "provider-bound state requires one provider and reason",
      });
    }
    if (
      value.portability === "placement_bound" &&
      (!value.placement || value.providerId || !value.reason)
    ) {
      context.addIssue({
        code: "custom",
        message: "placement-bound state requires one placement and reason",
      });
    }
    if (value.profileCrypto === "platform_bound" && value.portability !== "placement_bound") {
      context.addIssue({
        code: "custom",
        message: "platform-bound profile encryption requires placement-bound state",
      });
    }
  });
export type BrowserRevisionMaterialization = z.infer<typeof BrowserRevisionMaterialization>;

export const BrowserRevisionComponent = z
  .object({
    id: z.string().uuid(),
    kind: BrowserRevisionComponentKind,
    format: boundedOpaqueId,
    artifactDigest: sha256Hex,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    materialization: BrowserRevisionMaterialization,
  })
  .strict();
export type BrowserRevisionComponent = z.infer<typeof BrowserRevisionComponent>;

export const BrowserRevision = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    identityId: z.string().uuid(),
    parentRevisionId: z.string().uuid().nullable(),
    ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceBrowserSessionId: z.string().uuid(),
    manifestDigest: sha256Hex,
    components: z.array(BrowserRevisionComponent).min(1).max(16),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserRevision = z.infer<typeof BrowserRevision>;

export const BrowserIdentity = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    status: BrowserIdentityStatus,
    defaultRevisionId: z.string().uuid().nullable(),
    headGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    revisionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserIdentity = z.infer<typeof BrowserIdentity>;

/** A non-secret reference to credential authority held by OpenGeni Connections.
 * The subject and provider bindings are copied when the browser-auth resource is
 * configured so a later agent cannot swap the UUID to another credential. */
export const InteractionCredentialAuthorityRef = z
  .object({
    connectionId: z.string().uuid(),
    connectionSubjectId: z.string().min(1).max(1_024).nullable(),
    providerDomain: z.string().trim().min(1).max(512),
  })
  .strict();
export type InteractionCredentialAuthorityRef = z.infer<typeof InteractionCredentialAuthorityRef>;

export const NetworkRouteStatus = z.enum(["active", "archived"]);
export type NetworkRouteStatus = z.infer<typeof NetworkRouteStatus>;

export const NetworkRouteConfiguration = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }).strict(),
  z
    .object({
      kind: z.literal("proxy"),
      protocol: z.enum(["http", "https", "socks5"]),
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65_535),
      credential: InteractionCredentialAuthorityRef.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("managed"),
      providerId: boundedOpaqueId,
      routeId: boundedOpaqueId,
      egressClass: z.enum(["datacenter", "residential", "isp"]),
      region: z.string().trim().min(1).max(128).nullable(),
      credential: InteractionCredentialAuthorityRef.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tunnel"),
      placement: InteractionPlacement,
      tunnelId: boundedOpaqueId,
    })
    .strict(),
]);
export type NetworkRouteConfiguration = z.infer<typeof NetworkRouteConfiguration>;

export const NetworkRouteConsistency = z
  .object({
    dns: z.enum(["placement", "proxy", "provider"]),
    expectedPublicIp: z.string().trim().min(1).max(128).nullable(),
    expectedRegion: z.string().trim().min(1).max(128).nullable(),
    locale: z.string().trim().min(1).max(64).nullable(),
    timezone: z.string().trim().min(1).max(128).nullable(),
    geolocation: z
      .object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
        accuracyMeters: z.number().finite().positive().max(1_000_000),
      })
      .strict()
      .nullable(),
    webRtc: z.enum(["default", "disable_non_proxied_udp", "proxy_only"]),
    stability: z.enum(["session", "sticky", "persistent"]),
  })
  .strict();
export type NetworkRouteConsistency = z.infer<typeof NetworkRouteConsistency>;

export const NetworkRoute = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    status: NetworkRouteStatus,
    configuration: NetworkRouteConfiguration,
    consistency: NetworkRouteConsistency,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type NetworkRoute = z.infer<typeof NetworkRoute>;

export const NetworkRouteListResponse = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    routes: z.array(NetworkRoute).max(10_000),
  })
  .strict();
export type NetworkRouteListResponse = z.infer<typeof NetworkRouteListResponse>;

export const CreateNetworkRouteRequest = z
  .object({
    operationId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    configuration: NetworkRouteConfiguration,
    consistency: NetworkRouteConsistency,
  })
  .strict();
export type CreateNetworkRouteRequest = z.infer<typeof CreateNetworkRouteRequest>;

export const UpdateNetworkRouteRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().trim().min(1).max(200).optional(),
    status: NetworkRouteStatus.optional(),
    configuration: NetworkRouteConfiguration.optional(),
    consistency: NetworkRouteConsistency.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.status !== undefined ||
      value.configuration !== undefined ||
      value.consistency !== undefined,
    { message: "network route update is empty" },
  );
export type UpdateNetworkRouteRequest = z.infer<typeof UpdateNetworkRouteRequest>;

export const NetworkRouteMutationResponse = z
  .object({
    route: NetworkRoute,
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();
export type NetworkRouteMutationResponse = z.infer<typeof NetworkRouteMutationResponse>;

export const SiteAuthFieldPurpose = z.enum(["identifier", "password", "secret", "totp"]);
export type SiteAuthFieldPurpose = z.infer<typeof SiteAuthFieldPurpose>;

export const SiteAuthAuthority = z.discriminatedUnion("kind", [
  z
    .object({
      id: boundedOpaqueId,
      kind: z.literal("connection_fields"),
      label: z.string().trim().min(1).max(200),
      credential: InteractionCredentialAuthorityRef,
      fields: z
        .array(
          z
            .object({
              id: boundedOpaqueId,
              purpose: SiteAuthFieldPurpose,
              credentialKey: z.string().trim().min(1).max(256),
              digits: z.number().int().min(6).max(10).optional(),
              periodSeconds: z.number().int().min(15).max(300).optional(),
              algorithm: z.enum(["sha1", "sha256", "sha512"]).optional(),
            })
            .strict()
            .superRefine((field, context) => {
              const totp = field.purpose === "totp";
              if (!totp && (field.digits || field.periodSeconds || field.algorithm)) {
                context.addIssue({
                  code: "custom",
                  message: "TOTP parameters require purpose=totp",
                });
              }
            }),
        )
        .min(1)
        .max(32),
    })
    .strict(),
  z
    .object({
      id: boundedOpaqueId,
      kind: z.literal("human"),
      label: z.string().trim().min(1).max(200),
      fields: z
        .array(z.object({ id: boundedOpaqueId, purpose: SiteAuthFieldPurpose }).strict())
        .max(32),
    })
    .strict(),
  z
    .object({
      id: boundedOpaqueId,
      kind: z.literal("external_provider"),
      label: z.string().trim().min(1).max(200),
      adapterId: boundedOpaqueId,
      credential: InteractionCredentialAuthorityRef.nullable(),
    })
    .strict(),
]);
export type SiteAuthAuthority = z.infer<typeof SiteAuthAuthority>;

export const SiteAuthMethod = z
  .object({
    id: boundedOpaqueId,
    kind: z.enum(["password", "sso", "magic_link", "passkey", "external"]),
    label: z.string().trim().min(1).max(200),
    authorityIds: z.array(boundedOpaqueId).min(1).max(32),
  })
  .strict();
export type SiteAuthMethod = z.infer<typeof SiteAuthMethod>;

export const SiteAuthHealthPolicy = z
  .object({
    mode: z.enum(["on_use", "maintained"]),
    intervalSeconds: z.number().int().min(60).max(31_536_000).nullable(),
    automaticRepair: z.boolean(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.mode === "maintained" && policy.intervalSeconds === null) {
      context.addIssue({ code: "custom", message: "maintained auth requires an interval" });
    }
    if (policy.mode === "on_use" && policy.intervalSeconds !== null) {
      context.addIssue({ code: "custom", message: "on-use auth cannot have an interval" });
    }
  });
export type SiteAuthHealthPolicy = z.infer<typeof SiteAuthHealthPolicy>;

export const SiteAuthVerificationState = z.enum(["unknown", "verified", "needs_repair", "failed"]);
export type SiteAuthVerificationState = z.infer<typeof SiteAuthVerificationState>;

const SiteAuthConnectionConfiguration = z
  .object({
    name: z.string().trim().min(1).max(200),
    accountLabel: z.string().trim().min(1).max(200),
    origins: z.array(canonicalWebOrigin).min(1).max(64),
    loginUrl: boundedHttpUrl.nullable(),
    verificationUrlPrefixes: z.array(boundedHttpUrl).max(32),
    authorities: z.array(SiteAuthAuthority).min(1).max(32),
    methods: z.array(SiteAuthMethod).min(1).max(32),
    preferredIdentityId: z.string().uuid().nullable(),
    preferredPlacement: InteractionPlacement.nullable(),
    preferredNetworkRouteId: z.string().uuid().nullable(),
    healthPolicy: SiteAuthHealthPolicy,
  })
  .strict();

function validateSiteAuthConfiguration(
  connection: z.infer<typeof SiteAuthConnectionConfiguration>,
  context: z.RefinementCtx,
): void {
  if (new Set(connection.origins).size !== connection.origins.length) {
    context.addIssue({ code: "custom", path: ["origins"], message: "origins repeat" });
  }
  if (
    new Set(connection.verificationUrlPrefixes).size !== connection.verificationUrlPrefixes.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["verificationUrlPrefixes"],
      message: "verification URL prefixes repeat",
    });
  }
  const allowedOrigins = new Set(connection.origins);
  const checkedUrls = [
    ...(connection.loginUrl ? [{ path: ["loginUrl"], value: connection.loginUrl }] : []),
    ...connection.verificationUrlPrefixes.map((value, index) => ({
      path: ["verificationUrlPrefixes", index],
      value,
    })),
  ];
  for (const checked of checkedUrls) {
    if (!allowedOrigins.has(new URL(checked.value).origin)) {
      context.addIssue({
        code: "custom",
        path: checked.path,
        message: "URL origin must be explicitly allowed",
      });
    }
  }
  const authorityIds = new Set(connection.authorities.map((authority) => authority.id));
  if (authorityIds.size !== connection.authorities.length) {
    context.addIssue({ code: "custom", path: ["authorities"], message: "authority ids repeat" });
  }
  const methodIds = new Set(connection.methods.map((method) => method.id));
  if (methodIds.size !== connection.methods.length) {
    context.addIssue({ code: "custom", path: ["methods"], message: "method ids repeat" });
  }
  for (const [index, method] of connection.methods.entries()) {
    if (new Set(method.authorityIds).size !== method.authorityIds.length) {
      context.addIssue({
        code: "custom",
        path: ["methods", index, "authorityIds"],
        message: "method authority ids repeat",
      });
    }
    if (method.authorityIds.some((id) => !authorityIds.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["methods", index, "authorityIds"],
        message: "method references an unknown authority",
      });
    }
  }
  for (const [index, authority] of connection.authorities.entries()) {
    if (authority.kind === "external_provider") continue;
    const fieldIds = authority.fields.map((field) => field.id);
    if (new Set(fieldIds).size !== fieldIds.length) {
      context.addIssue({
        code: "custom",
        path: ["authorities", index, "fields"],
        message: "authority field ids repeat",
      });
    }
  }
}

export const SiteAuthConnection = SiteAuthConnectionConfiguration.extend({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  status: z.enum(["active", "archived"]),
  verificationState: SiteAuthVerificationState,
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  lastVerifiedUrl: boundedUrl.nullable(),
  repairCode: boundedOpaqueId.nullable(),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdBySubjectId: z.string().min(1).max(1_024),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine(validateSiteAuthConfiguration);
export type SiteAuthConnection = z.infer<typeof SiteAuthConnection>;

export const SiteAuthConnectionListResponse = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    connections: z.array(SiteAuthConnection).max(10_000),
  })
  .strict();
export type SiteAuthConnectionListResponse = z.infer<typeof SiteAuthConnectionListResponse>;

export const CreateSiteAuthConnectionRequest = SiteAuthConnectionConfiguration.extend({
  operationId: z.string().uuid(),
}).superRefine(validateSiteAuthConfiguration);
export type CreateSiteAuthConnectionRequest = z.infer<typeof CreateSiteAuthConnectionRequest>;

export const UpdateSiteAuthConnectionRequest = SiteAuthConnectionConfiguration.partial()
  .extend({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => !["operationId", "expectedVersion"].includes(key)),
    {
      message: "site auth connection update is empty",
    },
  );
export type UpdateSiteAuthConnectionRequest = z.infer<typeof UpdateSiteAuthConnectionRequest>;

export const SiteAuthConnectionMutationResponse = z
  .object({
    connection: SiteAuthConnection,
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();
export type SiteAuthConnectionMutationResponse = z.infer<typeof SiteAuthConnectionMutationResponse>;

export const AuthRunState = z.enum([
  "discovering",
  "awaiting_choice",
  "awaiting_secret",
  "awaiting_external_action",
  "working",
  "verified",
  "failed",
  "cancelled",
]);
export type AuthRunState = z.infer<typeof AuthRunState>;

export const AuthRunChoice = z
  .object({
    id: boundedOpaqueId,
    label: z.string().trim().min(1).max(200),
    methodId: boundedOpaqueId,
  })
  .strict();
export type AuthRunChoice = z.infer<typeof AuthRunChoice>;

export const AuthRunPendingField = z
  .object({
    id: boundedOpaqueId,
    label: z.string().trim().min(1).max(200),
    purpose: SiteAuthFieldPurpose,
  })
  .strict();
export type AuthRunPendingField = z.infer<typeof AuthRunPendingField>;

export const AuthRunExternalAction = z
  .object({
    kind: z.enum(["push", "security_key", "passkey", "device", "human", "other"]),
    label: z.string().trim().min(1).max(500),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type AuthRunExternalAction = z.infer<typeof AuthRunExternalAction>;

export const AuthRun = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    siteAuthConnectionId: z.string().uuid(),
    browserSessionId: z.string().uuid(),
    targetId: boundedOpaqueId,
    controllerGeneration: opaqueGeneration,
    targetGeneration: opaqueGeneration,
    documentGeneration: opaqueGeneration.nullable(),
    methodId: boundedOpaqueId.nullable(),
    authorityId: boundedOpaqueId.nullable(),
    state: AuthRunState,
    choices: z.array(AuthRunChoice).max(64),
    pendingFields: z.array(AuthRunPendingField).max(64),
    externalAction: AuthRunExternalAction.nullable(),
    interventionId: z.string().uuid().nullable(),
    verifiedUrl: boundedUrl.nullable(),
    failureCode: boundedOpaqueId.nullable(),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operationId: z.string().uuid(),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const settled = run.state === "verified" || run.state === "failed" || run.state === "cancelled";
    if (settled !== (run.settledAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["settledAt"],
        message: "settled state and timestamp must agree",
      });
    }
    if ((run.state === "verified") !== (run.verifiedUrl !== null)) {
      context.addIssue({
        code: "custom",
        path: ["verifiedUrl"],
        message: "verified URL requires verified state",
      });
    }
    if ((run.state === "failed") !== (run.failureCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failure code requires failed state",
      });
    }
    if ((run.state === "awaiting_choice") !== run.choices.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "choices require awaiting-choice state",
      });
    }
    if ((run.state === "awaiting_secret") !== run.pendingFields.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["pendingFields"],
        message: "pending fields require awaiting-secret state",
      });
    }
    if ((run.state === "awaiting_external_action") !== (run.externalAction !== null)) {
      context.addIssue({
        code: "custom",
        path: ["externalAction"],
        message: "external action requires its waiting state",
      });
    }
  });
export type AuthRun = z.infer<typeof AuthRun>;

export const AuthRunListResponse = z.object({ runs: z.array(AuthRun).max(10_000) }).strict();
export type AuthRunListResponse = z.infer<typeof AuthRunListResponse>;

export const AuthRunMutationResponse = z
  .object({
    run: AuthRun,
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();
export type AuthRunMutationResponse = z.infer<typeof AuthRunMutationResponse>;

export const StartAuthRunRequest = z
  .object({
    operationId: z.string().uuid(),
    siteAuthConnectionId: z.string().uuid(),
    targetId: boundedOpaqueId,
    expectedTargetGeneration: opaqueGeneration,
    expectedDocumentGeneration: opaqueGeneration.nullable(),
    methodId: boundedOpaqueId.optional(),
    authorityId: boundedOpaqueId.optional(),
  })
  .strict();
export type StartAuthRunRequest = z.infer<typeof StartAuthRunRequest>;

export const ReportAuthRunRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    methodId: boundedOpaqueId.optional(),
    authorityId: boundedOpaqueId.optional(),
    state: z.enum([
      "awaiting_choice",
      "awaiting_secret",
      "awaiting_external_action",
      "working",
      "failed",
      "cancelled",
    ]),
    choices: z.array(AuthRunChoice).max(64).optional(),
    pendingFields: z.array(AuthRunPendingField).max(64).optional(),
    externalAction: AuthRunExternalAction.nullable().optional(),
    failureCode: boundedOpaqueId.nullable().optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if ((report.state === "awaiting_choice") !== Boolean(report.choices?.length)) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "choices require awaiting-choice state",
      });
    }
    if ((report.state === "awaiting_secret") !== Boolean(report.pendingFields?.length)) {
      context.addIssue({
        code: "custom",
        path: ["pendingFields"],
        message: "pending fields require awaiting-secret state",
      });
    }
    if ((report.state === "awaiting_external_action") !== Boolean(report.externalAction)) {
      context.addIssue({
        code: "custom",
        path: ["externalAction"],
        message: "external action requires its waiting state",
      });
    }
    if ((report.state === "failed") !== Boolean(report.failureCode)) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failure code requires failed state",
      });
    }
  });
export type ReportAuthRunRequest = z.infer<typeof ReportAuthRunRequest>;

export const ProtectedAuthField = z
  .object({ fieldId: boundedOpaqueId, locator: z.lazy(() => BrowserLocator) })
  .strict();
export type ProtectedAuthField = z.infer<typeof ProtectedAuthField>;

export const ProtectedAuthSubmit = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("click"), locator: z.lazy(() => BrowserLocator) }).strict(),
  z
    .object({
      type: z.literal("press"),
      key: z.string().min(1).max(256),
      locator: z.lazy(() => BrowserLocator).optional(),
    })
    .strict(),
]);
export type ProtectedAuthSubmit = z.infer<typeof ProtectedAuthSubmit>;

export const ProtectedAuthFillRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedTargetGeneration: opaqueGeneration,
    expectedDocumentGeneration: opaqueGeneration.nullable(),
    expectedFrameId: opaqueGeneration.nullable(),
    authorityId: boundedOpaqueId,
    fields: z.array(ProtectedAuthField).min(1).max(32),
    submit: ProtectedAuthSubmit.default({ type: "none" }),
  })
  .strict();
export type ProtectedAuthFillRequest = z.infer<typeof ProtectedAuthFillRequest>;

export const ProtectedAuthFillResponse = z
  .object({
    run: AuthRun,
    status: z.enum(["submitted", "working", "needs_human", "stale", "failed"]),
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();
export type ProtectedAuthFillResponse = z.infer<typeof ProtectedAuthFillResponse>;

export const VerifyAuthRunRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type VerifyAuthRunRequest = z.infer<typeof VerifyAuthRunRequest>;

export const InteractionInterventionStatus = z.enum([
  "open",
  "completed",
  "dismissed",
  "expired",
  "cancelled",
]);
export type InteractionInterventionStatus = z.infer<typeof InteractionInterventionStatus>;

export const InteractionIntervention = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    resourceKind: z.enum(["browser_session", "computer_session"]),
    resourceId: z.string().uuid(),
    targetId: boundedOpaqueId,
    controllerGeneration: opaqueGeneration,
    targetGeneration: opaqueGeneration,
    documentGeneration: opaqueGeneration.nullable(),
    kind: z.enum(["manual_login", "mfa", "external_action", "confirmation", "other"]),
    reason: z.string().trim().min(1).max(2_048),
    status: InteractionInterventionStatus,
    authRunId: z.string().uuid().nullable(),
    originatingSessionId: z.string().uuid(),
    originatingTurnId: z.string().uuid().nullable(),
    originatingAttemptId: z.string().uuid().nullable(),
    originatingToolOperationId: z.string().uuid().nullable(),
    responseActorSubjectId: z.string().min(1).max(1_024).nullable(),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operationId: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type InteractionIntervention = z.infer<typeof InteractionIntervention>;

export const InteractionInterventionListResponse = z
  .object({ interventions: z.array(InteractionIntervention).max(10_000) })
  .strict();
export type InteractionInterventionListResponse = z.infer<
  typeof InteractionInterventionListResponse
>;

export const CreateInteractionInterventionRequest = z
  .object({
    operationId: z.string().uuid(),
    resourceKind: z.enum(["browser_session", "computer_session"]),
    resourceId: z.string().uuid(),
    targetId: boundedOpaqueId,
    expectedControllerGeneration: opaqueGeneration,
    expectedTargetGeneration: opaqueGeneration,
    expectedDocumentGeneration: opaqueGeneration.nullable(),
    kind: z.enum(["manual_login", "mfa", "external_action", "confirmation", "other"]),
    reason: z.string().trim().min(1).max(2_048),
    authRunId: z.string().uuid().optional(),
    expiresInSeconds: z.number().int().min(30).max(86_400).default(900),
  })
  .strict();
export type CreateInteractionInterventionRequest = z.infer<
  typeof CreateInteractionInterventionRequest
>;

export const ResolveInteractionInterventionRequest = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    outcome: z.enum(["completed", "dismissed"]),
  })
  .strict();
export type ResolveInteractionInterventionRequest = z.infer<
  typeof ResolveInteractionInterventionRequest
>;

export const InteractionInterventionMutationResponse = z
  .object({
    intervention: InteractionIntervention,
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();
export type InteractionInterventionMutationResponse = z.infer<
  typeof InteractionInterventionMutationResponse
>;

export const BrowserIdentityListResponse = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    identities: z.array(BrowserIdentity).max(10_000),
  })
  .strict();
export type BrowserIdentityListResponse = z.infer<typeof BrowserIdentityListResponse>;

export const BrowserRevisionListResponse = z
  .object({
    identity: BrowserIdentity,
    revisions: z.array(BrowserRevision).max(10_000),
  })
  .strict();
export type BrowserRevisionListResponse = z.infer<typeof BrowserRevisionListResponse>;

export const CreateBrowserIdentityRequest = z
  .object({
    operationId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreateBrowserIdentityRequest = z.infer<typeof CreateBrowserIdentityRequest>;

export const BrowserIdentityMutationResponse = z
  .object({
    identity: BrowserIdentity,
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();
export type BrowserIdentityMutationResponse = z.infer<typeof BrowserIdentityMutationResponse>;

/** Capture the exact live working profile. The controller derives the parent
 *  from the session's current saved base; callers cannot forge lineage. */
export const PublishBrowserRevisionRequest = z
  .object({
    operationId: z.string().uuid(),
    identityId: z.string().uuid(),
    expectedHeadGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    advanceDefault: z.boolean().default(true),
  })
  .strict();
export type PublishBrowserRevisionRequest = z.infer<typeof PublishBrowserRevisionRequest>;

export const PublishBrowserRevisionResponse = z
  .object({
    identity: BrowserIdentity,
    revision: BrowserRevision,
    outcome: z.enum(["saved_as_default", "saved_not_default"]),
    replayed: z.boolean(),
  })
  .strict();
export type PublishBrowserRevisionResponse = z.infer<typeof PublishBrowserRevisionResponse>;

export const BrowserTarget = z
  .object({
    id: boundedOpaqueId,
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetGeneration: opaqueGeneration,
    documentGeneration: opaqueGeneration.nullable(),
    kind: z.enum(["page", "popup", "background_page", "worker"]),
    title: z.string().max(4_096),
    url: boundedUrl,
    selected: z.boolean(),
    attached: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserTarget = z.infer<typeof BrowserTarget>;

export const InteractionRect = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
export type InteractionRect = z.infer<typeof InteractionRect>;

export const InteractionRedactedValue = z
  .object({
    redacted: z.literal(true),
    reason: z.enum(["password", "payment", "private", "policy"]),
  })
  .strict();
export type InteractionRedactedValue = z.infer<typeof InteractionRedactedValue>;

export type InteractionSemanticNodeValue = {
  ref: string;
  role: string;
  identifier?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  value?: string | InteractionRedactedValue | undefined;
  states: string[];
  bounds?: InteractionRect | undefined;
  actions: string[];
  children?: InteractionSemanticNodeValue[] | undefined;
  native?: { platform: "dom" | "mac_ax" | "at_spi" | "uia"; data: unknown } | undefined;
};

export const InteractionSemanticNode: z.ZodType<InteractionSemanticNodeValue> = z.lazy(() =>
  z
    .object({
      ref: boundedOpaqueId,
      role: z.string().min(1).max(256),
      identifier: z.string().min(1).max(2_048).optional(),
      name: z.string().max(8_192).optional(),
      description: z.string().max(8_192).optional(),
      value: z.union([z.string().max(32_768), InteractionRedactedValue]).optional(),
      states: z.array(z.string().min(1).max(128)).max(64),
      bounds: InteractionRect.optional(),
      actions: z.array(z.string().min(1).max(128)).max(64),
      children: z.array(InteractionSemanticNode).optional(),
      native: z
        .object({
          platform: z.enum(["dom", "mac_ax", "at_spi", "uia"]),
          data: z.json(),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

export const InteractionSemanticSnapshot = z
  .object({
    kind: z.literal("snapshot"),
    roots: z.array(InteractionSemanticNode),
    nodeCount: z.number().int().nonnegative().max(INTERACTION_MAX_SEMANTIC_NODES),
  })
  .strict();

export const InteractionSemanticDiff = z
  .object({
    kind: z.literal("diff"),
    baseObservationId: boundedOpaqueId,
    removedRefs: z.array(boundedOpaqueId).max(INTERACTION_MAX_CHANGED_NODES),
    changed: z.array(InteractionSemanticNode).max(INTERACTION_MAX_CHANGED_NODES),
  })
  .strict();

export const InteractionDiagnosticSummary = z
  .object({
    consoleErrorCount: z.number().int().nonnegative(),
    failedRequestCount: z.number().int().nonnegative(),
    downloadCount: z.number().int().nonnegative(),
    pageErrorCount: z.number().int().nonnegative(),
  })
  .strict();

export const BrowserDialog = z
  .object({
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string().max(8_192),
    defaultPrompt: z.string().max(32_768),
    openedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserDialog = z.infer<typeof BrowserDialog>;

export const BrowserObservation = z
  .object({
    protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
    observationId: boundedOpaqueId,
    browserSessionId: z.string().uuid(),
    target: BrowserTarget,
    frameId: opaqueGeneration.nullable(),
    semantic: z.union([InteractionSemanticSnapshot, InteractionSemanticDiff]).nullable(),
    screenshot: RetainedArtifactReferenceSchema.nullable(),
    focusedRef: boundedOpaqueId.nullable(),
    changedRegions: z.array(InteractionRect).max(INTERACTION_MAX_CHANGED_NODES),
    diagnostics: InteractionDiagnosticSummary,
    dialog: BrowserDialog.nullable(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserObservation = z.infer<typeof BrowserObservation>;

export const BrowserDiagnosticKind = z.enum([
  "console",
  "page_error",
  "failed_request",
  "download",
]);
export type BrowserDiagnosticKind = z.infer<typeof BrowserDiagnosticKind>;

export const BrowserDiagnosticEntry = z
  .object({
    sequence: z.number().int().positive(),
    kind: BrowserDiagnosticKind,
    level: z.enum(["debug", "info", "warning", "error"]).nullable(),
    message: z.string().max(8_192),
    url: boundedUrl.nullable(),
    method: z.string().min(1).max(32).nullable(),
    status: z.number().int().min(100).max(999).nullable(),
    filename: z.string().max(4_096).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserDiagnosticEntry = z.infer<typeof BrowserDiagnosticEntry>;

export const BrowserDiagnosticBatch = z
  .object({
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    targetGeneration: opaqueGeneration,
    entries: z.array(BrowserDiagnosticEntry).max(INTERACTION_MAX_DIAGNOSTIC_ENTRIES),
    cursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type BrowserDiagnosticBatch = z.infer<typeof BrowserDiagnosticBatch>;

export const BrowserLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ref"), ref: boundedOpaqueId }).strict(),
  z
    .object({
      kind: z.literal("role"),
      role: z.string().min(1).max(256),
      name: z.string().max(8_192).optional(),
      exact: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("label"), text: z.string().min(1).max(8_192) }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(8_192) }).strict(),
  z
    .object({
      kind: z.literal("placeholder"),
      text: z.string().min(1).max(8_192),
    })
    .strict(),
  z.object({ kind: z.literal("test_id"), value: z.string().min(1).max(2_048) }).strict(),
  z.object({ kind: z.literal("css"), selector: z.string().min(1).max(8_192) }).strict(),
]);
export type BrowserLocator = z.infer<typeof BrowserLocator>;

/** Provider-neutral locator for native accessibility trees. Native automation
 * identifiers are intentionally distinct from DOM selectors/test ids: AX,
 * AT-SPI, and UIA adapters resolve them inside the exact observed target. */
export const ComputerLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ref"), ref: boundedOpaqueId }).strict(),
  z
    .object({
      kind: z.literal("role"),
      role: z.string().min(1).max(256),
      name: z.string().max(8_192).optional(),
      exact: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("label"),
      text: z.string().min(1).max(8_192),
      exact: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().min(1).max(8_192),
      exact: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("identifier"),
      value: z.string().min(1).max(2_048),
    })
    .strict(),
]);
export type ComputerLocator = z.infer<typeof ComputerLocator>;

const browserActionVariants = [
  z.object({ type: z.literal("navigate"), url: boundedUrl }).strict(),
  z
    .object({
      type: z.literal("click"),
      locator: BrowserLocator,
      button: z.enum(["left", "right", "middle"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("double_click"), locator: BrowserLocator }).strict(),
  z.object({ type: z.literal("hover"), locator: BrowserLocator }).strict(),
  z
    .object({
      type: z.literal("fill"),
      locator: BrowserLocator,
      value: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      locator: BrowserLocator.optional(),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("press"),
      locator: BrowserLocator.optional(),
      key: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      locator: BrowserLocator,
      values: z.array(z.string().max(8_192)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("check"),
      locator: BrowserLocator,
      checked: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      locator: BrowserLocator.optional(),
      deltaX: z.number().finite(),
      deltaY: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      from: BrowserLocator,
      to: BrowserLocator,
    })
    .strict(),
  z
    .object({
      type: z.literal("pointer"),
      action: z.enum(["click", "double_click", "move", "scroll", "drag"]),
      x: z.number().finite().nonnegative().max(1_000_000),
      y: z.number().finite().nonnegative().max(1_000_000),
      endX: z.number().finite().nonnegative().max(1_000_000).optional(),
      endY: z.number().finite().nonnegative().max(1_000_000).optional(),
      deltaX: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
      deltaY: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    })
    .strict()
    .superRefine((action, context) => {
      const hasEnd = action.endX !== undefined || action.endY !== undefined;
      const hasDelta = action.deltaX !== undefined || action.deltaY !== undefined;
      if (action.action === "drag" && (action.endX === undefined || action.endY === undefined)) {
        context.addIssue({
          code: "custom",
          message: "pointer drag requires endX and endY",
        });
      }
      if (action.action !== "drag" && hasEnd) {
        context.addIssue({
          code: "custom",
          message: "pointer end coordinates require drag",
        });
      }
      if (
        action.action === "scroll" &&
        action.deltaX === undefined &&
        action.deltaY === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "pointer scroll requires a delta",
        });
      }
      if (action.action !== "scroll" && hasDelta) {
        context.addIssue({
          code: "custom",
          message: "pointer deltas require scroll",
        });
      }
    }),
  z
    .object({
      type: z.literal("handle_dialog"),
      response: z.enum(["accept", "dismiss"]),
      promptText: z.string().max(32_768).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("upload"),
      locator: BrowserLocator,
      workspaceFileIds: z.array(z.string().uuid()).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait"),
      condition: z.enum(["load", "network_idle", "visible", "hidden"]),
      locator: BrowserLocator.optional(),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    })
    .strict(),
] as const;

export const BrowserAction = z.discriminatedUnion("type", browserActionVariants);
export type BrowserAction = z.infer<typeof BrowserAction>;

export const BrowserActionBatch = z
  .object({
    type: z.literal("batch"),
    actions: z.array(BrowserAction).min(1).max(INTERACTION_MAX_ACTIONS_PER_BATCH),
  })
  .strict();
export type BrowserActionBatch = z.infer<typeof BrowserActionBatch>;

export const InteractionError = z
  .object({
    code: z.enum([
      "resource_not_found",
      "resource_unavailable",
      "controller_stale",
      "target_not_found",
      "target_stale",
      "observation_stale",
      "document_stale",
      "frame_stale",
      "locator_not_found",
      "locator_ambiguous",
      "unsupported",
      "permission_denied",
      "machine_locked",
      "attempt_stale",
      "operation_conflict",
      "outcome_unknown",
      "invalid_action",
      "timeout",
      "controller_lost",
      "driver_failed",
    ]),
    message: z.string().min(1).max(8_192),
    retryable: z.boolean(),
    details: z.record(z.string().max(256), z.json()).optional(),
  })
  .strict();
export type InteractionError = z.infer<typeof InteractionError>;

export const BrowserActionCommand = z
  .object({
    protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
    operationId: z.string().uuid(),
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    expectedTargetGeneration: opaqueGeneration,
    expectedDocumentGeneration: opaqueGeneration.nullable(),
    expectedFrameId: opaqueGeneration.nullable(),
    actor: InteractionActor,
    action: z.union([BrowserAction, BrowserActionBatch]),
  })
  .strict();
export type BrowserActionCommand = z.infer<typeof BrowserActionCommand>;

export const InteractionOperationState = z.enum([
  "prepared",
  "dispatched",
  "completed",
  "failed",
  "outcome_unknown",
]);
export type InteractionOperationState = z.infer<typeof InteractionOperationState>;

export const InteractionLifecycleOperationKind = z.enum([
  "create",
  "resume",
  "suspend",
  "end",
  "publish",
]);
export type InteractionLifecycleOperationKind = z.infer<typeof InteractionLifecycleOperationKind>;

export const InteractionLifecycleOperationReceipt = z
  .object({
    operationId: z.string().uuid(),
    resourceKind: z.enum(["browser_session", "computer_session"]),
    resourceId: z.string().uuid(),
    kind: InteractionLifecycleOperationKind,
    state: InteractionOperationState,
    replayed: z.boolean(),
    error: InteractionError.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    dispatchedAt: z.string().datetime({ offset: true }).nullable(),
    settledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.state === "completed" && (receipt.error !== null || receipt.settledAt === null)) {
      context.addIssue({
        code: "custom",
        message: "completed operation must settle without error",
      });
    }
    if (
      (receipt.state === "failed" || receipt.state === "outcome_unknown") &&
      (receipt.error === null || receipt.settledAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "terminal operation error requires error and time",
      });
    }
    if (receipt.state === "dispatched" && receipt.dispatchedAt === null) {
      context.addIssue({
        code: "custom",
        message: "dispatched operation requires dispatch time",
      });
    }
  });
export type InteractionLifecycleOperationReceipt = z.infer<
  typeof InteractionLifecycleOperationReceipt
>;

export const CreateBrowserSessionRequest = z
  .object({
    operationId: z.string().uuid(),
    sessionId: z.string().uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    initialUrl: boundedUrl.optional(),
    headless: z.boolean().default(true),
    placement: InteractionPlacement.optional(),
    identityId: z.string().uuid().optional(),
    baseRevisionId: z.string().uuid().optional(),
    networkRouteId: z.string().uuid().optional(),
    linkedComputerSessionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baseRevisionId && !value.identityId) {
      context.addIssue({
        code: "custom",
        path: ["baseRevisionId"],
        message: "baseRevisionId requires identityId",
      });
    }
    if (value.linkedComputerSessionId && value.headless) {
      context.addIssue({
        code: "custom",
        path: ["linkedComputerSessionId"],
        message: "a linked computer requires a headed browser",
      });
    }
    if (value.placement?.kind === "attached_device") {
      if (value.linkedComputerSessionId) {
        context.addIssue({
          code: "custom",
          path: ["linkedComputerSessionId"],
          message: "attached Chrome does not expose an exact linked computer yet",
        });
      }
      if (value.headless) {
        context.addIssue({
          code: "custom",
          path: ["headless"],
          message: "attached browser placement is always headed",
        });
      }
      if (value.identityId || value.baseRevisionId) {
        context.addIssue({
          code: "custom",
          path: ["identityId"],
          message: "attached browser placement already has a live profile identity",
        });
      }
    }
  });
export type CreateBrowserSessionRequest = z.infer<typeof CreateBrowserSessionRequest>;

export const BrowserSessionListResponse = z
  .object({
    revision: z.number().int().nonnegative(),
    sessions: z.array(BrowserSession).max(10_000),
  })
  .strict();
export type BrowserSessionListResponse = z.infer<typeof BrowserSessionListResponse>;

export const BrowserSessionMutationResponse = z
  .object({
    session: BrowserSession,
    operation: InteractionLifecycleOperationReceipt,
  })
  .strict();
export type BrowserSessionMutationResponse = z.infer<typeof BrowserSessionMutationResponse>;

export const BrowserSessionLifecycleRequest = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict();
export type BrowserSessionLifecycleRequest = z.infer<typeof BrowserSessionLifecycleRequest>;

export const BrowserOpenTargetRequest = z
  .object({
    url: boundedUrl.optional(),
  })
  .strict();
export type BrowserOpenTargetRequest = z.infer<typeof BrowserOpenTargetRequest>;

export const BrowserTargetListResponse = z
  .object({
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targets: z.array(BrowserTarget).max(10_000),
  })
  .strict();
export type BrowserTargetListResponse = z.infer<typeof BrowserTargetListResponse>;

export const InteractionFrameStreamOptions = z
  .object({
    format: z.enum(["jpeg", "png"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    maxWidth: z.number().int().min(1).max(4_096).optional(),
    maxHeight: z.number().int().min(1).max(4_096).optional(),
    everyNthFrame: z.number().int().min(1).max(60).optional(),
  })
  .strict();
export type InteractionFrameStreamOptions = z.infer<typeof InteractionFrameStreamOptions>;

export const BrowserFrameStreamOptions = InteractionFrameStreamOptions;
export type BrowserFrameStreamOptions = z.infer<typeof BrowserFrameStreamOptions>;

/** Placement-neutral controller attachment. Browser and Computer viewers use
 * the same authenticated transport shape while negotiating distinct stream
 * protocols and resource generations. */
const DirectInteractionFrameStreamAttachment = z
  .object({
    kind: z.literal("direct_websocket"),
    url: boundedUrl,
    protocols: z.array(z.string().min(1).max(2_048)).length(2),
  })
  .strict();

function relayInteractionFrameStreamAttachment<const Kind extends 3 | 4>(kind: Kind) {
  return z
    .object({
      kind: z.literal("relay"),
      url: boundedUrl,
      token: z.string().min(32).max(8_192),
      channel: z
        .object({
          channelId: boundedOpaqueId,
          workspaceId: z.string().uuid(),
          agentId: boundedOpaqueId,
          kind: z.literal(kind),
          port: z.number().int().min(1).max(65_535),
        })
        .strict(),
    })
    .strict();
}

export const BrowserFrameStreamAttachment = z.discriminatedUnion("kind", [
  DirectInteractionFrameStreamAttachment,
  relayInteractionFrameStreamAttachment(3),
]);
export type BrowserFrameStreamAttachment = z.infer<typeof BrowserFrameStreamAttachment>;

export const ComputerFrameStreamAttachment = z.discriminatedUnion("kind", [
  DirectInteractionFrameStreamAttachment,
  relayInteractionFrameStreamAttachment(4),
]);
export type ComputerFrameStreamAttachment = z.infer<typeof ComputerFrameStreamAttachment>;

export const InteractionFrameStreamAttachment = z.union([
  BrowserFrameStreamAttachment,
  ComputerFrameStreamAttachment,
]);
export type InteractionFrameStreamAttachment = z.infer<typeof InteractionFrameStreamAttachment>;

export const BrowserSessionAttachment = z
  .object({
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    stream: BrowserFrameStreamAttachment,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserSessionAttachment = z.infer<typeof BrowserSessionAttachment>;

export const BrowserSessionAttachmentRequest = z
  .object({
    targetId: boundedOpaqueId,
    expiresInSeconds: z.number().int().min(15).max(600).default(120),
    stream: BrowserFrameStreamOptions.optional(),
  })
  .strict();
export type BrowserSessionAttachmentRequest = z.infer<typeof BrowserSessionAttachmentRequest>;

/** Human/API action request. The API supplies resource/controller/actor fields
 * from authenticated durable authority before dispatching the canonical
 * BrowserActionCommand to the placement. */
export const BrowserActionRequest = z
  .object({
    operationId: z.string().uuid(),
    targetId: boundedOpaqueId,
    expectedTargetGeneration: opaqueGeneration,
    expectedDocumentGeneration: opaqueGeneration.nullable(),
    expectedFrameId: opaqueGeneration.nullable(),
    action: z.union([BrowserAction, BrowserActionBatch]),
  })
  .strict();
export type BrowserActionRequest = z.infer<typeof BrowserActionRequest>;

export const BrowserSessionHeartbeatResponse = z
  .object({
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    alive: z.literal(true),
  })
  .strict();
export type BrowserSessionHeartbeatResponse = z.infer<typeof BrowserSessionHeartbeatResponse>;

export const BrowserActionReceipt = z
  .object({
    protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
    operationId: z.string().uuid(),
    browserSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    state: InteractionOperationState,
    dispatchedAt: z.string().datetime({ offset: true }).nullable(),
    settledAt: z.string().datetime({ offset: true }).nullable(),
    observation: BrowserObservation.nullable(),
    error: InteractionError.nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.state === "completed" && (receipt.error !== null || receipt.settledAt === null)) {
      context.addIssue({
        code: "custom",
        message: "completed receipt must settle without error",
      });
    }
    if (
      (receipt.state === "failed" || receipt.state === "outcome_unknown") &&
      (receipt.error === null || receipt.settledAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "terminal error receipt requires error and time",
      });
    }
    if (receipt.state === "dispatched" && receipt.dispatchedAt === null) {
      context.addIssue({
        code: "custom",
        message: "dispatched receipt requires dispatch time",
      });
    }
  });
export type BrowserActionReceipt = z.infer<typeof BrowserActionReceipt>;

export const ComputerSessionCapabilities = z
  .object({
    semanticObservation: z.boolean(),
    appDiscovery: z.boolean(),
    appLaunch: z.boolean(),
    windowCapture: z.boolean(),
    screenCapture: z.boolean(),
    semanticActions: z.boolean(),
    pointerInput: z.boolean(),
    keyboardInput: z.boolean(),
    backgroundActions: z.boolean(),
    parallelApps: z.boolean(),
  })
  .strict();
export type ComputerSessionCapabilities = z.infer<typeof ComputerSessionCapabilities>;

export const ComputerSession = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    lifecycle: InteractionLifecycle,
    placement: InteractionPlacement,
    controller: InteractionControllerBinding.nullable(),
    platform: z.enum(["linux", "macos", "windows"]).nullable(),
    adapter: boundedOpaqueId.nullable(),
    seatId: boundedOpaqueId.nullable(),
    displayId: boundedOpaqueId.nullable(),
    capabilities: ComputerSessionCapabilities.nullable(),
    associations: z.array(InteractionAssociation).max(1_000),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }),
    failureCode: boundedOpaqueId.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const nativeBinding = [
      session.platform,
      session.adapter,
      session.seatId,
      session.displayId,
      session.capabilities,
    ];
    const populated = nativeBinding.filter((value) => value !== null).length;
    if (populated !== 0 && populated !== nativeBinding.length) {
      context.addIssue({
        code: "custom",
        message: "ComputerSession native binding must be absent or complete",
      });
    }
    if (session.lifecycle === "active" && (session.controller === null || populated === 0)) {
      context.addIssue({
        code: "custom",
        message: "active ComputerSession requires controller and native bindings",
      });
    }
  });
export type ComputerSession = z.infer<typeof ComputerSession>;

export const ComputerTarget = z
  .object({
    id: boundedOpaqueId,
    computerSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetGeneration: opaqueGeneration,
    kind: z.enum(["app", "window", "screen"]),
    applicationId: z.string().max(1_024).nullable(),
    processId: z.number().int().positive().nullable(),
    title: z.string().max(4_096),
    bounds: InteractionRect.nullable(),
    focused: z.boolean(),
  })
  .strict();
export type ComputerTarget = z.infer<typeof ComputerTarget>;

export const ComputerObservation = z
  .object({
    protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
    observationId: boundedOpaqueId,
    computerSessionId: z.string().uuid(),
    target: ComputerTarget,
    frameId: opaqueGeneration.nullable(),
    semantic: z.union([InteractionSemanticSnapshot, InteractionSemanticDiff]).nullable(),
    screenshot: RetainedArtifactReferenceSchema.nullable(),
    focusedRef: boundedOpaqueId.nullable(),
    changedRegions: z.array(InteractionRect).max(INTERACTION_MAX_CHANGED_NODES),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ComputerObservation = z.infer<typeof ComputerObservation>;

export const ComputerAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("semantic"),
      locator: ComputerLocator,
      action: z.enum([
        "invoke",
        "focus",
        "set_value",
        "increment",
        "decrement",
        "select",
        "deselect",
        "expand",
        "collapse",
        "show_menu",
        "scroll_into_view",
      ]),
      value: z.union([z.string().max(1_000_000), z.number().finite(), z.boolean()]).optional(),
    })
    .strict()
    .superRefine((action, context) => {
      if ((action.action === "set_value") !== (action.value !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "value is required exactly for set_value",
        });
      }
    }),
  z
    .object({
      type: z.literal("pointer"),
      frameId: opaqueGeneration,
      action: z.enum(["click", "double_click", "move", "scroll", "drag"]),
      x: z.number().finite(),
      y: z.number().finite(),
      endX: z.number().finite().optional(),
      endY: z.number().finite().optional(),
      deltaX: z.number().finite().optional(),
      deltaY: z.number().finite().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    })
    .strict()
    .superRefine((action, context) => {
      const hasEnd = action.endX !== undefined || action.endY !== undefined;
      const hasDelta = action.deltaX !== undefined || action.deltaY !== undefined;
      if (action.action === "drag" && (action.endX === undefined || action.endY === undefined)) {
        context.addIssue({
          code: "custom",
          message: "pointer drag requires endX and endY",
        });
      }
      if (action.action !== "drag" && hasEnd) {
        context.addIssue({
          code: "custom",
          message: "pointer end coordinates require drag",
        });
      }
      if (
        action.action === "scroll" &&
        action.deltaX === undefined &&
        action.deltaY === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "pointer scroll requires a delta",
        });
      }
      if (action.action !== "scroll" && hasDelta) {
        context.addIssue({
          code: "custom",
          message: "pointer deltas require scroll",
        });
      }
    }),
  z
    .object({
      type: z.literal("keyboard"),
      action: z.enum(["type", "press"]),
      value: z.string().max(1_000_000),
    })
    .strict(),
  z.object({ type: z.literal("focus"), targetId: boundedOpaqueId }).strict(),
  z
    .object({
      type: z.literal("launch"),
      applicationId: z.string().min(1).max(1_024),
    })
    .strict(),
]);
export type ComputerAction = z.infer<typeof ComputerAction>;

export const ComputerActionCommand = z
  .object({
    protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
    operationId: z.string().uuid(),
    computerSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    expectedTargetGeneration: opaqueGeneration,
    expectedObservationId: boundedOpaqueId.nullable(),
    expectedFrameId: opaqueGeneration.nullable(),
    actor: InteractionActor,
    action: ComputerAction,
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.action.type === "semantic" &&
      command.action.locator.kind === "ref" &&
      command.expectedObservationId === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedObservationId"],
        message: "semantic ref actions require expectedObservationId",
      });
    }
    if (command.action.type === "pointer") {
      if (command.expectedFrameId !== command.action.frameId) {
        context.addIssue({
          code: "custom",
          path: ["expectedFrameId"],
          message: "pointer action frameId must match expectedFrameId",
        });
      }
    } else if (command.expectedFrameId !== null) {
      context.addIssue({
        code: "custom",
        path: ["expectedFrameId"],
        message: "expectedFrameId is only valid for pointer actions",
      });
    }
  });
export type ComputerActionCommand = z.infer<typeof ComputerActionCommand>;

export const ComputerActionReceipt = z
  .object({
    protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
    operationId: z.string().uuid(),
    computerSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    state: InteractionOperationState,
    dispatchedAt: z.string().datetime({ offset: true }).nullable(),
    settledAt: z.string().datetime({ offset: true }).nullable(),
    observation: ComputerObservation.nullable(),
    error: InteractionError.nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.state === "completed" && (receipt.error !== null || receipt.settledAt === null)) {
      context.addIssue({
        code: "custom",
        message: "completed receipt must settle without error",
      });
    }
    if (
      (receipt.state === "failed" || receipt.state === "outcome_unknown") &&
      (receipt.error === null || receipt.settledAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "terminal error receipt requires error and time",
      });
    }
    if (receipt.state === "dispatched" && receipt.dispatchedAt === null) {
      context.addIssue({
        code: "custom",
        message: "dispatched receipt requires dispatch time",
      });
    }
  });
export type ComputerActionReceipt = z.infer<typeof ComputerActionReceipt>;

/** Public ComputerSession creation request. Placement chooses the concrete
 * platform adapter and allocates its default physical or isolated virtual seat;
 * callers may discover and reuse an existing ComputerSession instead. */
export const CreateComputerSessionRequest = z
  .object({
    operationId: z.string().uuid(),
    sessionId: z.string().uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    placement: InteractionPlacement.optional(),
  })
  .strict();
export type CreateComputerSessionRequest = z.infer<typeof CreateComputerSessionRequest>;

export const ComputerSessionListResponse = z
  .object({
    revision: z.number().int().nonnegative(),
    sessions: z.array(ComputerSession).max(10_000),
  })
  .strict();
export type ComputerSessionListResponse = z.infer<typeof ComputerSessionListResponse>;

export const ComputerSessionMutationResponse = z
  .object({
    session: ComputerSession,
    operation: InteractionLifecycleOperationReceipt,
  })
  .strict();
export type ComputerSessionMutationResponse = z.infer<typeof ComputerSessionMutationResponse>;

export const ComputerSessionLifecycleRequest = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict();
export type ComputerSessionLifecycleRequest = z.infer<typeof ComputerSessionLifecycleRequest>;

export const ComputerTargetListResponse = z
  .object({
    computerSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targets: z.array(ComputerTarget).max(10_000),
  })
  .strict();
export type ComputerTargetListResponse = z.infer<typeof ComputerTargetListResponse>;

export const ComputerFrameStreamOptions = InteractionFrameStreamOptions;
export type ComputerFrameStreamOptions = z.infer<typeof ComputerFrameStreamOptions>;

export const ComputerSessionAttachment = z
  .object({
    computerSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    targetId: boundedOpaqueId,
    stream: ComputerFrameStreamAttachment,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ComputerSessionAttachment = z.infer<typeof ComputerSessionAttachment>;

export const ComputerSessionAttachmentRequest = z
  .object({
    targetId: boundedOpaqueId,
    expiresInSeconds: z.number().int().min(15).max(600).default(120),
    stream: ComputerFrameStreamOptions.optional(),
  })
  .strict();
export type ComputerSessionAttachmentRequest = z.infer<typeof ComputerSessionAttachmentRequest>;

/** Human/API action request. Authenticated durable authority supplies the
 * resource, controller and actor fences before controller dispatch. */
export const ComputerActionRequest = z
  .object({
    operationId: z.string().uuid(),
    targetId: boundedOpaqueId,
    expectedTargetGeneration: opaqueGeneration,
    expectedObservationId: boundedOpaqueId.nullable(),
    expectedFrameId: opaqueGeneration.nullable(),
    action: ComputerAction,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.action.type === "semantic" &&
      request.action.locator.kind === "ref" &&
      request.expectedObservationId === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedObservationId"],
        message: "semantic ref actions require expectedObservationId",
      });
    }
    if (request.action.type === "pointer") {
      if (request.expectedFrameId !== request.action.frameId) {
        context.addIssue({
          code: "custom",
          path: ["expectedFrameId"],
          message: "pointer action frameId must match expectedFrameId",
        });
      }
    } else if (request.expectedFrameId !== null) {
      context.addIssue({
        code: "custom",
        path: ["expectedFrameId"],
        message: "expectedFrameId is only valid for pointer actions",
      });
    }
  });
export type ComputerActionRequest = z.infer<typeof ComputerActionRequest>;

export const ComputerSessionHeartbeatResponse = z
  .object({
    computerSessionId: z.string().uuid(),
    controllerGeneration: opaqueGeneration,
    alive: z.literal(true),
  })
  .strict();
export type ComputerSessionHeartbeatResponse = z.infer<typeof ComputerSessionHeartbeatResponse>;

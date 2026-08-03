import { z } from "zod";

import { ConnectionMetadata } from "./index";

export const GOOGLE_DRIVE_PROVIDER_DOMAIN = "googleapis.com" as const;
export const GOOGLE_DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive" as const;
export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;
export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly" as const;
export const GOOGLE_DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly" as const;
export const GOOGLE_DRIVE_CREDENTIAL_ROLE = "google_drive_metadata" as const;
export const GOOGLE_DRIVE_CREDENTIAL_LABEL = "Google Drive metadata browser" as const;

export const GoogleDriveOAuthCapability = z.enum([
  "picker_file_read",
  "source_metadata_discovery",
  "source_content_read",
  "recursive_source_sync",
]);
export type GoogleDriveOAuthCapability = z.infer<typeof GoogleDriveOAuthCapability>;

export type GoogleDriveOAuthScopeDecision = {
  accessMode: "metadata_readonly" | "readonly" | null;
  capabilities: GoogleDriveOAuthCapability[];
};

/**
 * Converts exact Google OAuth grants into the Drive capabilities OpenGeni may
 * rely on. Unknown or malformed grants add no authority. In particular,
 * drive.file covers only files explicitly opened or shared with the app and
 * never authorizes arbitrary recursive descendant discovery.
 */
export function googleDriveOAuthScopeDecision(
  grantedScopes: readonly string[],
): GoogleDriveOAuthScopeDecision {
  const granted = new Set(grantedScopes);
  const hasFullDrive = granted.has(GOOGLE_DRIVE_FULL_SCOPE);
  const hasSourceContentRead = hasFullDrive || granted.has(GOOGLE_DRIVE_READONLY_SCOPE);
  const hasSourceMetadataDiscovery =
    hasSourceContentRead || granted.has(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
  const hasPickerFileRead = hasSourceContentRead || granted.has(GOOGLE_DRIVE_FILE_SCOPE);
  const capabilities: GoogleDriveOAuthCapability[] = [];
  if (hasPickerFileRead) capabilities.push("picker_file_read");
  if (hasSourceMetadataDiscovery) capabilities.push("source_metadata_discovery");
  if (hasSourceContentRead) {
    capabilities.push("source_content_read", "recursive_source_sync");
  }
  return {
    accessMode: hasSourceContentRead
      ? "readonly"
      : hasSourceMetadataDiscovery
        ? "metadata_readonly"
        : null,
    capabilities,
  };
}

export function googleDriveScopesAllowCapability(
  grantedScopes: readonly string[],
  capability: GoogleDriveOAuthCapability,
): boolean {
  return googleDriveOAuthScopeDecision(grantedScopes).capabilities.includes(capability);
}

export const GoogleDriveTargetScope = z.enum(["user", "workspace", "organization"]);
export type GoogleDriveTargetScope = z.infer<typeof GoogleDriveTargetScope>;

export const GoogleDriveSyncCadence = z.enum(["manual", "hourly", "daily"]);
export type GoogleDriveSyncCadence = z.infer<typeof GoogleDriveSyncCadence>;

export const GoogleDriveReadPolicy = z.enum(["allow", "ask", "block"]);
export type GoogleDriveReadPolicy = z.infer<typeof GoogleDriveReadPolicy>;

export const GoogleDriveConnectionLifecycleState = z.enum([
  "active",
  "paused",
  "token_revoked",
  "app_removed",
  "disconnected",
  "reconnect_required",
  "reconsent_required",
]);
export type GoogleDriveConnectionLifecycleState = z.infer<
  typeof GoogleDriveConnectionLifecycleState
>;

const GoogleDriveLifecycleObservedAt = z.string().datetime({ offset: true });
export const GoogleDriveConnectionLifecycle = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("active"),
    recoverable: z.literal(true),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
  z.object({
    state: z.literal("paused"),
    recoverable: z.literal(true),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
  z.object({
    state: z.literal("token_revoked"),
    recoverable: z.literal(true),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
  z.object({
    state: z.literal("app_removed"),
    recoverable: z.literal(false),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
  z.object({
    state: z.literal("disconnected"),
    recoverable: z.literal(true),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
  z.object({
    state: z.literal("reconnect_required"),
    recoverable: z.literal(true),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
  z.object({
    state: z.literal("reconsent_required"),
    recoverable: z.literal(true),
    observedAt: GoogleDriveLifecycleObservedAt,
  }),
]);
export type GoogleDriveConnectionLifecycle = z.infer<typeof GoogleDriveConnectionLifecycle>;

export const GoogleDriveSelectedSource = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(256),
  driveId: z.string().min(1).max(256).nullable().default(null),
  targetScope: GoogleDriveTargetScope,
  syncCadence: GoogleDriveSyncCadence.default("hourly"),
  readPolicy: GoogleDriveReadPolicy.default("allow"),
  selectedAt: z.string().datetime({ offset: true }),
});
export type GoogleDriveSelectedSource = z.infer<typeof GoogleDriveSelectedSource>;

export const GoogleDriveConnectionMetadata = z
  .object({
    credentialRole: z.literal(GOOGLE_DRIVE_CREDENTIAL_ROLE),
    credentialLabel: z.literal(GOOGLE_DRIVE_CREDENTIAL_LABEL),
    googlePermissionId: z.string().min(1).max(256),
    googleEmail: z.string().email().max(320),
    googleDisplayName: z.string().min(1).max(512).nullable(),
    verifiedAt: z.string().datetime({ offset: true }),
    accessMode: z.enum(["metadata_readonly", "readonly"]),
    lifecycle: GoogleDriveConnectionLifecycle.optional(),
    selectedSources: z.array(GoogleDriveSelectedSource).max(100).optional(),
    /** @deprecated Read `selectedSources`; retained while existing connections migrate. */
    selectedSource: GoogleDriveSelectedSource.nullable().optional(),
  })
  .passthrough();
export type GoogleDriveConnectionMetadata = z.infer<typeof GoogleDriveConnectionMetadata>;

export const GoogleDriveOAuthStartRequest = z.object({
  connectionId: z.string().uuid().optional(),
});
export type GoogleDriveOAuthStartRequest = z.infer<typeof GoogleDriveOAuthStartRequest>;

export const GoogleDriveOAuthStartResponse = z.object({
  authorizationUrl: z.string().url(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type GoogleDriveOAuthStartResponse = z.infer<typeof GoogleDriveOAuthStartResponse>;

export const GoogleDriveLifecycleActionRequest = z.object({
  action: z.enum(["pause", "resume"]),
  expectedVersion: z.number().int().positive(),
});
export type GoogleDriveLifecycleActionRequest = z.infer<typeof GoogleDriveLifecycleActionRequest>;

export const GoogleDriveDisconnectRequest = z.object({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type GoogleDriveDisconnectRequest = z.infer<typeof GoogleDriveDisconnectRequest>;

export const GoogleDriveBrowseItem = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(256),
  kind: z.enum(["folder", "file"]),
  driveId: z.string().min(1).max(256).nullable(),
  modifiedTime: z.string().datetime({ offset: true }).nullable(),
  size: z.string().regex(/^\d+$/).nullable(),
  webViewLink: z.string().url().nullable(),
});
export type GoogleDriveBrowseItem = z.infer<typeof GoogleDriveBrowseItem>;

export const GoogleDriveBrowseResponse = z.object({
  connection: z.lazy(() => ConnectionMetadata),
  parentId: z.string().min(1).max(256),
  current: GoogleDriveBrowseItem.nullable(),
  items: z.array(GoogleDriveBrowseItem),
  nextPageToken: z.string().min(1).max(4096).nullable(),
  incompleteSearch: z.boolean(),
});
export type GoogleDriveBrowseResponse = z.infer<typeof GoogleDriveBrowseResponse>;

export const SaveGoogleDriveSourceRequest = z.object({
  sources: z
    .array(
      GoogleDriveBrowseItem.pick({
        id: true,
        name: true,
        mimeType: true,
        driveId: true,
      }),
    )
    .max(100)
    .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, {
      message: "Google Drive sources must be unique",
    }),
  targetScope: GoogleDriveTargetScope,
  syncCadence: GoogleDriveSyncCadence.default("hourly"),
  readPolicy: GoogleDriveReadPolicy.default("allow"),
});
export type SaveGoogleDriveSourceRequest = z.infer<typeof SaveGoogleDriveSourceRequest>;

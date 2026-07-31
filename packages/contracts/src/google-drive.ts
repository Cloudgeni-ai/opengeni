import { z } from "zod";

import { ConnectionMetadata } from "./index";

export const GOOGLE_DRIVE_PROVIDER_DOMAIN = "googleapis.com" as const;
export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly" as const;
export const GOOGLE_DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly" as const;
export const GOOGLE_DRIVE_CREDENTIAL_ROLE = "google_drive_metadata" as const;
export const GOOGLE_DRIVE_CREDENTIAL_LABEL = "Google Drive metadata browser" as const;

export const GoogleDriveTargetScope = z.enum(["user", "workspace", "organization"]);
export type GoogleDriveTargetScope = z.infer<typeof GoogleDriveTargetScope>;

export const GoogleDriveSyncCadence = z.enum(["manual", "hourly", "daily"]);
export type GoogleDriveSyncCadence = z.infer<typeof GoogleDriveSyncCadence>;

export const GoogleDriveReadPolicy = z.enum(["allow", "ask", "block"]);
export type GoogleDriveReadPolicy = z.infer<typeof GoogleDriveReadPolicy>;

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

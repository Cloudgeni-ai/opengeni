import { z } from "zod";

import { ConnectionMetadata } from "./index";
import {
  ConnectorDocumentDestination,
  ConnectorDocumentDestinationSelection,
} from "./connector-destinations";

export const GOOGLE_DRIVE_PROVIDER_DOMAIN = "googleapis.com" as const;
export const GOOGLE_DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive" as const;
export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;
export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly" as const;
export const GOOGLE_DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly" as const;
/** Stable serialized role retained for existing connection rows; not product-facing copy. */
export const GOOGLE_DRIVE_CREDENTIAL_ROLE = "google_drive_metadata" as const;
export const GOOGLE_DRIVE_CREDENTIAL_LABEL = "Google Drive read-only source sync" as const;
export const GOOGLE_DRIVE_LEGACY_CREDENTIAL_LABEL = "Google Drive metadata browser" as const;
export const GOOGLE_DRIVE_PUBLICATION_SERVER_ID = "google-drive-publishing" as const;
export const GOOGLE_DRIVE_PUBLICATION_TOOL_NAME = "google_drive_publish_file" as const;
export const GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION = "create" as const;

export const GoogleDriveOAuthCapability = z.enum([
  "picker_file_read",
  "publish_file",
  "source_metadata_discovery",
  "source_content_read",
  "recursive_source_sync",
]);
export type GoogleDriveOAuthCapability = z.infer<typeof GoogleDriveOAuthCapability>;

export type GoogleDriveOAuthScopeDecision = {
  accessMode: "file_only" | "metadata_readonly" | "readonly" | null;
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
  const hasFileWrite = hasFullDrive || granted.has(GOOGLE_DRIVE_FILE_SCOPE);
  const hasSourceMetadataDiscovery =
    hasSourceContentRead || granted.has(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
  const hasPickerFileRead = hasSourceContentRead || hasFileWrite;
  const capabilities: GoogleDriveOAuthCapability[] = [];
  if (hasPickerFileRead) capabilities.push("picker_file_read");
  if (hasFileWrite) capabilities.push("publish_file");
  if (hasSourceMetadataDiscovery) capabilities.push("source_metadata_discovery");
  if (hasSourceContentRead) {
    capabilities.push("source_content_read", "recursive_source_sync");
  }
  return {
    accessMode: hasSourceContentRead
      ? "readonly"
      : hasSourceMetadataDiscovery
        ? "metadata_readonly"
        : hasFileWrite
          ? "file_only"
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

/** @deprecated Connector document destinations use organization/workspace/personal authority. */
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
  destination: ConnectorDocumentDestination.optional(),
  /** @deprecated Missing destinations resolve to the current workspace boundary. */
  targetScope: GoogleDriveTargetScope.optional(),
  syncCadence: GoogleDriveSyncCadence.default("hourly"),
  syncEnabled: z.boolean().default(false),
  configGeneration: z.number().int().positive().default(1),
  readPolicy: GoogleDriveReadPolicy.default("allow"),
  selectedAt: z.string().datetime({ offset: true }),
});
export type GoogleDriveSelectedSource = z.infer<typeof GoogleDriveSelectedSource>;

export const GoogleDriveOutputDestination = z
  .object({
    folderId: z.string().min(1).max(256),
    folderName: z.string().min(1).max(1024),
    driveId: z.string().min(1).max(256).nullable(),
    location: z.enum(["my_drive", "shared_drive"]),
    selectedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.location === "my_drive") !== (value.driveId === null)) {
      context.addIssue({
        code: "custom",
        path: ["driveId"],
        message: "Google Drive destination location does not match its drive identity",
      });
    }
  });
export type GoogleDriveOutputDestination = z.infer<typeof GoogleDriveOutputDestination>;

export const GoogleDriveConnectionMetadata = z
  .object({
    credentialRole: z.literal(GOOGLE_DRIVE_CREDENTIAL_ROLE),
    credentialLabel: z.union([
      z.literal(GOOGLE_DRIVE_CREDENTIAL_LABEL),
      z.literal(GOOGLE_DRIVE_LEGACY_CREDENTIAL_LABEL),
    ]),
    googlePermissionId: z.string().min(1).max(256),
    googleEmail: z.string().email().max(320),
    googleDisplayName: z.string().min(1).max(512).nullable(),
    verifiedAt: z.string().datetime({ offset: true }),
    accessMode: z.enum(["file_only", "metadata_readonly", "readonly"]),
    lifecycle: GoogleDriveConnectionLifecycle.optional(),
    outputDestination: GoogleDriveOutputDestination.optional(),
    documentDestination: ConnectorDocumentDestination.optional(),
    selectedSources: z.array(GoogleDriveSelectedSource).max(100).optional(),
    /** @deprecated Read `selectedSources`; retained while existing connections migrate. */
    selectedSource: GoogleDriveSelectedSource.nullable().optional(),
  })
  .passthrough();
export type GoogleDriveConnectionMetadata = z.infer<typeof GoogleDriveConnectionMetadata>;

export const GoogleDriveOAuthStartRequest = z.object({
  connectionId: z.string().uuid().optional(),
  capability: z.enum(["source_read", "publish"]).default("source_read"),
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

export const GoogleDrivePublicationExportFile = z
  .object({
    fileId: z.string().uuid(),
    filename: z.string().trim().min(1).max(512),
    contentType: z.string().trim().min(1).max(256),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    artifactId: z.string().regex(/^[0-9a-f]{32}$/u),
    versionId: z.string().regex(/^[0-9a-f]{32}$/u),
    materializationJobId: z.string().regex(/^[0-9a-f]{32}$/u),
    sourceHeadSequence: z.number().int().nonnegative(),
    sourceStateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();
export type GoogleDrivePublicationExportFile = z.infer<typeof GoogleDrivePublicationExportFile>;

export const GoogleDrivePublicationToolInput = z
  .object({
    title: z.string().trim().min(1).max(512),
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    file: GoogleDrivePublicationExportFile,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();
export type GoogleDrivePublicationToolInput = z.infer<typeof GoogleDrivePublicationToolInput>;

export const GoogleDrivePublicationReceipt = z
  .object({
    connectionId: z.string().uuid(),
    providerFileId: z.string().min(1).max(256),
    webViewLink: z.string().url(),
    mimeType: z.enum([
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ]),
    destination: GoogleDriveOutputDestination,
    replayed: z.boolean(),
  })
  .strict();
export type GoogleDrivePublicationReceipt = z.infer<typeof GoogleDrivePublicationReceipt>;

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

const GoogleDriveSourceSelection = z
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
  });

export const SaveGoogleDriveSourceRequest = z
  .object({
    sources: GoogleDriveSourceSelection,
    destination: ConnectorDocumentDestinationSelection.optional(),
    /** @deprecated Legacy requests are accepted but resolve to workspace authority. */
    targetScope: GoogleDriveTargetScope.optional(),
    syncCadence: GoogleDriveSyncCadence.default("hourly"),
    syncEnabled: z.boolean().default(false),
    readPolicy: GoogleDriveReadPolicy.default("allow"),
  })
  .refine((request) => request.destination !== undefined || request.targetScope !== undefined, {
    message: "Google Drive document destination is required",
  });
export type SaveGoogleDriveSourceRequest = z.infer<typeof SaveGoogleDriveSourceRequest>;

export const GoogleDriveKnowledgeSourceItem = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(256),
  driveId: z.string().min(1).max(512).optional(),
  sourceKind: z.enum(["my_drive", "shared_drive", "folder"]),
  includeDescendants: z.boolean(),
});
export type GoogleDriveKnowledgeSourceItem = z.infer<typeof GoogleDriveKnowledgeSourceItem>;

export const GoogleDriveKnowledgeSourceDestination = z.object({
  authorityKind: z.enum(["organization", "workspace", "personal"]),
  authorityAccountId: z.string().min(1).max(128),
  authorityWorkspaceId: z.string().min(1).max(128).optional(),
  authoritySubjectId: z.string().min(1).max(512).optional(),
  collectionId: z.string().min(1).max(512).optional(),
});
export type GoogleDriveKnowledgeSourceDestination = z.infer<
  typeof GoogleDriveKnowledgeSourceDestination
>;

export const GoogleDriveKnowledgeSourceConfig = z.object({
  sources: z.array(GoogleDriveKnowledgeSourceItem).min(1).max(100),
  destination: GoogleDriveKnowledgeSourceDestination,
  syncCadence: GoogleDriveSyncCadence,
  readPolicy: GoogleDriveReadPolicy,
});
export type GoogleDriveKnowledgeSourceConfig = z.infer<typeof GoogleDriveKnowledgeSourceConfig>;

export const SaveGoogleDriveIntegrationSourceRequest = z.intersection(
  SaveGoogleDriveSourceRequest,
  z.object({
    sources: GoogleDriveSourceSelection.refine((sources) => sources.length > 0, {
      message: "At least one Google Drive source is required",
    }),
    expectedVersion: z.number().int().positive().optional(),
    idempotencyKey: z.string().uuid(),
  }),
);
export type SaveGoogleDriveIntegrationSourceRequest = z.infer<
  typeof SaveGoogleDriveIntegrationSourceRequest
>;

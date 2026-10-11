import { z } from "zod";

/**
 * Organization model-account settings with lockable workspace overrides and
 * the organization overview (contract SUB-SET-01..05). The organization sets
 * every value; a shared workspace may override a value unless the
 * organization locked it. Each effective value reports where it comes from.
 */
export const MODEL_ACCOUNT_SETTING_KEYS = [
  "rotation",
  "providers",
  "crossProviderFailover",
  "fallbackOrder",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
] as const;
export const ModelAccountSettingKey = z.enum(MODEL_ACCOUNT_SETTING_KEYS);
export type ModelAccountSettingKey = z.infer<typeof ModelAccountSettingKey>;

/** organization: the organization value; workspace: this workspace's override; locked: the organization value, which workspaces cannot override. */
export const ModelAccountSettingSource = z.enum(["organization", "workspace", "locked"]);
export type ModelAccountSettingSource = z.infer<typeof ModelAccountSettingSource>;

const SAFE_KEY = (key: string) => !["__proto__", "constructor", "prototype"].includes(key);
const ModelId = z.string().min(1).max(200).refine(SAFE_KEY);
const ProviderId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/)
  .refine(SAFE_KEY);

export const ModelAccountRotationMode = z.enum(["spread", "primary_first"]);
export type ModelAccountRotationMode = z.infer<typeof ModelAccountRotationMode>;

/** Ordered fallback models for a preferred model (at most 64 models, 8 fallbacks each). */
export const ModelAccountFallbackOrder = z
  .record(ModelId, z.array(ModelId).max(8))
  .refine((value) => Object.keys(value).length <= 64, "At most 64 models");

export const ModelAccountSettingValues = z.object({
  rotation: z.record(
    z.string(),
    z.object({
      mode: ModelAccountRotationMode,
      primaryConnectionId: z.string().nullable().optional(),
    }),
  ),
  providers: z.record(
    z.string(),
    z.object({
      inferenceSource: z.enum(["automatic", "workspace", "organization"]).optional(),
      useOrganizationAccounts: z.boolean(),
      enabled: z.boolean(),
    }),
  ),
  crossProviderFailover: z.boolean(),
  fallbackOrder: z.record(z.string(), z.array(z.string())),
  personalConnectionsAllowed: z.boolean(),
  personalFallbackAllowed: z.boolean(),
});
export type ModelAccountSettingValues = z.infer<typeof ModelAccountSettingValues>;

const ModelAccountSettingSources = z.object({
  rotation: ModelAccountSettingSource,
  providers: ModelAccountSettingSource,
  crossProviderFailover: ModelAccountSettingSource,
  fallbackOrder: ModelAccountSettingSource,
  personalConnectionsAllowed: ModelAccountSettingSource,
  personalFallbackAllowed: ModelAccountSettingSource,
});

const EntrySource = z.record(z.string(), z.enum(["organization", "workspace"]));

/** Effective values with one source per setting and, for map-valued settings, per entry. */
const ModelAccountSettingsView = z.object({
  values: ModelAccountSettingValues,
  sources: ModelAccountSettingSources,
  entrySources: z.object({
    rotation: EntrySource,
    providers: EntrySource,
    fallbackOrder: EntrySource,
  }),
});

export const OrganizationModelAccountSettings = z.object({
  organizationId: z.string(),
  values: ModelAccountSettingValues,
  locked: z.array(ModelAccountSettingKey),
  /** Pass back as `expectedVersion` to refuse a write over a concurrent change. */
  version: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
});
export type OrganizationModelAccountSettings = z.infer<typeof OrganizationModelAccountSettings>;

/**
 * PATCH body for the organization: omitted fields are kept; `fallbackOrder`
 * and `locked` replace the stored value; `rotation` sets the mode of each
 * named provider whose accounts run on the shared core. Locking a setting
 * clears every workspace override of it.
 */
export const UpdateOrganizationModelAccountSettingsRequest = z
  .object({
    crossProviderFailover: z.boolean().optional(),
    fallbackOrder: ModelAccountFallbackOrder.optional(),
    personalConnectionsAllowed: z.boolean().optional(),
    personalFallbackAllowed: z.boolean().optional(),
    rotation: z.record(ProviderId, z.object({ mode: ModelAccountRotationMode }).strict()).optional(),
    locked: z.array(ModelAccountSettingKey).max(MODEL_ACCOUNT_SETTING_KEYS.length).optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type UpdateOrganizationModelAccountSettingsRequest = z.infer<
  typeof UpdateOrganizationModelAccountSettingsRequest
>;

/** A workspace's stored overrides: null follows the organization. */
export const ModelAccountSettingOverrides = z.object({
  rotation: z.record(z.string(), z.unknown()).nullable(),
  providers: z.record(z.string(), z.unknown()).nullable(),
  crossProviderFailover: z.boolean().nullable(),
  fallbackOrder: z.record(z.string(), z.array(z.string())).nullable(),
  personalConnectionsAllowed: z.boolean().nullable(),
  personalFallbackAllowed: z.boolean().nullable(),
});

export const WorkspaceModelAccountSettings = ModelAccountSettingsView.extend({
  workspaceId: z.string(),
  locked: z.array(ModelAccountSettingKey),
  overrides: ModelAccountSettingOverrides,
  version: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
  /** Whether the caller may change this workspace's overrides. */
  canEdit: z.boolean(),
});
export type WorkspaceModelAccountSettings = z.infer<typeof WorkspaceModelAccountSettings>;

/**
 * PATCH body for a workspace: omitted fields are kept and `null` follows the
 * organization again. `fallbackOrder` and `rotation` change entry by entry;
 * a `null` entry follows the organization for that entry. A setting the
 * organization locked cannot be set.
 */
export const UpdateWorkspaceModelAccountSettingsRequest = z
  .object({
    crossProviderFailover: z.boolean().nullable().optional(),
    personalConnectionsAllowed: z.boolean().nullable().optional(),
    personalFallbackAllowed: z.boolean().nullable().optional(),
    fallbackOrder: z
      .record(ModelId, z.array(ModelId).max(8).nullable())
      .refine((value) => Object.keys(value).length <= 64, "At most 64 models")
      .nullable()
      .optional(),
    rotation: z
      .record(ProviderId, z.object({ mode: ModelAccountRotationMode }).strict().nullable())
      .nullable()
      .optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type UpdateWorkspaceModelAccountSettingsRequest = z.infer<
  typeof UpdateWorkspaceModelAccountSettingsRequest
>;

export const ModelAccountSettingsOverviewWorkspace = ModelAccountSettingsView.extend({
  workspaceId: z.string(),
  name: z.string(),
});

/** Every shared workspace's effective settings and sources, in pages ordered by workspace id. */
export const ModelAccountSettingsOverview = z.object({
  organization: OrganizationModelAccountSettings,
  workspaces: z.array(ModelAccountSettingsOverviewWorkspace),
  /** Pass as `after` for the next page; null after the last workspace. */
  nextCursor: z.string().nullable(),
});
export type ModelAccountSettingsOverview = z.infer<typeof ModelAccountSettingsOverview>;

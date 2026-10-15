import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  ExternalVaultProviderKind,
  VaultProviderCredentials,
  VaultProviderOperations,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import {
  encryptEnvironmentValue,
  getConnectionMetadata,
  getProviderConnectionHomeWorkspace,
  loadConnectionCredentialForBroker,
  updateConnection,
  type Database,
} from "@opengeni/db";
import {
  providerOperations,
  VaultProviderError,
  type VaultProvider,
  type VaultProviderAuthority,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { z } from "zod";

export const EXTERNAL_VAULT_CREDENTIAL_ROLE = "external_vault_provider";

const ExternalVaultConnectionDetails = z
  .object({
    version: z.literal(1),
    provider: ExternalVaultProviderKind,
    ownership: z.enum(["user", "workspace", "organization"]),
    accountId: z.string().min(1).max(300).nullable(),
    accountName: z.string().max(300).nullable(),
    label: z.string().max(120).nullable(),
    verifiedAt: z.string().datetime(),
    operations: VaultProviderOperations,
    verificationStatus: z.enum(["ready", "pending"]).optional(),
  })
  .strict();
export type ExternalVaultConnectionDetails = z.infer<typeof ExternalVaultConnectionDetails>;

export function externalVaultProviderDomain(provider: ExternalVaultProviderKind): string {
  return `vault:${provider}`;
}

/** Metadata is a projection, never a credential/configuration passthrough. */
export function externalVaultConnectionDetails(
  metadata: Record<string, unknown> | null | undefined,
): ExternalVaultConnectionDetails | null {
  if (metadata?.credentialRole !== EXTERNAL_VAULT_CREDENTIAL_ROLE) return null;
  const result = ExternalVaultConnectionDetails.safeParse(metadata.vaultProvider);
  return result.success ? result.data : null;
}

export function isExternalVaultConnection(connection: ConnectionMetadata): boolean {
  const details = externalVaultConnectionDetails(connection.metadata);
  return (
    details !== null &&
    connection.kind === "api_key" &&
    connection.providerDomain === externalVaultProviderDomain(details.provider) &&
    (details.ownership === "user") === (connection.subjectId !== null)
  );
}

/** Keeper bootstrap tokens are never a stored runtime credential. */
export const StoredVaultProviderCredentials = z.union([
  VaultProviderCredentials.options[0],
  VaultProviderCredentials.options[1],
  VaultProviderCredentials.options[2],
  z
    .object({
      provider: z.literal("keeper"),
      configuration: z
        .record(z.string().max(100), z.string().max(65_536))
        .refine((value) => Object.keys(value).length <= 32),
    })
    .strict(),
]);
export type StoredVaultProviderCredentials = z.infer<typeof StoredVaultProviderCredentials>;

const PendingVaultCredentialEnvelope = z
  .object({
    vaultCredentialEnvelope: z.literal(1),
    current: StoredVaultProviderCredentials.nullable(),
    pending: StoredVaultProviderCredentials,
  })
  .strict();

/** Encrypted only: preserve the working credential while a reconnect is checked. */
export function pendingVaultCredentialBundle(
  current: StoredVaultProviderCredentials | null,
  pending: StoredVaultProviderCredentials,
): Record<string, unknown> {
  return { vaultCredentialEnvelope: 1, current, pending };
}

export type ExternalVaultProviderFactory = (input: {
  credentials: VaultProviderCredentials | StoredVaultProviderCredentials;
  /** Stable native connection identity; adapter sessions must not cross it. */
  connectionId?: string;
  /** Includes credential binding and setup, before ordinary provider calls. */
  signal?: AbortSignal;
  /** Persist any later SDK key rotation before reporting successful readiness. */
  persistCredentials?: (credentials: StoredVaultProviderCredentials) => Promise<void>;
  /** Verified setup capabilities; the adapter may narrow, never widen them. */
  operations?: VaultProviderOperations;
}) => Promise<{ provider: VaultProvider; credentials: StoredVaultProviderCredentials }>;

export type ExternalVaultProviderFactories = Partial<
  Record<ExternalVaultProviderKind, ExternalVaultProviderFactory>
>;

export function externalVaultConnectionMetadata(
  details: ExternalVaultConnectionDetails,
): Record<string, unknown> {
  return {
    credentialRole: EXTERNAL_VAULT_CREDENTIAL_ROLE,
    vaultProvider: ExternalVaultConnectionDetails.parse(details),
  };
}

function unavailable(): VaultProviderError {
  return new VaultProviderError(
    "provider_auth_invalid",
    "This vault connection was removed or is not available to you. Reconnect it in Vaults.",
  );
}

/** Credentials can only be decrypted after the native reach and connection tuple agree. */
export async function loadExternalVaultConnection(
  db: Database,
  settings: Settings,
  input: {
    workspaceId: string;
    connectionId: string;
    subjectId: string | null;
    provider: ExternalVaultProviderKind;
    /** Setup-only recovery, after independent connection-management authorization. */
    allowPendingVerification?: boolean;
  },
): Promise<{
  connection: ConnectionMetadata;
  details: ExternalVaultConnectionDetails;
  credentials: StoredVaultProviderCredentials;
  currentCredentials: StoredVaultProviderCredentials | null;
  pendingCredentials: StoredVaultProviderCredentials | null;
}> {
  let connection = await getConnectionMetadata(
    db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection) {
    const home = await getProviderConnectionHomeWorkspace(
      db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    );
    if (home && home !== input.workspaceId)
      connection = await getConnectionMetadata(db, home, input.connectionId, input.subjectId);
  }
  if (!connection || !isExternalVaultConnection(connection)) throw unavailable();
  const details = externalVaultConnectionDetails(connection.metadata)!;
  if (details.provider !== input.provider) throw unavailable();
  if (
    connection.status !== "active" &&
    !(
      input.allowPendingVerification &&
      (connection.status === "needs_reauth" || connection.status === "error")
    )
  )
    throw new VaultProviderError(
      "provider_auth_expired",
      "This vault connection needs to be reconnected.",
    );
  if (connection.subjectId !== null && connection.subjectId !== input.subjectId)
    throw unavailable();
  const loaded = await loadConnectionCredentialForBroker(db, settings, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    providerDomain: externalVaultProviderDomain(input.provider),
    kind: "api_key",
    ...(connection.subjectId !== null
      ? { allowSubjectOwned: true, subjectId: input.subjectId }
      : {}),
  });
  // The broker decrypts by exact ID, so repeat tuple/status/version checks on
  // that same read rather than trusting the earlier metadata snapshot.
  if (
    !loaded ||
    loaded.status !== connection.status ||
    loaded.version !== connection.version ||
    loaded.accountId !== connection.accountId ||
    loaded.subjectId !== connection.subjectId ||
    loaded.providerDomain !== connection.providerDomain ||
    loaded.kind !== "api_key" ||
    externalVaultConnectionDetails(loaded.metadata)?.provider !== input.provider
  )
    throw unavailable();
  const envelope = PendingVaultCredentialEnvelope.safeParse(loaded.credential);
  const raw = envelope.success
    ? input.allowPendingVerification
      ? envelope.data.pending
      : envelope.data.current
    : loaded.credential;
  const parsed = StoredVaultProviderCredentials.safeParse(raw);
  if (!parsed.success || parsed.data.provider !== input.provider) throw unavailable();
  if (
    envelope.success &&
    (envelope.data.pending.provider !== input.provider ||
      (envelope.data.current !== null && envelope.data.current.provider !== input.provider))
  )
    throw unavailable();
  return {
    connection,
    details,
    credentials: parsed.data,
    currentCredentials: envelope.success ? envelope.data.current : parsed.data,
    pendingCredentials: envelope.success ? envelope.data.pending : null,
  };
}

/** A bound adapter never accepts model-supplied identity, even via a copied context. */
export function bindVaultProviderAuthority(
  provider: VaultProvider,
  input: {
    connectionId: string;
    authority: VaultProviderAuthority;
    operations: VaultProviderOperations;
    revalidate: () => Promise<void>;
  },
): VaultProvider {
  async function context(ctx: VaultProviderContext): Promise<VaultProviderContext> {
    ctx.signal?.throwIfAborted();
    await input.revalidate();
    ctx.signal?.throwIfAborted();
    return { ...ctx, connectionId: input.connectionId, authority: { ...input.authority } };
  }
  return {
    id: provider.id,
    capabilities: () => ({
      ...provider.capabilities(),
      operations: providerOperations(provider.capabilities(), { operations: input.operations }),
    }),
    validate: async (ctx) => provider.validate(await context(ctx)),
    listVaults: async (ctx) => provider.listVaults(await context(ctx)),
    listItems: async (ctx, vaultId) => provider.listItems(await context(ctx), vaultId),
    readFields: async (ctx, vaultId, itemId, fields) =>
      provider.readFields(await context(ctx), vaultId, itemId, fields),
    writeItem: async (ctx, vaultId, item) => provider.writeItem(await context(ctx), vaultId, item),
    archiveItem: async (ctx, vaultId, itemId) =>
      provider.archiveItem(await context(ctx), vaultId, itemId),
    ...(provider.listVaultPage
      ? { listVaultPage: async (ctx, page) => provider.listVaultPage!(await context(ctx), page) }
      : {}),
    ...(provider.listItemPage
      ? {
          listItemPage: async (ctx, vaultId, page) =>
            provider.listItemPage!(await context(ctx), vaultId, page),
        }
      : {}),
    ...(provider.createVault
      ? { createVault: async (ctx, value) => provider.createVault!(await context(ctx), value) }
      : {}),
  };
}

export async function externalVaultProviderForConnection(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  subjectId: string | null;
  connectionId: string;
  provider: ExternalVaultProviderKind;
  factory: ExternalVaultProviderFactory;
  executionContext?: Pick<VaultProviderAuthority, "sessionId" | "turnId" | "attemptId" | "siteId">;
}): Promise<VaultProvider> {
  const loaded = await loadExternalVaultConnection(input.db, input.settings, input);
  let connection = loaded.connection;
  const prepared = await input.factory({
    credentials: loaded.credentials,
    connectionId: connection.id,
    signal: AbortSignal.timeout(30_000),
    operations: loaded.details.operations,
    persistCredentials: async (next) => {
      const parsed = StoredVaultProviderCredentials.safeParse(next);
      if (!parsed.success || parsed.data.provider !== loaded.details.provider) throw unavailable();
      const credentials = parsed.data;
      const key = environmentsEncryptionKeyBytes(input.settings);
      if (!key)
        throw new VaultProviderError(
          "provider_unavailable",
          "Vault credential encryption is unavailable.",
        );
      const updated = await updateConnection(input.db, {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        visibleToSubjectId: input.subjectId,
        expectedVersion: connection.version,
        credentialEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify(
            loaded.pendingCredentials
              ? pendingVaultCredentialBundle(credentials, loaded.pendingCredentials)
              : credentials,
          ),
        ),
      });
      if (!updated)
        throw new VaultProviderError(
          "provider_conflict",
          "This vault connection changed while its credentials were renewed.",
        );
      connection = updated;
    },
  });
  if (prepared.provider.id !== input.provider) throw unavailable();
  return bindVaultProviderAuthority(prepared.provider, {
    connectionId: connection.id,
    authority: {
      accountId: connection.accountId,
      workspaceId: input.workspaceId,
      connectionWorkspaceId: connection.workspaceId,
      subjectId: input.subjectId,
      ...input.executionContext,
    },
    operations: loaded.details.operations,
    revalidate: async () => {
      // Revalidate cross-workspace reach as well as the exact connection generation.
      if (connection.workspaceId !== input.workspaceId) {
        const home = await getProviderConnectionHomeWorkspace(
          input.db,
          input.workspaceId,
          connection.id,
          input.subjectId,
        );
        if (home !== connection.workspaceId) throw unavailable();
      }
      const live = await getConnectionMetadata(
        input.db,
        connection.workspaceId,
        connection.id,
        input.subjectId,
      );
      if (
        !live ||
        !isExternalVaultConnection(live) ||
        live.status !== "active" ||
        live.version !== connection.version ||
        live.accountId !== connection.accountId ||
        live.subjectId !== connection.subjectId ||
        live.providerDomain !== connection.providerDomain
      )
        throw unavailable();
    },
  });
}

import {
  ClaudeSubscriptionCredential,
  claudeSubscriptionCapacity,
  emptyClaudeUsage,
} from "@opengeni/config";
import { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "./database";
import * as schema from "./schema";
import {
  createSubscriptionAccountRepository,
  type SubscriptionAccountCapacity,
} from "./subscription-account-repository";
import { createOrganizationSubscriptionRepository } from "./organization-subscription-repository";

export type ClaudeAccountSecret = z.infer<typeof ClaudeSubscriptionCredential>;
type ClaudeAccountSettings = { readonly claudeSubscriptionEnabled: boolean };
export const claudeSubscriptionTables = {
  credentials: schema.claudeSubscriptionCredentials,
  rotationSettings: schema.claudeRotationSettings,
  credentialLeases: schema.claudeCredentialLeases,
  sessionAccountPins: schema.claudeSessionAccountPins,
  capacityWaiters: schema.claudeCapacityWaiters,
};

/** Bulk read inside the selector's already-authorized transaction. */
async function readAccountCapacity(
  db: Database,
  input: {
    candidates: readonly { id: string; version: number; exhaustedUntil: Date | null }[];
    upstreamModelId: string;
    now: Date;
  },
): Promise<ReadonlyMap<string, SubscriptionAccountCapacity>> {
  const rows = await db
    .select()
    .from(schema.claudeSubscriptionAccountUsage)
    .where(
      inArray(
        schema.claudeSubscriptionAccountUsage.credentialId,
        input.candidates.map((account) => account.id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.credentialId, row]));
  return new Map(
    input.candidates.map((account) => {
      const row = byId.get(account.id);
      const parsed =
        row?.credentialVersion === account.version
          ? ClaudeSubscriptionUsage.safeParse(row.snapshot)
          : null;
      const valid = parsed?.success && parsed.data.credentialVersion === account.version;
      const usage = valid ? parsed.data : emptyClaudeUsage(account.version);
      const capacity = claudeSubscriptionCapacity(usage, input.upstreamModelId, input.now);
      const cooldown =
        row?.credentialVersion === account.version
          ? row.modelCooldowns[input.upstreamModelId]
          : undefined;
      const cooldownDeadline =
        cooldown &&
        Number.isFinite(Date.parse(cooldown)) &&
        Date.parse(cooldown) > input.now.getTime()
          ? new Date(cooldown)
          : null;
      // A legacy unclassified cooldown has no per-model evidence. Once full
      // observations exist, their own windows decide which model is available.
      const fallback =
        !valid && account.exhaustedUntil && account.exhaustedUntil > input.now
          ? account.exhaustedUntil
          : null;
      return [
        account.id,
        {
          available:
            capacity.available &&
            usage.refreshStatus !== "reconnect" &&
            !fallback &&
            !cooldownDeadline,
          resetsAt: [fallback, capacity.nextCheckAt, cooldownDeadline]
            .filter((value): value is Date => value !== null)
            .reduce<Date | null>(
              (latest, value) => (!latest || value > latest ? value : latest),
              null,
            ),
        },
      ];
    }),
  );
}

export const claudeSubscriptionAccountRepository = createSubscriptionAccountRepository<
  ClaudeAccountSecret,
  ClaudeAccountSettings
>({
  provider: "claude",
  label: "Claude",
  displayName: "Claude",
  isEnabled: (settings) => settings.claudeSubscriptionEnabled,
  tables: claudeSubscriptionTables,
  leaseTable: "claude_credential_leases",
  assertSecret: (secret) => {
    ClaudeSubscriptionCredential.parse(secret);
  },
  parseSecret: (value) => ClaudeSubscriptionCredential.parse(JSON.parse(value)),
  accessToken: (secret) => secret.token,
  refreshToken: (secret) => secret.oauth?.refreshToken,
  refreshIncrementsVersion: false,
  metadataIncrementsVersion: false,
  onAccessTokenRenewed: async (db, credential) => {
    const table = schema.claudeSubscriptionAccountUsage;
    const [row] = await db.select().from(table).where(eq(table.credentialId, credential.id));
    const parsed = ClaudeSubscriptionUsage.safeParse(row?.snapshot);
    if (
      row?.credentialVersion !== credential.version ||
      !parsed.success ||
      parsed.data.credentialVersion !== credential.version ||
      parsed.data.refreshStatus !== "reconnect"
    )
      return;
    await db
      .update(table)
      .set({
        snapshot: { ...parsed.data, refreshStatus: "not_checked", refreshCheckedAt: null },
        updatedAt: new Date(),
      })
      .where(
        and(eq(table.credentialId, credential.id), eq(table.credentialVersion, credential.version)),
      );
  },
  readCapacity: readAccountCapacity,
});

export const {
  createSubscriptionCredential: createClaudeSubscriptionAccount,
  upsertSubscriptionCredential: upsertClaudeSubscriptionAccount,
  listSubscriptionAccountsMetadata: listClaudeSubscriptionAccountsMetadata,
  listSubscriptionAccountsMetadataForAuthority: listClaudeSubscriptionAccountsMetadataForAuthority,
  getSubscriptionAccountMetadata: getClaudeSubscriptionAccountMetadata,
  getSubscriptionAccountAuthoritySnapshot: getClaudeSubscriptionAccountAuthoritySnapshot,
  resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance:
    resolveClaudeProviderAccountAuthoritySnapshotForAcceptance,
  resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction:
    resolveClaudeProviderAccountAuthoritySnapshotForAcceptanceInTransaction,
  workspaceSubscriptionActive: workspaceClaudeSubscriptionActive,
  workspaceSubscriptionActiveForAuthority: workspaceClaudeSubscriptionActiveForAuthority,
  materializeSubscriptionCredentialForRun: materializeClaudeSubscriptionAccountForRun,
  refreshSubscriptionCredentialSerialized: refreshClaudeSubscriptionAccountSerialized,
  refreshOrganizationSubscriptionCredentialSerialized:
    refreshOrganizationClaudeSubscriptionAccountSerialized,
  acquireSubscriptionCredentialLease: acquireClaudeCredentialLease,
  selectSubscriptionCredentialForUse: selectClaudeCredentialForUse,
  releaseSubscriptionCredentialLease: releaseClaudeCredentialLease,
  heartbeatSubscriptionCredentialLeaseUntil: heartbeatClaudeCredentialLeaseUntil,
  renameSubscriptionAccount: renameClaudeSubscriptionAccount,
  updateSubscriptionAllocatorEligibility: updateClaudeAllocatorEligibility,
  getSubscriptionRotationSettings: getClaudeRotationSettings,
  ensureSubscriptionRotationSettings: ensureClaudeRotationSettings,
  updateSubscriptionRotationSettings: updateClaudeRotationSettings,
  setActiveSubscriptionCredential: setActiveClaudeCredential,
  setInitialActiveSubscriptionCredential: setInitialActiveClaudeCredential,
  disconnectSubscriptionCredentialAndRepick: disconnectClaudeSubscriptionAccountAndRepick,
  disconnectSubscriptionCredential: disconnectClaudeSubscriptionAccount,
  setSubscriptionSessionAccountPin: setClaudeSessionAccountPin,
  getSubscriptionSessionAccountPin: getClaudeSessionAccountPin,
  recordSubscriptionSessionLastAccount: recordClaudeSessionLastAccount,
  wakeSubscriptionCapacityWaiters: wakeClaudeCapacityWaiters,
  SubscriptionAuthorityPoolInactiveError: ClaudeAuthorityPoolInactiveError,
  CREDENTIAL_LEASE_TTL_MS: CLAUDE_CREDENTIAL_LEASE_TTL_MS,
} = claudeSubscriptionAccountRepository;

const organization = createOrganizationSubscriptionRepository<
  ClaudeAccountSecret,
  ClaudeAccountSettings
>({
  provider: "claude",
  displayName: "Claude",
  tables: claudeSubscriptionTables,
  repository: claudeSubscriptionAccountRepository,
  accessToken: (secret) => secret.token,
});
export const {
  listOrganizationSubscriptions: listOrganizationClaudeSubscriptions,
  withOrganizationCapacityMutation: withOrganizationClaudeCapacityMutation,
  upsertOrganizationSubscription: upsertOrganizationClaudeSubscription,
  updateOrganizationSubscription: updateOrganizationClaudeSubscription,
  updateOrganizationRotation: updateOrganizationClaudeRotation,
} = organization;
export type ClaudeSubscriptionAccountMetadata = NonNullable<
  Awaited<ReturnType<typeof getClaudeSubscriptionAccountMetadata>>
>;
export type ClaudeSubscriptionAccountForRun = Awaited<
  ReturnType<typeof materializeClaudeSubscriptionAccountForRun>
>;

/**
 * TEST ONLY: the retired SuperGrok (xAI) legacy account repository, used to
 * construct pre-cutover database states for the 0721 cutover tests. Snapshot
 * source: packages/db/src/xai-subscription.ts at
 * de002bb3260141048dcbb671d6fbf0f554278fe3, deleted with the legacy SuperGrok
 * runtime (M4 X4). Never import this module from production: the runtime
 * no-legacy guard enforces that boundary. After the 0721 receipt every write it
 * attempts is refused by the receipt-gated policies.
 */
import * as schema from "../../src/schema";
import { createSubscriptionAccountRepository } from "../../src/subscription-account-repository";

/** The production factory now types only Claude; SuperGrok used the same code. */
type RetiredProviderOptions = Parameters<
  typeof createSubscriptionAccountRepository<
    XaiCredentialSecretV1,
    { readonly supergrokSubscriptionEnabled: boolean }
  >
>[0];

export type XaiCredentialSecretV1 = {
  version: 1;
  accessToken?: string;
  refreshToken?: string;
  sessionToken?: string;
  cookie?: string;
};

function assertSecret(secret: XaiCredentialSecretV1): void {
  if (secret.version !== 1) throw new Error("Unsupported xAI credential secret version");
  const values = [secret.accessToken, secret.refreshToken, secret.sessionToken, secret.cookie];
  if (!values.some((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("An xAI credential must contain at least one secret value");
  }
}

function parseSecret(value: string): XaiCredentialSecretV1 {
  const parsed = JSON.parse(value) as Partial<XaiCredentialSecretV1>;
  const secret: XaiCredentialSecretV1 = {
    version: 1,
    ...(typeof parsed.accessToken === "string" ? { accessToken: parsed.accessToken } : {}),
    ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
    ...(typeof parsed.sessionToken === "string" ? { sessionToken: parsed.sessionToken } : {}),
    ...(typeof parsed.cookie === "string" ? { cookie: parsed.cookie } : {}),
  };
  assertSecret(secret);
  return secret;
}

export const xaiSubscriptionRepository = createSubscriptionAccountRepository<
  XaiCredentialSecretV1,
  { readonly supergrokSubscriptionEnabled: boolean }
>({
  provider: "xai" as unknown as RetiredProviderOptions["provider"],
  label: "xAI" as unknown as RetiredProviderOptions["label"],
  displayName: "SuperGrok" as unknown as RetiredProviderOptions["displayName"],
  isEnabled: (settings) => settings.supergrokSubscriptionEnabled,
  tables: {
    credentials: schema.xaiSubscriptionCredentials,
    rotationSettings: schema.xaiRotationSettings,
    credentialLeases: schema.xaiCredentialLeases,
    sessionAccountPins: schema.xaiSessionAccountPins,
    capacityWaiters: schema.xaiCapacityWaiters,
  },
  leaseTable: "xai_credential_leases" as unknown as RetiredProviderOptions["leaseTable"],
  assertSecret,
  parseSecret,
  accessToken: (secret) => secret.accessToken,
  refreshToken: (secret) => secret.refreshToken,
});

export const {
  subscriptionAccountMetadataFromRow: xaiSubscriptionMetadataFromRow,
  createSubscriptionCredential: createXaiSubscriptionCredential,
  upsertSubscriptionCredential: upsertXaiSubscriptionCredential,
  listSubscriptionAccountsMetadata: listXaiSubscriptionAccountsMetadata,
  workspaceSubscriptionActive: workspaceXaiSubscriptionActive,
  workspaceSubscriptionActiveForAuthority: workspaceXaiSubscriptionActiveForAuthority,
  getSubscriptionAccountMetadata: getXaiSubscriptionAccountMetadata,
  getSubscriptionAccountAuthoritySnapshot: getXaiSubscriptionAccountAuthoritySnapshot,
  resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance:
    resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction:
    resolveXaiProviderAccountAuthoritySnapshotForAcceptanceInTransaction,
  resolveSubscriptionSharedPoolAuthoritySnapshotInTransaction:
    resolveXaiSharedPoolAuthoritySnapshotInTransaction,
  updateSubscriptionAccountSettings: updateXaiSubscriptionAccountSettings,
  updateSubscriptionAllocatorEligibility: updateXaiAllocatorEligibility,
  renameSubscriptionAccount: renameXaiSubscriptionAccount,
  disconnectSubscriptionCredential: disconnectXaiSubscriptionCredential,
  materializeSubscriptionCredentialForRun: materializeXaiCredentialForRun,
  refreshSubscriptionCredentialSerialized: refreshXaiSubscriptionCredentialSerialized,
  acquireSubscriptionCredentialLease: acquireXaiCredentialLease,
  selectSubscriptionCredentialForUse: selectXaiCredentialForUse,
  releaseSubscriptionCredentialLease: releaseXaiCredentialLease,
  heartbeatSubscriptionCredentialLeaseUntil: heartbeatXaiCredentialLeaseUntil,
  getSubscriptionRotationSettings: getXaiRotationSettings,
  ensureSubscriptionRotationSettings: ensureXaiRotationSettings,
  setActiveSubscriptionCredential: setActiveXaiCredential,
  setInitialActiveSubscriptionCredential: setInitialActiveXaiCredential,
  disconnectSubscriptionCredentialAndRepick: disconnectXaiSubscriptionCredentialAndRepick,
  updateSubscriptionRotationSettings: updateXaiRotationSettings,
  setSubscriptionSessionAccountPin: setXaiSessionAccountPin,
  getSubscriptionSessionAccountPin: getXaiSessionAccountPin,
  recordSubscriptionSessionLastAccount: recordXaiSessionLastAccount,
  updateSubscriptionQuotaMetadata: updateXaiQuotaMetadata,
  wakeSubscriptionCapacityWaiters: wakeXaiCapacityWaiters,
  subscriptionCredentialWorkspacePredicate: xaiCredentialWorkspacePredicate,
  subscriptionRotationWorkspacePredicate: xaiRotationWorkspacePredicate,
  credentialMetadataColumns: xaiCredentialMetadataColumns,
  credentialShardIndex: xaiCredentialShardIndex,
  CREDENTIAL_LEASE_TTL_MS: XAI_CREDENTIAL_LEASE_TTL_MS,
  SubscriptionAuthorityPoolInactiveError: XaiAuthorityPoolInactiveError,
} = xaiSubscriptionRepository;

export type XaiAccountAuthorityScope = "workspace" | "user" | "organization";
export type XaiCredentialStatus = "active" | "needs_relogin" | "error" | "disabled";
export type XaiSubscriptionAccountMetadata = ReturnType<typeof xaiSubscriptionMetadataFromRow>;
export type XaiCredentialForRun = NonNullable<
  Awaited<ReturnType<typeof materializeXaiCredentialForRun>>
>;
export type XaiCredentialLeaseResult = Awaited<ReturnType<typeof acquireXaiCredentialLease>>;
export type XaiSerializedCredentialRefreshResult = Awaited<
  ReturnType<typeof refreshXaiSubscriptionCredentialSerialized>
>;
export type XaiAllocatorUpdateResult = Awaited<ReturnType<typeof updateXaiAllocatorEligibility>>;
export type XaiAuthorityPoolInactiveError = InstanceType<
  typeof xaiSubscriptionRepository.SubscriptionAuthorityPoolInactiveError
>;

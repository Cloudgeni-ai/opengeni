/**
 * 1Password service-account adapter for OpenGeni vaults.
 *
 * Import this package only with a dynamic `import()` from apps/api or
 * apps/worker (the SDK carries a ~14 MB WASM core); see
 * test/import-guard.test.ts.
 */
export {
  createOnePasswordVaultProvider,
  ONEPASSWORD_GET_ALL_BATCH,
  ONEPASSWORD_MANAGED_GROUP_PERMISSIONS,
  ONEPASSWORD_VALUE_CACHE_MS,
  type OnePasswordVaultProvider,
  type OnePasswordVaultProviderOptions,
} from "./provider";
export {
  createAttemptProviderBudget,
  ONEPASSWORD_PLAN_LIMITS,
  OnePasswordQuota,
  onePasswordQuotaFor,
  PROVIDER_READS_PER_ATTEMPT,
  resetOnePasswordQuotasForTests,
  type OnePasswordPlanTier,
} from "./budget";
export {
  classifyOnePasswordMessage,
  mapOnePasswordError,
  ONEPASSWORD_MESSAGE_RULES,
  onePasswordRetryAfterMs,
} from "./errors";
export {
  describeOnePasswordToken,
  isOnePasswordFakeToken,
  ONEPASSWORD_FAKE_TOKENS,
  type OnePasswordFakeToken,
  type OnePasswordTokenDescription,
} from "./token";
export {
  loadOnePasswordSdk,
  OnePasswordClientCache,
  ONEPASSWORD_SDK_VERSION,
  type OnePasswordSdk,
  type OnePasswordSdkClient,
} from "./sdk";
export { itemTypeForCategory, categoryForItemType } from "./mapping";

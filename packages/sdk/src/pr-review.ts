/**
 * Optional Opengeni Review Bot API client, deprecated: pull-request review is an
 * automation with a GitHub event trigger now. Removed in the next major.
 */
export { OpenGeniPrReviewClient } from "./pr-review-client";
export type { OpenGeniPrReviewTransport } from "./pr-review-client";
export type {
  CreatePrReviewAppRegistrationRequest,
  CreatePrReviewRepositoryBindingRequest,
  PrReviewAppRegistration,
  PrReviewCredentialKind,
  PrReviewProvider,
  PrReviewManagedGitHubInstallation,
  PrReviewManagedGitHubSetup,
  PrReviewRepositoryBinding,
  PrReviewWebhookAuthKind,
  ListPrReviewConfigurationResponse,
  UpdatePrReviewAppRegistrationRequest,
  UpdatePrReviewRepositoryBindingRequest,
} from "./types";

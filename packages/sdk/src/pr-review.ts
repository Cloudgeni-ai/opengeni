/** Optional OpenGeni Review Bot API client; import this entry only where the capability is used. */
export { OpenGeniPrReviewClient } from "./pr-review-client";
export type { OpenGeniPrReviewTransport } from "./pr-review-client";
export type {
  CreatePrReviewAppRegistrationRequest,
  CreatePrReviewRepositoryBindingRequest,
  PrReviewAppRegistration,
  PrReviewCredentialKind,
  PrReviewProvider,
  PrReviewRepositoryBinding,
  PrReviewWebhookAuthKind,
  ListPrReviewConfigurationResponse,
  UpdatePrReviewAppRegistrationRequest,
  UpdatePrReviewRepositoryBindingRequest,
} from "./types";

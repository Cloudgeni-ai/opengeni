import * as schema from "./schema";
import { createOrganizationSubscriptionRepository } from "./organization-subscription-repository";
import { xaiSubscriptionRepository, type XaiCredentialSecretV1 } from "./xai-subscription";

const repository = createOrganizationSubscriptionRepository<
  XaiCredentialSecretV1,
  { readonly supergrokSubscriptionEnabled: boolean }
>({
  provider: "xai",
  displayName: "SuperGrok",
  tables: {
    credentials: schema.xaiSubscriptionCredentials,
    rotationSettings: schema.xaiRotationSettings,
    credentialLeases: schema.xaiCredentialLeases,
    sessionAccountPins: schema.xaiSessionAccountPins,
    capacityWaiters: schema.xaiCapacityWaiters,
  },
  repository: xaiSubscriptionRepository,
  accessToken: (secret) => secret.accessToken,
});
export const {
  listOrganizationSubscriptions: listOrganizationXaiSubscriptions,
  withOrganizationCapacityMutation: withOrganizationXaiCapacityMutation,
  upsertOrganizationSubscription: upsertOrganizationXaiSubscription,
  updateOrganizationSubscription: updateOrganizationXaiSubscription,
  updateOrganizationRotation: updateOrganizationXaiRotation,
} = repository;

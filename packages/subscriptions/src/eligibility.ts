import { modelCooldownUntil, quotaCapacity, type QuotaCapacity } from "./quota";
import { inferenceSourceFor, providerSwitchesFor } from "./settings";
import type {
  ModelDescriptor,
  ModelId,
  PlacementInput,
  PlacementPerson,
  PlacementWorkspace,
  SubscriptionConnection,
} from "./types";

/**
 * Reasons a connection may not serve a session at all. These are authority:
 * the database enforces the same rules, so a connection with any of them must
 * never be selected (SUB-ELIG-01, SUB-ELIG-05, SUB-SET-06, SUB-FAIL-04).
 */
export type AuthorizationIneligibility =
  | "provider_disabled"
  | "organization_accounts_off"
  | "inference_source_excludes_connection"
  | "out_of_scope"
  | "personal_connections_disabled"
  | "personal_owner_inactive"
  | "personal_not_owners_work"
  | "personal_authority_missing";

/** Reasons an authorized connection cannot serve a model now (SUB-ELIG-02..04). */
export type ServiceIneligibility =
  | "unhealthy"
  | "allocator_disabled"
  | "wrong_provider"
  | "model_unknown"
  | "model_not_allowed_by_workspace"
  | "model_not_entitled"
  | "model_not_allowed_by_connection"
  | "source_assignment_policy_mismatch"
  | "model_cooling_down"
  | "exhausted";

export type Ineligibility = AuthorizationIneligibility | ServiceIneligibility;

export const AUTHORIZATION_INELIGIBILITIES: readonly AuthorizationIneligibility[] = Object.freeze([
  "provider_disabled",
  "organization_accounts_off",
  "inference_source_excludes_connection",
  "out_of_scope",
  "personal_connections_disabled",
  "personal_owner_inactive",
  "personal_not_owners_work",
  "personal_authority_missing",
]);

const AUTHORIZATION_SET = new Set<Ineligibility>(AUTHORIZATION_INELIGIBILITIES);

export function isAuthorizationIneligibility(
  reason: Ineligibility,
): reason is AuthorizationIneligibility {
  return AUTHORIZATION_SET.has(reason);
}

const PERMANENT_SERVICE = new Set<Ineligibility>([
  "wrong_provider",
  "model_unknown",
  "model_not_allowed_by_workspace",
  "model_not_entitled",
  "model_not_allowed_by_connection",
  "source_assignment_policy_mismatch",
]);

/**
 * Reasons that neither time nor a quota reset clears: the work is not
 * authorized on the account, or the account cannot serve the model at all.
 * Health and allocator eligibility are not permanent: reconnecting or
 * re-enabling allocation restores them.
 */
export function isPermanentIneligibility(reason: Ineligibility): boolean {
  return AUTHORIZATION_SET.has(reason) || PERMANENT_SERVICE.has(reason);
}

/** Capacity of a connection now, with the input's staleness bound for its provider. */
export function connectionCapacity(
  input: PlacementInput,
  connection: SubscriptionConnection,
): QuotaCapacity {
  return quotaCapacity(connection.quota, input.now, input.quotaStaleAfterMs?.[connection.provider]);
}

function findModel(input: PlacementInput, modelId: ModelId): ModelDescriptor | undefined {
  return input.models.find((model) => model.id === modelId);
}

function findPerson(input: PlacementInput, membershipId: string): PlacementPerson | undefined {
  return input.people.find((person) => person.membershipId === membershipId);
}

function sourceAssignments(input: PlacementInput, connection: SubscriptionConnection) {
  const source = inferenceSourceFor(input.settings, connection.provider);
  return connection.assignmentPolicies?.filter(
    (policy) =>
      policy.workspaceId === input.workspace.id &&
      (source === "automatic" || policy.inferencePool === source),
  );
}

function sharedConnectionMatchesSource(input: PlacementInput, connection: SubscriptionConnection) {
  const source = inferenceSourceFor(input.settings, connection.provider);
  const assignments = sourceAssignments(input, connection);
  if (assignments !== undefined) return assignments.length > 0;

  // M2 worlds do not yet include the M3 per-workspace assignment relation.
  // Keep their compatibility projection readable while the cutover is off.
  const managedHere = connection.ownership.kind === "shared" &&
    connection.ownership.managedByWorkspaceId === input.workspace.id;
  if (source === "workspace") return managedHere;
  if (source === "organization") return !managedHere;
  return source === "automatic" || managedHere;
}

/** Workspace model restrictions are a ceiling on every selection (SUB-ELIG-02). */
export function modelAllowedInWorkspace(workspace: PlacementWorkspace, modelId: ModelId): boolean {
  return workspace.allowedModelIds === null || workspace.allowedModelIds.includes(modelId);
}

/** Is the provider switched on for this workspace (SUB-SET-06)? */
export function providerEnabled(input: PlacementInput, provider: string): boolean {
  return providerSwitchesFor(input.settings, provider).enabled;
}

/**
 * Authorization of one connection for the session's work, independent of
 * model and capacity. Personal connections serve only their owner's own work,
 * in the owner's private sessions or Personal workspace, with frozen personal
 * authority for that provider (SUB-ELIG-05, design 3.7, 3.8). Shared
 * connections serve the workspaces and people in their scope, where people are
 * evaluated against the session owner.
 */
export function authorizationIneligibility(
  input: PlacementInput,
  connection: SubscriptionConnection,
): AuthorizationIneligibility[] {
  const reasons: AuthorizationIneligibility[] = [];
  const { session, workspace } = input;
  const switches = providerSwitchesFor(input.settings, connection.provider);
  if (!switches.enabled) reasons.push("provider_disabled");
  const ownership = connection.ownership;
  if (ownership.kind === "personal") {
    const owner = ownership.ownerMembershipId;
    if (!input.settings.personalConnectionsAllowed) reasons.push("personal_connections_disabled");
    if (!findPerson(input, owner)?.active) reasons.push("personal_owner_inactive");
    const ownersOwnWork =
      session.ownerMembershipId === owner &&
      (session.visibility === "private" ||
        (workspace.kind === "personal" && workspace.ownerMembershipId === owner));
    if (!ownersOwnWork) reasons.push("personal_not_owners_work");
    const frozen = session.personalAuthority.some(
      (authority) =>
        authority.provider === connection.provider && authority.ownerMembershipId === owner,
    );
    if (!frozen) reasons.push("personal_authority_missing");
    return reasons;
  }
  if (!sharedConnectionMatchesSource(input, connection)) {
    reasons.push(
      switches.inferenceSource === undefined && !switches.useOrganizationAccounts
        ? "organization_accounts_off"
        : "inference_source_excludes_connection",
    );
  }
  const scope = ownership.scope;
  const inScope =
    scope.kind === "organization" ||
    (scope.kind === "workspaces" &&
      (scope.workspaceIds.includes(workspace.id) ||
        (workspace.kind === "personal" && scope.allowPersonalWorkspaces))) ||
    (scope.kind === "people" && scope.membershipIds.includes(session.ownerMembershipId));
  if (!inScope) reasons.push("out_of_scope");
  return reasons;
}

/** Reasons the connection cannot serve this model, ignoring capacity and cooldowns. */
function staticServiceIneligibility(
  input: PlacementInput,
  connection: SubscriptionConnection,
  modelId: ModelId,
): ServiceIneligibility[] {
  const reasons: ServiceIneligibility[] = [];
  if (connection.health !== "healthy") reasons.push("unhealthy");
  const assignments = sourceAssignments(input, connection);
  if (!connection.allocatorEnabled || (assignments !== undefined && !assignments.some((policy) => policy.allocatorEnabled))) {
    reasons.push("allocator_disabled");
  }
  const model = findModel(input, modelId);
  if (!model) reasons.push("model_unknown");
  else if (model.provider !== connection.provider) reasons.push("wrong_provider");
  if (!modelAllowedInWorkspace(input.workspace, modelId)) {
    reasons.push("model_not_allowed_by_workspace");
  }
  const entitled =
    (connection.entitledModelIds === null || connection.entitledModelIds.includes(modelId)) &&
    !connection.excludedModelIds.includes(modelId);
  if (!entitled) reasons.push("model_not_entitled");
  if (connection.allowedModelIds !== null && !connection.allowedModelIds.includes(modelId)) {
    reasons.push("model_not_allowed_by_connection");
  }
  if (assignments !== undefined) {
    const hasAllocatableAssignment = assignments.some((policy) => policy.allocatorEnabled);
    const hasServingAssignment = assignments.some(
      (policy) =>
        policy.allocatorEnabled &&
        (policy.allowedModelIds === null || policy.allowedModelIds.includes(modelId)),
    );
    if (hasAllocatableAssignment && !hasServingAssignment) {
      reasons.push("source_assignment_policy_mismatch");
    }
  }
  return reasons;
}

/** Every reason this connection cannot serve this session and model now; empty when it can. */
export function connectionIneligibility(
  input: PlacementInput,
  connection: SubscriptionConnection,
  modelId: ModelId,
): Ineligibility[] {
  const reasons: Ineligibility[] = [
    ...authorizationIneligibility(input, connection),
    ...staticServiceIneligibility(input, connection, modelId),
  ];
  if (modelCooldownUntil(connection.quota, modelId, input.now) !== null) {
    reasons.push("model_cooling_down");
  }
  if (connectionCapacity(input, connection).kind === "exhausted") reasons.push("exhausted");
  return reasons;
}

/** SUB-ELIG-01..06: may this connection serve this session's model now? */
export function canServe(
  input: PlacementInput,
  connection: SubscriptionConnection,
  modelId: ModelId,
): boolean {
  return connectionIneligibility(input, connection, modelId).length === 0;
}

/**
 * When a connection that is blocked only by capacity or a model cooldown can
 * serve this model again. Returns `undefined` when something other than time
 * blocks it, or when it is not blocked at all, and `null` when the reset time
 * is unknown.
 */
export function servableAgainAt(
  input: PlacementInput,
  connection: SubscriptionConnection,
  modelId: ModelId,
): number | null | undefined {
  if (authorizationIneligibility(input, connection).length > 0) return undefined;
  if (staticServiceIneligibility(input, connection, modelId).length > 0) return undefined;
  const capacity = connectionCapacity(input, connection);
  const cooldown = modelCooldownUntil(connection.quota, modelId, input.now);
  if (capacity.kind !== "exhausted" && cooldown === null) return undefined;
  if (capacity.kind === "exhausted" && capacity.resetsAt === null) return null;
  const capacityAt = capacity.kind === "exhausted" ? (capacity.resetsAt as number) : input.now;
  return Math.max(capacityAt, cooldown ?? input.now);
}

/** The owner opted in and the effective setting allows personal fallback (SUB-SEL-02, D-12). */
export function personalFallbackActive(input: PlacementInput): boolean {
  return (
    input.settings.personalFallbackAllowed &&
    !!findPerson(input, input.session.ownerMembershipId)?.personalFallbackOptIn
  );
}

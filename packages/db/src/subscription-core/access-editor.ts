import type { ProviderId } from "@opengeni/subscriptions";
import type { Database } from "../database";
import { subscriptionCoreProvider } from "../subscription-core-providers";
import {
  readSubscriptionCoreConnectionAccess,
  SubscriptionCoreAccessForbiddenError,
  SubscriptionCoreAccessWorkspaceNotInOrganizationError,
  updateSubscriptionCoreConnectionAccess,
  withSubscriptionCoreAccessScope,
  type SubscriptionCoreAccess,
  type SubscriptionCoreAccessTarget,
} from "./access";

export type { SubscriptionCoreAccessTarget } from "./access";

/** What a connection serves, in the access routes' shape. */
export type ModelConnectionAccess = {
  allowedModels: string[] | null;
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  /** Chosen people (organization membership ids); shared core connections only. */
  allowedPeople?: string[] | null | undefined;
  version: number;
};

/** A requested access policy names a workspace outside the organization's shared workspaces. */
export class ModelConnectionWorkspaceNotInOrganizationError extends Error {
  constructor() {
    super("A selected workspace is not in this organization");
    this.name = "ModelConnectionWorkspaceNotInOrganizationError";
  }
}

/** The viewer can read a connection's access but may not change it. */
export class ModelConnectionAccessForbiddenError extends Error {
  constructor() {
    super("You can't change what this account serves");
    this.name = "ModelConnectionAccessForbiddenError";
  }
}

/**
 * Runs an access route's reads and writes: under the subject's workspace RLS
 * for a workspace's connection, otherwise in the organization scope once the
 * subject's organization administration overview is readable.
 */
export async function withModelConnectionAccessScope<T>(
  db: Database,
  target: SubscriptionCoreAccessTarget,
  use: (db: Database) => Promise<T>,
): Promise<T> {
  return await withSubscriptionCoreAccessScope(db, target, use);
}

/** The legacy policy shape; `allowedPeople` appears only when people are chosen. */
function legacyCorePolicy(access: SubscriptionCoreAccess): ModelConnectionAccess {
  const { allowedPeople, ...policy } = access.policy;
  return allowedPeople === null ? policy : { ...policy, allowedPeople };
}

function coreTarget(target: SubscriptionCoreAccessTarget): SubscriptionCoreAccessTarget {
  return {
    accountId: target.accountId,
    workspaceId: target.workspaceId,
    subjectId: target.subjectId,
    connectionId: target.connectionId,
  };
}

/**
 * A shared connection's access on the shared subscription core, for any
 * registered provider, with the workspaces that use it as their own and its
 * delegated manager (design 5.4). The organization route reads any
 * organization account, including one a shared workspace manages; the
 * workspace route only one that workspace manages.
 */
export async function readSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
): Promise<SubscriptionCoreAccess | null> {
  return await readSubscriptionCoreConnectionAccess(
    db,
    subscriptionCoreProvider(provider),
    coreTarget(target),
  );
}

/**
 * A shared connection's access policy on the shared subscription core, for
 * any registered provider, in the legacy shape. `allowedWorkspaces` is null
 * when every shared workspace, including ones created later, may use it.
 */
export async function getSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
): Promise<ModelConnectionAccess | null> {
  const access = await readSubscriptionCoreModelConnectionAccess(db, provider, target);
  return access ? legacyCorePolicy(access) : null;
}

/**
 * Save what a shared connection of any registered provider serves on the
 * core (`updateSubscriptionCoreConnectionAccess`). Null when the connection
 * is gone or its access changed since `policy.version` was read.
 */
export async function updateSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  const binding = subscriptionCoreProvider(provider);
  try {
    const access = await updateSubscriptionCoreConnectionAccess(
      db,
      binding,
      coreTarget(target),
      policy,
    );
    return access ? legacyCorePolicy(access) : null;
  } catch (error) {
    if (error instanceof SubscriptionCoreAccessWorkspaceNotInOrganizationError)
      throw new ModelConnectionWorkspaceNotInOrganizationError();
    if (error instanceof SubscriptionCoreAccessForbiddenError)
      throw new ModelConnectionAccessForbiddenError();
    throw error;
  }
}

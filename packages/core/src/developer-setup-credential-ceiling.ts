import {
  readTurnExecutionPolicyV1,
  type AccessGrant,
  type Permission,
  type TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  isDeveloperSetupAuthorization,
  isDeveloperSetupGrant,
  isDeveloperSetupDelegatedPermissionAllowed,
  type AccessGrantAuthorization,
} from "./access";

/** The policy must be server-frozen, never supplied as request metadata. */
export function requireDeveloperSetupDelegatedPermissions(
  policy: TurnExecutionPolicyV1,
  permissions: readonly Permission[] | undefined,
): void {
  requireDeveloperSetupDelegatablePermissions(
    policy.credentialRestriction === "developer_setup",
    permissions,
  );
}

export function requireDeveloperSetupDelegatablePermissions(
  restricted: boolean,
  permissions: readonly Permission[] | undefined,
): void {
  if (!restricted) return;
  const forbidden = permissions?.find(
    (permission) => !isDeveloperSetupDelegatedPermissionAllowed(permission),
  );
  if (forbidden) {
    throw new HTTPException(403, {
      message: `Developer setup cannot delegate first-party MCP permission: ${forbidden}`,
    });
  }
}

/** Only pass server-owned persisted session/turn metadata, never request JSON. */
export function withDeveloperSetupCredentialRestriction(
  policy: TurnExecutionPolicyV1,
  source: {
    grant?: AccessGrant;
    authorization?: AccessGrantAuthorization | undefined;
    trustedMetadata?: readonly unknown[];
  },
): TurnExecutionPolicyV1 {
  const restricted =
    policy.credentialRestriction === "developer_setup" ||
    developerSetupCredentialRestricted(source);
  return restricted ? { ...policy, credentialRestriction: "developer_setup" } : policy;
}

/**
 * Whether the caller or the frozen session policy carries the developer-setup
 * credential ceiling. Only pass server-owned persisted session metadata.
 */
export function developerSetupCredentialRestricted(source: {
  grant?: AccessGrant;
  authorization?: AccessGrantAuthorization | undefined;
  trustedMetadata?: readonly unknown[];
}): boolean {
  let restricted =
    isDeveloperSetupAuthorization(source.authorization) ||
    (source.grant !== undefined && isDeveloperSetupGrant(source.grant));
  for (const metadata of source.trustedMetadata ?? []) {
    if (metadata === null || metadata === undefined) continue;
    let inherited: ReturnType<typeof readTurnExecutionPolicyV1>;
    try {
      inherited = readTurnExecutionPolicyV1(metadata);
    } catch {
      throw new HTTPException(409, { message: "The frozen session credential ceiling is invalid" });
    }
    if (
      inherited.kind === "valid" &&
      inherited.policy.credentialRestriction === "developer_setup"
    ) {
      restricted = true;
    }
  }
  return restricted;
}

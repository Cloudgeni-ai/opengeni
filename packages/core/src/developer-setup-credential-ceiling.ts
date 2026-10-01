import {
  readTurnExecutionPolicyV1,
  type AccessGrant,
  type TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  isDeveloperSetupAuthorization,
  isDeveloperSetupGrant,
  type AccessGrantAuthorization,
} from "./access";

/** Only pass server-owned persisted session/turn metadata, never request JSON. */
export function withDeveloperSetupCredentialRestriction(
  policy: TurnExecutionPolicyV1,
  source: {
    grant?: AccessGrant;
    authorization?: AccessGrantAuthorization | undefined;
    trustedMetadata?: readonly unknown[];
  },
): TurnExecutionPolicyV1 {
  let restricted =
    policy.credentialRestriction === "developer_setup" ||
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
  return restricted ? { ...policy, credentialRestriction: "developer_setup" } : policy;
}

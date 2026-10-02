import { readTurnExecutionPolicyV1, type TurnExecutionPolicyV1 } from "@opengeni/contracts";

/** Only accepted policies establish the ceiling; ordinary metadata is not authority. */
export function turnCredentialRestriction(
  acceptedPolicy: TurnExecutionPolicyV1,
  initialSessionMetadata: unknown,
): "developer_setup" | undefined {
  const initialPolicy = readTurnExecutionPolicyV1(initialSessionMetadata);
  return acceptedPolicy.credentialRestriction === "developer_setup" ||
    (initialPolicy.kind === "valid" &&
      initialPolicy.policy.credentialRestriction === "developer_setup")
    ? "developer_setup"
    : undefined;
}

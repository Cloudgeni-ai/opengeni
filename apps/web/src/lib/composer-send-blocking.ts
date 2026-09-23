export type ComposerSendBlocker =
  | "upload"
  | "repository"
  | "policy"
  | "variable_sets"
  | "personal_decision"
  | "personal_loading";
export function getComposerSendBlocker(input: {
  uploadPending: boolean;
  repositoryError: string | null;
  policyValid: boolean;
  variableSetBlocked: boolean;
  personalDecision: boolean;
  personalLoading: boolean;
}): ComposerSendBlocker | null {
  if (input.uploadPending) return "upload";
  if (input.repositoryError !== null) return "repository";
  if (!input.policyValid) return "policy";
  if (input.variableSetBlocked) return "variable_sets";
  if (input.personalDecision) return "personal_decision";
  if (input.personalLoading) return "personal_loading";
  return null;
}

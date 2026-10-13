import {
  generatePassword,
  normalizePermission,
  passwordStrength,
  tokenizeSecretText,
} from "@opengeni/contracts";
import type { SecretsUi } from "@opengeni/react";
import type { HumanInputSecretSaveTo } from "@opengeni/sdk";
import type { AccessContext } from "@/types";

/**
 * The console's secret-reference tokenizer and password generator for
 * `SecretsUiProvider`: the one grammar and generator from @opengeni/contracts,
 * which @opengeni/react cannot import itself.
 */
export const webSecretsUi: SecretsUi = {
  tokenize: tokenizeSecretText,
  generatePassword: (spec) => generatePassword(spec),
  passwordStrength,
};

/**
 * Where this person may save an ask-card secret: always Only me and This
 * task; This workspace needs `secrets:write` (or a legacy alias) in it.
 */
export function secretSaveTargets(
  access: AccessContext | null,
  workspaceId: string,
): HumanInputSecretSaveTo[] {
  const grant = access?.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  const canWrite = Boolean(
    grant?.permissions.some(
      (permission) =>
        permission === "workspace:admin" || normalizePermission(permission) === "secrets:write",
    ),
  );
  return canWrite ? ["user", "task", "workspace"] : ["user", "task"];
}

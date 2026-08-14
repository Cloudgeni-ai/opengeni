import {
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import { signDelegatedAccessToken } from "@opengeni/contracts";

export const CODEMODE_TOKEN_TTL_SECONDS = 60 * 60;

export type CodemodeAuthorityScope = {
  accountId: string;
  workspaceId: string;
};

export type SandboxCodemodeAuthority = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type MintedSandboxCodemodeToken = {
  token: string;
  expiresAt: Date;
};

/**
 * Mint the one canonical exact-attempt Codemode bearer used by every compute
 * placement. Delivery is deliberately a separate concern: managed sandboxes
 * rotate it through a private file, while Connected Machines receive it only
 * in the environment of an authorized child process.
 */
export async function mintSandboxCodemodeToken(
  settings: Settings,
  scope: CodemodeAuthorityScope,
  authority: SandboxCodemodeAuthority,
  nowMs = Date.now(),
): Promise<MintedSandboxCodemodeToken | undefined> {
  const delegationSecret = resolveFirstPartyDelegationSecret(settings);
  if (!delegationSecret) return undefined;
  const expiresAtSeconds = Math.floor(nowMs / 1000) + CODEMODE_TOKEN_TTL_SECONDS;
  const token = await signDelegatedAccessToken(delegationSecret, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: `sandbox:${authority.attemptId}`,
    subjectLabel: "sandbox Codemode",
    permissions: ["codemode:call"],
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    attemptId: authority.attemptId,
    executionGeneration: authority.executionGeneration,
    principalKind: "agent_attempt",
    exp: expiresAtSeconds,
  });
  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
}

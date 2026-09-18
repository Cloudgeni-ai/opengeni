import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { type GitHubInstallationBindingProof } from "@opengeni/contracts";
import { PR_REVIEW_AUTOMATION_SETUP, type ApiRouteDeps } from "@opengeni/core";
import {
  encryptVariableSetValue,
  recordAuditEvent,
  syncManagedGitHubPrReviewInstallation,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export async function requireGitHubLensConnect(deps: ApiRouteDeps) {
  if (deps.settings.sandboxBackend === "selfhosted")
    throw new HTTPException(409, { message: "OpenGeni Lens requires managed compute" });
  if (!environmentsEncryptionKeyBytes(deps.settings))
    throw new HTTPException(503, { message: "Lens secret encryption is unavailable" });
  return { template: PR_REVIEW_AUTOMATION_SETUP };
}

/** Separate Lens registration/source/automation domain, not a repository-access
 * binding. Invoked inside the Connect receipt's authorized transaction. */
export async function commitGitHubLensConnect(
  deps: ApiRouteDeps,
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    installationId: number;
    proof: GitHubInstallationBindingProof;
    checkedAt: Date;
    expiresAt: Date;
    nonce: string;
  },
) {
  const { template } = await requireGitHubLensConnect({ ...deps, db: tx });
  const synchronized = await syncManagedGitHubPrReviewInstallation(tx, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    providerAccountLogin: input.proof.installation.accountLogin,
    providerAccountType: input.proof.installation.accountType as "User" | "Organization",
    githubActorId: input.proof.actorId,
    authorityKind: input.proof.authorityKind,
    authorityCheckedAt: input.checkedAt,
    authorityExpiresAt: input.expiresAt,
    authorityNonce: input.nonce,
    appId: deps.settings.prReviewGithubAppId!,
    webhookSecretEncrypted: encryptVariableSetValue(
      environmentsEncryptionKeyBytes(deps.settings)!,
      deps.settings.prReviewGithubWebhookSecret!,
    ),
    repositories: input.proof.repositories,
    createdBySubjectId: input.subjectId,
    adapterId: template.adapterId,
    eventTypes: template.eventTypes,
    configuration: template.configuration,
    sessionTemplate: template.sessionTemplate,
  });
  await recordAuditEvent(tx, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    action: "prReview.managed_github.connected",
    targetType: "pr_review_app_registration",
    targetId: synchronized.registration.id,
    metadata: {
      installationId: input.installationId,
      providerAccountLogin: input.proof.installation.accountLogin,
      repositoryCount: synchronized.repositories.length,
      authorityKind: input.proof.authorityKind,
      githubActorId: input.proof.actorId,
    },
  });
  return synchronized.registration;
}

import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  OPENGENI_PR_REVIEW_PACK_ID,
  type GitHubInstallationBindingProof,
} from "@opengeni/contracts";
import {
  getCapabilityPack,
  PR_REVIEW_AUTOMATION_TEMPLATE_ID,
  prReviewPackConnectorId,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  encryptVariableSetValue,
  getPackInstallation,
  recordAuditEvent,
  syncManagedGitHubPrReviewInstallation,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export async function requireGitHubLensConnect(deps: ApiRouteDeps, workspaceId: string) {
  if (deps.settings.sandboxBackend === "selfhosted")
    throw new HTTPException(409, { message: "OpenGeni Lens requires managed compute" });
  const installation = await getPackInstallation(deps.db, workspaceId, OPENGENI_PR_REVIEW_PACK_ID);
  if (installation?.status !== "active")
    throw new HTTPException(409, { message: "Install and enable the Review Bot Pack first" });
  const template = getCapabilityPack(OPENGENI_PR_REVIEW_PACK_ID)?.automationTemplates?.find(
    (value) => value.id === PR_REVIEW_AUTOMATION_TEMPLATE_ID,
  );
  if (!template || !environmentsEncryptionKeyBytes(deps.settings))
    throw new HTTPException(503, { message: "Lens template or secret encryption is unavailable" });
  return { installation, template };
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
  const { installation, template } = await requireGitHubLensConnect(
    { ...deps, db: tx },
    input.workspaceId,
  );
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
    packInstallationId: installation.id,
    packConnectorId: prReviewPackConnectorId("github"),
    packTemplateId: template.id,
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

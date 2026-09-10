import type {
  GitHubInstallationBindingCandidate,
  GitHubInstallationBindingProof,
} from "@opengeni/contracts";

export function isConsistentGitHubBindingCandidates(
  candidates: GitHubInstallationBindingCandidate[],
): boolean {
  const ids = new Set<number>();
  return candidates.every(({ installation, authorityKind }) => {
    if (
      !Number.isSafeInteger(installation.installationId) ||
      installation.installationId <= 0 ||
      !Number.isSafeInteger(installation.accountId) ||
      installation.accountId <= 0 ||
      !installation.accountLogin?.trim() ||
      installation.suspended ||
      ids.has(installation.installationId)
    )
      return false;
    ids.add(installation.installationId);
    return authorityKind === "personal_owner"
      ? installation.accountType === "User"
      : authorityKind === "organization_owner" && installation.accountType === "Organization";
  });
}

export function isConsistentGitHubBindingProof(
  proof: GitHubInstallationBindingProof,
  installationId: number,
): boolean {
  const installation = proof.installation;
  if (
    installation.installationId !== installationId ||
    !Number.isSafeInteger(installation.accountId) ||
    installation.accountId <= 0 ||
    !installation.accountLogin?.trim() ||
    installation.suspended ||
    !Number.isSafeInteger(proof.actorId) ||
    proof.actorId <= 0 ||
    !proof.actorLogin.trim() ||
    proof.repositories.length === 0 ||
    new Set(proof.repositories.map((repo) => repo.id)).size !== proof.repositories.length
  )
    return false;
  if (
    proof.authorityKind === "personal_owner"
      ? installation.accountType !== "User" || proof.actorId !== installation.accountId
      : proof.authorityKind !== "organization_owner" || installation.accountType !== "Organization"
  )
    return false;
  return proof.repositories.every(
    (repo) =>
      Number.isSafeInteger(repo.id) &&
      repo.id > 0 &&
      repo.installationId === installationId &&
      repo.accountLogin === installation.accountLogin &&
      repo.accountType === installation.accountType,
  );
}

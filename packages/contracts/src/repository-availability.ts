/**
 * `details.code` on a 422 `validation_failed` envelope when one or more GitHub
 * App repositories in a request are no longer shared with the workspace: the
 * installation was removed or suspended, or the repository was taken out of
 * it. `details.repositories` names them (`owner/name`). The same request is
 * refused again until the repository is removed or its access is restored.
 * Additive to the public error envelope: `code` stays `validation_failed` and
 * the message keeps its historical text.
 */
export const GITHUB_REPOSITORY_UNAVAILABLE_ERROR_CODE = "github_repository_unavailable" as const;

/** Typed cause for GitHub App repositories the workspace can no longer use. */
export class GitHubRepositoryUnavailableError extends Error {
  readonly code = GITHUB_REPOSITORY_UNAVAILABLE_ERROR_CODE;

  constructor(readonly repositories: readonly string[]) {
    super(
      "GitHub App repository resources must be authorized for a GitHub App installation linked to this workspace",
    );
    this.name = "GitHubRepositoryUnavailableError";
  }
}

import { parseCanonicalGitHubRepositoryUrl } from "@opengeni/contracts";

import type { ManualRepositoryAttachResult } from "@/components/manual-repository-editor";
import type { RepoDraft } from "@/lib/session-tools";
import type {
  GitHubRepository,
  PersonalGitHubRepositoryCatalogItem,
  VerifyPublicGitHubRepositoryRefRequest,
  VerifyPublicGitHubRepositoryRefResponse,
} from "@/types";

export const ANONYMOUS_REPOSITORY_WARNING =
  "OpenGeni will clone this repository anonymously. Make sure it is publicly readable.";

const CANONICAL_GITHUB_URL_ERROR =
  "Use a canonical GitHub URL such as https://github.com/owner/repository.";

type ManualRepositoryTarget =
  | { kind: "workspace_github"; repository: GitHubRepository; ref: string }
  | {
      kind: "personal_github";
      repository: PersonalGitHubRepositoryCatalogItem;
      ref: string;
    }
  | { kind: "public_github"; request: VerifyPublicGitHubRepositoryRefRequest }
  | { kind: "anonymous_https"; url: string; ref: string };

export function attachedManualRepositoryCount(repositories: RepoDraft[]): number {
  return repositories.filter(
    (repository) => repository.attached !== false && repository.url.trim().length > 0,
  ).length;
}

export function classifyManualRepository(input: {
  repository: RepoDraft;
  workspaceRepositories: GitHubRepository[];
  personalRepositories: PersonalGitHubRepositoryCatalogItem[];
}): ManualRepositoryTarget {
  const rawUrl = input.repository.url.trim();
  const ref = input.repository.ref.trim();
  if (!rawUrl) throw new Error("Enter a repository URL.");
  if (!ref) throw new Error("Enter a branch, tag, or commit SHA.");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Repository URL must be a valid public HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Repository URL must be a public HTTPS URL without credentials.");
  }

  if (parsed.hostname.toLowerCase().replace(/\.$/, "") === "github.com") {
    let canonical: ReturnType<typeof parseCanonicalGitHubRepositoryUrl>;
    try {
      canonical = parseCanonicalGitHubRepositoryUrl(rawUrl);
    } catch {
      throw new Error(CANONICAL_GITHUB_URL_ERROR);
    }
    const workspaceRepository = input.workspaceRepositories.find(
      (repository) => repository.fullName.toLowerCase() === canonical.fullName.toLowerCase(),
    );
    if (workspaceRepository) {
      return { kind: "workspace_github", repository: workspaceRepository, ref };
    }
    const personalRepository = input.personalRepositories.find(
      (repository) =>
        repository.selectedAccess !== null &&
        repository.fullName.toLowerCase() === canonical.fullName.toLowerCase(),
    );
    if (personalRepository) {
      return { kind: "personal_github", repository: personalRepository, ref };
    }
    return {
      kind: "public_github",
      request: { url: canonical.canonicalUrl, ref },
    };
  }

  return { kind: "anonymous_https", url: parsed.toString(), ref };
}

export async function attachManualRepository(input: {
  repository: RepoDraft;
  workspaceRepositories: GitHubRepository[];
  personalRepositories: PersonalGitHubRepositoryCatalogItem[];
  selectWorkspaceRepository: (repository: GitHubRepository, ref: string) => Promise<void> | void;
  selectPersonalRepository: (
    repository: PersonalGitHubRepositoryCatalogItem,
    ref: string,
  ) => Promise<void> | void;
  verifyPublicGitHubRepository: (
    request: VerifyPublicGitHubRepositoryRefRequest,
  ) => Promise<VerifyPublicGitHubRepositoryRefResponse>;
  attach: (repository: RepoDraft) => void;
  remove: (id: number) => void;
}): Promise<ManualRepositoryAttachResult> {
  const target = classifyManualRepository(input);
  if (target.kind === "workspace_github") {
    await input.selectWorkspaceRepository(target.repository, target.ref);
    input.remove(input.repository.id);
    return;
  }
  if (target.kind === "personal_github") {
    await input.selectPersonalRepository(target.repository, target.ref);
    input.remove(input.repository.id);
    return;
  }
  if (target.kind === "public_github") {
    const verified = await input.verifyPublicGitHubRepository(target.request);
    input.attach({
      ...input.repository,
      url: verified.cloneUrl,
      ref: verified.ref,
      attached: true,
    });
    return;
  }
  input.attach({
    ...input.repository,
    url: target.url,
    ref: target.ref,
    attached: true,
  });
  return { warning: ANONYMOUS_REPOSITORY_WARNING };
}

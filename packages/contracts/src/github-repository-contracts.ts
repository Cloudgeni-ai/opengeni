import { z } from "zod";

export const VerifyPublicGitHubRepositoryRefRequest = z
  .object({
    url: z.string().min(1).max(2048),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "ref contains control characters"),
  })
  .strict();
export type VerifyPublicGitHubRepositoryRefRequest = z.infer<
  typeof VerifyPublicGitHubRepositoryRefRequest
>;

export const VerifyPublicGitHubRepositoryRefResponse = z
  .object({
    owner: z.string().min(1).max(39),
    name: z.string().min(1).max(100),
    fullName: z.string().min(3).max(140),
    canonicalUrl: z.string().url(),
    cloneUrl: z.string().url(),
    defaultBranch: z.string().min(1).max(1024),
    ref: z.string().min(1).max(1024),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict();
export type VerifyPublicGitHubRepositoryRefResponse = z.infer<
  typeof VerifyPublicGitHubRepositoryRefResponse
>;

export const GITHUB_REPOSITORY_BRANCH_PAGE_MAX = 100 as const;

export const ListGitHubRepositoryBranchesQuery = z
  .object({
    cursor: z.coerce.number().int().positive().max(10_000).default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(GITHUB_REPOSITORY_BRANCH_PAGE_MAX)
      .default(GITHUB_REPOSITORY_BRANCH_PAGE_MAX),
  })
  .strict();
export type ListGitHubRepositoryBranchesQuery = z.infer<typeof ListGitHubRepositoryBranchesQuery>;

export const GitHubRepositoryBranch = z
  .object({
    name: z.string().min(1).max(1024),
    isDefault: z.boolean(),
  })
  .strict();
export type GitHubRepositoryBranch = z.infer<typeof GitHubRepositoryBranch>;

export const GitHubRepositoryBranchesResponse = z
  .object({
    branches: z.array(GitHubRepositoryBranch).max(GITHUB_REPOSITORY_BRANCH_PAGE_MAX),
    nextCursor: z.number().int().positive().max(10_000).nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    const names = new Set<string>();
    let defaultCount = 0;
    response.branches.forEach((branch, index) => {
      if (names.has(branch.name)) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "name"],
          message: "branch names must be unique",
        });
      }
      names.add(branch.name);
      if (branch.isDefault) defaultCount += 1;
    });
    if (defaultCount > 1) {
      context.addIssue({
        code: "custom",
        path: ["branches"],
        message: "at most one branch may be marked as default",
      });
    }
  });
export type GitHubRepositoryBranchesResponse = z.infer<typeof GitHubRepositoryBranchesResponse>;

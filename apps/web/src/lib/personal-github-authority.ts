import type { McpConnectionAuthoritySelection } from "@/types";

export type PersonalGitHubAuthorityCache = Readonly<{
  authority: McpConnectionAuthoritySelection;
  connectionVersion: number;
}>;

export function reusablePersonalGitHubAuthority(
  cache: PersonalGitHubAuthorityCache | null,
  expected: Readonly<{
    connectionId: string;
    connectionVersion: number;
    connectionAuthorityGeneration?: number | undefined;
    context?: "user_private" | "workspace_shared" | undefined;
  }>,
): McpConnectionAuthoritySelection | null {
  if (
    !cache ||
    cache.authority.connectionId !== expected.connectionId ||
    cache.connectionVersion !== expected.connectionVersion ||
    (expected.connectionAuthorityGeneration !== undefined &&
      cache.authority.userDelegation.authorityGeneration !==
        expected.connectionAuthorityGeneration) ||
    (expected.context !== undefined && cache.authority.userDelegation.context !== expected.context)
  ) {
    return null;
  }
  return cache.authority;
}

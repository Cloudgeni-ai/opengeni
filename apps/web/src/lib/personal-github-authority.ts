import type { McpConnectionAccountSelection } from "@/types";

export type PersonalGitHubAuthorityCache = Readonly<{
  authority: McpConnectionAccountSelection;
  connectionVersion: number;
}>;

export function reusablePersonalGitHubAuthority(
  cache: PersonalGitHubAuthorityCache | null,
  expected: Readonly<{
    connectionId: string;
    connectionVersion: number;
  }>,
): McpConnectionAccountSelection | null {
  if (
    !cache ||
    cache.authority.connectionId !== expected.connectionId ||
    cache.connectionVersion !== expected.connectionVersion
  ) {
    return null;
  }
  return cache.authority;
}

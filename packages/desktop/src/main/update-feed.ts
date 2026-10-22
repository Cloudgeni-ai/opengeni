import type { DesktopUpdateFeed } from "./config";

/** The highest stable version tag with the prefix, e.g. desktop-v1.2.3. */
export function newestReleaseTag(tags: readonly string[], prefix: string): string | null {
  let best: { tag: string; version: number[] } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag.slice(prefix.length));
    if (!match) continue;
    const version = match.slice(1).map(Number);
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The directory URL that holds the newest update files, or null if none is published. */
export async function resolveUpdateFeedUrl(
  feed: DesktopUpdateFeed,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if ("url" in feed) return feed.url;
  const response = await fetchImpl(
    `https://api.github.com/repos/${feed.githubRepository}/git/matching-refs/tags/${encodeURIComponent(feed.tagPrefix)}`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`);
  const refs = (await response.json()) as Array<{ ref?: unknown }>;
  const tags = refs.flatMap((entry) =>
    typeof entry.ref === "string" && entry.ref.startsWith("refs/tags/")
      ? [entry.ref.slice("refs/tags/".length)]
      : [],
  );
  const tag = newestReleaseTag(tags, feed.tagPrefix);
  return tag
    ? `https://github.com/${feed.githubRepository}/releases/download/${encodeURIComponent(tag)}`
    : null;
}

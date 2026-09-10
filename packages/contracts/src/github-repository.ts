export type CanonicalGitHubRepository = {
  owner: string;
  name: string;
  fullName: string;
  canonicalUrl: string;
  cloneUrl: string;
};

/**
 * Parse only a canonical public github.com repository URL. This deliberately
 * rejects aliases, credentials, ports, query/fragment state, encoded paths,
 * and repository subpaths so callers cannot accidentally verify one target
 * and attach another.
 */
export function parseCanonicalGitHubRepositoryUrl(value: string): CanonicalGitHubRepository {
  if (!value.startsWith("https://github.com/")) {
    throw new Error("GitHub repository URL must use the exact https://github.com host.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("GitHub repository URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.host !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.includes("%")
  ) {
    throw new TypeError("Use a canonical https://github.com/owner/repository URL.");
  }
  const match = /^\/([^/]+)\/([^/]+?)\/?$/u.exec(url.pathname);
  if (!match) {
    throw new TypeError("GitHub repository URL must contain exactly owner/repository.");
  }
  const owner = match[1]!;
  const name = match[2]!.replace(/\.git$/iu, "");
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new TypeError("GitHub repository owner or name is invalid.");
  }
  const fullName = `${owner}/${name}`;
  return {
    owner,
    name,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
  };
}

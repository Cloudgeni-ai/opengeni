import {
  GitCredentialRepositoryRef as GitCredentialRepositoryRefContract,
  type GitCredentialProvider,
  type GitCredentialRepositoryRef,
  type ObservedGitRepositoryIdentity,
} from "@opengeni/contracts";

/**
 * Validate a token-free repository ref before it crosses the worker/DB boundary.
 * Errors deliberately describe only the violated invariant and never echo the URI.
 */
export function assertCredentialRepositoryRefSecretFree(
  value: GitCredentialRepositoryRef,
): GitCredentialRepositoryRef {
  const ref = GitCredentialRepositoryRefContract.parse(value);
  const scp = /^([^/:@]+)@([^/:]+):(.+)$/.exec(ref.uri);
  if (scp) {
    if (scp[1] !== "git" || !scp[2] || !scp[3] || /[\s?#]/.test(scp[2]) || /[\s?#]/.test(scp[3])) {
      throw new Error("repository credential ref contains unsupported SCP-style components");
    }
    return ref;
  }
  let url: URL;
  try {
    url = new URL(ref.uri);
  } catch {
    throw new Error("repository credential ref is not a supported absolute Git URL");
  }
  if (
    !["https:", "http:", "ssh:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.replace(/^\/+/, "")
  ) {
    throw new Error("repository credential ref is not a supported absolute Git URL");
  }
  if (
    url.password ||
    url.search ||
    url.hash ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git"))
  ) {
    throw new Error("repository credential ref contains credential-bearing URL components");
  }
  return ref;
}

/** Normalize one already-token-free ref to the same identity Channel A emits. */
export function repositoryIdentityForCredentialRef(
  value: GitCredentialRepositoryRef,
): ObservedGitRepositoryIdentity {
  const ref = assertCredentialRepositoryRefSecretFree(value);
  if (!ref.provider) throw new Error("rebound repository ref omitted provider");
  let host = "";
  let path = "";
  const scp = /^([^/:@]+)@([^/:]+):(.+)$/.exec(ref.uri);
  if (scp) {
    if (scp[1] !== "git") throw new Error("rebound repository ref contains unsupported userinfo");
    host = scp[2]!;
    path = scp[3]!;
  } else {
    let url: URL;
    try {
      url = new URL(ref.uri);
    } catch {
      throw new Error("rebound repository ref is not a supported absolute Git URL");
    }
    if (url.password || url.search || url.hash) {
      throw new Error("rebound repository ref contains credential-bearing URL components");
    }
    if (url.username && !(url.protocol === "ssh:" && url.username === "git")) {
      throw new Error("rebound repository ref contains credential-bearing URL components");
    }
    if (!["https:", "http:", "ssh:"].includes(url.protocol)) {
      throw new Error("rebound repository ref uses an unsupported URL protocol");
    }
    host = url.hostname;
    path = url.pathname;
  }
  host = host.toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\.git$/i, "");
  if (!host || !path || !/^[A-Za-z0-9._~%+@/-]+$/.test(path) || path.includes("..")) {
    throw new Error("rebound repository ref has an invalid repository identity");
  }
  let provider: GitCredentialProvider;
  let canonical: string;
  if (host === "github.com") {
    provider = "github";
    canonical = `github.com/${path}`;
  } else if (host.includes("gitlab")) {
    provider = "gitlab";
    canonical = `${host}/${path}`;
  } else if (host === "ssh.dev.azure.com") {
    const match = /^v3\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    if (!match) throw new Error("rebound Azure DevOps SSH ref has an invalid identity");
    provider = "azure_devops";
    canonical = `dev.azure.com/${match[1]}/${match[2]}/_git/${match[3]}`;
  } else if (host === "dev.azure.com") {
    if (!/^[^/]+\/[^/]+\/_git\/.+$/.test(path)) {
      throw new Error("rebound Azure DevOps ref has an invalid identity");
    }
    provider = "azure_devops";
    canonical = `dev.azure.com/${path}`;
  } else if (host.endsWith(".visualstudio.com")) {
    const org = host.slice(0, -".visualstudio.com".length);
    const match = /^([^/]+)\/_git\/(.+)$/.exec(path);
    if (!match) throw new Error("rebound Azure DevOps ref has an invalid identity");
    provider = "azure_devops";
    canonical = `dev.azure.com/${org}/${match[1]}/_git/${match[2]}`;
  } else {
    throw new Error("rebound repository ref uses an unsupported Git host");
  }
  if (provider !== ref.provider) throw new Error("rebound repository provider does not match URI");
  return { provider, canonical };
}

/**
 * Explicit GitHub App metadata is authorization only for github.com. Prove the
 * provider/host identity before minting while preserving custom GitLab hosts.
 */
export function assertExplicitCredentialRepositoryRef(
  value: GitCredentialRepositoryRef,
): GitCredentialRepositoryRef {
  const ref = assertCredentialRepositoryRefSecretFree(value);
  if (ref.provider === "github") {
    const scp = /^([^/:@]+)@([^/:]+):(.+)$/.exec(ref.uri);
    if (!scp) {
      const url = new URL(ref.uri);
      if ((url.protocol !== "https:" && url.protocol !== "ssh:") || url.port) {
        throw new Error("explicit GitHub repository ref uses an unsupported transport");
      }
    }
    repositoryIdentityForCredentialRef(ref);
  }
  return ref;
}

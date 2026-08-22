---
"@opengeni/github": patch
---

Add `createGitHubAppInstallationRepositoryLookup` / `getGitHubAppInstallationRepository`: resolve one `owner/name` repository through an exact App installation with a server-side, metadata-read-only installation token (memoized per installation for the lookup's lifetime, bounded by a 10 s lookup timeout) and return GitHub's stable repository identity, or null when the installation cannot see it. The internal installation-token mint now accepts an optional `permissions` narrowing.

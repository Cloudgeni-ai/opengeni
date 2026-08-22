---
"@opengeni/github": patch
---

Add `createGitHubAppInstallationRepositoryLookup` / `getGitHubAppInstallationRepository`: resolve one `owner/name` repository through an exact App installation with a server-side installation token (memoized per installation for the lookup's lifetime) and return GitHub's stable repository identity, or null when the installation cannot see it.

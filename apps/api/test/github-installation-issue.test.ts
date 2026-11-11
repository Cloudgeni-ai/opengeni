import { expect, test } from "bun:test";
import type { GitHubInstallationAccess } from "@opengeni/db";
import {
  githubInstallationBindingIssue,
  githubInstallationBindingLifecycle,
  type LiveGitHubInstallation,
} from "../src/github-access";

const stored = {
  id: "binding",
  accountId: "account",
  workspaceId: "workspace",
  installationId: 42,
  githubAccountId: 501,
  accountLogin: "owner",
  accountType: "User",
  repositoryScope: "selected",
  linkedBySubjectId: "subject",
  githubActorId: 501,
  githubActorLogin: "owner",
  authorityKind: "personal_owner",
  authorityCheckedAt: new Date("2026-07-28T00:00:00.000Z"),
  authorityExpiresAt: new Date("2026-07-28T00:10:00.000Z"),
  authorityNonce: "proof",
  repositoryIds: [1001],
  createdAt: new Date("2026-07-28T00:00:00.000Z"),
  updatedAt: new Date("2026-07-28T00:00:00.000Z"),
} as unknown as GitHubInstallationAccess;
const unproven = { ...stored, authorityNonce: null } as unknown as GitHubInstallationAccess;
const live = (patch: Partial<LiveGitHubInstallation> = {}) =>
  new Map([[42, { installationId: 42, accountId: 501, suspended: false, ...patch }]]);

test("an installation that is not active is named by its fix", () => {
  expect(githubInstallationBindingIssue(stored, live(), 42, true)).toBeNull();
  expect(githubInstallationBindingIssue(stored, new Map(), 42, true)).toBe("uninstalled");
  expect(githubInstallationBindingIssue(stored, live({ suspended: true }), 42, true)).toBe(
    "suspended",
  );
  expect(githubInstallationBindingIssue(stored, live(), 42, false)).toBe("github_unreachable");
  expect(githubInstallationBindingIssue(unproven, live(), 42, true)).toBe("owner_unconfirmed");
  expect(githubInstallationBindingIssue(stored, live({ accountId: 999 }), 42, true)).toBe(
    "account_changed",
  );
  const empty = { ...stored, repositoryIds: [] };
  expect(githubInstallationBindingIssue(empty, live(), 42, true)).toBe("no_repositories");
  expect(githubInstallationBindingLifecycle(empty, live(), 42, true)).toBe("unverified");
});

test("what GitHub says wins over a missing owner proof", () => {
  // An uninstall clears the repositories and leaves no proof to renew.
  expect(
    githubInstallationBindingIssue({ ...stored, repositoryIds: [] }, new Map(), 42, true),
  ).toBe("uninstalled");
  expect(
    githubInstallationBindingIssue({ ...unproven, repositoryIds: [] }, new Map(), 42, true),
  ).toBe("uninstalled");
  // Unknown on GitHub: the missing proof is what can be fixed.
  expect(githubInstallationBindingIssue(unproven, live(), 42, false)).toBe("owner_unconfirmed");
});

test("a link stored without its GitHub account needs authorizing, not removing", () => {
  const withoutAccount = {
    ...unproven,
    githubAccountId: null,
  } as unknown as GitHubInstallationAccess;
  expect(githubInstallationBindingIssue(withoutAccount, live(), 42, true)).toBe(
    "owner_unconfirmed",
  );
});

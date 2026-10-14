import { expect, test } from "bun:test";
import { connectionAccountIdentityLabel } from "../src/connection-account-label";

test("uses the authenticated email across provider metadata shapes", () => {
  for (const key of ["email", "providerEmail", "googleEmail", "gmailEmail"]) {
    expect(
      connectionAccountIdentityLabel(
        { [key]: "user@example.test", displayName: "User" },
        "Account",
      ),
    ).toBe("user@example.test");
  }
});

test("distinguishes Slack workspaces and truthfully falls back to verified IDs", () => {
  expect(
    connectionAccountIdentityLabel(
      { slackUserName: "member", slackTeamName: "Community" },
      "Slack account",
    ),
  ).toBe("member · Community");
  expect(
    connectionAccountIdentityLabel({ slackUserId: "U_ONE", slackTeamId: "T_ONE" }, "Slack account"),
  ).toBe("U_ONE · T_ONE");
});

test("ignores malformed identities and bounds presentation without mutating metadata", () => {
  const metadata = { email: 123, displayName: "\n", teamName: {}, name: "x".repeat(200) };
  expect(connectionAccountIdentityLabel(metadata, "Account")).toBe("x".repeat(180));
  expect(metadata.name).toHaveLength(200);
  expect(connectionAccountIdentityLabel({ email: [], name: null }, "Account 42")).toBe(
    "Account 42",
  );
  expect(connectionAccountIdentityLabel({ name: "Same", workspaceName: "Same" }, "Account")).toBe(
    "Same",
  );
});

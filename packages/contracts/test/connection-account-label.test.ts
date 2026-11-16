import { expect, test } from "bun:test";
import {
  CONNECTION_LABEL_MAX_LENGTH,
  connectionAccountIdentityLabel,
  connectionAccountLabel,
  distinctConnectionAccountLabels,
  normalizeConnectionLabel,
} from "../src/connection-account-label";

test("uses the authenticated email across provider metadata shapes", () => {
  for (const key of [
    "email",
    "providerEmail",
    "googleEmail",
    "gmailEmail",
    "googleDriveEmail",
    "atlassianEmail",
    "linearEmail",
    "notionEmail",
    "asanaEmail",
    "stripeEmail",
    "oidcEmail",
  ]) {
    expect(
      connectionAccountIdentityLabel(
        { [key]: "user@example.test", displayName: "User" },
        "Account",
      ),
    ).toBe("user@example.test");
  }
});

test("uses real workspace names without displaying provider IDs", () => {
  expect(
    connectionAccountIdentityLabel(
      { slackUserName: "member", slackTeamName: "Community" },
      "Slack account",
    ),
  ).toBe("member · Community");
  expect(
    connectionAccountIdentityLabel(
      { linearEmail: "user@example.test", linearUserId: "u-1", linearWorkspaceName: "Acme" },
      "Linear account",
    ),
  ).toBe("user@example.test · Acme");
  expect(
    connectionAccountIdentityLabel({ oidcName: "User", oidcSubject: "sub-1" }, "Account"),
  ).toBe("User");
  expect(
    connectionAccountIdentityLabel({ slackUserId: "U_ONE", slackTeamId: "T_ONE" }, "Slack account"),
  ).toBe("Slack account");
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

test("a person's name is trimmed, single-line, bounded, and blank means none", () => {
  expect(normalizeConnectionLabel("  Team\n inbox\t ")).toBe("Team inbox");
  expect(normalizeConnectionLabel("   ")).toBeNull();
  expect(normalizeConnectionLabel(null)).toBeNull();
  expect(normalizeConnectionLabel(42)).toBeNull();
  expect(normalizeConnectionLabel("x".repeat(200))).toHaveLength(CONNECTION_LABEL_MAX_LENGTH);
});

test("identity, then the person's name, then the fallback", () => {
  const key = { mcpUrl: "https://mcp.example.test/mcp" };
  expect(connectionAccountLabel({ metadata: key }, "mcp.example.test account")).toBe(
    "mcp.example.test account",
  );
  expect(connectionAccountLabel({ metadata: key, label: " Team inbox " }, "fallback")).toBe(
    "Team inbox",
  );
  expect(connectionAccountLabel({ metadata: key, label: "" }, "fallback")).toBe("fallback");
  expect(
    connectionAccountLabel(
      { metadata: { email: "ops@example.test" }, label: "Someone else" },
      "fallback",
    ),
  ).toBe("ops@example.test");
});

test("accounts that read the same get the date, then the time, then a short ID", () => {
  const connectedOn = (createdAt: string, withTime: boolean) =>
    withTime ? `Connected ${createdAt.slice(0, 16)}` : `Connected ${createdAt.slice(0, 10)}`;
  const labels = distinctConnectionAccountLabels(
    [
      { id: "a1", label: "Key", scope: "Yours", createdAt: "2026-10-25T09:00" },
      { id: "a2", label: "Key", scope: "Yours", createdAt: "2026-10-26T09:00" },
      { id: "a3", label: "Key", scope: "Shared", createdAt: "2026-10-25T09:00" },
      { id: "a4", label: "Other", scope: "Yours", createdAt: "2026-10-25T09:00" },
    ],
    connectedOn,
  );
  expect([...labels.values()]).toEqual([
    "Key · Connected 2026-10-25",
    "Key · Connected 2026-10-26",
    "Key",
    "Other",
  ]);
  const sameDay = distinctConnectionAccountLabels(
    [
      { id: "b1", label: "Key", scope: "Yours", createdAt: "2026-10-25T09:00" },
      { id: "b2", label: "Key", scope: "Yours", createdAt: "2026-10-25T14:05" },
      { id: "b3", label: "Key", scope: "Yours", createdAt: "2026-10-26T09:00" },
    ],
    connectedOn,
  );
  expect([...sameDay.values()]).toEqual([
    "Key · Connected 2026-10-25T09:00",
    "Key · Connected 2026-10-25T14:05",
    "Key · Connected 2026-10-26",
  ]);
  const sameMinute = distinctConnectionAccountLabels(
    [
      { id: "0f3e-91aa-b", label: "Key", scope: "Yours", createdAt: "2026-10-25T09:00" },
      { id: "77c2-0d1e-c", label: "Key", scope: "Yours", createdAt: "2026-10-25T09:00" },
    ],
    connectedOn,
  );
  expect([...sameMinute.values()]).toEqual([
    "Key · Connected 2026-10-25T09:00 · 0f3e91",
    "Key · Connected 2026-10-25T09:00 · 77c20d",
  ]);
});

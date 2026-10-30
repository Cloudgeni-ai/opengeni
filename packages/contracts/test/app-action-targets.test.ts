import { expect, test } from "bun:test";
import {
  appActionConfirmationTitle,
  appActionTargetFacts,
  appActionTargetParameter,
  findAppAction,
  type AppActionTargets,
} from "../src/app-actions";
import { toolReviewDetails, toolReviewFields } from "../src/tool-review-presentation";

const here = { workspaceId: "ws-1", sessionId: "chat-1" };
const gmailId = "e6b94031-0000-4000-8000-000000000001";
const removeGmail = {
  id: "deleteConnection",
  pathParameters: { workspaceId: "ws-1", connectionId: gmailId },
  body: { expectedVersion: 2 },
};
const gmail: AppActionTargets = {
  workspaceId: { kind: "workspace", name: "cloudgeni" },
  connectionId: {
    kind: "connection",
    name: "Gmail",
    account: "bendik@cloudgeni.ai",
    facts: [
      { label: "Who can use it", value: "Only you" },
      { label: "Added", value: "14 Oct 2026, 07:41 UTC" },
    ],
  },
};

test("a connection removal names the integration and account the server found", () => {
  // Before, every removal read the same: "Delete connection in this workspace?"
  expect(appActionConfirmationTitle(removeGmail, here, gmail)).toBe(
    "Remove the Gmail connection for bendik@cloudgeni.ai?",
  );
  expect(appActionTargetFacts(removeGmail, here, gmail)).toEqual([
    { label: "Who can use it", value: "Only you" },
    { label: "Added", value: "14 Oct 2026, 07:41 UTC" },
  ]);
  // Without a lookup the old, plain wording stays.
  expect(appActionConfirmationTitle(removeGmail, here)).toBe(
    "Delete connection in this workspace?",
  );
  expect(appActionTargetFacts(removeGmail, here, undefined)).toEqual([]);
});

test("the call's own text can never write the question or its facts", () => {
  const spoofed = {
    ...removeGmail,
    title: "Remove the unused test connection?",
    name: "test connection",
    pathParameters: {
      ...removeGmail.pathParameters,
      name: "Unused test",
      account: "nobody@example.com",
    },
    body: { expectedVersion: 2, name: "Unused test”? Yes", account: "nobody@example.com" },
  };
  const title = appActionConfirmationTitle(spoofed, here, gmail);
  expect(title).toBe("Remove the Gmail connection for bendik@cloudgeni.ai?");
  const facts = JSON.stringify(appActionTargetFacts(spoofed, here, gmail));
  expect(facts).not.toContain("Unused");
  expect(facts).not.toContain("nobody@");
  // A target for an id the route doesn't take is ignored.
  expect(
    appActionConfirmationTitle(removeGmail, here, {
      ...gmail,
      connectionId: undefined as never,
      name: { kind: "connection", name: "Fake" },
    }),
  ).toBe("Delete connection in this workspace?");
  // Stored names are one bounded line, and can't close the quote early.
  const longName = `Plan “A”\n${"x".repeat(200)}`;
  const site = appActionConfirmationTitle(
    {
      id: "duplicateWorkspaceArtifact",
      pathParameters: { workspaceId: "ws-1", artifactId: "a-1" },
    },
    here,
    { artifactId: { kind: "Site", name: longName } },
  );
  expect(site).not.toContain("\n");
  expect(site).toContain('“Plan "A" xxx');
  expect(site.length).toBeLessThan(140);
});

test("a target that isn't there says so plainly instead of naming anything", () => {
  const missing = { ...gmail, connectionId: { kind: "connection" } };
  expect(appActionConfirmationTitle(removeGmail, here, missing)).toBe(
    "Delete connection in this workspace?",
  );
  expect(appActionTargetFacts(removeGmail, here, missing)).toEqual([
    { label: "Connection", value: "Not found. It may have been removed already." },
  ]);
});

test("other kinds name their target, and another workspace is named too", () => {
  const task = {
    id: "deleteScheduledTask",
    pathParameters: { workspaceId: "ws-1", taskId: "t-1" },
  };
  expect(
    appActionConfirmationTitle(task, here, {
      taskId: { kind: "scheduled task", name: "Weekly metrics digest" },
    }),
  ).toBe("Delete scheduled task “Weekly metrics digest”?");
  const key = {
    id: "deleteApiKey",
    pathParameters: { workspaceId: "ws-2", apiKeyId: "k-1" },
  };
  const keyTargets: AppActionTargets = {
    workspaceId: { kind: "workspace", name: "Marketing" },
    apiKeyId: {
      kind: "API key",
      name: "Zapier export",
      facts: [{ label: "Starts with", value: "og_live_7Kp…" }],
    },
  };
  expect(appActionConfirmationTitle(key, here, keyTargets)).toBe(
    "Delete API key “Zapier export” in workspace “Marketing”?",
  );
  // The workspace is in the question, so it isn't repeated below it.
  expect(appActionTargetFacts(key, here, keyTargets)).toEqual([
    { label: "Starts with", value: "og_live_7Kp…" },
  ]);
  // Acting on a workspace or chat itself names it.
  expect(
    appActionConfirmationTitle(
      { id: "deleteWorkspace", pathParameters: { workspaceId: "ws-2" } },
      here,
      { workspaceId: { kind: "workspace", name: "Marketing" } },
    ),
  ).toBe("Delete workspace “Marketing”?");
  expect(
    appActionConfirmationTitle(
      { id: "deleteSession", pathParameters: { workspaceId: "ws-1", sessionId: "chat-1" } },
      here,
      { sessionId: { kind: "chat", name: "Q3 plan" } },
    ),
  ).toBe("Delete this chat?");
  expect(
    appActionConfirmationTitle(
      { id: "deleteSession", pathParameters: { workspaceId: "ws-1", sessionId: "chat-9" } },
      here,
      { sessionId: { kind: "chat", name: "Q3 plan" } },
    ),
  ).toBe("Delete chat “Q3 plan”?");
  // Acronyms keep their capitals.
  expect(
    appActionConfirmationTitle(
      { id: "deleteApiKey", pathParameters: { workspaceId: "ws-1", apiKeyId: "k" } },
      here,
    ),
  ).toBe("Delete API key in this workspace?");
});

test("an app action's target is the last id in its route", () => {
  expect(appActionTargetParameter(findAppAction("deleteConnection")!)).toBe("connectionId");
  expect(appActionTargetParameter(findAppAction("deleteWorkspace")!)).toBe("workspaceId");
  expect(appActionTargetParameter(findAppAction("removeWorkspaceMember")!)).toBe("subjectId");
});

test("the card lists the server's facts, and Details reads as plain labelled values", () => {
  const context = {
    kind: "generic" as const,
    title: "Remove the Gmail connection for bendik@cloudgeni.ai?",
    targetFacts: appActionTargetFacts(removeGmail, here, gmail),
  };
  const { fields } = toolReviewFields(removeGmail, context, "admin_action_call");
  expect(fields.map((field) => [field.label, field.preview])).toEqual([
    ["Who can use it", "Only you"],
    ["Added", "14 Oct 2026, 07:41 UTC"],
  ]);
  const details = toolReviewDetails(removeGmail, context, "", 0, 25, "admin_action_call");
  expect(details.items.map((item) => [item.label, item.value])).toEqual([
    ["Action", "Delete connection"],
    ["Who can use it", "Only you"],
    ["Added", "14 Oct 2026, 07:41 UTC"],
    // What the agent sent is set apart, so it never passes for a server fact.
    ["Sent by the agent", "The values below, as written"],
    ["Workspace ID", "ws-1"],
    ["Connection ID", gmailId],
    ["Expected version", "2"],
  ]);
});

test("an action the catalog names by its route reads in words, not as a request line", () => {
  const site = { kind: "Site", name: "Layoff plan Q4" };
  const unpublish = {
    id: "DELETE /v1/workspaces/:workspaceId/published-artifacts/:artifactId/publication",
    pathParameters: { workspaceId: "ws-1", artifactId: "a-1" },
  };
  expect(appActionConfirmationTitle(unpublish, here, { artifactId: site })).toBe(
    "Delete the publication of Site “Layoff plan Q4”?",
  );
  const restore = {
    id: "POST /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/restore",
    pathParameters: { workspaceId: "ws-1", vaultId: "v-1", itemId: "i-1" },
  };
  expect(
    appActionConfirmationTitle(restore, here, {
      itemId: { kind: "vault item", name: "Stripe key" },
    }),
  ).toBe("Restore vault item “Stripe key”?");
});

test("a name counts as said only as a whole name", () => {
  const removeA = {
    ...removeGmail,
    pathParameters: { workspaceId: "ws-1", connectionId: gmailId },
  };
  const targets: AppActionTargets = {
    connectionId: { kind: "connection", name: "Gmail", account: "a" },
  };
  // "a" appears inside "Gmail" and "connection", but the account is said whole.
  expect(appActionConfirmationTitle(removeA, here, targets)).toBe(
    "Remove the Gmail connection for a?",
  );
  expect(appActionTargetFacts(removeA, here, targets)).toEqual([]);
  const unnamed: AppActionTargets = {
    connectionId: { kind: "connection", name: "Gmail", account: "mail" },
  };
  expect(appActionConfirmationTitle(removeA, here, unnamed)).toBe(
    "Remove the Gmail connection for mail?",
  );
});

import { expect, test } from "bun:test";
import {
  compileOpenApiRevision,
  createOpenApiMcpServer,
  displayTitleMeta,
  integrationOperationDisplayTitle,
} from "../src/index";

const graph = { serverUrl: "https://graph.microsoft.com/v1.0" };

test("everyday Microsoft 365 operations read as plain actions", () => {
  const cases: Record<string, string> = {
    "me.mailFolders.CreateMessages": "Save a draft email",
    "me.mailFolders.childFolders.CreateMessages": "Save a draft email",
    "me.mailFolders.childFolders.ListMessages": "Read emails",
    "me.CreateMessages": "Save a draft email",
    "me.sendMail": "Send an email",
    "me.messages.message.send": "Send a draft email",
    "me.messages.message.reply": "Reply to an email",
    "me.messages.delta": "Read changes to emails",
    "me.ListMessages": "Read emails",
    "me.calendar.CreateEvents": "Create a calendar event",
    "me.events.event.decline": "Decline an invitation",
    "me.events.event.permanentDelete": "Permanently delete a calendar event",
    "me.calendar.permanentDelete": "Permanently delete a calendar",
    "me.mailFolders.mailFolder.permanentDelete": "Permanently delete a mail folder",
    "me.contacts.contact.permanentDelete": "Permanently delete a contact",
    "me.CreateContacts": "Add a contact",
    "drives.drive.items.driveItem.createLink": "Create a sharing link",
    "drives.drive.items.driveItem.permanentDelete": "Permanently delete a file or folder",
    "drives.DeleteItems": "Delete a file or folder",
    "drives.UpdateItems": "Update a file or folder",
    "chats.CreateMessages": "Send a chat message",
    "chats.ListMessages": "Read chat messages",
    "me.chats.ListMessages": "Read messages",
    "drives.drive.items.driveItem.delta-fa14": "Read changes to files",
    "me.messages.delta-1a2b": "Read changes to emails",
    "me.mailFolders.CreateChildFolders": "Create child folder",
  };
  for (const [key, title] of Object.entries(cases))
    expect(integrationOperationDisplayTitle(key, graph)).toBe(title);
  // National clouds are Graph too.
  expect(
    integrationOperationDisplayTitle("me.sendMail", { serverUrl: "https://graph.microsoft.us" }),
  ).toBe("Send an email");
  // Actions on another user's mailbox name that user first.
  expect(integrationOperationDisplayTitle("users.user.sendMail", graph)).toBe("Send an email");
});

test("Microsoft 365 phrasing stays on Microsoft Graph", () => {
  const stripe = { serverUrl: "https://api.stripe.com", method: "get" };
  expect(integrationOperationDisplayTitle("GetEvents", stripe)).toBe("Read events");
  expect(integrationOperationDisplayTitle("getSchedule", { method: "post" })).toBe("Read schedule");
  expect(integrationOperationDisplayTitle("me.sendMail")).toBe("Send mail");
});

test("ids named after their method and path read like that route", () => {
  const cases: Record<string, readonly [string, string]> = {
    PostCharges: ["post", "Create charge"],
    PostChargesCharge: ["post", "Update charge"],
    GetChargesCharge: ["get", "Read charge"],
    GetCharges: ["get", "Read charges"],
    DeleteCustomersCustomer: ["delete", "Delete customer"],
    PostChargesChargeCapture: ["post", "Capture charge"],
    PostRefundsRefundCancel: ["post", "Cancel refund"],
    PostCheckoutSessionsSessionExpire: ["post", "Expire checkout session"],
    PostCustomersCustomerBalanceTransactions: ["post", "Create balance transaction"],
    GetCustomersCustomerSourcesId: ["get", "Read source"],
    GetBalanceHistory: ["get", "Read balance history"],
  };
  for (const [key, [method, title]] of Object.entries(cases))
    expect(integrationOperationDisplayTitle(key, { method })).toBe(title);
  // Without a matching method, or with a lookup phrase, ids read as before.
  expect(integrationOperationDisplayTitle("PostCharges")).toBe("Post charges");
  expect(integrationOperationDisplayTitle("GetPetById", { method: "get" })).toBe("Read pet by id");
});

test("other operation ids read as their verb and object", () => {
  const cases: Record<string, string> = {
    "me.ListMailFolders": "Read mail folders",
    "me.GetMailboxSettings": "Read mailbox settings",
    "me.calendar.events.event.dismissReminder": "Dismiss reminder",
    "me.contacts.GetCount-9c39": "Count contacts",
    "me.mailFolders.mailFolder.permanentDelete": "Permanently delete mail folder",
    "me.messages.delta": "Read changes to messages",
    "drive.files.list": "Read files",
    "drive.files.get": "Read file",
    "issues/list-for-repo": "Read issues for repo",
    "reports.getLastSevenDays": "Read last seven days",
    listPets: "Read pets",
    createPet: "Create pet",
    "get_/pets/{id}": "Read pet",
    "get_/pets": "Read pets",
    "post_/pets": "Create pet",
    "query:issues": "Read issues",
    "mutation:createIssue": "Create issue",
  };
  for (const [key, title] of Object.entries(cases))
    expect(integrationOperationDisplayTitle(key)).toBe(title);
  // A person approving a destructive action sees its real scope.
  const scope: Record<string, string> = {
    "actions/delete-workflow-run-logs": "Delete workflow run logs",
    "issues/remove-assignees": "Remove assignees",
    "issues/remove-all-labels": "Remove all labels",
    "pulls/remove-requested-reviewers": "Remove requested reviewers",
    "delete_/users": "Delete users",
    "delete_/users/{id}": "Delete user",
    "post_/repos/{owner}/{repo}/archive": "Archive repo",
    "post_/accounts/{id}/close": "Close account",
    "post_/users/{id}/delete": "Delete user",
    "post_/users/{id}/reset-password": "Reset password for user",
    "post_/orders/{id}/cancel-all": "Cancel all for order",
    "post_/projects/{id}/merge-requests": "Create merge request",
    "post_/repos/{owner}/{repo}/forks": "Create fork",
    "gmail.users.messages.batchDelete": "Delete multiple messages",
    "gmail.users.messages.batchModify": "Update multiple messages",
    "gmail.users.settings.sendAs.delete": "Delete send as",
    "gmail.users.settings.sendAs.smimeInfo.setDefault": "Set default smime info",
  };
  for (const [key, title] of Object.entries(scope))
    expect(integrationOperationDisplayTitle(key)).toBe(title);
  // A read named by what it returns says that it reads.
  expect(integrationOperationDisplayTitle("me.outlook.supportedTimeZones", { method: "get" })).toBe(
    "Read supported time zones",
  );
  expect(integrationOperationDisplayTitle("")).toBeUndefined();
  expect(displayTitleMeta("")).toEqual({});
});

test("OpenAPI tools carry the display title in _meta, never in what the model reads", async () => {
  const revision = await compileOpenApiRevision(
    {
      openapi: "3.0.0",
      info: { title: "Mail", version: "1" },
      servers: [{ url: "https://graph.microsoft.com/v1.0" }],
      paths: {
        "/me/mailFolders/{mailFolder-id}/messages": {
          post: {
            operationId: "me.mailFolders.CreateMessages",
            summary: "Create open extension",
            parameters: [
              { name: "mailFolder-id", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: { "201": { description: "Created" } },
          },
        },
      },
    },
    { definitionId: "mail" },
  );
  const [tool] = await createOpenApiMcpServer({
    revision,
    transport: async () => {
      throw new Error("not called");
    },
    authority: {} as never,
  }).listTools();
  const listed = tool as unknown as Record<string, unknown>;
  expect(listed._meta).toMatchObject({ "opengeni/displayTitle": "Save a draft email" });
  expect(listed).not.toHaveProperty("title");
  expect(JSON.stringify({ ...listed, _meta: undefined })).not.toContain("Save a draft email");
});

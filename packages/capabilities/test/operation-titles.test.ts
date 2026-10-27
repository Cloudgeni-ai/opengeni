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
  };
  for (const [key, title] of Object.entries(cases))
    expect(integrationOperationDisplayTitle(key, graph)).toBe(title);
  // National clouds are Graph too.
  expect(
    integrationOperationDisplayTitle("me.sendMail", { serverUrl: "https://graph.microsoft.us" }),
  ).toBe("Send an email");
});

test("Microsoft 365 phrasing stays on Microsoft Graph", () => {
  const stripe = { serverUrl: "https://api.stripe.com", method: "get" };
  expect(integrationOperationDisplayTitle("GetEvents", stripe)).toBe("Read event");
  expect(integrationOperationDisplayTitle("getSchedule", { method: "post" })).toBe("Read schedule");
  expect(integrationOperationDisplayTitle("me.sendMail")).toBe("Send mail");
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

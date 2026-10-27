import { expect, test } from "bun:test";
import {
  compileOpenApiRevision,
  createOpenApiMcpServer,
  displayTitleMeta,
  integrationOperationDisplayTitle,
} from "../src/index";

test("everyday Microsoft 365 operations read as plain actions", () => {
  const cases: Record<string, string> = {
    "me.mailFolders.CreateMessages": "Save a draft email",
    "me.CreateMessages": "Save a draft email",
    "me.sendMail": "Send an email",
    "me.messages.message.send": "Send a draft email",
    "me.messages.message.reply": "Reply to an email",
    "me.ListMessages": "Read emails",
    "me.calendar.CreateEvents": "Create a calendar event",
    "me.events.event.decline": "Decline an invitation",
    "me.CreateContacts": "Add a contact",
    "drives.drive.items.driveItem.createLink": "Create a sharing link",
    "chats.CreateMessages": "Send a chat message",
    "chats.ListMessages": "Read chat messages",
    "me.chats.ListMessages": "Read messages",
  };
  for (const [key, title] of Object.entries(cases))
    expect(integrationOperationDisplayTitle(key)).toBe(title);
});

test("other operation ids read as their verb and object", () => {
  const cases: Record<string, string> = {
    "me.ListMailFolders": "Read mail folders",
    "me.GetMailboxSettings": "Read mailbox settings",
    "me.calendar.events.event.dismissReminder": "Dismiss reminder",
    "me.contacts.GetCount-9c39": "Count contacts",
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
  expect(integrationOperationDisplayTitle("")).toBeUndefined();
  expect(displayTitleMeta("")).toEqual({});
});

test("OpenAPI tools carry the display title in _meta, never in what the model reads", async () => {
  const revision = await compileOpenApiRevision(
    {
      openapi: "3.0.0",
      info: { title: "Mail", version: "1" },
      servers: [{ url: "https://mail.example.test" }],
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

import type { MCPServer } from "@openai/agents";

type Tool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
const string = { type: "string" };
const strings = { type: "array", items: string, maxItems: 100 };
const page = {
  pageSize: { type: "integer", minimum: 1, maximum: 50 },
  pageToken: string,
};
const file = {
  type: "object",
  additionalProperties: false,
  required: ["path", "sha256"],
  properties: { path: string, sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } },
};
export const GMAIL_COMPOSE_PROPERTIES = {
  from: { ...string, description: "Primary account or verified send-as address." },
  replyTo: string,
  raw: {
    ...string,
    description: "Complete RFC 5322 message encoded as base64url. Alternative to composing fields.",
  },
  rawFile: {
    ...file,
    description: "Workspace .eml file with its exact SHA-256; alternative to composing fields.",
  },
};
export const GMAIL_ATTACHMENT_SOURCE_PROPERTIES = {
  file,
  contentId: {
    ...string,
    description: "Content-ID for an inline attachment; use cid: references in HTML.",
  },
};
const label = {
  name: string,
  messageListVisibility: { type: "string", enum: ["show", "hide"] },
  labelListVisibility: { type: "string", enum: ["labelShow", "labelShowIfUnread", "labelHide"] },
  color: {
    type: "object",
    additionalProperties: false,
    properties: { textColor: string, backgroundColor: string },
  },
};
const labels = { addLabelIds: strings, removeLabelIds: strings };
const view = { type: "string", enum: ["MINIMAL", "METADATA_ONLY", "FULL_CONTENT"] };
const settingsResources = [
  "autoForwarding",
  "imap",
  "language",
  "pop",
  "vacation",
  "sendAs",
  "filters",
  "forwardingAddresses",
  "smimeInfo",
  "cseIdentities",
  "cseKeypairs",
];
const settingsListResources = [
  "sendAs",
  "filters",
  "forwardingAddresses",
  "smimeInfo",
  "cseIdentities",
  "cseKeypairs",
];
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
  };
}

export const GMAIL_EXTRA_TOOLS: Tool[] = [
  tool(
    "get_profile",
    "Reads the selected Gmail account, mailbox counts and current history cursor.",
    {},
  ),
  tool(
    "search_messages",
    "Searches individual messages using Gmail query syntax. Only matching messages are returned, with pagination.",
    {
      ...page,
      query: string,
      labelIds: strings,
      includeSpamTrash: { type: "boolean" },
      messageFormat: view,
    },
  ),
  tool(
    "get_draft",
    "Reads an existing draft; returns both its draft ID and current message ID.",
    { draftId: string, messageFormat: view },
    ["draftId"],
  ),
  tool(
    "update_draft",
    "Replaces the content of an existing saved draft, keeping its draft ID. Supply complete replacement content using the same fields as create_draft.",
    { draftId: string, expectedContentSha256: string },
    ["draftId"],
  ),
  tool(
    "delete_draft",
    "Permanently deletes one unsent draft. This does not delete received or sent mail.",
    { draftId: string },
    ["draftId"],
  ),
  tool(
    "get_label",
    "Reads label details, visibility and message/thread counts. System labels are readable.",
    { labelId: string },
    ["labelId"],
  ),
  tool(
    "create_label",
    "Creates a user label, optionally with color and visibility settings.",
    label,
    ["name"],
  ),
  tool(
    "update_label",
    "Renames or changes a user label. PATCH preserves omitted fields; replace=true uses the Gmail replacement operation.",
    { labelId: string, ...label, replace: { type: "boolean" } },
    ["labelId"],
  ),
  tool(
    "delete_label",
    "Deletes a user label definition and removes it from messages. Messages themselves remain.",
    { labelId: string },
    ["labelId"],
  ),
  tool(
    "modify_message",
    "Atomically adds and removes labels on one message. INBOX, UNREAD, STARRED and IMPORTANT support inbox organization; SPAM supports spam placement/removal. Use trash_message for Trash.",
    { messageId: string, ...labels },
    ["messageId"],
  ),
  tool(
    "modify_thread",
    "Atomically adds and removes labels on a conversation. Use trash_thread for Trash.",
    { threadId: string, ...labels },
    ["threadId"],
  ),
  tool(
    "batch_modify_messages",
    "Adds/removes labels for up to 1000 exact message IDs in one Gmail request.",
    { messageIds: { ...strings, minItems: 1, maxItems: 1000 }, ...labels },
    ["messageIds"],
  ),
  ...(["message", "thread"] as const).flatMap((kind) => [
    tool(
      `trash_${kind}`,
      `Moves one ${kind} to Trash. It is recoverable until Gmail removes it.`,
      { [`${kind}Id`]: string },
      [`${kind}Id`],
    ),
    tool(`restore_${kind}`, `Restores one ${kind} from Trash.`, { [`${kind}Id`]: string }, [
      `${kind}Id`,
    ]),
  ]),
  tool(
    "download_attachment",
    "Downloads the exact original bytes of a MIME part to the agent filesystem. Select partId from get_message, or attachmentId. Supports inline data, embedded images and body parts. Returns a verified file receipt, never a signed URL.",
    { messageId: string, partId: string, attachmentId: string },
    ["messageId"],
  ),
  tool(
    "download_message",
    "Downloads the complete original RFC 5322 email as an .eml file, preserving headers, MIME and attachments.",
    { messageId: string },
    ["messageId"],
  ),
  tool(
    "get_history",
    "Reads mailbox changes since startHistoryId. Follow every nextPageToken before saving the returned historyId. A resyncRequired result means the cursor expired: perform a full mailbox search then obtain a fresh profile cursor.",
    {
      ...page,
      startHistoryId: string,
      labelId: string,
      historyTypes: {
        type: "array",
        items: {
          type: "string",
          enum: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        },
      },
    },
    ["startHistoryId"],
  ),
  tool(
    "watch_mailbox",
    "Starts/renews Gmail notifications to the deployment-configured Pub/Sub topic. No topic can be supplied by the agent. Renew before expiration; consume history and retain polling reconciliation. Requires operator Pub/Sub setup.",
    { labelIds: strings, labelFilterBehavior: { type: "string", enum: ["include", "exclude"] } },
  ),
  tool(
    "stop_watch",
    "Stops Gmail push notifications for the selected mailbox. This affects its existing Gmail watch.",
    {},
  ),
  tool(
    "get_settings",
    "Reads one Gmail setting or configuration item. Encryption metadata requires an eligible Workspace account. No settings writes or additional scopes are used.",
    { resource: { type: "string", enum: settingsResources }, id: string, sendAsEmail: string },
    ["resource"],
  ),
  tool(
    "list_settings",
    "Lists aliases, filters, forwarding addresses or eligible Workspace encryption metadata. Follow pagination when returned.",
    { resource: { type: "string", enum: settingsListResources }, ...page, sendAsEmail: string },
    ["resource"],
  ),
  ...(["import", "insert"] as const).map((mode) =>
    tool(
      `${mode}_message`,
      mode === "import"
        ? "Imports an RFC 5322 email into this mailbox, using normal Gmail scanning/classification. Does not send email."
        : "Inserts an RFC 5322 email into this mailbox, bypassing most scanning/classification. Does not send email.",
      {
        raw: string,
        rawFile: file,
        labelIds: strings,
        internalDateSource: { type: "string", enum: ["receivedTime", "dateHeader"] },
        ...(mode === "import"
          ? {
              neverMarkSpam: { type: "boolean" },
              processForCalendar: {
                type: "boolean",
                description: "Defaults false, preventing imported invites from changing Calendar.",
              },
            }
          : {}),
      },
    ),
  ),
];

export const GMAIL_EXTRA_MUTATIONS = new Set([
  "update_draft",
  "delete_draft",
  "create_label",
  "update_label",
  "delete_label",
  "modify_message",
  "modify_thread",
  "batch_modify_messages",
  "trash_message",
  "restore_message",
  "trash_thread",
  "restore_thread",
  "watch_mailbox",
  "stop_watch",
  "import_message",
  "insert_message",
]);
const composeTools = new Set([
  "create_draft",
  "send_message",
  "send_draft",
  "update_draft",
  "delete_draft",
]);
const draftReads = new Set(["get_draft", "list_drafts"]);
export function gmailToolSupportsScopes(name: string, scopes: readonly string[]): boolean {
  const has = (suffix: string) =>
    scopes.includes(`https://www.googleapis.com/auth/gmail.${suffix}`);
  if (has("modify") || scopes.includes("https://mail.google.com/")) return true;
  if (composeTools.has(name)) return has("compose");
  if (draftReads.has(name)) return has("readonly") || has("compose");
  if (GMAIL_EXTRA_MUTATIONS.has(name) || /^(?:label|unlabel)_/u.test(name)) {
    return ["watch_mailbox", "stop_watch"].includes(name) && has("readonly");
  }
  return has("readonly");
}

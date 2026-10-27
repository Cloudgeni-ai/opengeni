/**
 * Plain display titles for API integration operations, such as "Save a draft
 * email" for Microsoft Graph's `me.mailFolders.CreateMessages`.
 *
 * Presentation only. People read these on approval cards and activity rows.
 * They travel in tool `_meta`, never in a tool's name, title or description,
 * so nothing an agent sees changes. Provider summaries are not used because
 * they are often wrong for a person: Graph summarizes `me.CreateMessages` as
 * "Create open extension".
 */

/** Reviewed phrasing for everyday Microsoft 365 actions, matched on the operation id's tail. */
const REVIEWED_OPERATION_TITLES: readonly (readonly [RegExp, string])[] = [
  // Outlook mail. Creating a message in Graph saves a draft; nothing is sent.
  [/^(me|users)\.(mailFolders\.)?CreateMessages$/, "Save a draft email"],
  [/^(me|users)\.sendMail$/, "Send an email"],
  [/\.messages\.message\.send$/, "Send a draft email"],
  [/\.messages\.message\.reply$/, "Reply to an email"],
  [/\.messages\.message\.replyAll$/, "Reply all to an email"],
  [/\.messages\.message\.forward$/, "Forward an email"],
  [/\.messages\.message\.createReply$/, "Save a draft reply"],
  [/\.messages\.message\.createReplyAll$/, "Save a draft reply to all"],
  [/\.messages\.message\.createForward$/, "Save a draft forward"],
  [/\.messages\.message\.move$/, "Move an email"],
  [/\.messages\.message\.copy$/, "Copy an email"],
  [/\.messages\.message\.permanentDelete$/, "Permanently delete an email"],
  [/^(me|users)\.(mailFolders\.)?ListMessages$/, "Read emails"],
  [/^(me|users)\.(mailFolders\.)?GetMessages$/, "Read an email"],
  [/^(me|users)\.(mailFolders\.)?GetMessagesContent$/, "Download an email"],
  [/^(me|users)\.(mailFolders\.)?UpdateMessages$/, "Update an email"],
  [/^(me|users)\.(mailFolders\.)?DeleteMessages$/, "Delete an email"],
  [/^(me|users)\.ListMailFolders$/, "Read mail folders"],
  // Outlook calendar, under /me/events, /me/calendar and /me/calendars.
  [/(^|\.)CreateEvents$/, "Create a calendar event"],
  [/(^|\.)UpdateEvents$/, "Update a calendar event"],
  [/(^|\.)DeleteEvents$/, "Delete a calendar event"],
  [/(^|\.)GetEvents$/, "Read a calendar event"],
  [/(^|\.)(ListEvents|ListCalendarView)$/, "Read calendar events"],
  [/\.event\.accept$/, "Accept an invitation"],
  [/\.event\.tentativelyAccept$/, "Tentatively accept an invitation"],
  [/\.event\.decline$/, "Decline an invitation"],
  [/\.event\.cancel$/, "Cancel a meeting"],
  [/\.event\.forward$/, "Forward an invitation"],
  [/(^|\.)findMeetingTimes$/, "Find meeting times"],
  [/(^|\.)getSchedule$/, "Check availability"],
  // Outlook contacts.
  [/(^|\.)CreateContacts$/, "Add a contact"],
  [/(^|\.)UpdateContacts$/, "Update a contact"],
  [/(^|\.)DeleteContacts$/, "Delete a contact"],
  [/(^|\.)GetContacts$/, "Read a contact"],
  [/(^|\.)ListContacts$/, "Read contacts"],
  [/(^|\.)ListPeople$/, "Find people"],
  // OneDrive and SharePoint files.
  [/^drives\.CreateItems$/, "Create a file or folder"],
  [/^drives\.UpdateItems$/, "Update a file"],
  [/^drives\.DeleteItems$/, "Delete a file"],
  [/^drives\.GetItems$/, "Read file details"],
  [/^drives\.GetItemsContent$/, "Download a file"],
  [/^drives\.DeleteItemsContent$/, "Delete a file's content"],
  [/^drives\.items\.CreateChildren$/, "Create a file or folder"],
  [/^drives\.items\.ListChildren$/, "Read folder contents"],
  [/\.driveItem\.copy$/, "Copy a file"],
  [/\.driveItem\.createLink$/, "Create a sharing link"],
  [/\.driveItem\.invite$/, "Share a file"],
  [/\.driveItem\.restore$/, "Restore a file"],
  [/\.driveItem\.checkin$/, "Check in a file"],
  [/\.driveItem\.checkout$/, "Check out a file"],
  [/\.(drive|driveItem)\.search$/, "Search files"],
  // Teams.
  [/^chats\.CreateMessages$/, "Send a chat message"],
  [/^chats\.ListMessages$/, "Read chat messages"],
  [/^teams\.channels\.CreateMessages$/, "Post a channel message"],
  [/^teams\.channels\.ListMessages$/, "Read channel messages"],
  [/^teams\.channels\.messages\.CreateReplies$/, "Reply in a channel thread"],
  [/^teams\.channels\.messages\.ListReplies$/, "Read thread replies"],
];

const CRUD_VERBS: Readonly<Record<string, readonly [string, "one" | "many"]>> = {
  list: ["Read", "many"],
  get: ["Read", "one"],
  create: ["Create", "one"],
  add: ["Add", "one"],
  update: ["Update", "one"],
  patch: ["Update", "one"],
  set: ["Set", "one"],
  delete: ["Delete", "one"],
  remove: ["Remove", "one"],
};

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-./:]+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
}

// Words whose trailing "s" is not a plural, or that name one thing anyway.
const NOT_PLURAL = /(ss|us|is|settings|analytics|details|news|series)$/;

function singular(word: string): string {
  if (NOT_PLURAL.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function sentence(parts: readonly string[]): string {
  const text = parts.join(" ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Tool `_meta` key for the display title. Hosts read it; models never see `_meta`. */
export const DISPLAY_TITLE_META_KEY = "opengeni/displayTitle";

/** The `_meta` entry carrying an operation's display title, when one can be derived. */
export function displayTitleMeta(operationKey: string): Record<string, string> {
  const title = integrationOperationDisplayTitle(operationKey);
  return title ? { [DISPLAY_TITLE_META_KEY]: title } : {};
}

/**
 * A short, plain title for one API operation. Reviewed phrasing wins; any
 * other operation id reads as its verb and object ("me.ListMailFolders" →
 * "Read mail folders", "listPets" → "Read pets", "createPet" → "Create pet").
 * Returns undefined when nothing readable can be derived.
 */
export function integrationOperationDisplayTitle(operationKey: string): string | undefined {
  const key = operationKey.trim();
  if (!key || key.length > 512) return undefined;
  for (const [pattern, title] of REVIEWED_OPERATION_TITLES) if (pattern.test(key)) return title;
  // An operation without an id is keyed by its method and path: "get_/pets/{id}".
  const route = /^(get|head|post|put|patch|delete)_(\/.*)$/.exec(key);
  if (route) {
    const path = route[2]!.split("/").filter(Boolean);
    const resource = path.filter((segment) => !segment.startsWith("{"));
    const noun = resource.length > 0 ? words(resource.at(-1)!) : [];
    if (noun.length === 0) return undefined;
    const one = path.at(-1)?.startsWith("{") === true || !["get", "head"].includes(route[1]!);
    if (one) noun[noun.length - 1] = singular(noun.at(-1)!);
    const verb = {
      get: "Read",
      head: "Read",
      post: "Create",
      put: "Update",
      patch: "Update",
      delete: "Delete",
    }[route[1] as "get"];
    return sentence([verb, ...noun]);
  }
  // GraphQL operation keys read "query:issues" / "mutation:createIssue".
  const graphql = /^(query|mutation):(.+)$/.exec(key);
  const segments = (graphql ? graphql[2]! : key).split(/[./]/).filter(Boolean);
  // Graph appends a short hash to count operations: "GetCount-53a3".
  const last = segments.at(-1)?.replace(/-[0-9a-f]{4}$/, "");
  if (!last) return undefined;
  const parts = words(last);
  if (parts.length === 0) return undefined;
  const subject = segments.length > 1 ? words(segments.at(-2)!) : [];
  if (parts[0] === "get" && parts[1] === "count" && parts.length === 2)
    return subject.length > 0 && subject.join(" ") !== "me"
      ? sentence(["Count", ...subject])
      : undefined;
  const verb = Object.hasOwn(CRUD_VERBS, parts[0]!) ? CRUD_VERBS[parts[0]!] : undefined;
  if (verb && parts.length > 1) {
    const object = parts.slice(1);
    if (verb[1] === "one") object[object.length - 1] = singular(object.at(-1)!);
    return sentence([verb[0], ...object]);
  }
  if (graphql && parts.length === 1)
    return sentence(graphql[1] === "query" ? ["Read", ...parts] : parts);
  // A bare action on a parent ("events.event.accept") names that parent.
  if (parts.length === 1 && subject.length > 0 && subject.join(" ") !== "me")
    return sentence([...parts, ...subject.map(singular)]);
  return sentence(parts);
}

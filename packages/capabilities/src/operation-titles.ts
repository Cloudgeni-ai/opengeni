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
const REVIEWED_GRAPH_TITLES: readonly (readonly [RegExp, string])[] = [
  // Outlook mail. Creating a message in Graph saves a draft; nothing is sent.
  [/^(me|users)\.(mailFolders\.(childFolders\.)*)?CreateMessages$/, "Save a draft email"],
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
  [/\.messages\.delta$/, "Read changes to emails"],
  [/^(me|users)\.(mailFolders\.(childFolders\.)*)?ListMessages$/, "Read emails"],
  [/^(me|users)\.(mailFolders\.(childFolders\.)*)?GetMessages$/, "Read an email"],
  [/^(me|users)\.(mailFolders\.(childFolders\.)*)?GetMessagesContent$/, "Download an email"],
  [/^(me|users)\.(mailFolders\.(childFolders\.)*)?UpdateMessages$/, "Update an email"],
  [/^(me|users)\.(mailFolders\.(childFolders\.)*)?DeleteMessages$/, "Delete an email"],
  [/^(me|users)\.ListMailFolders$/, "Read mail folders"],
  [/\.mailFolder\.permanentDelete$/, "Permanently delete a mail folder"],
  [/\.mailFolders\.delta$/, "Read changes to mail folders"],
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
  [/\.event\.permanentDelete$/, "Permanently delete a calendar event"],
  [/\.(events|calendarView)\.delta$/, "Read changes to calendar events"],
  [/(^|\.)calendar\.permanentDelete$/, "Permanently delete a calendar"],
  [/(^|\.)findMeetingTimes$/, "Find meeting times"],
  [/(^|\.)getSchedule$/, "Check availability"],
  // Outlook contacts.
  [/(^|\.)CreateContacts$/, "Add a contact"],
  [/(^|\.)UpdateContacts$/, "Update a contact"],
  [/(^|\.)DeleteContacts$/, "Delete a contact"],
  [/(^|\.)GetContacts$/, "Read a contact"],
  [/(^|\.)ListContacts$/, "Read contacts"],
  [/\.contact\.permanentDelete$/, "Permanently delete a contact"],
  [/\.contacts\.delta$/, "Read changes to contacts"],
  [/(^|\.)ListPeople$/, "Find people"],
  // Work or school directory.
  [/^users\.user\.ListUser$/, "Find colleagues"],
  [/^users\.user\.GetUser$/, "Read a colleague's profile"],
  [/^(me|users)\.GetManager$/, "Read a manager"],
  [/^(me|users)\.ListDirectReports$/, "Read direct reports"],
  // OneDrive and SharePoint files. An item is a file or a folder.
  [/^drives\.CreateItems$/, "Create a file or folder"],
  [/^drives\.UpdateItems$/, "Update a file or folder"],
  [/^drives\.DeleteItems$/, "Delete a file or folder"],
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
  [/\.driveItem\.permanentDelete$/, "Permanently delete a file or folder"],
  [/\.(drive|driveItem)\.search$/, "Search files"],
  [/\.(drive|root|driveItem)\.delta$/, "Read changes to files"],
  // SharePoint sites, lists and Microsoft 365 search.
  [/^search\.query$/, "Search Microsoft 365"],
  [/^sites\.site\.ListSite$/, "Find SharePoint sites"],
  [/^sites\.site\.GetSite$/, "Read a SharePoint site"],
  [/^sites\.site\.getByPath$/, "Read a SharePoint site"],
  [/^sites\.ListSites$/, "Read subsites"],
  [/^me\.ListFollowedSites$/, "Read followed sites"],
  [/^sites\.(ListDrives|GetDrive)$/, "Read document libraries"],
  [/^sites\.(ListLists|GetLists)$/, "Read SharePoint lists"],
  [/^sites\.lists\.(ListItems|GetItems)$/, "Read list items"],
  [/^sites\.lists\.CreateItems$/, "Add a list item"],
  [/^sites\.lists\.items\.UpdateFields$/, "Update a list item"],
  [/^sites\.ListPages$/, "Read site pages"],
  [/^drives\.GetRoot$/, "Read a library's top folder"],
  // Teams.
  [/^chats\.CreateMessages$/, "Send a chat message"],
  [/^chats\.ListMessages$/, "Read chat messages"],
  [/^teams\.channels\.CreateMessages$/, "Post a channel message"],
  [/^teams\.channels\.ListMessages$/, "Read channel messages"],
  [/^teams\.channels\.messages\.CreateReplies$/, "Reply in a channel thread"],
  [/^teams\.channels\.messages\.ListReplies$/, "Read thread replies"],
];

/** Microsoft Graph in its public and national clouds. */
const GRAPH_HOSTS = new Set([
  "graph.microsoft.com",
  "graph.microsoft.us",
  "dod-graph.microsoft.us",
  "graph.microsoft.de",
  "microsoftgraph.chinacloudapi.cn",
]);

function graphHost(serverUrl: string | undefined): boolean {
  if (!serverUrl) return false;
  try {
    return GRAPH_HOSTS.has(new URL(serverUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** What the title can know about the operation besides its id. */
export type OperationTitleContext = {
  /** The HTTP method, for OpenAPI operations. */
  readonly method?: string | undefined;
  /** The server the operation is called on, for OpenAPI operations. */
  readonly serverUrl?: string | undefined;
};

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
  modify: ["Update", "one"],
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
  // "as", "bus", "ids": too short to tell a plural from a word.
  if (word.length <= 3 || NOT_PLURAL.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function sentence(parts: readonly string[]): string {
  const text = parts.join(" ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "for repo", "by id": an object that starts here names its parent first.
const PREPOSITION = /^(for|by|in|on|from|to|with|of|at|under|into)$/;
// "last seven days" counts a span; its noun stays plural.
const COUNTING =
  /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|last|next|previous|recent|first)$/;
// A read whose first word is one of these already says what it does.
const READ_VERB =
  /^(read|search|find|check|count|download|export|fetch|lookup|query|preview|validate|resolve|list|get)$/;

// "setDefault" says how, not what: the thing it acts on is its parent.
const QUALIFIER = /^(default|primary|active|current|main|preferred|public|private)$/;
// A POST to "/accounts/{id}/close" performs that action on the account.
const ROUTE_ACTION =
  /^(accept|activate|apply|approve|archive|cancel|capture|close|confirm|copy|deactivate|decline|delete|deploy|disable|dismiss|enable|finalize|generate|lock|mark|merge|move|open|pause|pay|publish|refund|reject|remove|renew|reopen|rerun|reset|resolve|restart|restore|resume|retry|revoke|run|send|start|stop|submit|suspend|sync|transfer|trigger|unarchive|unlock|unpublish|update|verify|void)$/;

/** Action phrases whose meaning needs the thing they act on. */
const SUBJECT_ACTIONS: Readonly<Record<string, (subject: string) => string>> = {
  "permanent delete": (subject) => `Permanently delete ${subject}`,
  delta: (subject) => `Read changes to ${subject}`,
};

/** The object with its last word singular, unless it counts a span. */
function singularObject(object: readonly string[]): string[] {
  if (object.length === 0 || object.slice(0, -1).some((word) => COUNTING.test(word)))
    return [...object];
  return [...object.slice(0, -1), singular(object.at(-1)!)];
}

/** Tool `_meta` key for the display title. Hosts read it; models never see `_meta`. */
export const DISPLAY_TITLE_META_KEY = "opengeni/displayTitle";

/** The `_meta` entry carrying an operation's display title, when one can be derived. */
export function displayTitleMeta(
  operationKey: string,
  context: OperationTitleContext = {},
): Record<string, string> {
  const title = integrationOperationDisplayTitle(operationKey, context);
  return title ? { [DISPLAY_TITLE_META_KEY]: title } : {};
}

/**
 * A short, plain title for one API operation. Reviewed Microsoft 365 phrasing
 * wins for operations served by Microsoft Graph; any other operation id reads
 * as its verb and object ("me.ListMailFolders" → "Read mail folders",
 * "listPets" → "Read pets", "drive.files.get" → "Read file",
 * "issues/list-for-repo" → "Read issues for repo"). Returns undefined when
 * nothing readable can be derived.
 */
export function integrationOperationDisplayTitle(
  operationKey: string,
  context: OperationTitleContext = {},
): string | undefined {
  const key = operationKey.trim();
  if (!key || key.length > 512) return undefined;
  const graph = graphHost(context.serverUrl);
  if (graph) {
    // Graph appends a short hash to repeated operation ids: "driveItem.delta-fa14".
    const reviewed = key.replace(/-[0-9a-f]{4}$/, "");
    for (const [pattern, title] of REVIEWED_GRAPH_TITLES) if (pattern.test(reviewed)) return title;
  }
  // An operation without an id is keyed by its method and path: "get_/pets/{id}".
  const route = /^(get|head|post|put|patch|delete)_(\/.*)$/.exec(key);
  if (route) {
    const method = route[1]!;
    const path = route[2]!.split("/").filter(Boolean);
    const isParameter = (segment: string | undefined) => segment?.startsWith("{") === true;
    const resource = path.filter((segment) => !isParameter(segment));
    const named = words(path.at(-1) ?? "");
    // "post_/repos/{owner}/{repo}/archive" archives one repo, and
    // "post_/users/{id}/reset-password" resets the password for one user.
    // A plural last word names a collection instead: "merge-requests".
    if (
      method === "post" &&
      isParameter(path.at(-2)) &&
      named.length > 0 &&
      ROUTE_ACTION.test(named[0]!) &&
      singular(named.at(-1)!) === named.at(-1) &&
      resource.length >= 2
    ) {
      const object = singularObject(words(resource.at(-2)!));
      return named.length === 1
        ? sentence([...named, ...object])
        : sentence([...named, "for", ...object]);
    }
    const noun = resource.length > 0 ? words(resource.at(-1)!) : [];
    if (noun.length === 0) return undefined;
    // One thing when the path names it, or when a POST creates it;
    // "delete_/users" acts on every user.
    const one = isParameter(path.at(-1)) || method === "post";
    const verb = {
      get: "Read",
      head: "Read",
      post: "Create",
      put: "Update",
      patch: "Update",
      delete: "Delete",
    }[route[1] as "get"];
    return sentence([verb, ...(one ? singularObject(noun) : noun)]);
  }
  // GraphQL operation keys read "query:issues" / "mutation:createIssue".
  const graphql = /^(query|mutation):(.+)$/.exec(key);
  const segments = (graphql ? graphql[2]! : key).split(/[./]/).filter(Boolean);
  // Graph appends a short hash to count operations: "GetCount-53a3".
  const last = segments.at(-1)?.replace(/-[0-9a-f]{4}$/, "");
  if (!last) return undefined;
  const parts = words(last);
  if (parts.length === 0) return undefined;
  const parent = segments.length > 1 ? words(segments.at(-2)!) : [];
  const subject = parent.join(" ") === "me" ? [] : parent;
  if (parts[0] === "get" && parts[1] === "count" && parts.length === 2)
    return subject.length > 0 ? sentence(["Count", ...subject]) : undefined;
  // "messages.batchDelete" acts on several messages at once.
  const batch = parts[0] === "batch" && parts.length > 1 && Object.hasOwn(CRUD_VERBS, parts[1]!);
  const verbParts = batch ? parts.slice(1) : parts;
  const verb = Object.hasOwn(CRUD_VERBS, verbParts[0]!) ? CRUD_VERBS[verbParts[0]!] : undefined;
  if (verb) {
    const [action, count] = verb;
    const own = verbParts.slice(1);
    const scope = batch ? ["multiple"] : [];
    if (own.length > 0 && !PREPOSITION.test(own[0]!)) {
      // "smimeInfo.setDefault" sets the default smime info.
      if (own.every((word) => QUALIFIER.test(word)) && subject.length > 0)
        return sentence([action, ...own, ...(count === "one" ? singularObject(subject) : subject)]);
      // "createPet" names its own object, and "removeAllLabels" its real
      // scope. Only Graph names one item by its plural collection.
      return sentence([
        action,
        ...scope,
        ...(count === "one" && graph && !batch ? singularObject(own) : own),
      ]);
    }
    // "drive.files.get" and "issues/list-for-repo" act on their parent.
    if (subject.length > 0)
      return sentence([
        action,
        ...scope,
        ...(count === "one" && !batch ? singularObject(subject) : subject),
        ...own,
      ]);
    return own.length > 0 ? sentence([action, ...own]) : undefined;
  }
  if (graphql && parts.length === 1)
    return sentence(graphql[1] === "query" ? ["Read", ...parts] : parts);
  const phrase = SUBJECT_ACTIONS[parts.join(" ")];
  if (phrase) return subject.length > 0 ? phrase(subject.join(" ")) : undefined;
  // A read named by what it returns ("supportedTimeZones") says that it reads.
  if (context.method?.toLowerCase() === "get" && !READ_VERB.test(parts[0]!))
    return sentence(["Read", ...parts]);
  // A bare action on a parent ("events.event.accept") names that parent.
  if (parts.length === 1 && subject.length > 0)
    return sentence([...parts, ...subject.map(singular)]);
  return sentence(parts);
}

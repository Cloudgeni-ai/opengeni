import { ACTION_CATALOG } from "./app-action-catalog.gen";
import type { ActionCatalogEntry } from "./app-action-catalog-types";

/* ----------------------------------------------------------------------------
   App actions: every public API action, the same ones the organization MCP
   server and a session's admin_action_* tools run as a person. The API runs
   them; the worker reads this module only to tell a change from a read and to
   word the confirmation the person sees in the chat before a change runs.
   -------------------------------------------------------------------------- */

export type { ActionCatalogEntry };
export { ACTION_CATALOG };

/** The tool that runs an app action in a session; the only one that can change anything. */
export const APP_ACTION_CALL_TOOL_NAME = "admin_action_call" as const;

/**
 * Requests that only read but are sent as POST (a search query or a file path
 * in the body). Read only connections may run them; each route still checks
 * its own read permission.
 */
export const READ_ONLY_POST_ACTIONS: ReadonlySet<string> = new Set([
  "/v1/workspaces/:workspaceId/knowledge/entries/search",
  "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read",
  "/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff",
  "/v1/workspaces/:workspaceId/integrations/preview",
  "/v1/workspaces/:workspaceId/plugins/preview",
  "/v1/workspaces/:workspaceId/skills/preview",
  "/v1/organizations/:organizationId/external-identities/lookup",
]);

/** An action by its id, or by "METHOD /path". */
export function findAppAction(id: string): ActionCatalogEntry | undefined {
  const trimmed = id.trim();
  return ACTION_CATALOG.find(
    (entry) => entry.id === trimmed || `${entry.method} ${entry.path}` === trimmed,
  );
}

/**
 * Whether running the action can change anything. Only GET, HEAD, the
 * read-only POSTs and retired actions can't: a retired action runs nothing and
 * only names its replacement, so it never needs a confirmation.
 */
export function appActionChangesState(entry: ActionCatalogEntry): boolean {
  return !(
    entry.method === "GET" ||
    entry.method === "HEAD" ||
    entry.retired !== undefined ||
    READ_ONLY_POST_ACTIONS.has(entry.path)
  );
}

/**
 * Whether an admin_action_call with these arguments needs the person's
 * confirmation when the session lacks full access: true for every change, and
 * for anything that can't be recognised as a read (unknown action, bad input).
 */
export function appActionCallChangesState(args: unknown): boolean {
  const id = callArguments(args)?.id;
  if (typeof id !== "string") return true;
  const entry = findAppAction(id);
  return entry === undefined || appActionChangesState(entry);
}

/**
 * Whether the action can create, show, copy or rotate a key, password, token
 * or other secret, or hand one to the app (its catalog entry lists where).
 */
export function appActionHandlesSecrets(entry: ActionCatalogEntry): boolean {
  return (entry.secretFields?.length ?? 0) > 0;
}

/**
 * Whether this call of the action carries a secret: the action returns or
 * stores one whatever it is given (a response field or a route), or this
 * call's body fills a request field that holds one ("headers" when creating a
 * chat with MCP servers; creating it without them carries none). Without full
 * access the chat route never runs such a call: one click would put a lasting
 * secret into the conversation and the model provider's logs. The person
 * does it in the app instead.
 */
export function appActionCallCarriesSecrets(entry: ActionCatalogEntry, body: unknown): boolean {
  return (entry.secretFields ?? []).some((field) => {
    if (!field.startsWith("request.") && !field.startsWith("request[]")) return true;
    return filledAt(body, field.slice("request".length));
  });
}

/** The same, for an admin_action_call's arguments; an unknown action is not one. */
export function appActionCallHandlesSecrets(args: unknown): boolean {
  const call = callArguments(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  return entry !== undefined && appActionCallCarriesSecrets(entry, call?.body);
}

/** Whether a body has a non-empty value at a catalog field path such as ".mcpServers[].headers". */
function filledAt(value: unknown, path: string): boolean {
  if (path === "") return filled(value);
  if (path.startsWith("[]")) {
    const items = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value)
        : [];
    return items.some((item) => filledAt(item, path.slice(2)));
  }
  const match = /^\.([^.[]+)/.exec(path);
  if (!match) return true;
  const object = record(value);
  return object !== null && filledAt(object[match[1]!], path.slice(match[0].length));
}

function filled(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// Values put into a confirmation's words are checked first, so an argument can
// never write its own question. Anything else falls back to the generic text.
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/**
 * The question the person answers before a change runs, in plain words, from
 * the action and its checked arguments; never text the agent wrote. `here` is
 * the chat asking, so "this chat" and "this workspace" are said only when the
 * call targets exactly them.
 */
export function appActionConfirmationTitle(
  args: unknown,
  here: { workspaceId: string; sessionId: string },
): string {
  const call = callArguments(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  if (!entry) return "Make this change in the app?";
  const body = record(call?.body);
  const path = record(call?.pathParameters);
  const workspace = path?.workspaceId === here.workspaceId ? "this workspace" : "another workspace";
  const chat =
    path?.sessionId === here.sessionId && path?.workspaceId === here.workspaceId
      ? "this chat"
      : "another chat";
  switch (entry.id) {
    case "createOrganizationInvitation": {
      const email = typeof body?.email === "string" ? body.email : "";
      const who = PLAIN_EMAIL.test(email) ? email : "someone";
      const role = body?.role ?? "member";
      return role === "member"
        ? `Invite ${who} to your organization?`
        : role === "admin" || role === "owner"
          ? `Invite ${who} to your organization as an ${role}?`
          : `Invite ${who} to your organization?`;
    }
    case "addWorkspaceMember":
      return `Add someone to ${workspace}?`;
    case "updateSessionVisibility":
      return body?.visibility === "workspace"
        ? `Share ${chat} with everyone in the workspace?`
        : body?.visibility === "private"
          ? `Make ${chat} visible only to you?`
          : `Change who can see ${chat}?`;
    case "updateWorkspaceSettings":
      return `Change ${workspace}'s settings?`;
    case "updateOrganizationModelDefaults":
      return "Change your organization's default models?";
    default: {
      // Name where it applies; the card's next line shows the key values.
      const target =
        typeof path?.sessionId === "string"
          ? ` for ${chat}`
          : typeof path?.workspaceId === "string"
            ? ` in ${workspace}`
            : typeof path?.organizationId === "string"
              ? " in your organization"
              : "";
      return `${sentence(entry)}${target}?`;
    }
  }
}

/** "updateWorkspaceSettings" reads "Update workspace settings"; unnamed routes read by their path. */
function sentence(entry: ActionCatalogEntry): string {
  if (/^[a-z][A-Za-z0-9]*$/.test(entry.id)) {
    const words = entry.id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return `Run ${entry.method} ${entry.path}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A call's arguments, parsed or still as their JSON text. */
function callArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}
